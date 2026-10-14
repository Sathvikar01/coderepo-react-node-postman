// Phase 35 — Investigation Engine orchestration (Workflow 5).
//
// One investigation run orchestrates the merged Phase 31-34 modules and answers:
//   when did it start failing (Phase 33 regression boundary),
//   what changed (Phase 31/27 delta + comparison),
//   what is the experimentally verified cause (Phase 31 counterfactual proof),
//   what is the smallest reproducer (Phase 32 failure minimization),
//   is it reliable (Phase 34 reproduction series),
//   and here is a safe reproduction capsule (existing ReproCapsuleV1).
//
// There is no second execution engine and no AI inference: every probe runs the
// normal compiler/policy/DNS/transport/capture/normalize path and every
// conclusion is a deterministic restatement of recorded evidence. Unsafe
// mutating requests are never silently executed - those stages degrade to
// explicit `not_replayable` / `skipped` results.
import { randomUUID } from "node:crypto";
import { AppError } from "../../../shared/errors/app-error.js";
import { getConfig } from "../../../shared/config/index.js";
import { historyService } from "../../history/history.service.js";
import { executionService } from "../../executions/execution.service.js";
import { mockService } from "../../mocks/mock.service.js";
import { buildReproCapsule, failurePredicateForRecord, sanitizeCapsuleRequest, serializeReproCapsule } from "../repro-capsule.js";
import { computeCounterfactualDeltas } from "../counterfactual/counterfactual-deltas.js";
import { isSafeMethod } from "../counterfactual/counterfactual-model.js";
import { minimizeFailure } from "../failure-minimizer.js";
import { runReproductionSeries } from "../reproducibility/reproduction-series.js";
import { executionIntelligenceService } from "../execution-intelligence.service.js";
import { counterfactualService } from "../counterfactual/counterfactual.service.js";
import { regressionService } from "../regression/regression.service.js";
import { investigationRepository } from "./investigation.repository.js";
import { buildInvestigationV1, scrubSecrets } from "./investigation.js";
import { parseInvestigationInput } from "./investigation-model.js";

function publicError(error) {
	if (!(error instanceof AppError)) return { code: "INVESTIGATION_FAILED", message: "The investigation failed unexpectedly." };
	return { code: error.code, message: error.message };
}

function isCancellation(error) {
	return (
		error instanceof AppError &&
		["INVESTIGATION_CANCELLED", "MINIMIZATION_CANCELLED", "COUNTERFACTUAL_CANCELLED", "REPRODUCTION_CANCELLED"].includes(error.code)
	);
}

function cancelledSection(section) {
	return { ...section, status: "cancelled", reason: "cancelled", error: { code: "INVESTIGATION_CANCELLED", message: "The investigation was cancelled." } };
}

function serializeRecord(entry) {
	return {
		schemaVersion: 1,
		kind: "tracer.investigation",
		investigationId: entry.investigationId,
		status: entry.status,
		stage: entry.stage,
		failingExecutionId: entry.failingExecutionId,
		result: entry.result ?? null,
		error: entry.error ?? null,
		startedAt: entry.startedAt ?? null,
		finishedAt: entry.finishedAt ?? null,
		expiresAt: entry.expiresAt ?? null,
	};
}

/**
 * Whether this investigation may actually dispatch probes. Unsafe mutating
 * requests are restricted to mocked targets or explicitly confirmed approved
 * local targets - exactly the Phase 31/34 rule, applied up front so those
 * stages can degrade truthfully instead of throwing.
 */
export function probePermission(record, input) {
	const method = String(record?.request?.method ?? "GET").toUpperCase();
	if (isSafeMethod(method)) return { allowed: true };
	if (input.targetMode === "mock") return { allowed: true };
	if (record?.receipt?.policy?.local === true && input.allowUnsafeLocal && input.allowUnsafeConfirm) return { allowed: true };
	return {
		allowed: false,
		reason: "unsafe_mutating_request_not_replayed_without_explicit_approved_local_confirmation",
	};
}

function counterfactualProbeIds(result) {
	const ids = [];
	for (const probe of result?.baseline?.probes?.good ?? []) if (probe?.probeExecutionId) ids.push(probe.probeExecutionId);
	for (const probe of result?.baseline?.probes?.failing ?? []) if (probe?.probeExecutionId) ids.push(probe.probeExecutionId);
	for (const item of result?.interventions ?? []) {
		if (item?.evidence?.applied?.probeExecutionId) ids.push(item.evidence.applied.probeExecutionId);
		if (item?.evidence?.reverted?.probeExecutionId) ids.push(item.evidence.reverted.probeExecutionId);
	}
	return ids;
}

/**
 * When the counterfactual engine refuses to probe (unsafe mutating request),
 * the changed inputs are still listed truthfully: same deterministic delta
 * computation, classified `not_replayable` with zero probes and zero claims.
 */
function fallbackInterventions({ baseRecord, candidateRecord, reason, classification = "not_replayable" }) {
	const deltas = computeCounterfactualDeltas({
		baseRequest: baseRecord?.request ?? null,
		candidateRequest: candidateRecord?.request ?? null,
		baseReceipt: baseRecord?.receipt ?? null,
		candidateReceipt: candidateRecord?.receipt ?? null,
	});
	return {
		available: true,
		status: classification,
		reason,
		probeBudget: 0,
		probesUsed: 0,
		budgetExhausted: false,
		probeExecutionIds: [],
		items: deltas.map((delta) => ({
			schemaVersion: 1,
			kind: "tracer.counterfactual-intervention",
			delta: {
				id: delta.id,
				path: delta.path,
				kind: delta.kind,
				replayable: delta.replayable === true,
				before: delta.displayBefore ?? null,
				after: delta.displayAfter ?? null,
			},
			classification,
			reason: delta.reason ?? reason,
			evidence: { applied: null, reverted: null },
		})),
	};
}

export function createInvestigationService({
	repository = investigationRepository,
	history = historyService,
	executions = executionService,
	mocks = mockService,
	regression = regressionService,
	intelligence = executionIntelligenceService,
	counterfactual = counterfactualService,
	minimize = minimizeFailure,
	reproduce = runReproductionSeries,
} = {}) {
	// In-flight runs of THIS service instance. A fresh instance (for example a
	// restarted server) has no entry here, so `status` can detect orphaned runs.
	const ACTIVE = new Map();

	async function loadRecordOrFail(profileId, executionId, code) {
		const record = await history.get(profileId, executionId);
		if (!record || record.expired || record.visible === false) {
			throw new AppError(404, code, "The history record was not found.");
		}
		return record;
	}

	function makeProbe(profileId, sourceRecord, input, signal, collector) {
		let attempt = 0;
		return async (candidate) => {
			attempt += 1;
			if (signal.aborted) throw new AppError(409, "INVESTIGATION_CANCELLED", "The investigation was cancelled.");
			const executionId = randomUUID();
			let result;
			if (input.targetMode === "mock") {
				const resolved = await mocks.resolve(profileId, {
					request: candidate,
					environmentId: sourceRecord.context?.environment?.environmentId ?? null,
					executionId,
				});
				result = resolved?.result ?? resolved;
			} else {
				result = await executions.send(
					profileId,
					{
						executionId,
						tabId: `investigation:${attempt}`,
						draftVersion: attempt,
						request: candidate,
						context: {
							replayHistoryId: sourceRecord.executionId,
							environmentId: sourceRecord.context?.environment?.environmentId ?? null,
							environmentRevision: sourceRecord.context?.environment?.environmentRevision ?? null,
						},
					},
					{ rateLimit: false, visible: false, signal },
				);
			}
			const value = result && result.executionId ? result : { ...result, executionId };
			collector.push(value.executionId);
			return value;
		};
	}

	async function run(profileId, entry, failingRecord, input) {
		const controller = new AbortController();
		ACTIVE.set(entry.investigationId, controller);
		const stageOutputs = { completed: ["preparing"], interruptedAt: null };
		const stages = {
			regression: null,
			comparison: null,
			counterfactual: null,
			minimization: null,
			reproducibility: null,
			capsule: null,
		};
		let goodRecord = null;
		let goodExecutionId = null;

		const beginStage = async (stage) => {
			stageOutputs.interruptedAt = stage;
			await repository.update(profileId, entry.investigationId, { stage });
			if (controller.signal.aborted) throw new AppError(409, "INVESTIGATION_CANCELLED", "The investigation was cancelled.");
		};
		const endStage = (stage) => {
			stageOutputs.completed.push(stage);
			stageOutputs.interruptedAt = null;
		};

		let finalStatus = "completed";
		let finalError = null;
		let rawMinimizedRequest = null;
		let sanitizedMinimizedRequest = null;
		let probeSecrets = [];

		try {
			const predicate = input.predicate ?? failurePredicateForRecord(failingRecord);
			probeSecrets = [...sanitizeCapsuleRequest(failingRecord.request ?? {}).state.secrets];

			// ── 1. regression boundary — when did it start failing? (Phase 33) ──
			await beginStage("regression_boundary");
			let timeline = null;
			try {
				timeline = await regression.buildTimeline(profileId, failingRecord.executionId, { predicate });
			} catch (error) {
				timeline = { unresolved: { reason: error.code ?? "TIMELINE_UNAVAILABLE", message: error.message ?? "The regression boundary could not be computed." } };
			}
			if (input.goodExecutionId) {
				goodExecutionId = input.goodExecutionId;
				goodRecord = await loadRecordOrFail(profileId, input.goodExecutionId, "INVESTIGATION_BASELINE_NOT_FOUND");
				probeSecrets = [...probeSecrets, ...sanitizeCapsuleRequest(goodRecord.request ?? {}).state.secrets];
				stages.regression = { source: "provided", timeline };
			} else if (timeline?.boundary?.lastKnownGoodExecutionId) {
				goodExecutionId = timeline.boundary.lastKnownGoodExecutionId;
				goodRecord = await history.get(profileId, goodExecutionId);
				stages.regression = { source: "phase33", timeline };
			} else {
				stages.regression = {
					source: "none",
					timeline,
					unavailableReason: timeline?.unresolved?.reason ? `no_good_execution_${timeline.unresolved.reason.toLowerCase()}` : "no_good_execution",
				};
			}
			endStage("regression_boundary");

			// ── 2. comparison — what changed? (Phase 27 deterministic comparison) ──
			await beginStage("comparison");
			if (goodRecord) {
				try {
					stages.comparison = await intelligence.compare(profileId, goodExecutionId, failingRecord.executionId);
				} catch (error) {
					stages.comparison = null;
					stages.regression = { ...stages.regression, unavailableReason: `comparison_${(error.code ?? "unavailable").toLowerCase()}` };
				}
			}
			endStage("comparison");

			// ── 3. counterfactual — experimentally verified cause? (Phase 31) ──
			await beginStage("counterfactual");
			if (goodRecord) {
				try {
					const result = await counterfactual.analyze(
						profileId,
						{
							baseExecutionId: goodExecutionId,
							candidateExecutionId: failingRecord.executionId,
							predicate,
							targetMode: input.targetMode,
							allowUnsafeLocal: input.allowUnsafeLocal,
							allowUnsafeConfirm: input.allowUnsafeConfirm,
							maxProbes: input.probeBudget,
						},
						{ signal: controller.signal },
					);
					stages.counterfactual = {
						available: true,
						status: result.status,
						reason: result.reason ?? null,
						probeBudget: result.probeBudget,
						probesUsed: result.probesUsed,
						budgetExhausted: result.budgetExhausted,
						items: result.interventions ?? [],
						probeExecutionIds: counterfactualProbeIds(result),
					};
				} catch (error) {
					if (isCancellation(error)) {
						stages.counterfactual = {
							available: true,
							status: "cancelled",
							reason: "cancelled",
							probeBudget: null,
							probesUsed: null,
							budgetExhausted: null,
							items: [],
							probeExecutionIds: [],
						};
						throw error;
					}
					if (error instanceof AppError && ["COUNTERFACTUAL_UNSAFE_METHOD", "COUNTERFACTUAL_CONFIRMATION_REQUIRED", "COUNTERFACTUAL_INPUT", "COUNTERFACTUAL_BUDGET"].includes(error.code)) {
						// Refused before (or during) probing: truthfully report the changed
						// inputs without claiming any cause and without inventing probes.
						const refused =
							error.code === "COUNTERFACTUAL_UNSAFE_METHOD" || error.code === "COUNTERFACTUAL_CONFIRMATION_REQUIRED";
						stages.counterfactual = fallbackInterventions({
							baseRecord: goodRecord,
							candidateRecord: failingRecord,
							classification: refused ? "not_replayable" : "inconclusive",
							reason: refused
								? "unsafe_mutating_request_not_replayed"
								: error.code === "COUNTERFACTUAL_BUDGET"
									? "probe_budget_exhausted"
									: "counterfactual_input_invalid",
						});
					} else {
						stages.counterfactual = {
							available: true,
							status: "failed",
							reason: error.code ?? "COUNTERFACTUAL_FAILED",
							probeBudget: null,
							probesUsed: null,
							budgetExhausted: null,
							items: [],
							probeExecutionIds: [],
						};
					}
				}
			}
			endStage("counterfactual");

			// ── 4. minimization — the smallest reproducer (Phase 32) ──
			await beginStage("minimization");
			const permission = probePermission(failingRecord, input);
			if (permission.allowed) {
				const minimizationProbeIds = [];
				const probe = makeProbe(profileId, failingRecord, input, controller.signal, minimizationProbeIds);
				try {
					const result = await minimize({
						request: failingRecord.request,
						predicate,
						probe,
						signal: controller.signal,
						maxProbes: input.minimizationProbes ?? 12,
					});
					rawMinimizedRequest = result.request;
					sanitizedMinimizedRequest = sanitizeCapsuleRequest(result.request).request;
					stages.minimization = {
						status: "completed",
						reason: null,
						minimality: result.minimality,
						budgetExhausted: result.budgetExhausted,
						probesUsed: result.probesUsed,
						probeBudget: result.probeBudget,
						originalComponentCount: result.originalComponentCount,
						remainingComponentCount: result.remainingComponentCount,
						removed: result.removed ?? [],
						probeTrace: result.probeTrace ?? [],
						request: sanitizedMinimizedRequest,
						error: null,
						executionIds: minimizationProbeIds,
					};
				} catch (error) {
					if (isCancellation(error)) {
						stages.minimization = cancelledSection({
							minimality: null,
							budgetExhausted: null,
							probesUsed: minimizationProbeIds.length,
							probeBudget: input.minimizationProbes ?? 12,
							originalComponentCount: null,
							remainingComponentCount: null,
							removed: [],
							probeTrace: [],
							request: null,
							error: null,
							executionIds: minimizationProbeIds,
						});
						throw error;
					}
					stages.minimization = {
						status: "failed",
						reason: error.message ?? null,
						minimality: null,
						budgetExhausted: null,
						probesUsed: minimizationProbeIds.length,
						probeBudget: input.minimizationProbes ?? 12,
						originalComponentCount: null,
						remainingComponentCount: null,
						removed: [],
						probeTrace: [],
						request: null,
						error: publicError(error),
						executionIds: minimizationProbeIds,
					};
				}
			} else {
				stages.minimization = {
					status: "skipped",
					reason: permission.reason,
					minimality: null,
					budgetExhausted: null,
					probesUsed: 0,
					probeBudget: input.minimizationProbes ?? 12,
					originalComponentCount: null,
					remainingComponentCount: null,
					removed: [],
					probeTrace: [],
					request: null,
					error: null,
					executionIds: [],
				};
			}
			endStage("minimization");

			// ── 5. reproducibility — does the reproducer reproduce? (Phase 34) ──
			await beginStage("reproducibility");
			if (permission.allowed) {
				const reproProbeIds = [];
				const probe = makeProbe(profileId, failingRecord, input, controller.signal, reproProbeIds);
				const appliedTo = rawMinimizedRequest ? "minimized" : "failing";
				let series;
				try {
					series = await reproduce({
						request: rawMinimizedRequest ?? failingRecord.request,
						predicate,
						probe,
						probeCount: input.reproductionProbes ?? 3,
						signal: controller.signal,
					});
				} catch (error) {
					if (isCancellation(error)) {
						stages.reproducibility = cancelledSection({
							appliedTo,
							classification: null,
							statement: null,
							plannedProbes: input.reproductionProbes ?? 3,
							attempts: 0,
							matches: 0,
							probes: [],
							error: null,
							executionIds: reproProbeIds,
						});
						throw error;
					}
					throw error;
				}
				if (series.status === "cancelled") {
					stages.reproducibility = cancelledSection({
						appliedTo,
						classification: null,
						statement: null,
						plannedProbes: series.plannedProbes ?? input.reproductionProbes ?? 3,
						attempts: series.attempts ?? 0,
						matches: series.matches ?? 0,
						probes: (series.probes ?? []).map((probeEntry) => ({
							index: probeEntry.index,
							probeExecutionId: probeEntry.executionId ?? null,
							outcome: probeEntry.outcome ?? null,
							responseStatus: probeEntry.responseStatus ?? null,
							predicateMatched: Boolean(probeEntry.predicateMatched),
						})),
						error: null,
						executionIds: reproProbeIds,
					});
					throw new AppError(409, "INVESTIGATION_CANCELLED", "The investigation was cancelled.");
				}
				stages.reproducibility = {
					status: series.status,
					reason: series.error?.code ?? null,
					appliedTo,
					classification: series.classification ?? null,
					statement: series.statement ?? null,
					plannedProbes: series.plannedProbes ?? null,
					attempts: series.attempts ?? 0,
					matches: series.matches ?? 0,
					probes: (series.probes ?? []).map((probeEntry) => ({
						index: probeEntry.index,
						probeExecutionId: probeEntry.executionId ?? null,
						outcome: probeEntry.outcome ?? null,
						responseStatus: probeEntry.responseStatus ?? null,
						predicateMatched: Boolean(probeEntry.predicateMatched),
					})),
					error: series.error ? { code: series.error.code, message: series.error.message } : null,
					executionIds: reproProbeIds,
				};
			} else {
				stages.reproducibility = {
					status: "skipped",
					reason: permission.reason,
					appliedTo: null,
					classification: null,
					statement: null,
					plannedProbes: input.reproductionProbes ?? 3,
					attempts: 0,
					matches: 0,
					probes: [],
					error: null,
					executionIds: [],
				};
			}
			endStage("reproducibility");

			// ── 6. reproduction capsule — a safe, importable reproducer ─────────
			await beginStage("capsule");
			try {
				const capsuleRecord = {
					...failingRecord,
					request: sanitizedMinimizedRequest ?? sanitizeCapsuleRequest(failingRecord.request ?? {}).request,
				};
				const capsule = buildReproCapsule(capsuleRecord, { includeResponseBody: true });
				stages.capsule = {
					text: serializeReproCapsule(capsule),
					filename: `investigation-${entry.investigationId.slice(0, 8)}.repro.json`,
					requestSource: sanitizedMinimizedRequest ? "minimized" : "failing",
					requiredInputs: capsule.requiredInputs ?? [],
				};
			} catch (error) {
				stages.capsule = null;
				stages.capsuleError = error instanceof AppError ? error.code : "CAPSULE_UNAVAILABLE";
			}
			endStage("capsule");
		} catch (error) {
			if (controller.signal.aborted || isCancellation(error)) {
				finalStatus = "cancelled";
				finalError = { code: "INVESTIGATION_CANCELLED", message: "The investigation was cancelled." };
			} else {
				finalStatus = "failed";
				finalError = publicError(error);
			}
		}

		// Assemble and persist one coherent InvestigationV1 - including for
		// cancelled and failed runs, where the completed stages remain
		// evidence-linked and later stages degrade truthfully. The run must stay
		// in ACTIVE until this final write lands: `status` treats a `running`
		// record with no ACTIVE entry as a restarted server, so deleting too early
		// made a just-completed investigation intermittently read as interrupted
		// with a null result. Persist the result and clear ACTIVE atomically.
		try {
			let result = null;
			try {
				result = buildInvestigationV1({
					investigationId: entry.investigationId,
					failingExecutionId: failingRecord.executionId,
					goodExecutionId,
					predicate: input.predicate ?? failurePredicateForRecord(failingRecord),
					targetMode: input.targetMode,
					status: finalStatus,
					error: finalError,
					regression: stages.regression ?? { source: "none", timeline: null, unavailableReason: "not_reached" },
					comparison: stages.comparison ?? null,
					counterfactual: stages.counterfactual ?? null,
					minimization: stages.minimization ?? null,
					reproducibility: stages.reproducibility ?? null,
					capsule: stages.capsule ?? null,
					stageOutputs,
				});
				result = scrubSecrets(result, probeSecrets);
			} catch {
				result = null;
				if (finalStatus === "completed") {
					finalStatus = "failed";
					finalError = { code: "INVESTIGATION_INVALID", message: "The investigation result failed strict schema validation." };
				}
			}

			return await repository.update(profileId, entry.investigationId, {
				status: finalStatus,
				result,
				error: finalError,
				stage: finalStatus === "completed" ? "capsule" : stageOutputs.interruptedAt ?? "capsule",
				finishedAt: new Date(),
			});
		} finally {
			ACTIVE.delete(entry.investigationId);
		}
	}

	async function start(profileId, input) {
		const parsed = parseInvestigationInput(input);
		const failingRecord = await loadRecordOrFail(profileId, parsed.failingExecutionId, "INVESTIGATION_TARGET_NOT_FOUND");
		if (parsed.goodExecutionId) await loadRecordOrFail(profileId, parsed.goodExecutionId, "INVESTIGATION_BASELINE_NOT_FOUND");

		const now = new Date();
		const created = await repository.create({
			ownerProfileId: profileId,
			investigationId: randomUUID(),
			schemaVersion: 1,
			kind: "tracer.investigation",
			failingExecutionId: parsed.failingExecutionId,
			status: "running",
			stage: "preparing",
			result: null,
			error: null,
			startedAt: now,
			finishedAt: null,
			expiresAt: new Date(now.getTime() + getConfig().execution.retentionDays * 24 * 60 * 60 * 1000),
		});
		run(profileId, created, failingRecord, parsed).catch(() => undefined);
		return serializeRecord(created);
	}

	async function status(profileId, investigationId) {
		const entry = await repository.get(profileId, investigationId);
		if (!entry) throw new AppError(404, "INVESTIGATION_NOT_FOUND", "The investigation was not found.");
		if (entry.status === "running" && !ACTIVE.has(entry.investigationId)) {
			return repository
				.update(profileId, entry.investigationId, {
					status: "failed",
					error: { code: "INVESTIGATION_INTERRUPTED", message: "The server restarted before the investigation completed." },
					finishedAt: new Date(),
				})
				.then(serializeRecord);
		}
		return serializeRecord(entry);
	}

	async function wait(profileId, investigationId) {
		const startedAt = Date.now();
		while (Date.now() - startedAt < 3000) {
			const entry = await repository.get(profileId, investigationId);
			if (entry && entry.status !== "running") return serializeRecord(entry);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const entry = await repository.get(profileId, investigationId);
		if (!entry) throw new AppError(404, "INVESTIGATION_NOT_FOUND", "The investigation was not found.");
		return serializeRecord(entry);
	}

	async function cancel(profileId, investigationId) {
		const entry = await repository.get(profileId, investigationId);
		if (!entry) throw new AppError(404, "INVESTIGATION_NOT_FOUND", "The investigation was not found.");
		if (entry.status === "running" && ACTIVE.has(entry.investigationId)) {
			ACTIVE.get(entry.investigationId).abort();
			return wait(profileId, investigationId);
		}
		return serializeRecord(entry);
	}

	async function exportCapsule(profileId, investigationId) {
		const entry = await repository.get(profileId, investigationId);
		if (!entry) throw new AppError(404, "INVESTIGATION_NOT_FOUND", "The investigation was not found.");
		const capsule = entry.result?.reproductionCapsule;
		if (!capsule?.available || !capsule.text) {
			throw new AppError(409, "CAPSULE_UNAVAILABLE", "No reproduction capsule is available for this investigation.");
		}
		return { filename: capsule.filename, text: capsule.text };
	}

	return { start, status, wait, cancel, exportCapsule, probePermission };
}

export const investigationService = createInvestigationService();
