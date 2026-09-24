// Phase 46B — Rehearsal Checkpoint Core. Closed vocabularies.
//
// Every state, reason code, and error code is a closed, machine-readable token.
// The core never emits prose for control flow; downstream tooling (and a later
// rehearsal executor) switches on these values.
//
// This module is the only place these vocabularies are defined. Any state that is
// not listed here cannot appear in a checkpoint, and any reason code that is not
// listed here cannot be produced.

// ---------------------------------------------------------------------------
// Lifecycle states
// ---------------------------------------------------------------------------
//
// A rehearsal run is a strict, closed state machine:
//
//   CREATED --start--> RUNNING --checkpoint--> RUNNING (self-loop, progress only)
//                      |  ^                       |
//             pause ---+  +--- resume ------------+
//                      |                          |
//                      +--> COMPLETED | ABORTED | FAILED
//
//   PAUSED --resume--> RUNNING
//   PAUSED --abort--> ABORTED
//   CREATED --abort--> ABORTED
//   CREATED --fail--> FAILED
//
// COMPLETED, ABORTED, and FAILED are terminal: no transition leaves them. A
// terminal run can never silently return to RUNNING.
export const RUN_STATES = Object.freeze({
	CREATED: "CREATED",
	RUNNING: "RUNNING",
	PAUSED: "PAUSED",
	COMPLETED: "COMPLETED",
	ABORTED: "ABORTED",
	FAILED: "FAILED",
});

export const RUN_STATE_VALUES = Object.freeze(Object.values(RUN_STATES));

// States from which no transition is legal. Kept as an explicit set rather than
// derived so a reader can see the terminal contract at a glance.
export const TERMINAL_RUN_STATES = Object.freeze([
	RUN_STATES.COMPLETED,
	RUN_STATES.ABORTED,
	RUN_STATES.FAILED,
]);

export const TERMINAL_RUN_STATE_VALUES = Object.freeze([...TERMINAL_RUN_STATES]);

// ---------------------------------------------------------------------------
// Step states
// ---------------------------------------------------------------------------
//
// A step is a member of the run's ordered plan. Steps are derived from the plan
// identity, so the plan is the single source of truth for what must run.
//
//   PENDING      scheduled, not yet started
//   IN_PROGRESS  a worker claimed it and is executing it
//   COMPLETED    terminal for the step: the outcome was recorded
//   SKIPPED      terminal for the step: deliberately not run (policy/abort path)
//   FAILED       terminal for the step: the attempt failed
export const STEP_STATES = Object.freeze({
	PENDING: "PENDING",
	IN_PROGRESS: "IN_PROGRESS",
	COMPLETED: "COMPLETED",
	SKIPPED: "SKIPPED",
	FAILED: "FAILED",
});

export const STEP_STATE_VALUES = Object.freeze(Object.values(STEP_STATES));

// A step that counts as "finished work" for resume purposes. These steps are
// never scheduled again.
export const TERMINAL_STEP_STATES = Object.freeze([
	STEP_STATES.COMPLETED,
	STEP_STATES.SKIPPED,
]);

export const TERMINAL_STEP_STATE_VALUES = Object.freeze([...TERMINAL_STEP_STATES]);

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------
//
// Machine-readable reasons attached to abort/failure transitions. Stable strings.
export const REASON_CODES = Object.freeze({
	// Caller-driven
	OPERATOR_REQUESTED: "OPERATOR_REQUESTED",
	// Budget / safety driven (a rehearsal executor supplies the code; this core
	// only stores it).
	BLAST_RADIUS_LIMIT: "BLAST_RADIUS_LIMIT",
	FAILURE_LIMIT_REACHED: "FAILURE_LIMIT_REACHED",
	DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
	TARGET_UNAVAILABLE: "TARGET_UNAVAILABLE",
	// Integrity driven
	PLAN_INCOMPLETE: "PLAN_INCOMPLETE",
	STEP_OUTCOME_MISSING: "STEP_OUTCOME_MISSING",
	INTERNAL_ERROR: "INTERNAL_ERROR",
});

export const REASON_CODE_VALUES = Object.freeze(Object.values(REASON_CODES));

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------
//
// Hard, typed failures surfaced when the core refuses to act. These are not
// state values and never persist as an outcome; they are rejected operations.
export const CHECKPOINT_ERROR_CODES = Object.freeze({
	MALFORMED_INPUT: "REHEARSAL_CHECKPOINT_MALFORMED_INPUT",
	MISSING_IDENTITY: "REHEARSAL_CHECKPOINT_MISSING_IDENTITY",
	IDENTITY_CONFLICT: "REHEARSAL_CHECKPOINT_IDENTITY_CONFLICT",
	NOT_FOUND: "REHEARSAL_CHECKPOINT_NOT_FOUND",
	INVALID_TRANSITION: "REHEARSAL_CHECKPOINT_INVALID_TRANSITION",
	TERMINAL_STATE: "REHEARSAL_CHECKPOINT_TERMINAL_STATE",
	STALE_GENERATION: "REHEARSAL_CHECKPOINT_STALE_GENERATION",
	LEASE_NOT_HELD: "REHEARSAL_CHECKPOINT_LEASE_NOT_HELD",
	STEP_NOT_FOUND: "REHEARSAL_CHECKPOINT_STEP_NOT_FOUND",
	STEP_NOT_PENDING: "REHEARSAL_CHECKPOINT_STEP_NOT_PENDING",
	STEP_CONTRADICTORY: "REHEARSAL_CHECKPOINT_STEP_CONTRADICTORY",
	DUPLICATE_RUN: "REHEARSAL_CHECKPOINT_DUPLICATE_RUN",
	PROFILE_REQUIRED: "REHEARSAL_CHECKPOINT_PROFILE_REQUIRED",
});

export const CHECKPOINT_ERROR_CODE_VALUES = Object.freeze(Object.values(CHECKPOINT_ERROR_CODES));
