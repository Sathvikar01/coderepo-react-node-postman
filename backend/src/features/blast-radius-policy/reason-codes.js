// Phase 45A — closed vocabularies for the blast-radius safety policy engine.
//
// Every state and reason code is a closed, machine-readable token. No prose is
// emitted by the engine; downstream tooling switches on these values.

/**
 * Admission states. Closed vocabulary.
 *
 * ADMITTED               policy fully satisfied; the request may be proposed
 *                        to a rehearsal engine.
 * BLOCKED                an explicit policy violation applies.
 * REQUIRES_CONFIRMATION  permitted, but mutating and the policy demands an
 *                        explicit human confirmation before execution.
 * UNKNOWN                safety cannot be proven (unresolved host/method).
 */
export const ADMISSION_STATES = Object.freeze({
	ADMITTED: "ADMITTED",
	BLOCKED: "BLOCKED",
	REQUIRES_CONFIRMATION: "REQUIRES_CONFIRMATION",
	UNKNOWN: "UNKNOWN",
});

export const ADMISSION_STATE_VALUES = Object.freeze(Object.values(ADMISSION_STATES));

/**
 * Request mutability classification. Closed vocabulary.
 *
 * `UNKNOWN` is never treated as safe by any admission rule.
 */
export const REQUEST_CLASSIFICATIONS = Object.freeze({
	NON_MUTATING: "NON_MUTATING",
	MUTATING: "MUTATING",
	UNKNOWN: "UNKNOWN",
});

export const REQUEST_CLASSIFICATION_VALUES = Object.freeze(Object.values(REQUEST_CLASSIFICATIONS));

/**
 * Reason codes. Closed vocabulary, stable strings.
 */
export const REASON_CODES = Object.freeze({
	ENVIRONMENT_NOT_ALLOWED: "ENVIRONMENT_NOT_ALLOWED",
	HOST_NOT_ALLOWED: "HOST_NOT_ALLOWED",
	METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
	MUTATING_REQUEST_NOT_ALLOWED: "MUTATING_REQUEST_NOT_ALLOWED",
	MUTATING_CONFIRMATION_REQUIRED: "MUTATING_CONFIRMATION_REQUIRED",
	REQUEST_LIMIT_EXCEEDED: "REQUEST_LIMIT_EXCEEDED",
	MUTATING_LIMIT_EXCEEDED: "MUTATING_LIMIT_EXCEEDED",
	HOST_REQUEST_LIMIT_EXCEEDED: "HOST_REQUEST_LIMIT_EXCEEDED",
	UNKNOWN_METHOD: "UNKNOWN_METHOD",
	UNKNOWN_HOST: "UNKNOWN_HOST",
	FAILURE_LIMIT_REACHED: "FAILURE_LIMIT_REACHED",
	CONSECUTIVE_FAILURE_LIMIT_REACHED: "CONSECUTIVE_FAILURE_LIMIT_REACHED",
	CRITICAL_FAILURE: "CRITICAL_FAILURE",
});

export const REASON_CODE_VALUES = Object.freeze(Object.values(REASON_CODES));

/**
 * Typed error codes surfaced when the engine fails closed on bad input.
 * These are not admission reason codes; they are hard errors.
 */
export const BLAST_RADIUS_ERROR_CODES = Object.freeze({
	MALFORMED_INPUT: "BLAST_RADIUS_MALFORMED_INPUT",
	CONTRADICTORY_LIMITS: "BLAST_RADIUS_CONTRADICTORY_LIMITS",
	MISSING_IDENTITY: "BLAST_RADIUS_MISSING_IDENTITY",
	DUPLICATE_REQUEST_ID: "BLAST_RADIUS_DUPLICATE_REQUEST_ID",
});

/** Abort evaluator decisions. Closed vocabulary. */
export const ABORT_DECISIONS = Object.freeze({
	CONTINUE: "CONTINUE",
	ABORT: "ABORT",
});
