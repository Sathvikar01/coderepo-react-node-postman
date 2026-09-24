import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.js";
import { executionService } from "../executions/execution.service.js";
import {
	REASON_CODES as CHECKPOINT_REASON_CODES,
	STEP_STATES,
	TERMINAL_RUN_STATES,
	createRehearsalCheckpointService,
	presentRun,
} from "../rehearsal-checkpoints/index.js";
import { evaluateAbort } from "../blast-radius-policy/index.js";
import { compareContractToResponse } from "../contract-compatibility/index.js";
import { verifyCrossEnvironment } from "../cross-env-verification/index.js";
import {
	CONTRACT_STATUS,
	EXECUTOR_ERROR_CODES,
	EXECUTOR_LIMITS,
	EXECUTOR_STOP_REASONS,
	REHEARSAL_EXECUTION_KIND,
	REHEARSAL_EXECUTION_SCHEMA_VERSION,
	parseExecutorInput,
} from "./executor-schema.js";
import { deriveRunBinding } from "./step-plan.js";
import {
	buildContractAssertion,
	buildOutcomeId,
	buildStepMetadata,
	classifyExecution,
	isKnownOutcome,
	mapAbortReasonCode,
	toObservedResponse,
} from "./outcome-mapping.js";
import { buildExecutionEvidence, createEvidenceRecorder } from "./evidence-recorder.js";

// Phase 46C — Checkpointed rehearsal executor (orchestrator).
//
// The executor is the *conductor*, not a second runner. It:
//
//   1. accepts the exact Phase 46A plan and the Phase 45A envelope it was built
//      against,
//   2. creates or resumes the matching Phase 46B checkpoint run,
//   3. claims the current checkpoint generation (so a stale worker cannot
//      checkpoint),
//   4. dispatches only eligible plan steps through the existing execution path
//      (`executionService.send`) — one ordinary execution per step,
//   5. checkpoints after every step and never re-executes a completed step,
//   6. evaluates the Phase 45A abort policy after every result and stops
//      immediately on ABORT,
//   7. runs Phase 43 contract compatibility on observed responses,
//   8. records bounded, redacted evidence and projects it for Phase 41.
//
// It deliberately owns no transport, no run variables, and no persistence of its
// own: history and checkpoints are the existing stores, and Phase 13 owns
// collection-run variable semantics. Nothing here invents success.

const DEFAULTS = Object.freeze({
	label: "rehearsal-execution",
});

// Derive the trailing failure progress from a resumed run's persisted step
// metadata, so abort limits are computed from what actually happened rather than
// reset to zero on resume. Completed steps always form a prefix because the
// executor checkpoints in plan order.
function derivePriorProgress(run) {
	let totalCompleted = 0;
	let failureCount = 0;
	let consecutiveFailureCount = 0;

	for (const step of run.plan.steps) {
		const entry = run.stepStates.find((candidate) => candidate.stepId === step.stepId);
		if (!entry || (entry.state !== STEP_STATES.COMPLETED && entry.state !== STEP_STATES.SKIPPED)) break;
		totalCompleted += 1;
		const metadata = entry.completion?.metadata ?? {};
		const failed =
			entry.state === STEP_STATES.SKIPPED ||
			metadata.outcome !== "response" ||
			(Number.isInteger(metadata.httpStatus) && metadata.httpStatus >= 400);
		if (failed) {
			failureCount += 1;
			consecutiveFailureCount += 1;
		} else {
			consecutiveFailureCount = 0;
		}
	}

	return { totalCompleted, failureCount, consecutiveFailureCount };
}

function resolveContractFor(step, input) {
	if (typeof input.resolveContract === "function") {
		const resolved = input.resolveContract(step);
		if (resolved) return resolved;
	}
	const contracts = input.contracts;
	if (!contracts) return null;
	if (contracts instanceof Map) return contracts.get(step.requestId) ?? null;
	if (Array.isArray(contracts)) return contracts.find((contract) => contract?.requestId === step.requestId) ?? null;
	if (typeof contracts === "object") return contracts[step.requestId] ?? null;
	return null;
}

function sideIdentityOf(identity) {
	const side = {};
	for (const [key, value] of Object.entries(identity)) {
		if (value !== undefined && value !== null) side[key] = value;
	}
	return side;
}

// Map an execution-path throw to a checkpoint terminal reason. The persisted
// reason is always a machine token, never a message, so no upstream detail can
// leak into the checkpoint.
function failureReasonFor(error) {
	const code = error?.code ?? null;
	if (code === "COLLECTION_NOT_FOUND" || code === "REQUEST_NOT_FOUND" || code === "CONTEXT_CHANGED" || code === "CONTEXT_CONFLICT") {
		return CHECKPOINT_REASON_CODES.PLAN_INCOMPLETE;
	}
	return CHECKPOINT_REASON_CODES.INTERNAL_ERROR;
}

export function createRehearsalExecutor({
	checkpoints = createRehearsalCheckpointService(),
	executions = { send: (...args) => executionService.send(...args) },
	contractCompatibility = { compare: compareContractToResponse },
	verify = verifyCrossEnvironment,
	abortEvaluator = evaluateAbort,
	now = () => new Date(),
	newExecutionId = () => randomUUID(),
	newOwner = () => `exec-${randomUUID()}`,
} = {}) {
	async function dispatchStep(profileId, binding, step, runId, input) {
		const context = { environmentId: binding.targetEnvironmentId };
		let request;

		if (step.collectionId) {
			// A saved request: the collection is the source of truth, resolved by the
			// execution path itself. The executor does not duplicate request lookup.
			context.collectionId = step.collectionId;
			context.requestId = step.requestId;
		} else {
			// A scratch request: there is no collection to resolve against, so the
			// caller must supply the exact request. Absence fails closed.
			if (typeof input.resolveRequest !== "function") {
				return { kind: "refused", code: EXECUTOR_ERROR_CODES.REQUEST_UNRESOLVED };
			}
			request = await input.resolveRequest(step);
			if (!request || typeof request !== "object") {
				return { kind: "refused", code: EXECUTOR_ERROR_CODES.REQUEST_UNRESOLVED };
			}
		}

		const executionId = newExecutionId();
		const result = await executions.send(
			profileId,
			{
				executionId,
				tabId: `rehearsal:${runId}`,
				draftVersion: null,
				request,
				context,
			},
			{ rateLimit: false },
		);
		return { kind: "result", result, executionId };
	}

	async function compareStepContract(step, result, executionId, binding, input, profileId) {
		const contract = resolveContractFor(step, input);
		if (!contract) return { status: CONTRACT_STATUS.ABSENT, compatibility: null, assertion: null };

		const projected = toObservedResponse(result, {
			requestId: step.requestId,
			collectionId: step.collectionId ?? null,
			workspaceId: binding.workspaceId,
			snapshotId: binding.snapshotId,
			snapshotFingerprint: binding.snapshotFingerprint,
			profileId,
			executionId,
		});
		if (projected.status !== CONTRACT_STATUS.COMPARED) {
			return { status: projected.status, compatibility: null, assertion: null };
		}

		try {
			const compatibility = contractCompatibility.compare({ contract, response: projected.response });
			const assertion = buildContractAssertion({
				executionId,
				requestId: step.requestId,
				collectionId: step.collectionId ?? null,
				snapshotId: binding.snapshotId,
				snapshotFingerprint: binding.snapshotFingerprint,
				environmentId: binding.targetEnvironmentId,
				ownerProfileId: profileId,
				compatible: compatibility.compatible,
				observedAt: now().toISOString(),
			});
			return { status: CONTRACT_STATUS.COMPARED, compatibility, assertion };
		} catch (error) {
			// A contract that cannot be compared (unpublished, identity mismatch,
			// malformed) produces no assertion. Missing evidence must never become a
			// fabricated pass, so the comparison is simply absent.
			return { status: CONTRACT_STATUS.NOT_COMPARABLE, compatibility: null, assertion: null, errorCode: error?.code ?? null };
		}
	}

	function projectVerification(input, binding, profileId, evidence) {
		if (!input.verification) return null;
		const supplied = input.verification;
		const target = supplied.target ?? sideIdentityOf({
			workspaceId: binding.workspaceId,
			snapshotId: binding.snapshotId,
			snapshotFingerprint: binding.snapshotFingerprint,
			environmentId: binding.targetEnvironmentId,
			environmentName: input.environment.environmentName,
		});

		const verificationInput = {
			target,
			executions: [...(supplied.executions ?? []), ...evidence.executions],
			assertions: [...(supplied.assertions ?? []), ...evidence.assertions],
			ownerProfileId: supplied.ownerProfileId ?? profileId,
		};
		if (supplied.source !== undefined && supplied.source !== null) verificationInput.source = supplied.source;
		if (supplied.snapshotDiff !== undefined) verificationInput.snapshotDiff = supplied.snapshotDiff;
		if (supplied.environmentDrift !== undefined) verificationInput.environmentDrift = supplied.environmentDrift;
		if (supplied.changeImpact !== undefined) verificationInput.changeImpact = supplied.changeImpact;
		const freshness = input.freshness ?? supplied.freshness ?? null;
		if (freshness) verificationInput.freshness = freshness;

		return verify(verificationInput);
	}

	function buildReport({
		binding,
		run,
		runId,
		terminated,
		stopReason,
		executedStepIds,
		skippedStepIds,
		abort,
		evidence,
		verification,
		stepOutcomes,
		reasonCodes,
	}) {
		return {
			kind: REHEARSAL_EXECUTION_KIND,
			schemaVersion: REHEARSAL_EXECUTION_SCHEMA_VERSION,
			runId,
			runState: run.runState,
			generation: run.generation,
			owner: run.owner,
			planFingerprint: binding.planFingerprint,
			identityFingerprint: run.identityFingerprint,
			terminated,
			stopReason,
			executedStepIds: [...executedStepIds],
			skippedStepIds: [...skippedStepIds].sort(),
			completedStepIds: [...run.completedStepIds].sort(),
			abort,
			evidence,
			verification,
			stepOutcomes: [...stepOutcomes],
			reasonCodes: [...reasonCodes].sort(),
			run: presentRun(run),
		};
	}

	async function run(profileId, rawInput) {
		const input = parseExecutorInput(rawInput);

		// (1) Accept the exact plan and derive the immutable run binding. Every
		// identity mismatch or non-executable step fails closed here, before a run is
		// created or resumed.
		const binding = deriveRunBinding({
			plan: input.plan,
			blastRadius: input.blastRadius,
			environment: input.environment,
			snapshot: input.snapshot,
		});

		// A plan maps to exactly one run id deterministically, so a retried
		// invocation resumes the same run. A caller may pass an explicit runId to
		// deliberately rehearse the same plan as a fresh run.
		const runId = input.runId ?? `run_${binding.planFingerprint.slice(0, 24)}`;
		const owner = input.owner ?? newOwner();

		// (2) Create or resume the matching checkpoint run.
		const ensured = await checkpoints.ensureRun(profileId, {
			runId,
			identity: binding.identity,
			plan: binding.checkpointPlan,
			label: DEFAULTS.label,
		});
		let current = ensured.run;

		// A terminal run is returned as-is. Completed steps are never re-executed and
		// a terminal run is never reopened.
		if (TERMINAL_RUN_STATES.includes(current.runState)) {
			return buildReport({
				binding,
				run: current,
				runId,
				terminated: true,
				stopReason: EXECUTOR_STOP_REASONS.TERMINAL,
				executedStepIds: [],
				skippedStepIds: current.completedStepIds,
				abort: null,
				evidence: { executions: [], assertions: [] },
				verification: null,
				stepOutcomes: [],
				reasonCodes: [],
			});
		}

		// (3) Claim the current generation. `resumeRun` is the only claiming path the
		// executor uses: it checks identity, performs the generation CAS, and returns
		// the exact pending work. `startRun` is avoided because it does not check the
		// owner and could strand a stale lease.
		const resumed = await checkpoints.resumeRun(profileId, runId, {
			expectedGeneration: current.generation,
			owner,
			identity: binding.identity,
		});
		current = resumed.run;
		const generation = current.generation;

		const recorder = createEvidenceRecorder({ maxStepOutcomes: EXECUTOR_LIMITS.maxStepOutcomes });
		const progress = derivePriorProgress(current);
		const executedStepIds = [];
		const skippedStepIds = [...current.completedStepIds];

		let stopReason = null;
		let abort = null;
		let terminal = false;

		const pending = resumed.pendingStepIds;
		const budget = input.maxSteps ?? pending.length;

		for (const stepId of pending) {
			if (input.signal?.aborted) {
				stopReason = EXECUTOR_STOP_REASONS.CANCELLED;
				break;
			}
			if (input.deadlineAt !== null && now().getTime() >= input.deadlineAt) {
				stopReason = EXECUTOR_STOP_REASONS.DEADLINE_EXCEEDED;
				break;
			}
			if (executedStepIds.length >= budget) {
				stopReason = EXECUTOR_STOP_REASONS.STEP_BUDGET;
				break;
			}

			const step = binding.executableSteps.find((candidate) => candidate.stepId === stepId) ?? null;
			if (!step) {
				// The persisted plan references a step the accepted plan does not. That
				// is drift and fails closed rather than guessing.
				recorder.addReasonCode(EXECUTOR_ERROR_CODES.PLAN_NOT_EXECUTABLE);
				current = await checkpoints.failRun(profileId, runId, {
					generation,
					owner,
					reasonCode: CHECKPOINT_REASON_CODES.PLAN_INCOMPLETE,
					reason: "STEP_NOT_IN_PLAN",
				});
				stopReason = EXECUTOR_STOP_REASONS.EXECUTION_ERROR;
				terminal = true;
				break;
			}

			let dispatched;
			try {
				dispatched = await dispatchStep(profileId, binding, step, runId, input);
			} catch (error) {
				recorder.addReasonCode(EXECUTOR_ERROR_CODES.EXECUTION_FAILED);
				current = await checkpoints.failRun(profileId, runId, {
					generation,
					owner,
					reasonCode: failureReasonFor(error),
					reason: typeof error?.code === "string" ? error.code.slice(0, 120) : null,
				});
				stopReason = EXECUTOR_STOP_REASONS.EXECUTION_ERROR;
				terminal = true;
				break;
			}

			if (dispatched.kind === "refused") {
				recorder.addReasonCode(dispatched.code);
				current = await checkpoints.failRun(profileId, runId, {
					generation,
					owner,
					reasonCode: CHECKPOINT_REASON_CODES.PLAN_INCOMPLETE,
					reason: dispatched.code.slice(0, 120),
				});
				stopReason = EXECUTOR_STOP_REASONS.EXECUTION_ERROR;
				terminal = true;
				break;
			}

			const { result, executionId } = dispatched;

			// Cancellation is not a completed step. Pausing leaves the step PENDING so a
			// resume re-runs it, and no checkpoint is written for work that did not
			// finish.
			if (result?.outcome === "cancelled" || input.signal?.aborted) {
				stopReason = EXECUTOR_STOP_REASONS.CANCELLED;
				break;
			}

			// An outcome the executor does not understand cannot be checkpointed: it
			// would have to guess whether the step succeeded.
			if (!isKnownOutcome(result?.outcome)) {
				recorder.addReasonCode(EXECUTOR_ERROR_CODES.EXECUTION_FAILED);
				current = await checkpoints.failRun(profileId, runId, {
					generation,
					owner,
					reasonCode: CHECKPOINT_REASON_CODES.STEP_OUTCOME_MISSING,
					reason: "UNKNOWN_OUTCOME",
				});
				stopReason = EXECUTOR_STOP_REASONS.EXECUTION_ERROR;
				terminal = true;
				break;
			}

			// (7) Contract compatibility is evaluated on the observed response before the
			// checkpoint so its result is part of the step's bounded metadata.
			const contract = await compareStepContract(step, result, executionId, binding, input, profileId);

			const metadata = buildStepMetadata(result, { contractStatus: contract.status, compatibility: contract.compatibility });
			const outcomeId = buildOutcomeId(stepId, result.outcome);

			// (5) Checkpoint exactly once. A terminal result — success or failure — is a
			// COMPLETED step; the HTTP outcome lives in the metadata and evidence and
			// drives the abort policy.
			const checkpointed = await checkpoints.checkpointStep(profileId, runId, {
				generation,
				owner,
				stepId,
				state: STEP_STATES.COMPLETED,
				outcome: { outcomeId, metadata },
				evidenceRefs: [executionId],
				identity: binding.identity,
			});
			current = checkpointed.run;
			executedStepIds.push(stepId);

			// (8) Bounded evidence for Phase 41.
			const evidenceRecord = buildExecutionEvidence(result, {
				executionId,
				requestId: step.requestId,
				collectionId: step.collectionId ?? null,
				workspaceId: binding.workspaceId,
				snapshotId: binding.snapshotId,
				snapshotFingerprint: binding.snapshotFingerprint,
				environmentId: binding.targetEnvironmentId,
				environmentName: input.environment.environmentName,
				ownerProfileId: profileId,
			});
			recorder.recordExecution(evidenceRecord);
			if (contract.assertion) recorder.recordAssertion(contract.assertion);

			recorder.recordStepOutcome({
				stepId,
				requestId: step.requestId,
				executionId,
				outcome: result.outcome,
				httpStatus: Number.isInteger(result?.response?.status) ? result.response.status : null,
				classification: classifyExecution(result),
				contractStatus: contract.status,
				compatible: contract.compatibility?.compatible ?? null,
			});

			// (6) Abort evaluation after every result.
			const classification = classifyExecution(result);
			progress.totalCompleted += 1;
			if (classification === "failure" || classification === "error") {
				progress.failureCount += 1;
				progress.consecutiveFailureCount += 1;
			} else {
				progress.consecutiveFailureCount = 0;
			}

			const mutating =
				binding.projected.byRequest.get(step.requestId)?.mutating === true || step.mutating === true;
			const latestResultCritical =
				mutating && (classification === "failure" || classification === "error");

			const evaluated = abortEvaluator({
				envelope: input.blastRadius,
				progress: {
					totalCompleted: progress.totalCompleted,
					failureCount: progress.failureCount,
					consecutiveFailureCount: progress.consecutiveFailureCount,
					latestResultClassification: classification,
					latestResultCritical,
				},
			});

			if (evaluated.decision === "ABORT") {
				const reasonCode = mapAbortReasonCode(evaluated.reasonCodes);
				abort = { decision: evaluated.decision, reasonCodes: [...evaluated.reasonCodes], reasonCode };
				recorder.addReasonCode(reasonCode);
				current = await checkpoints.abortRun(profileId, runId, {
					generation,
					owner,
					reasonCode,
					reason: evaluated.reasonCodes.join(",").slice(0, 120) || null,
				});
				stopReason = EXECUTOR_STOP_REASONS.BLAST_RADIUS_ABORT;
				terminal = true;
				break;
			}
		}

		// Terminate the checkpoint run coherently. Nothing is ever left RUNNING.
		if (!terminal) {
			if (stopReason === null) {
				current = await checkpoints.completeRun(profileId, runId, {
					expectedGeneration: generation,
					owner,
					identity: binding.identity,
				});
				stopReason = EXECUTOR_STOP_REASONS.COMPLETED;
				terminal = true;
			} else {
				current = await checkpoints.pauseRun(profileId, runId, {
					expectedGeneration: generation,
					owner,
					identity: binding.identity,
				});
			}
		}

		if (recorder.hasOverflowed()) recorder.addReasonCode(EXECUTOR_ERROR_CODES.EVIDENCE_LIMIT);

		const evidence = recorder.projection();
		const verification = projectVerification(input, binding, profileId, evidence);

		return buildReport({
			binding,
			run: current,
			runId,
			terminated: terminal,
			stopReason,
			executedStepIds,
			skippedStepIds,
			abort,
			evidence,
			verification,
			stepOutcomes: recorder.stepOutcomes(),
			reasonCodes: recorder.reasonCodes(),
		});
	}

	return { run };
}

// Convenience entry point for callers that do not need to hold a service. The
// executor is stateless between calls, so a fresh instance is equivalent to a
// reused one.
export async function runRehearsal(profileId, input, options = {}) {
	return createRehearsalExecutor(options).run(profileId, input);
}

export { EXECUTOR_ERROR_CODES, EXECUTOR_LIMITS, EXECUTOR_STOP_REASONS, CONTRACT_STATUS };
export { AppError };
