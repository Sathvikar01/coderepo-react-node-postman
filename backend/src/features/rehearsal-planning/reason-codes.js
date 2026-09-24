// Phase 46A — Checkpointed Rehearsal Planning Core (closed vocabularies).
//
// Every state, verdict, and reason code is a closed, machine-readable token.
// The planner never emits prose; downstream rehearsal integration switches on
// these values. New tokens must be added here and given a rule in the planner,
// otherwise they cannot appear in a plan.
//
// The single invariant that shapes this vocabulary:
//
//   missing / unknown evidence != safe
//
// So the planner carries explicit states for "we do not know" rather than
// collapsing them into "admitted".

/**
 * Overall plan state. Closed vocabulary.
 *
 * PLANNED      the plan contains at least one executable step and nothing
 *              prevented planning.
 * PARTIAL      the plan contains executable steps but also carried requests that
 *              could not be admitted or ordered (blocked/unknown/excluded). The
 *              caller may run the plan, but the omissions are explicit.
 * EMPTY        the plan admitted zero executable steps. This is a valid,
 *              explicit outcome: "nothing may be rehearsed", never silently
 *              upgraded to a runnable plan.
 * UNRESOLVED   the planner could not safely resolve the request set at all
 *              (missing required input, cyclic or unresolved dependencies that
 *              make ordering untrustworthy). Fails closed.
 */
export const PLAN_STATES = Object.freeze({
	PLANNED: "PLANNED",
	PARTIAL: "PARTIAL",
	EMPTY: "EMPTY",
	UNRESOLVED: "UNRESOLVED",
});

export const PLAN_STATE_VALUES = Object.freeze(Object.values(PLAN_STATES));

/**
 * Per-request step state. Closed vocabulary.
 *
 * EXECUTABLE            the request is impacted, unblocked, and its dependencies
 *                       are all resolved and ordered before it.
 * EXCLUDED              the request is not part of the impacted rehearsal set.
 * BLOCKED               the blast-radius policy explicitly blocks it.
 * UNKNOWN               safety cannot be proven (unresolved host/method/drift).
 * REQUIRES_CONFIRMATION the request is permitted only after explicit human
 *                       confirmation; never silently executable.
 * DEPENDENCY_UNRESOLVED a dependency is missing or dynamic, so ordering cannot
 *                       be proven for this request.
 * CYCLE                 the request participates in a dependency cycle.
 */
export const STEP_STATES = Object.freeze({
	EXECUTABLE: "EXECUTABLE",
	EXCLUDED: "EXCLUDED",
	BLOCKED: "BLOCKED",
	UNKNOWN: "UNKNOWN",
	REQUIRES_CONFIRMATION: "REQUIRES_CONFIRMATION",
	DEPENDENCY_UNRESOLVED: "DEPENDENCY_UNRESOLVED",
	CYCLE: "CYCLE",
});

export const STEP_STATE_VALUES = Object.freeze(Object.values(STEP_STATES));

/**
 * Dependencies represented on a plan step. Closed vocabulary.
 *
 * RESOLVED  the dependency names a request that exists in the candidate set and
 *           is itself orderable.
 * EXTERNAL  the dependency names a request that is not in the candidate set. It
 *           is preserved so the caller can decide, never assumed satisfied.
 * DYNAMIC   the dependency cannot be named statically (the caller supplied an
 *           unresolved/dynamic marker). It is never dropped.
 * SELF      the request depends on itself (a degenerate cycle).
 */
export const DEPENDENCY_KINDS = Object.freeze({
	RESOLVED: "RESOLVED",
	EXTERNAL: "EXTERNAL",
	DYNAMIC: "DYNAMIC",
	SELF: "SELF",
});

export const DEPENDENCY_KIND_VALUES = Object.freeze(Object.values(DEPENDENCY_KINDS));

/**
 * Cycle representation. A cycle is reported explicitly rather than silently
 * broken: a caller must be able to see that two or more requests mutually
 * depend, and which ones.
 */
export const CYCLE_KINDS = Object.freeze({
	SELF: "SELF",
	MUTUAL: "MUTUAL",
});

export const CYCLE_KIND_VALUES = Object.freeze(Object.values(CYCLE_KINDS));

/**
 * Plan-level reason codes. Closed vocabulary, stable strings.
 *
 * These describe the plan as a whole; per-step reasons are the dependency kinds
 * and the blast-radius reason codes the planner copies verbatim.
 */
export const PLAN_REASON_CODES = Object.freeze({
	// Structural
	IMPACT_MISSING: "IMPACT_MISSING",
	DRIFT_MISSING: "DRIFT_MISSING",
	TARGET_ENVIRONMENT_MISMATCH: "TARGET_ENVIRONMENT_MISMATCH",
	DUPLICATE_REQUEST_IDENTITY: "DUPLICATE_REQUEST_IDENTITY",
	DEPENDENCY_TARGET_EXTERNAL: "DEPENDENCY_TARGET_EXTERNAL",
	DEPENDENCY_TARGET_NOT_EXECUTABLE: "DEPENDENCY_TARGET_NOT_EXECUTABLE",
	DYNAMIC_DEPENDENCY_UNRESOLVED: "DYNAMIC_DEPENDENCY_UNRESOLVED",
	DEPENDENCY_CYCLE: "DEPENDENCY_CYCLE",
	CANDIDATE_NOT_IMPACTED: "CANDIDATE_NOT_IMPACTED",

	// Blast radius (copied from the Phase 45 policy envelope, never invented here)
	BLAST_RADIUS_MISSING: "BLAST_RADIUS_MISSING",
	BLAST_RADIUS_NOT_ADMITTED: "BLAST_RADIUS_NOT_ADMITTED",
	BLAST_RADIUS_TARGET_MISMATCH: "BLAST_RADIUS_TARGET_MISMATCH",

	// Outcomes
	NO_ADMITTED_REQUESTS: "NO_ADMITTED_REQUESTS",
	UNRESOLVED_DEPENDENCIES: "UNRESOLVED_DEPENDENCIES",
	REQUIRES_CONFIRMATION: "REQUIRES_CONFIRMATION",
	UNKNOWN_SAFETY: "UNKNOWN_SAFETY",
	EXCLUDED_BY_IMPACT: "EXCLUDED_BY_IMPACT",
});

export const PLAN_REASON_CODE_VALUES = Object.freeze(Object.values(PLAN_REASON_CODES));

/**
 * Typed error codes surfaced when the planner fails closed on bad input.
 * These are hard errors, not plan reason codes.
 */
export const REHEARSAL_PLANNING_ERROR_CODES = Object.freeze({
	MALFORMED_INPUT: "REHEARSAL_PLANNING_MALFORMED_INPUT",
	MISSING_IDENTITY: "REHEARSAL_PLANNING_MISSING_IDENTITY",
	DUPLICATE_REQUEST_ID: "REHEARSAL_PLANNING_DUPLICATE_REQUEST_ID",
	INVALID_RESULT: "REHEARSAL_PLANNING_INVALID_RESULT",
	SNAPSHOT_STALE: "REHEARSAL_PLANNING_SNAPSHOT_STALE",
	TARGET_ENVIRONMENT_MISMATCH: "REHEARSAL_PLANNING_TARGET_ENVIRONMENT_MISMATCH",
});
