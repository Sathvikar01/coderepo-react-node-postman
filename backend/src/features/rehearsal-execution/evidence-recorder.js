import { EXECUTOR_LIMITS } from "./executor-schema.js";

// Phase 46C — bounded evidence accumulator.
//
// The executor records two things per executed step: a Phase 41 execution-evidence
// record and, when a contract was comparable, a Phase 41 assertion-evidence record.
// The accumulator is deliberately dumb and bounded: it never invents a record and
// it never drops one silently. Overflow is reported so the caller can fail closed
// rather than present a truncated evidence set as complete.

function toIso(value) {
	if (value === undefined || value === null) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	if (typeof value === "string" && value) return value;
	return null;
}

export function buildExecutionEvidence(result, identity) {
	return {
		executionId: identity.executionId,
		requestId: identity.requestId,
		collectionId: identity.collectionId ?? null,
		workspaceId: identity.workspaceId ?? null,
		snapshotFingerprint: identity.snapshotFingerprint ?? null,
		snapshotId: identity.snapshotId ?? null,
		environmentId: identity.environmentId ?? null,
		environmentName: identity.environmentName ?? null,
		outcome: result?.outcome,
		complete: true,
		ownerProfileId: identity.ownerProfileId ?? null,
		startedAt: toIso(result?.startedAt),
		finishedAt: toIso(result?.finishedAt),
	};
}

export function createEvidenceRecorder({
	maxStepOutcomes = EXECUTOR_LIMITS.maxStepOutcomes,
	maxReasonCodes = EXECUTOR_LIMITS.maxReasonCodes,
} = {}) {
	const executions = [];
	const assertions = [];
	const stepOutcomes = [];
	const reasonCodes = [];
	let overflowed = false;

	function addReasonCode(code) {
		if (typeof code !== "string" || !code) return;
		if (reasonCodes.includes(code)) return;
		if (reasonCodes.length >= maxReasonCodes) {
			overflowed = true;
			return;
		}
		reasonCodes.push(code);
	}

	function push(bucket, record) {
		if (bucket.length >= maxStepOutcomes) {
			overflowed = true;
			return false;
		}
		bucket.push(record);
		return true;
	}

	return {
		addReasonCode,
		recordExecution(record) {
			return push(executions, record);
		},
		recordAssertion(record) {
			return push(assertions, record);
		},
		recordStepOutcome(record) {
			return push(stepOutcomes, record);
		},
		// The Phase 41 projection. Records are already bounded and redacted at
		// construction; this is a plain view, not a transformation.
		projection() {
			return { executions: [...executions], assertions: [...assertions] };
		},
		stepOutcomes() {
			return [...stepOutcomes];
		},
		reasonCodes() {
			return [...reasonCodes];
		},
		hasOverflowed() {
			return overflowed;
		},
	};
}
