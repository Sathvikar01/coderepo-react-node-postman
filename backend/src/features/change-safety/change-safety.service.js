import { AppError } from "../../shared/errors/app-error.js";
import { collectionService } from "../collections/collection.service.js";
import { environmentService } from "../environments/environment.service.js";
import { versionsService } from "../versions/versions.service.js";
import { buildSafeSnapshot } from "../versions/snapshot.js";
import { fingerprintSnapshot } from "../versions/canonical.js";
import { analyzeWorkspaceDiff } from "../change-impact/change-impact.service.js";
import { toWorkspaceCollection, toWorkspaceEnvironment } from "../change-impact/change-impact-adapter.js";
import { analyzeEnvironmentDrift } from "../environment-drift/index.js";
import { projectChangeImpact, projectEnvironmentDrift } from "../core-integration/index.js";
import { evaluateBlastRadius } from "../blast-radius-policy/index.js";
import { planRehearsal } from "../rehearsal-planning/index.js";
import { runRehearsal } from "../rehearsal-execution/index.js";
import { randomUUID } from "node:crypto";
import { compileRequest } from "../executions/request-compiler.js";
import { executionService } from "../executions/execution.service.js";
import { contractRegistryService, inferContractFromResponse } from "../contract-registry/index.js";
import { compareContractToResponse } from "../contract-compatibility/index.js";
import { toObservedResponse } from "../rehearsal-execution/outcome-mapping.js";
import { historyService } from "../history/history.service.js";
import { verificationProofApiService } from "../verification-proof-api/index.js";

// Phase 54 — browser-facing Change Safety workflow.
//
// This service is orchestration only. Every domain answer remains owned by the
// existing Phase 39/40/41/43/45/46/47 cores. The browser supplies only a saved
// collection, a baseline revision, and source/target environment ids; all
// evidence is reloaded and recomputed on the backend.

const MAX_CHANGED_PATHS = 50;

function idOf(value) {
	return value === undefined || value === null ? null : String(value);
}

function snapshotIdOf(collectionId, revision) {
	return `collection:${collectionId}:v${revision}`;
}

function environmentIdentity(environment) {
	const snapshot = buildSafeSnapshot("environment", environment);
	return {
		environmentId: idOf(environment._id ?? environment.id),
		environmentName: environment.name ?? null,
		environmentFingerprint: fingerprintSnapshot(snapshot),
	};
}

function collectionVersionDocument(version, collectionId, ownerProfileId) {
	return {
		...version.snapshot,
		_id: collectionId,
		id: collectionId,
		ownerProfileId,
	};
}

function workspaceForImpact({ collectionVersion, collectionId, ownerProfileId, environments, environmentId }) {
	return {
		ownerProfileId,
		environmentId,
		collections: [toWorkspaceCollection(collectionVersionDocument(collectionVersion, collectionId, ownerProfileId))],
		environments: environments.map((environment) => toWorkspaceEnvironment(environment)),
	};
}

function secretMapFor(profileId, collection, environment, resolveSecretAlias) {
	const secrets = new Map();
	for (const variable of [...(collection?.variables ?? []), ...(environment?.variables ?? [])]) {
		if (variable?.enabled === false || variable?.kind !== "secretRef" || !variable.key || !variable.alias) continue;
		const value = resolveSecretAlias(profileId, variable.alias);
		if (value !== null && value !== undefined) secrets.set(variable.key, value);
	}
	return secrets;
}

function uniqueRequestRows(impact) {
	const rows = [...(impact?.requests?.direct ?? []), ...(impact?.requests?.indirect ?? [])];
	const byId = new Map();
	for (const row of rows) {
		if (!row?.requestId) continue;
		const current = byId.get(row.requestId);
		if (!current || (row.hop ?? Infinity) < (current.hop ?? Infinity)) byId.set(row.requestId, row);
	}
	return [...byId.values()].sort((left, right) => String(left.requestId).localeCompare(String(right.requestId)));
}

function requestById(collection, requestId) {
	return (collection?.requests ?? []).find((request) => String(request.id ?? request._id) === String(requestId)) ?? null;
}

function buildCandidate({ request, collectionId, collection, environment, secrets }) {
	const requestId = idOf(request.id ?? request._id);
	try {
		const compiled = compileRequest({ request, collection, environment, secrets });
		const url = new URL(compiled.url);
		const defaultPort = url.protocol === "https:" ? 443 : 80;
		return {
			candidate: {
				requestId,
				collectionId,
				host: url.hostname,
				port: url.port ? Number(url.port) : defaultPort,
				method: compiled.method,
				dependsOn: [],
				dynamicDependencies: [],
			},
			policyRequest: {
				requestId,
				method: compiled.method,
				host: { host: url.hostname, port: url.port ? Number(url.port) : defaultPort },
			},
			compileError: null,
		};
	} catch (error) {
		return {
			candidate: {
				requestId,
				collectionId,
				host: null,
				port: null,
				method: String(request?.method ?? "").toUpperCase() || null,
				dependsOn: [],
				dynamicDependencies: [],
			},
			policyRequest: {
				requestId,
				method: String(request?.method ?? "").toUpperCase() || "GET",
				host: null,
			},
			compileError: {
				requestId,
				code: error?.code ?? "REQUEST_COMPILE_FAILED",
				message: error?.message ?? "The request could not be compiled for rehearsal planning.",
			},
		};
	}
}

function planCanRun(plan) {
	return Boolean(plan && (plan.summary?.executable ?? 0) > 0 && Array.isArray(plan.steps) && plan.steps.length > 0);
}

function summaryOfContracts(contractsByRequest, requestIds, snapshotFingerprint) {
	let published = 0;
	let boundToCurrent = 0;
	let stale = 0;
	let unbound = 0;
	for (const requestId of requestIds) {
		const contract = contractsByRequest.get(requestId);
		if (!contract) continue;
		published += 1;
		if (!contract.snapshotFingerprint) unbound += 1;
		else if (contract.snapshotFingerprint === snapshotFingerprint) boundToCurrent += 1;
		else stale += 1;
	}
	return {
		requests: requestIds.length,
		published,
		missing: requestIds.length - published,
		boundToCurrent,
		stale,
		unbound,
	};
}

function publicAnalysis(analysis) {
	const {
		contractsByRequest,
		sourceEnvironment,
		targetEnvironment,
		collection,
		...safe
	} = analysis;
	return safe;
}

export function createChangeSafetyService({
	collections = collectionService,
	environments = environmentService,
	versions = versionsService,
	analyzeImpact = analyzeWorkspaceDiff,
	analyzeDrift = analyzeEnvironmentDrift,
	blastRadius = evaluateBlastRadius,
	plan = planRehearsal,
	execute = runRehearsal,
	contracts = contractRegistryService,
	history = historyService,
	proofs = verificationProofApiService,
	compareContract = compareContractToResponse,
	executions = executionService,
	inferContract = inferContractFromResponse,
	newExecutionId = randomUUID,
	projectImpact = projectChangeImpact,
	projectDrift = projectEnvironmentDrift,
	resolveSecretAlias = (profileId, alias) => environmentService.resolveSecretAlias(profileId, alias),
} = {}) {
	async function buildAnalysis(profileId, workspaceScope, input) {
		const collection = await collections.get(input.collectionId, workspaceScope);
		const currentRevision = Number(collection.revision);
		const baselineRevision = Number(input.baselineRevision);
		if (!Number.isInteger(baselineRevision) || baselineRevision < 1 || baselineRevision > currentRevision) {
			throw new AppError(400, "CHANGE_SAFETY_BASELINE_INVALID", "Choose a saved baseline revision from this collection.");
		}
		if (String(input.sourceEnvironmentId) === String(input.targetEnvironmentId)) {
			throw new AppError(400, "CHANGE_SAFETY_ENVIRONMENTS_MATCH", "Choose different source and target environments.");
		}

		const [baselineVersion, currentVersion, versionDiff, sourceEnvironment, targetEnvironment] = await Promise.all([
			versions.get("collection", input.collectionId, baselineRevision, workspaceScope),
			versions.get("collection", input.collectionId, currentRevision, workspaceScope),
			versions.compare("collection", input.collectionId, baselineRevision, currentRevision, workspaceScope),
			environments.get(input.sourceEnvironmentId, workspaceScope),
			environments.get(input.targetEnvironmentId, workspaceScope),
		]);

		const ownerProfileId = String(profileId);
		const environmentDocs = [sourceEnvironment, targetEnvironment];
		const before = workspaceForImpact({
			collectionVersion: baselineVersion,
			collectionId: input.collectionId,
			ownerProfileId,
			environments: environmentDocs,
			environmentId: input.sourceEnvironmentId,
		});
		const after = workspaceForImpact({
			collectionVersion: currentVersion,
			collectionId: input.collectionId,
			ownerProfileId,
			environments: environmentDocs,
			environmentId: input.sourceEnvironmentId,
		});

		const impactDiff = analyzeImpact({
			before,
			after,
			environmentId: String(input.sourceEnvironmentId),
		});
		const changeCount = impactDiff.changes?.length ?? 0;
		const changeIndex = input.changeIndex === undefined || input.changeIndex === null ? 0 : Number(input.changeIndex);
		if (changeCount > 0 && (!Number.isInteger(changeIndex) || changeIndex < 0 || changeIndex >= changeCount)) {
			throw new AppError(400, "CHANGE_SAFETY_CHANGE_INVALID", "Choose one of the detected changes to verify.", {
				changeCount,
			});
		}
		const selectedImpact = changeCount > 0 ? impactDiff.changes[changeIndex] : null;
		const drift = analyzeDrift({
			collection,
			sourceEnvironment,
			targetEnvironment,
		});

		const currentSnapshot = {
			snapshotId: snapshotIdOf(input.collectionId, currentRevision),
			snapshotFingerprint: currentVersion.fingerprint,
		};
		const baselineSnapshot = {
			snapshotId: snapshotIdOf(input.collectionId, baselineRevision),
			snapshotFingerprint: baselineVersion.fingerprint,
		};
		const sourceIdentity = environmentIdentity(sourceEnvironment);
		const targetIdentity = environmentIdentity(targetEnvironment);

		const blockers = [];
		if (versionDiff.identical || changeCount === 0) {
			blockers.push({ code: "NO_SAVED_CHANGE", message: "The selected baseline and current collection revision are identical." });
		}

		const impactRows = selectedImpact ? uniqueRequestRows(selectedImpact) : [];
		if (selectedImpact && impactRows.length === 0) {
			blockers.push({ code: "NO_AFFECTED_REQUESTS", message: "The selected change has no affected request that can be rehearsed." });
		}

		const secrets = secretMapFor(profileId, collection, targetEnvironment, resolveSecretAlias);
		const candidates = [];
		const policyRequests = [];
		const compileErrors = [];
		for (const row of impactRows) {
			const request = requestById(collection, row.requestId);
			if (!request) {
				compileErrors.push({
					requestId: row.requestId,
					code: "REQUEST_NOT_IN_CURRENT_COLLECTION",
					message: "The affected request does not exist in the current saved collection.",
				});
				continue;
			}
			const built = buildCandidate({
				request,
				collectionId: String(input.collectionId),
				collection,
				environment: targetEnvironment,
				secrets,
			});
			candidates.push(built.candidate);
			policyRequests.push(built.policyRequest);
			if (built.compileError) compileErrors.push(built.compileError);
		}
		if (compileErrors.length > 0) {
			blockers.push({
				code: "REQUEST_COMPILE_BLOCKED",
				message: "One or more affected requests could not be resolved safely for rehearsal.",
				requestIds: compileErrors.map((entry) => entry.requestId),
			});
		}

		let blast = null;
		let rehearsalPlan = null;
		if (selectedImpact && policyRequests.length > 0) {
			const resolvedHosts = [...new Set(policyRequests.map((request) => request.host?.host).filter(Boolean))].sort();
			blast = blastRadius({
				workspaceId: String(workspaceScope.workspaceId),
				snapshotId: currentSnapshot.snapshotId,
				environmentId: sourceIdentity.environmentId,
				targetEnvironmentId: targetIdentity.environmentId,
				policy: {
					allowedEnvironmentIds: [targetIdentity.environmentId],
					allowedHosts: resolvedHosts,
					allowMutating: Boolean(input.allowMutating),
					requireMutatingConfirmation: false,
					maxTotalRequests: policyRequests.length,
					maxMutatingRequests: Boolean(input.allowMutating) ? policyRequests.length : 0,
					maxRequestsPerHost: policyRequests.length,
					maxFailures: policyRequests.length,
					maxConsecutiveFailures: policyRequests.length,
					stopOnCriticalFailure: true,
				},
				requests: policyRequests,
			});

			rehearsalPlan = plan({
				workspaceId: String(workspaceScope.workspaceId),
				snapshot: currentSnapshot,
				source: {
					workspaceId: String(workspaceScope.workspaceId),
					collectionId: String(input.collectionId),
					snapshotId: baselineSnapshot.snapshotId,
					snapshotFingerprint: baselineSnapshot.snapshotFingerprint,
					environmentId: sourceIdentity.environmentId,
					environmentName: sourceIdentity.environmentName,
					revision: baselineRevision,
				},
				target: {
					workspaceId: String(workspaceScope.workspaceId),
					collectionId: String(input.collectionId),
					snapshotId: currentSnapshot.snapshotId,
					snapshotFingerprint: currentSnapshot.snapshotFingerprint,
					environmentId: targetIdentity.environmentId,
					environmentName: targetIdentity.environmentName,
					revision: currentRevision,
				},
				impact: selectedImpact,
				drift,
				blastRadius: blast,
				candidates,
			});
			if (!planCanRun(rehearsalPlan)) {
				blockers.push({ code: "NO_EXECUTABLE_REHEARSAL", message: "The safety policy admitted no executable rehearsal steps." });
			}
		}

		const requestIds = candidates.map((candidate) => candidate.requestId);
		const contractPairs = await Promise.all(
			requestIds.map(async (requestId) => [requestId, await contracts.getCurrentForRequest(profileId, requestId)]),
		);
		const contractsByRequest = new Map(contractPairs);

		return {
			selection: {
				collectionId: String(input.collectionId),
				collectionName: collection.name,
				baselineRevision,
				currentRevision,
				sourceEnvironmentId: sourceIdentity.environmentId,
				sourceEnvironmentName: sourceIdentity.environmentName,
				targetEnvironmentId: targetIdentity.environmentId,
				targetEnvironmentName: targetIdentity.environmentName,
				changeIndex,
				allowMutating: Boolean(input.allowMutating),
			},
			snapshot: currentSnapshot,
			baselineSnapshot,
			snapshotDiff: {
				identical: versionDiff.identical,
				changedCount: versionDiff.changes?.length ?? 0,
				changedPaths: (versionDiff.changes ?? []).slice(0, MAX_CHANGED_PATHS).map((entry) => entry.path),
				truncated: Boolean(versionDiff.truncated),
			},
			impactDiff,
			selectedImpact,
			drift,
			blastRadius: blast,
			plan: rehearsalPlan,
			compileErrors,
			contracts: summaryOfContracts(contractsByRequest, requestIds, currentSnapshot.snapshotFingerprint),
			canRun: blockers.length === 0 && planCanRun(rehearsalPlan),
			blockers,
			contractsByRequest,
			sourceEnvironment,
			targetEnvironment,
			collection,
			sourceIdentity,
			targetIdentity,
		};
	}

	async function analyze(profileId, workspaceScope, input) {
		return publicAnalysis(await buildAnalysis(profileId, workspaceScope, input));
	}

	async function generateContracts(profileId, workspaceScope, input) {
		const analysis = await buildAnalysis(profileId, workspaceScope, input);
		if (!analysis.selectedImpact) {
			throw new AppError(409, "CHANGE_SAFETY_NO_CHANGE", "Choose a detected saved change before generating contracts.");
		}

		const requestRows = uniqueRequestRows(analysis.selectedImpact);
		const generated = [];
		const skipped = [];
		for (const row of requestRows) {
			const request = requestById(analysis.collection, row.requestId);
			if (!request) {
				skipped.push({ requestId: row.requestId, code: "REQUEST_NOT_IN_CURRENT_COLLECTION" });
				continue;
			}

			const existing = analysis.contractsByRequest.get(row.requestId) ?? null;
			if (
				existing &&
				(!existing.snapshotFingerprint || existing.snapshotFingerprint === analysis.snapshot.snapshotFingerprint)
			) {
				skipped.push({ requestId: row.requestId, code: "CURRENT_CONTRACT_EXISTS", contractId: existing.contractId });
				continue;
			}

			const method = String(request.method ?? "").toUpperCase();
			const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
			if (mutating && !input.allowMutating) {
				throw new AppError(
					409,
					"CHANGE_SAFETY_CONTRACT_MUTATION_CONFIRMATION_REQUIRED",
					"Generating this contract requires a source-environment execution of a mutating request. Enable the explicit mutating-request toggle first.",
					{ requestId: row.requestId, method },
				);
			}

			const executionId = newExecutionId();
			const execution = await executions.send(
				profileId,
				{
					executionId,
					tabId: `change-safety-contract:${row.requestId}`,
					draftVersion: null,
					request: null,
					context: {
						collectionId: analysis.selection.collectionId,
						collectionRevision: analysis.selection.currentRevision,
						requestId: row.requestId,
						environmentId: analysis.sourceIdentity.environmentId,
						environmentRevision: analysis.sourceEnvironment.revision,
					},
				},
				{ rateLimit: false, workspaceId: String(workspaceScope.workspaceId) },
			);
			if (execution?.outcome !== "response" || !execution.response) {
				throw new AppError(
					409,
					"CHANGE_SAFETY_CONTRACT_SOURCE_FAILED",
					"The source-environment request did not produce a response that can define an expected contract.",
					{ requestId: row.requestId, executionId, outcome: execution?.outcome ?? null },
				);
			}

			const headers = Array.isArray(execution.response.headers) ? execution.response.headers : [];
			const contentType =
				headers.find((header) => String(header?.name ?? "").toLowerCase() === "content-type")?.value ?? null;
			const responseBody = execution.response.body;
			const body =
				responseBody?.encoding === "text" && responseBody?.truncated !== true && !responseBody?.omittedReason
					? responseBody.value
					: null;
			const inferred = inferContract({
				response: {
					status: execution.response.status,
					headers,
					body,
					contentType,
				},
				name: `${request.name ?? row.requestId} response`,
				description: `Generated from ${analysis.sourceIdentity.environmentName ?? "source environment"} by Change Safety.`,
			});

			const draft = await contracts.createDraftFromResponse(
				profileId,
				{
					...(existing?.contractId ? { contractId: existing.contractId } : {}),
					collectionId: analysis.selection.collectionId,
					workspaceId: String(workspaceScope.workspaceId),
					requestId: row.requestId,
					// Phase 42 persists snapshotId as an ObjectId, while this browser
					// workflow's revision identity is a richer string. Bind the contract
					// to the canonical fingerprint and leave the optional registry id unset.
					snapshotFingerprint: analysis.snapshot.snapshotFingerprint,
					name: inferred.name,
					description: inferred.description ?? "",
					body: inferred.body,
				},
				inferred,
			);
			const published = await contracts.publish(profileId, draft.contractId, draft.sequence);
			generated.push({
				requestId: row.requestId,
				requestName: request.name ?? null,
				contractId: published.contractId,
				sequence: published.sequence,
				executionId,
				warnings: inferred.warnings ?? [],
			});
		}

		const refreshed = await buildAnalysis(profileId, workspaceScope, input);
		return {
			analysis: publicAnalysis(refreshed),
			generated,
			skipped,
		};
	}

	async function run(profileId, workspaceScope, input) {
		const analysis = await buildAnalysis(profileId, workspaceScope, input);
		if (!analysis.canRun) {
			throw new AppError(409, "CHANGE_SAFETY_NOT_RUNNABLE", "Resolve the analysis blockers before starting a rehearsal.", {
				blockers: analysis.blockers,
			});
		}

		const phase41Impact = projectImpact(analysis.selectedImpact);
		const phase41Drift = projectDrift(analysis.drift);
		if (!phase41Impact || !phase41Drift) {
			throw new AppError(409, "CHANGE_SAFETY_EVIDENCE_INVALID", "The generated impact or drift evidence could not be projected for verification.");
		}

		const verificationInput = {
			source: {
				workspaceId: String(workspaceScope.workspaceId),
				collectionId: analysis.selection.collectionId,
				snapshotId: analysis.baselineSnapshot.snapshotId,
				snapshotFingerprint: analysis.baselineSnapshot.snapshotFingerprint,
				environmentId: analysis.sourceIdentity.environmentId,
				environmentName: analysis.sourceIdentity.environmentName,
				label: "source",
			},
			target: {
				workspaceId: String(workspaceScope.workspaceId),
				collectionId: analysis.selection.collectionId,
				snapshotId: analysis.snapshot.snapshotId,
				snapshotFingerprint: analysis.snapshot.snapshotFingerprint,
				environmentId: analysis.targetIdentity.environmentId,
				environmentName: analysis.targetIdentity.environmentName,
				label: "target",
			},
			snapshotDiff: {
				identical: analysis.snapshotDiff.identical,
				changedCount: analysis.snapshotDiff.changedCount,
				changedPaths: analysis.snapshotDiff.changedPaths,
			},
			environmentDrift: phase41Drift,
			changeImpact: phase41Impact,
			executions: [],
			assertions: [],
			ownerProfileId: String(profileId),
		};

		const rehearsal = await execute(
			profileId,
			{
				plan: analysis.plan,
				blastRadius: analysis.blastRadius,
				environment: {
					environmentId: analysis.targetIdentity.environmentId,
					environmentFingerprint: analysis.targetIdentity.environmentFingerprint,
					environmentName: analysis.targetIdentity.environmentName,
				},
				snapshot: analysis.snapshot,
				contracts: analysis.contractsByRequest,
				verification: verificationInput,
				context: { workspaceId: String(workspaceScope.workspaceId) },
			},
			{ workspaceId: String(workspaceScope.workspaceId) },
		);

		const compatibility = [];
		for (const outcome of rehearsal.stepOutcomes ?? []) {
			if (!outcome?.executionId || !outcome?.requestId) continue;
			const contract = analysis.contractsByRequest.get(outcome.requestId);
			if (!contract) continue;
			const record = await history.get(profileId, outcome.executionId);
			if (!record || record.expired) continue;
			const projected = toObservedResponse(record, {
				requestId: outcome.requestId,
				collectionId: analysis.selection.collectionId,
				workspaceId: String(workspaceScope.workspaceId),
				snapshotId: analysis.snapshot.snapshotId,
				snapshotFingerprint: analysis.snapshot.snapshotFingerprint,
				profileId: String(profileId),
				environmentId: analysis.targetIdentity.environmentId,
				executionId: outcome.executionId,
			});
			if (!projected.response) continue;
			try {
				compatibility.push(compareContract({ contract, response: projected.response }));
			} catch {
				// The executor already treats an uncomparable contract as absent
				// evidence. The browser workflow preserves that fail-closed outcome.
			}
		}

		const { proof } = proofs.build(profileId, {
			workspaceId: String(workspaceScope.workspaceId),
			snapshot: analysis.snapshot,
			targetEnvironment: {
				environmentId: analysis.targetIdentity.environmentId,
				environmentFingerprint: analysis.targetIdentity.environmentFingerprint,
				environmentName: analysis.targetIdentity.environmentName,
			},
			plan: analysis.plan,
			execution: rehearsal,
			impact: analysis.selectedImpact,
			drift: analysis.drift,
			contracts: compatibility,
			verifiedAt: new Date().toISOString(),
		});

		return {
			...publicAnalysis(analysis),
			rehearsal,
			compatibility: {
				compared: compatibility.length,
				results: compatibility,
			},
			proof,
		};
	}

	return { analyze, generateContracts, run };
}

export const changeSafetyService = createChangeSafetyService();
