import { AppError } from "../../shared/errors/app-error.js";

// Phase 46C — Rehearsal Executor. Input contract and closed vocabularies.
//
// This module owns the executor's own wrapper contract. It deliberately does NOT
// re-declare the 46A plan schema or the 46B run identity schema: those cores own
// their shapes, and the executor validates them through the cores' own parsers so
// there is exactly one definition of what a plan or a run identity is.

export const REHEARSAL_EXECUTION_KIND = "tracer.rehearsal-execution";
export const REHEARSAL_EXECUTION_SCHEMA_VERSION = 1;

// Hard bounds. The executor is a loop over a bounded plan and it accumulates
// bounded evidence, so every accumulator has an explicit ceiling rather than an
// implicit "whatever the caller passed".
export const EXECUTOR_LIMITS = Object.freeze({
	maxSteps: 5000,
	maxReasonCodes: 128,
	maxStepOutcomes: 5000,
	maxEvidenceRefsPerStep: 64,
});

// Typed, machine-readable refusals. A refusal is never a state; it is an error
// the caller must handle. Anything the executor cannot prove fails closed with
// one of these codes instead of a best-effort continuation.
export const EXECUTOR_ERROR_CODES = Object.freeze({
	MALFORMED_INPUT: "REHEARSAL_EXECUTOR_MALFORMED_INPUT",
	MISSING_PLAN: "REHEARSAL_EXECUTOR_MISSING_PLAN",
	MISSING_IDENTITY: "REHEARSAL_EXECUTOR_MISSING_IDENTITY",
	IDENTITY_MISMATCH: "REHEARSAL_EXECUTOR_IDENTITY_MISMATCH",
	PLAN_NOT_EXECUTABLE: "REHEARSAL_EXECUTOR_PLAN_NOT_EXECUTABLE",
	BLAST_RADIUS_MISSING: "REHEARSAL_EXECUTOR_BLAST_RADIUS_MISSING",
	BLAST_RADIUS_MISMATCH: "REHEARSAL_EXECUTOR_BLAST_RADIUS_MISMATCH",
	STEP_NOT_ADMITTED: "REHEARSAL_EXECUTOR_STEP_NOT_ADMITTED",
	REQUEST_UNRESOLVED: "REHEARSAL_EXECUTOR_REQUEST_UNRESOLVED",
	EXECUTION_FAILED: "REHEARSAL_EXECUTOR_EXECUTION_FAILED",
	EVIDENCE_LIMIT: "REHEARSAL_EXECUTOR_EVIDENCE_LIMIT",
});

// Reason codes the executor may attach to a terminal transition or surface in
// its report. Kept separate from the 46B reason vocabulary because these describe
// *why the executor stopped*, and the 46B vocabulary is what it is allowed to
// persist. Every persisted code is one of the 46B codes; these are the executor's
// own explanatory tokens for the report.
export const EXECUTOR_STOP_REASONS = Object.freeze({
	COMPLETED: "COMPLETED",
	BLAST_RADIUS_ABORT: "BLAST_RADIUS_ABORT",
	DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
	CANCELLED: "CANCELLED",
	STEP_BUDGET: "STEP_BUDGET",
	EXECUTION_ERROR: "EXECUTION_ERROR",
	TERMINAL: "TERMINAL",
});

// Contract handling outcomes, surfaced on a step outcome and in the report.
export const CONTRACT_STATUS = Object.freeze({
	COMPARED: "COMPARED",
	ABSENT: "ABSENT",
	SKIPPED_NO_RESPONSE: "SKIPPED_NO_RESPONSE",
	SKIPPED_TRUNCATED: "SKIPPED_TRUNCATED",
	SKIPPED_NO_BODY: "SKIPPED_NO_BODY",
	NOT_COMPARABLE: "NOT_COMPARABLE",
});

export function executorError(statusCode, code, message, details) {
	return new AppError(statusCode, code, message, details);
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requirePlainObject(value, field) {
	if (!isPlainObject(value)) {
		throw executorError(400, EXECUTOR_ERROR_CODES.MALFORMED_INPUT, `"${field}" must be an object.`, { field });
	}
	return value;
}

function requireNonEmptyString(value, field) {
	if (typeof value !== "string" || !value.trim()) {
		throw executorError(400, EXECUTOR_ERROR_CODES.MISSING_IDENTITY, `"${field}" is required and must be a non-empty string.`, {
			field,
		});
	}
	return value.trim();
}

// Parse an optional deadline. Accepts a Date, an ISO-8601 string, or an epoch
// millisecond number. An unparseable value fails closed rather than being
// ignored, because silently dropping a deadline would remove a stop condition.
export function parseDeadline(value) {
	if (value === undefined || value === null) return null;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			throw executorError(400, EXECUTOR_ERROR_CODES.MALFORMED_INPUT, '"deadlineAt" is not a valid Date.', { field: "deadlineAt" });
		}
		return value.getTime();
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw executorError(400, EXECUTOR_ERROR_CODES.MALFORMED_INPUT, '"deadlineAt" must be a finite number.', { field: "deadlineAt" });
		}
		return value;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isNaN(parsed)) {
			throw executorError(400, EXECUTOR_ERROR_CODES.MALFORMED_INPUT, '"deadlineAt" is not a valid ISO-8601 timestamp.', {
				field: "deadlineAt",
			});
		}
		return parsed;
	}
	throw executorError(400, EXECUTOR_ERROR_CODES.MALFORMED_INPUT, '"deadlineAt" must be a Date, ISO-8601 string, or epoch millis.', {
		field: "deadlineAt",
	});
}

// The executor wrapper. `plan` and `blastRadius` are validated by the owning
// cores; here we only assert the wrapper's own required structural fields. Runtime
// hooks (`resolveRequest`, `resolveContract`, `signal`) are validated by type.
export function parseExecutorInput(input) {
	const value = requirePlainObject(input, "input");

	if (!value.plan) {
		throw executorError(400, EXECUTOR_ERROR_CODES.MISSING_PLAN, "A Phase 46A rehearsal plan is required.", { field: "plan" });
	}
	if (!value.blastRadius) {
		throw executorError(400, EXECUTOR_ERROR_CODES.BLAST_RADIUS_MISSING, "A Phase 45A blast-radius envelope is required.", {
			field: "blastRadius",
		});
	}

	const environment = requirePlainObject(value.environment, "environment");
	const environmentId = requireNonEmptyString(environment.environmentId, "environment.environmentId");
	const environmentFingerprint = requireNonEmptyString(environment.environmentFingerprint, "environment.environmentFingerprint");
	const environmentName =
		environment.environmentName === undefined || environment.environmentName === null
			? null
			: requireNonEmptyString(environment.environmentName, "environment.environmentName");

	if (value.resolveRequest !== undefined && typeof value.resolveRequest !== "function") {
		throw executorError(400, EXECUTOR_ERROR_CODES.MALFORMED_INPUT, '"resolveRequest" must be a function when supplied.', {
			field: "resolveRequest",
		});
	}
	if (value.resolveContract !== undefined && typeof value.resolveContract !== "function") {
		throw executorError(400, EXECUTOR_ERROR_CODES.MALFORMED_INPUT, '"resolveContract" must be a function when supplied.', {
			field: "resolveContract",
		});
	}
	if (value.signal !== undefined && (typeof value.signal !== "object" || typeof value.signal.aborted !== "boolean")) {
		throw executorError(400, EXECUTOR_ERROR_CODES.MALFORMED_INPUT, '"signal" must be an AbortSignal when supplied.', {
			field: "signal",
		});
	}

	const maxSteps =
		value.maxSteps === undefined || value.maxSteps === null
			? null
			: (() => {
					if (!Number.isInteger(value.maxSteps) || value.maxSteps < 1) {
						throw executorError(400, EXECUTOR_ERROR_CODES.MALFORMED_INPUT, '"maxSteps" must be a positive integer when supplied.', {
							field: "maxSteps",
						});
					}
					return Math.min(value.maxSteps, EXECUTOR_LIMITS.maxSteps);
				})();

	return {
		plan: value.plan,
		blastRadius: value.blastRadius,
		environment: { environmentId, environmentFingerprint, environmentName },
		snapshot: value.snapshot ?? null,
		owner: value.owner === undefined || value.owner === null ? null : requireNonEmptyString(value.owner, "owner"),
		profileId: value.profileId === undefined || value.profileId === null ? null : requireNonEmptyString(value.profileId, "profileId"),
		runId: value.runId === undefined || value.runId === null ? null : requireNonEmptyString(value.runId, "runId"),
		contracts: value.contracts ?? null,
		context: isPlainObject(value.context) ? value.context : {},
		verification: isPlainObject(value.verification) ? value.verification : null,
		freshness: isPlainObject(value.freshness) ? value.freshness : null,
		deadlineAt: parseDeadline(value.deadlineAt),
		maxSteps,
		resolveRequest: value.resolveRequest ?? null,
		resolveContract: value.resolveContract ?? null,
		signal: value.signal ?? null,
	};
}

// Parse an explicit snapshot override. Used when the 46A plan carries only one of
// the two snapshot identity fields; the caller may complete the pair, and the
// executor refuses a pair that contradicts the plan.
export function parseSnapshotOverride(value) {
	if (value === undefined || value === null) return null;
	const snapshot = requirePlainObject(value, "snapshot");
	const snapshotId = snapshot.snapshotId === undefined || snapshot.snapshotId === null ? null : requireNonEmptyString(snapshot.snapshotId, "snapshot.snapshotId");
	const snapshotFingerprint =
		snapshot.snapshotFingerprint === undefined || snapshot.snapshotFingerprint === null
			? null
			: requireNonEmptyString(snapshot.snapshotFingerprint, "snapshot.snapshotFingerprint");
	if (!snapshotId && !snapshotFingerprint) {
		throw executorError(400, EXECUTOR_ERROR_CODES.MISSING_IDENTITY, "A snapshot override must supply at least one identity field.", {
			field: "snapshot",
		});
	}
	return { snapshotId, snapshotFingerprint };
}
