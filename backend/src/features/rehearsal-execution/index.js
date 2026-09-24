// Phase 46C — Checkpointed Cross-Environment Rehearsal Integration.
//
// Public surface. Backend-only: no routes, no HTTP transport of its own, no
// frontend, no second runner.
//
// This phase integrates three completed cores into Tracer's *existing* execution
// path:
//
//   Phase 46A Rehearsal Planning   -> the exact plan and its identity
//   Phase 45A Blast-Radius Policy  -> admission + runtime abort
//   Phase 46B Rehearsal Checkpoint -> durable, resumable run state
//
// and produces:
//
//   Phase 43 Contract Compatibility -> per-response contract evidence
//   Phase 41 Cross-Env Verification -> a consumable evidence projection
//
// The executor is a conductor. It dispatches one ordinary execution per eligible
// step through `executionService.send`, checkpoints after each step, refuses to
// repeat completed work, and stops the moment the safety policy aborts. Missing
// or unknown evidence is never upgraded to VERIFIED.

export {
	REHEARSAL_EXECUTION_KIND,
	REHEARSAL_EXECUTION_SCHEMA_VERSION,
	EXECUTOR_ERROR_CODES,
	EXECUTOR_LIMITS,
	EXECUTOR_STOP_REASONS,
	CONTRACT_STATUS,
	parseExecutorInput,
	parseDeadline,
} from "./executor-schema.js";

export { deriveRunBinding } from "./step-plan.js";

export {
	EXECUTION_OUTCOMES,
	isKnownOutcome,
	classifyExecution,
	buildStepMetadata,
	buildOutcomeId,
	toObservedResponse,
	mapAbortReasonCode,
	buildContractAssertion,
} from "./outcome-mapping.js";

export { createEvidenceRecorder, buildExecutionEvidence } from "./evidence-recorder.js";

export { createRehearsalExecutor, runRehearsal } from "./rehearsal-executor.service.js";
