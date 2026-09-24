// Phase 46B — Rehearsal Checkpoint Core.
//
// Public surface. Backend-only: no routes, no HTTP execution, no runner
// integration, no contract checking.
//
// This core answers exactly one question:
//
//   "How do we checkpoint a rehearsal after each completed step and resume safely
//    without repeating completed work or allowing stale workers to continue?"
//
// It owns state + checkpoint semantics only:
//
//   * an immutable run identity binding (workspace / snapshot / target environment
//     / plan / policy),
//   * a strict, closed lifecycle (CREATED / RUNNING / PAUSED / COMPLETED /
//     ABORTED / FAILED) with validated transitions,
//   * generation + lease + CAS ownership so a stale worker can never continue,
//   * exactly-once step completion accounting,
//   * crash-safe resume that excludes already-completed work,
//   * deterministic, byte-stable checkpoint serialization.
//
// Composition seam for later phases (not implemented here on purpose):
//
//   Blast Radius Policy  ->  Rehearsal Checkpoint Core  ->  Rehearsal Executor
//
// The executor (which actually dispatches requests) is a separate, later phase.
// This core deliberately does not know how a step is executed; it only records
// that a step finished, what its outcome identity was, and who owned the run when
// that happened.

export {
	REHEARSAL_CHECKPOINT_SCHEMA_VERSION,
	REHEARSAL_CHECKPOINT_KIND,
	CHECKPOINT_LIMITS,
	createRunInputSchema,
	runIdentitySchema,
	planSchema,
	checkpointStepInputSchema,
	resumeInputSchema,
	abortInputSchema,
	failInputSchema,
	claimInputSchema,
	parseCreateRunInput,
	parseRunIdentity,
	parsePlan,
	parseGenerationInput,
	parseClaimInput,
	parseCheckpointStepInput,
	parseAbortInput,
	parseFailInput,
	parseResumeInput,
	parseStoredRun,
	isCredentialShaped,
} from "./checkpoint-schema.js";

export {
	RUN_STATES,
	RUN_STATE_VALUES,
	TERMINAL_RUN_STATES,
	STEP_STATES,
	STEP_STATE_VALUES,
	TERMINAL_STEP_STATES,
	REASON_CODES,
	REASON_CODE_VALUES,
	CHECKPOINT_ERROR_CODES,
	CHECKPOINT_ERROR_CODE_VALUES,
} from "./reason-codes.js";

export {
	RUN_TRANSITIONS,
	STEP_TRANSITIONS,
	isValidRunState,
	isTerminalRunState,
	canTransition,
	canRequestTransition,
	assertTransition,
	isValidStepState,
	isTerminalStepState,
	canTransitionStep,
	pendingSteps,
	allStepsTerminal,
} from "./run-lifecycle.js";

export {
	identityBindings,
	identityFingerprint,
	identityFingerprintKeyId,
	identityDifferences,
	identitiesMatch,
	canonicalIdentityJson,
	canonicalizeValue,
	canonicalizeJson,
	compareStrings,
} from "./run-identity.js";

export {
	checkpointCanonicalForm,
	checkpointFingerprint,
	stepCompletionIdentity,
	stepCompletionFingerprint,
	completionsAgree,
	derivedPointers,
	initialStepStates,
	assertCheckpointSize,
	isTerminalCheckpointState,
} from "./checkpoint-canonical.js";

export { RehearsalCheckpoint } from "./checkpoint.model.js";
export { checkpointRepository } from "./checkpoint.repository.js";
export { createRehearsalCheckpointService, presentRun } from "./rehearsal-checkpoint.service.js";
