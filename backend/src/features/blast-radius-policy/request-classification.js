// Phase 45A — deterministic HTTP method classification.
//
// Classification is a syntactic, closed mapping. It says nothing about
// semantic idempotency or about whether a method is "safe" in the HTTP sense;
// it only records whether the method is expected to mutate server state.
//
//   GET, HEAD, OPTIONS                      -> NON_MUTATING
//   POST, PUT, PATCH, DELETE                -> MUTATING
//   anything else (custom/extended methods) -> UNKNOWN
//
// UNKNOWN is never coerced to NON_MUTATING. A caller cannot smuggle a custom
// method past the mutating guards by relying on a default.

import { REQUEST_CLASSIFICATIONS } from "./reason-codes.js";

const NON_MUTATING_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Normalize an HTTP method token for comparison: uppercase only.
 *
 * Leading/trailing whitespace is *not* trimmed away, because a token that
 * arrived with padding is malformed and must stay malformed. Trimming here
 * would silently turn `"GET\t"` into a well-formed `GET` and classify it as
 * NON_MUTATING — a fail-open bug.
 *
 * @param {unknown} method
 * @returns {string} uppercased method token (may be an empty string)
 */
export function normalizeMethod(method) {
	if (typeof method !== "string") return "";
	return method.toUpperCase();
}

/**
 * Validate that a method token is a legal HTTP method token *as supplied*.
 * Fails closed on empty, padded, whitespace-containing, or non-token inputs.
 *
 * @param {unknown} method
 * @returns {boolean}
 */
export function isWellFormedMethod(method) {
	if (typeof method !== "string" || method.length === 0 || method.length > 64) return false;
	// RFC 7230 token: "!#$%&'*+-.^_`|~" plus digits and letters. No whitespace,
	// no control characters, no separators.
	return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(method);
}

/**
 * Classify a request method.
 *
 * A malformed method token is classified UNKNOWN — never as non-mutating.
 *
 * @param {unknown} method
 * @returns {"NON_MUTATING"|"MUTATING"|"UNKNOWN"}
 */
export function classifyMethod(method) {
	if (!isWellFormedMethod(method)) return REQUEST_CLASSIFICATIONS.UNKNOWN;
	const normalized = normalizeMethod(method);
	if (NON_MUTATING_METHODS.has(normalized)) return REQUEST_CLASSIFICATIONS.NON_MUTATING;
	if (MUTATING_METHODS.has(normalized)) return REQUEST_CLASSIFICATIONS.MUTATING;
	return REQUEST_CLASSIFICATIONS.UNKNOWN;
}

/**
 * Does a classification denote a method that may mutate server state?
 * Only an explicit MUTATING classification counts.
 *
 * @param {string} classification
 * @returns {boolean}
 */
export function isMutatingClassification(classification) {
	return classification === REQUEST_CLASSIFICATIONS.MUTATING;
}

export { NON_MUTATING_METHODS, MUTATING_METHODS };
