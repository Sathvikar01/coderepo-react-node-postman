import { AppError } from "../../shared/errors/app-error.js";
import { RUN_STATES, RUN_STATE_VALUES, TERMINAL_RUN_STATES, STEP_STATES, TERMINAL_STEP_STATES } from "./reason-codes.js";

// Phase 46B — Rehearsal run lifecycle.
//
// A small, explicit state machine. The transitions are pure predicates so the
// service, the repository's state filters, and the tests all reason about the same
// definitions. There is no numeric scoring, no implicit transition, and no
// "reasonable default": a move that is not listed below is refused.
//
//   CREATED  --start--> RUNNING
//   CREATED  --abort--> ABORTED
//   CREATED  --fail---> FAILED
//   RUNNING  --checkpoint (progress)--> RUNNING   (self-loop; state unchanged)
//   RUNNING  --pause--> PAUSED
//   RUNNING  --abort--> ABORTED
//   RUNNING  --fail---> FAILED
//   RUNNING  --complete--> COMPLETED
//   PAUSED   --resume--> RUNNING
//   PAUSED   --abort--> ABORTED
//   PAUSED   --fail---> FAILED
//
// COMPLETED, ABORTED, FAILED: no outgoing transitions. A terminal run can never
// silently return to RUNNING.

export const RUN_TRANSITIONS = Object.freeze({
	[RUN_STATES.CREATED]: [RUN_STATES.RUNNING, RUN_STATES.ABORTED, RUN_STATES.FAILED],
	[RUN_STATES.RUNNING]: [RUN_STATES.RUNNING, RUN_STATES.PAUSED, RUN_STATES.COMPLETED, RUN_STATES.ABORTED, RUN_STATES.FAILED],
	[RUN_STATES.PAUSED]: [RUN_STATES.RUNNING, RUN_STATES.ABORTED, RUN_STATES.FAILED],
	[RUN_STATES.COMPLETED]: [],
	[RUN_STATES.ABORTED]: [],
	[RUN_STATES.FAILED]: [],
});

export function isValidRunState(state) {
	return RUN_STATE_VALUES.includes(state);
}

export function isTerminalRunState(state) {
	return TERMINAL_RUN_STATES.includes(state);
}

export function canTransition(from, to) {
	if (!isValidRunState(from) || !isValidRunState(to)) return false;
	return (RUN_TRANSITIONS[from] ?? []).includes(to);
}

// The transitions a *caller* may request. The RUNNING -> RUNNING self-loop is real
// (it is progress) but it is never requested by name; it is the effect of a
// checkpoint write. Exposed separately so a caller-facing API can never ask for a
// no-op transition.
export function canRequestTransition(from, to) {
	if (from === to) return false;
	return canTransition(from, to);
}

export function assertTransition(from, to) {
	if (isTerminalRunState(from))
		throw new AppError(409, "REHEARSAL_CHECKPOINT_TERMINAL_STATE", `A ${from} run is terminal and cannot change state.`, { from, to });
	if (!canTransition(from, to))
		throw new AppError(409, "REHEARSAL_CHECKPOINT_INVALID_TRANSITION", `A rehearsal run cannot move from ${from} to ${to}.`, { from, to });
	return to;
}

// ---------------------------------------------------------------------------
// Step lifecycle
// ---------------------------------------------------------------------------

export const STEP_TRANSITIONS = Object.freeze({
	[STEP_STATES.PENDING]: [STEP_STATES.IN_PROGRESS, STEP_STATES.COMPLETED, STEP_STATES.SKIPPED, STEP_STATES.FAILED],
	[STEP_STATES.IN_PROGRESS]: [STEP_STATES.COMPLETED, STEP_STATES.SKIPPED, STEP_STATES.FAILED, STEP_STATES.PENDING],
	[STEP_STATES.COMPLETED]: [],
	[STEP_STATES.SKIPPED]: [],
	[STEP_STATES.FAILED]: [],
});

export function isValidStepState(state) {
	return Object.values(STEP_STATES).includes(state);
}

export function isTerminalStepState(state) {
	return TERMINAL_STEP_STATES.includes(state);
}

export function canTransitionStep(from, to) {
	if (!isValidStepState(from) || !isValidStepState(to)) return false;
	return (STEP_TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// Derived progress
// ---------------------------------------------------------------------------

// Steps that still need work, in plan order. Terminal steps are excluded, which is
// what makes "resume only unfinished work" a property of the model rather than a
// convention a caller has to remember.
export function pendingSteps(plan, stepStates) {
	const terminal = new Set(
		stepStates.filter((entry) => isTerminalStepState(entry.state)).map((entry) => entry.stepId),
	);
	return plan.steps.filter((step) => !terminal.has(step.stepId)).map((step) => step.stepId);
}

// Whether every step in the plan has reached a terminal step state.
export function allStepsTerminal(plan, stepStates) {
	return pendingSteps(plan, stepStates).length === 0;
}
