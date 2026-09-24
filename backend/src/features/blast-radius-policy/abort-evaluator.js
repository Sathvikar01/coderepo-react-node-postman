// Phase 45A — runtime abort evaluator.
//
// A pure, deterministic function a future rehearsal runner calls after every
// completed request. It performs no execution, no I/O, and no persistence; it
// only reads the admitted envelope's effective limits and the run's progress
// and returns CONTINUE or ABORT with exact reason codes.
//
// Multiple reasons can apply at once. They are returned sorted and stable.

import { BLAST_RADIUS_ABORT_KIND, BLAST_RADIUS_ABORT_VERSION, BlastRadiusError } from "./blast-radius-schema.js";
import { ABORT_DECISIONS, BLAST_RADIUS_ERROR_CODES, REASON_CODES } from "./reason-codes.js";

export const RESULT_CLASSIFICATIONS = Object.freeze(["success", "failure", "error", "canceled", "skipped"]);

function requireCount(value, field) {
	if (!Number.isInteger(value) || value < 0) {
		throw new BlastRadiusError(
			BLAST_RADIUS_ERROR_CODES.MALFORMED_INPUT,
			`Abort evaluation requires "${field}" to be a non-negative integer.`,
			{ field, value },
		);
	}
	return value;
}

/**
 * Evaluate whether a rehearsal must abort after the latest result.
 *
 * @param {object} args
 * @param {object} args.envelope the previously admitted safety envelope
 * @param {object} args.progress
 * @param {number} args.progress.totalCompleted completed request count
 * @param {number} args.progress.failureCount total failed request count
 * @param {number} args.progress.consecutiveFailureCount trailing consecutive failures
 * @param {"success"|"failure"|"error"|"canceled"|"skipped"} args.progress.latestResultClassification
 * @param {boolean} [args.progress.latestResultCritical]
 * @returns {{decision: "CONTINUE"|"ABORT", reasonCodes: string[], kind: string, version: number}}
 */
export function evaluateAbort({ envelope, progress }) {
	if (!envelope || typeof envelope !== "object") {
		throw new BlastRadiusError(
			BLAST_RADIUS_ERROR_CODES.MALFORMED_INPUT,
			"Abort evaluation requires a previously admitted safety envelope.",
			{ field: "envelope" },
		);
	}
	if (!progress || typeof progress !== "object") {
		throw new BlastRadiusError(
			BLAST_RADIUS_ERROR_CODES.MALFORMED_INPUT,
			"Abort evaluation requires a progress object.",
			{ field: "progress" },
		);
	}

	const totalCompleted = requireCount(progress.totalCompleted, "totalCompleted");
	const failureCount = requireCount(progress.failureCount, "failureCount");
	const consecutiveFailureCount = requireCount(progress.consecutiveFailureCount, "consecutiveFailureCount");
	const latestResultClassification = progress.latestResultClassification;
	if (!RESULT_CLASSIFICATIONS.includes(latestResultClassification)) {
		throw new BlastRadiusError(
			BLAST_RADIUS_ERROR_CODES.MALFORMED_INPUT,
			"Abort evaluation requires a known latestResultClassification.",
			{ field: "latestResultClassification", value: latestResultClassification },
		);
	}
	if (failureCount > totalCompleted) {
		throw new BlastRadiusError(
			BLAST_RADIUS_ERROR_CODES.MALFORMED_INPUT,
			'"failureCount" cannot exceed "totalCompleted".',
			{ failureCount, totalCompleted },
		);
	}
	if (consecutiveFailureCount > failureCount) {
		throw new BlastRadiusError(
			BLAST_RADIUS_ERROR_CODES.MALFORMED_INPUT,
			'"consecutiveFailureCount" cannot exceed "failureCount".',
			{ consecutiveFailureCount, failureCount },
		);
	}

	const limits = envelope?.effectiveLimits ?? {};
	const reasons = new Set();

	const maxFailures = limits.maxFailures?.value ?? null;
	if (limits.maxFailures?.configured && maxFailures !== null && failureCount >= maxFailures) {
		reasons.add(REASON_CODES.FAILURE_LIMIT_REACHED);
	}

	const maxConsecutiveFailures = limits.maxConsecutiveFailures?.value ?? null;
	if (
		limits.maxConsecutiveFailures?.configured &&
		maxConsecutiveFailures !== null &&
		consecutiveFailureCount >= maxConsecutiveFailures
	) {
		reasons.add(REASON_CODES.CONSECUTIVE_FAILURE_LIMIT_REACHED);
	}

	if (limits.stopOnCriticalFailure?.configured && limits.stopOnCriticalFailure.value === true && progress.latestResultCritical === true) {
		reasons.add(REASON_CODES.CRITICAL_FAILURE);
	}

	const reasonCodes = [...reasons].sort();
	return {
		kind: BLAST_RADIUS_ABORT_KIND,
		version: BLAST_RADIUS_ABORT_VERSION,
		decision: reasonCodes.length > 0 ? ABORT_DECISIONS.ABORT : ABORT_DECISIONS.CONTINUE,
		reasonCodes,
	};
}
