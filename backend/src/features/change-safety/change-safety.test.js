import { describe, expect, test } from "bun:test";
import { createChangeSafetyService } from "./change-safety.service.js";
import { planRehearsal } from "../rehearsal-planning/index.js";
import { parseRunIdentity } from "../rehearsal-checkpoints/checkpoint-schema.js";
import { initConfig } from "../../shared/config/index.js";

initConfig();

const PROFILE = "profile-1";
const WORKSPACE = "workspace-1";
const COLLECTION = "collection-1";
const SOURCE_ENV = "environment-source";
const TARGET_ENV = "environment-target";

function row(id, key, value) {
	return { id, key, value, enabled: true };
}

function request() {
	return {
		id: "request-1",
		folderId: null,
		name: "List orders",
		method: "GET",
		urlTemplate: "https://api.example.test/orders",
		query: [],
		headers: [row("header-1", "X-Client", "web")],
		body: { mode: "none" },
		auth: { mode: "none" },
		scripts: { preRequest: "", postResponse: "" },
		assertions: [],
		settings: { timeoutMs: 15000 },
	};
}

const baselineSnapshot = {
	name: "Orders",
	description: "",
	variables: [],
	auth: { mode: "none" },
	folders: [],
	requests: [{ ...request(), headers: [row("header-1", "X-Client", "old")] }],
};

const currentSnapshot = {
	...baselineSnapshot,
	requests: [request()],
};

const collection = {
	_id: COLLECTION,
	name: "Orders",
	revision: 2,
	variables: [],
	auth: { mode: "none" },
	folders: [],
	requests: [request()],
};

const sourceEnvironment = { _id: SOURCE_ENV, name: "Local", revision: 1, variables: [] };
const targetEnvironment = { _id: TARGET_ENV, name: "Staging", revision: 1, variables: [] };

// The Phase 46B core projects a run two ways: `normalizeRun` (canonical, nested
// identity) and `presentRun` (flattened identity for display). The executor
// report carries the presentation; the proof builder requires the canonical one.
const canonicalRun = {
	id: "checkpoint-1",
	ownerProfileId: PROFILE,
	runId: "run-1",
	schemaVersion: 1,
	kind: "tracer.rehearsal-checkpoint",
	identity: {
		workspaceId: WORKSPACE,
		snapshotId: `collection:${COLLECTION}:v2`,
		snapshotFingerprint: "b".repeat(64),
		targetEnvironment: { environmentId: TARGET_ENV, environmentName: "Staging", environmentFingerprint: "c".repeat(64) },
		planId: "plan-1",
		planFingerprint: "plan-1",
		policyId: "policy-1",
		policyFingerprint: "e".repeat(64),
	},
	identityFingerprint: "d".repeat(64),
	plan: { steps: [{ stepId: "step-1", refId: "request-1" }] },
	planFingerprint: "plan-1",
	runState: "COMPLETED",
	generation: 2,
	completedStepIds: ["step-1"],
	currentStepId: null,
	nextStepId: null,
};

const impact = {
	schemaVersion: 1,
	kind: "tracer.change-impact",
	change: {
		operation: "changed",
		target: { kind: "header", scope: "request", collectionId: COLLECTION, requestId: "request-1", name: "X-Client" },
	},
	resolved: true,
	summary: {
		directRequests: 1,
		indirectRequests: 0,
		totalRequests: 1,
		affectedCollections: 1,
		affectedFolders: 0,
		affectedAssertions: 0,
		unknownReferences: 0,
		severity: "medium",
	},
	impact: { direct: [], indirect: [] },
	requests: {
		direct: [{ requestId: "request-1", collectionId: COLLECTION, nodeKind: "request", impact: "direct", hop: 1, confidence: "exact" }],
		indirect: [],
	},
	collections: [],
	folders: [],
	assertions: [],
	unknown: [],
	truncated: false,
};

const drift = {
	kind: "tracer.environment-drift",
	schemaVersion: 1,
	identical: true,
	source: { environmentId: SOURCE_ENV, name: "Local", revision: 1 },
	target: { environmentId: TARGET_ENV, name: "Staging", revision: 1 },
	summary: { total: 0, byCategory: {}, bySeverity: {} },
	drift: [],
};

function fixtureService(overrides = {}) {
	const calls = { proof: null, execute: null, contractDraft: null, sourceExecution: null };
	let currentContract = null;
	const service = createChangeSafetyService({
		collections: { get: async () => collection },
		environments: {
			get: async (id) => (id === SOURCE_ENV ? sourceEnvironment : targetEnvironment),
		},
		versions: {
			get: async (_type, _id, revision) =>
				revision === 1
					? { revision: 1, fingerprint: "a".repeat(64), snapshot: baselineSnapshot }
					: { revision: 2, fingerprint: "b".repeat(64), snapshot: currentSnapshot },
			compare: async () => ({ identical: false, truncated: false, changes: [{ path: "requests[id=request-1].headers", change: "changed" }] }),
		},
		analyzeImpact: () => ({ schemaVersion: 1, kind: "tracer.change-impact.diff", changeCount: 1, changes: [impact] }),
		analyzeDrift: () => drift,
		blastRadius: () => ({
			kind: "tracer.blast-radius-envelope",
			schemaVersion: 1,
			workspace: { workspaceId: WORKSPACE, snapshotId: `collection:${COLLECTION}:v2` },
			environment: { environmentId: SOURCE_ENV, targetEnvironmentId: TARGET_ENV },
			policy: { identity: "policy-1" },
			admissionState: "ADMITTED",
			requests: { proposed: 1, admitted: 1, blocked: 0, unknown: 0, requiresConfirmation: 0 },
			allowedRequests: [{ requestId: "request-1", admission: "ADMITTED" }],
			blockedRequests: [],
			unknownRequests: [],
			confirmationRequests: [],
		}),
		plan: () => ({
			kind: "tracer.rehearsal-plan",
			schemaVersion: 1,
			state: "READY",
			identity: { planFingerprint: "plan-1", fingerprintKeyId: "key-1" },
			workspace: { workspaceId: WORKSPACE },
			snapshot: { snapshotId: `collection:${COLLECTION}:v2`, snapshotFingerprint: "b".repeat(64) },
			source: { environmentId: SOURCE_ENV, snapshotFingerprint: "b".repeat(64) },
			target: { environmentId: TARGET_ENV, snapshotFingerprint: "b".repeat(64) },
			impactedRequestIds: ["request-1"],
			executableRequestIds: ["request-1"],
			excludedRequestIds: [],
			blockedRequestIds: [],
			unknownRequestIds: [],
			requiresConfirmationRequestIds: [],
			unresolvedDependencyRequestIds: [],
			cycleRequestIds: [],
			dependencyIds: [],
			steps: [{ stepId: "step-1", requestId: "request-1", collectionId: COLLECTION, ordinal: 0, state: "EXECUTABLE" }],
			excluded: [],
			cycles: [],
			blastRadius: { policyIdentity: "policy-1", admissionState: "ADMITTED" },
			reasonCodes: [],
			prerequisites: [],
			evidenceReferences: [],
			summary: { candidates: 1, impacted: 1, executable: 1, excluded: 0, blocked: 0, unknown: 0, requiresConfirmation: 0, unresolvedDependencies: 0, cycles: 0, dependencyEdges: 0 },
		}),
		contracts: {
			getCurrentForRequest: async () => currentContract,
			createDraftFromResponse: async (_profile, draftInput) => {
				calls.contractDraft = draftInput;
				return { contractId: "contract-1", sequence: 1 };
			},
			publish: async () => {
				currentContract = {
					contractId: "contract-1",
					sequence: 1,
					state: "PUBLISHED",
					requestId: "request-1",
					snapshotFingerprint: calls.contractDraft?.snapshotFingerprint ?? null,
				};
				return currentContract;
			},
		},
		executions: {
			send: async (_profile, input, internal) => {
				calls.sourceExecution = { input, internal };
				return {
					executionId: input.executionId,
					outcome: "response",
					response: {
						status: 200,
						headers: [{ name: "content-type", value: "application/json" }],
						body: { encoding: "text", value: '{"ok":true}', truncated: false },
					},
				};
			},
		},
		inferContract: ({ name, description }) => ({
			provenance: "inferred",
			name,
			description,
			body: { status: 200, statuses: [], headers: [], bodyType: "object", body: { type: "object", properties: {}, requiredProperties: [] } },
			warnings: [],
		}),
		newExecutionId: () => "source-execution-1",
		checkpoints: { getRun: async () => canonicalRun },
		execute: async (_profile, input) => {
			calls.execute = input;
			return {
				runId: "run-1",
				run: {
					runId: "run-1",
					runState: "COMPLETED",
					identity: {
						workspaceId: WORKSPACE,
						snapshotId: `collection:${COLLECTION}:v2`,
						snapshotFingerprint: "b".repeat(64),
						environmentId: TARGET_ENV,
						environmentFingerprint: "c".repeat(64),
						planId: "plan-1",
						planFingerprint: "plan-1",
						policyId: "policy-1",
						policyFingerprint: "e".repeat(64),
					},
					identityFingerprint: "d".repeat(64),
					completedStepIds: ["step-1"],
					pendingStepIds: [],
				},
				evidence: { executions: [], assertions: [] },
				verification: { state: "VERIFIED" },
				executedStepIds: ["step-1"],
				stepOutcomes: [],
				terminated: true,
				stopReason: "COMPLETED",
			};
		},
		proofs: {
			build: (_profile, input) => {
				calls.proof = input;
				return { proof: { proofId: "proof-1", state: "VERIFIED" } };
			},
		},
		projectImpact: (value) => value,
		projectDrift: (value) => value,
		resolveSecretAlias: () => null,
		...overrides,
	});
	return { service, calls };
}

const input = {
	collectionId: COLLECTION,
	baselineRevision: 1,
	sourceEnvironmentId: SOURCE_ENV,
	targetEnvironmentId: TARGET_ENV,
	changeIndex: 0,
	allowMutating: false,
};

describe("Phase 54 change-safety workflow", () => {
	test("analysis composes saved versions into Impact, Drift, safety policy, plan and contract status", async () => {
		const { service } = fixtureService();
		const result = await service.analyze(PROFILE, { workspaceId: WORKSPACE }, input);
		expect(result.selection.baselineRevision).toBe(1);
		expect(result.selection.currentRevision).toBe(2);
		expect(result.selectedImpact.summary.totalRequests).toBe(1);
		expect(result.drift.identical).toBe(true);
		expect(result.plan.summary.executable).toBe(1);
		expect(result.contracts).toEqual({ requests: 1, published: 0, missing: 1, boundToCurrent: 0, stale: 0, unbound: 0 });
		expect(result.canRun).toBe(true);
		expect(result.blockers).toEqual([]);
		expect(result.contractsByRequest).toBeUndefined();
		expect(result.collection).toBeUndefined();
	});

	test("normalizes workspace attribution and nested environment ids before Phase 39 analysis", async () => {
		const sharedSource = {
			...sourceEnvironment,
			ownerProfileId: "resource-owner",
			variables: [{ id: { toString: () => "variable-source" }, key: "base_url", kind: "plain", value: "https://api.example.test", enabled: true }],
		};
		const sharedTarget = {
			...targetEnvironment,
			ownerProfileId: "resource-owner",
			variables: [{ id: { toString: () => "variable-target" }, key: "base_url", kind: "plain", value: "https://api.example.test", enabled: true }],
		};
		const { service } = fixtureService({
			analyzeImpact: undefined,
			environments: {
				get: async (id) => (id === SOURCE_ENV ? sharedSource : sharedTarget),
			},
		});
		const result = await service.analyze(PROFILE, { workspaceId: WORKSPACE }, input);
		expect(result.selectedImpact.summary.totalRequests).toBe(1);
		expect(result.blockers.map((item) => item.code)).not.toContain("NO_AFFECTED_REQUESTS");
	});

	test("generates a published contract from a real source-environment response and binds it by snapshot fingerprint", async () => {
		const { service, calls } = fixtureService();
		const result = await service.generateContracts(PROFILE, { workspaceId: WORKSPACE }, input);
		expect(result.generated).toHaveLength(1);
		expect(result.generated[0].requestId).toBe("request-1");
		expect(calls.sourceExecution.internal.workspaceId).toBe(WORKSPACE);
		expect(calls.sourceExecution.input.context.environmentId).toBe(SOURCE_ENV);
		expect(calls.contractDraft.snapshotId).toBeUndefined();
		expect(calls.contractDraft.snapshotFingerprint).toBe("b".repeat(64));
		expect(result.analysis.contracts.boundToCurrent).toBe(1);
		expect(result.analysis.contracts.missing).toBe(0);
	});

	test("run sends the backend-produced plan/evidence into rehearsal and proof generation", async () => {
		const { service, calls } = fixtureService();
		const result = await service.run(PROFILE, { workspaceId: WORKSPACE }, input);
		expect(calls.execute.plan.identity.planFingerprint).toBe("plan-1");
		expect(calls.execute.context.workspaceId).toBe(WORKSPACE);
		expect(calls.execute.verification.source.snapshotFingerprint).toBe("a".repeat(64));
		expect(calls.execute.verification.target.snapshotFingerprint).toBe("b".repeat(64));
		expect(calls.proof.plan.identity.planFingerprint).toBe("plan-1");
		expect(calls.proof.execution.stopReason).toBe("COMPLETED");
		expect(result.proof).toEqual({ proofId: "proof-1", state: "VERIFIED" });
	});

	test("hands the proof builder the canonical 46B run, not the flattened presentation", async () => {
		const { service, calls } = fixtureService();
		await service.run(PROFILE, { workspaceId: WORKSPACE }, input);
		// The executor report's `run` is the Phase 46B presentation (flat identity):
		// the proof builder cannot validate it.
		expect(() => parseRunIdentity(calls.proof.execution.run.identity)).toThrow();
		// Phase 54 must reload the run from the core that owns it and forward the
		// canonical, nested identity instead.
		expect(calls.proof.run).toEqual({ ...canonicalRun, pendingStepIds: [] });
		expect(() => parseRunIdentity(calls.proof.run.identity)).not.toThrow();
		expect(calls.proof.run.identity.targetEnvironment.environmentId).toBe(TARGET_ENV);
	});

	test("fails closed when the rehearsal run cannot be reloaded for the proof", async () => {
		const { service } = fixtureService({ checkpoints: { getRun: async () => null } });
		expect(service.run(PROFILE, { workspaceId: WORKSPACE }, input)).rejects.toMatchObject({
			code: "CHANGE_SAFETY_REHEARSAL_RUN_MISSING",
		});
	});

	test("identical revisions fail closed instead of fabricating a rehearsal", async () => {
		const { service } = fixtureService({
			versions: {
				get: async () => ({ revision: 1, fingerprint: "a".repeat(64), snapshot: baselineSnapshot }),
				compare: async () => ({ identical: true, truncated: false, changes: [] }),
			},
			analyzeImpact: () => ({ schemaVersion: 1, kind: "tracer.change-impact.diff", changeCount: 0, changes: [] }),
		});
		const result = await service.analyze(PROFILE, { workspaceId: WORKSPACE }, { ...input, baselineRevision: 1 });
		expect(result.canRun).toBe(false);
		expect(result.blockers.map((item) => item.code)).toContain("NO_SAVED_CHANGE");
	});

	test("source and target environment must be different", async () => {
		const { service } = fixtureService();
		expect(service.analyze(PROFILE, { workspaceId: WORKSPACE }, { ...input, targetEnvironmentId: SOURCE_ENV })).rejects.toMatchObject({
			code: "CHANGE_SAFETY_ENVIRONMENTS_MATCH",
		});
	});

	test("binds both rehearsal-plan sides to the frozen snapshot, not the diff baseline", async () => {
		let planInput = null;
		const { service } = fixtureService({
			plan: (raw) => {
				planInput = raw;
				return {
					kind: "tracer.rehearsal-plan",
					schemaVersion: 1,
					state: "READY",
					identity: { planFingerprint: "plan-1", fingerprintKeyId: "key-1" },
					workspace: { workspaceId: WORKSPACE },
					snapshot: { snapshotId: raw.snapshot.snapshotId, snapshotFingerprint: raw.snapshot.snapshotFingerprint },
					source: { environmentId: raw.source.environmentId, snapshotFingerprint: raw.source.snapshotFingerprint },
					target: { environmentId: raw.target.environmentId, snapshotFingerprint: raw.target.snapshotFingerprint },
					steps: [{ stepId: "step-1", requestId: "request-1", collectionId: COLLECTION, ordinal: 0, state: "EXECUTABLE" }],
					summary: { candidates: 1, impacted: 1, executable: 1 },
				};
			},
		});
		const result = await service.analyze(PROFILE, { workspaceId: WORKSPACE }, input);
		// The plan is bound to the current saved revision...
		expect(planInput.snapshot.snapshotFingerprint).toBe("b".repeat(64));
		expect(planInput.snapshot.snapshotId).toBe(`collection:${COLLECTION}:v2`);
		// ...and both sides describe that SAME frozen rehearsal snapshot. A source
		// side bound to the historical baseline is the exact Phase 46
		// SNAPSHOT_STALE failure this composition must prevent.
		expect(planInput.source.snapshotFingerprint).toBe(planInput.snapshot.snapshotFingerprint);
		expect(planInput.source.snapshotId).toBe(planInput.snapshot.snapshotId);
		expect(planInput.target.snapshotFingerprint).toBe(planInput.snapshot.snapshotFingerprint);
		expect(planInput.target.snapshotId).toBe(planInput.snapshot.snapshotId);
		// The historical baseline is still carried for the diff and Phase 41 evidence.
		expect(result.baselineSnapshot.snapshotFingerprint).toBe("a".repeat(64));
		expect(result.snapshot.snapshotFingerprint).toBe("b".repeat(64));
	});

	test("composes a plan the real Phase 46 planner accepts without SNAPSHOT_STALE", async () => {
		const { service } = fixtureService({ plan: planRehearsal });
		const result = await service.analyze(PROFILE, { workspaceId: WORKSPACE }, input);
		expect(result.plan).not.toBeNull();
		expect(result.plan.kind).toBe("tracer.rehearsal-plan");
		expect(result.plan.snapshot.snapshotFingerprint).toBe("b".repeat(64));
		expect(result.plan.source.snapshotFingerprint).toBe(result.plan.snapshot.snapshotFingerprint);
		expect(result.plan.target.snapshotFingerprint).toBe(result.plan.snapshot.snapshotFingerprint);
	});
});
