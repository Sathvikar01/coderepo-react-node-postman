// Phase 45A — blast-radius policy service.
//
// Public API (the future integration seam):
//
//   Change Impact  ->  BlastRadiusPolicy  ->  Checkpointed Rehearsal
//
// `evaluateBlastRadius(input)` consumes a change-impact-shaped proposal
// (workspace/snapshot identity, environment identity, proposed request set)
// and returns a stable safety envelope. `evaluateAbort(progress)` is the
// matching runtime guard. Neither function executes HTTP requests, resolves
// DNS, or touches persistence.
//
// The core is pure and injectable: every dependency is a plain function, so a
// caller can supply its own clock-free determinism or wrap the service without
// reaching into internals.

import {
	BLAST_RADIUS_POLICY_KIND,
	BLAST_RADIUS_POLICY_VERSION,
	BlastRadiusError,
	assertPolicyConsistent,
	parseBlastRadiusInput,
} from "./blast-radius-schema.js";
import { REQUEST_CLASSIFICATIONS, BLAST_RADIUS_ERROR_CODES, ADMISSION_STATES } from "./reason-codes.js";
import { admitRequest, evaluateEnvironment } from "./admission-rules.js";
import { buildEnvelope, buildExecutionEntry, buildResultEntry } from "./execution-envelope.js";
import { normalizePolicy, normalizeRequests } from "./policy-normalization.js";
import { classifyMethod, isMutatingClassification } from "./request-classification.js";

export { evaluateAbort } from "./abort-evaluator.js";

/**
 * Stable identity for a policy. The identity is a deterministic digest of the
 * normalized policy so equivalent policies share an identity and different
 * policies never collide.
 *
 * @param {object} normalizedPolicy
 * @returns {string}
 */
export function policyIdentity(normalizedPolicy) {
	return stableHash(canonicalJson(normalizedPolicy));
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

// FNV-1a, 32-bit, hex. Small, dependency-free, and byte-stable across runs.
function stableHash(text) {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Compute the effective limits block, preserving tri-state semantics.
 */
function effectiveLimitsOf(policy) {
	return {
		maxTotalRequests: policy.limits.maxTotalRequests,
		maxMutatingRequests: policy.limits.maxMutatingRequests,
		maxRequestsPerHost: policy.limits.maxRequestsPerHost,
		maxFailures: policy.limits.maxFailures,
		maxConsecutiveFailures: policy.limits.maxConsecutiveFailures,
		allowMutating: {
			configured: policy.allowMutatingConfigured,
			value: policy.allowMutatingConfigured ? policy.allowMutating : null,
		},
		requireMutatingConfirmation: {
			configured: true,
			value: policy.requireMutatingConfirmation,
		},
		stopOnCriticalFailure: {
			configured: true,
			value: policy.stopOnCriticalFailure,
		},
	};
}

/**
 * Derive the declared abort conditions from the policy, so the envelope tells
 * a runner exactly when it must stop even before the first request is sent.
 */
function abortConditionsOf(policy) {
	const conditions = [];
	if (policy.limits.maxFailures.configured) {
		conditions.push({ reasonCode: "FAILURE_LIMIT_REACHED", limit: "maxFailures", value: policy.limits.maxFailures.value });
	}
	if (policy.limits.maxConsecutiveFailures.configured) {
		conditions.push({
			reasonCode: "CONSECUTIVE_FAILURE_LIMIT_REACHED",
			limit: "maxConsecutiveFailures",
			value: policy.limits.maxConsecutiveFailures.value,
		});
	}
	if (policy.stopOnCriticalFailure) {
		conditions.push({ reasonCode: "CRITICAL_FAILURE", limit: "stopOnCriticalFailure", value: true });
	}
	return conditions.sort((left, right) => left.reasonCode.localeCompare(right.reasonCode));
}

/**
 * Evaluate the safety envelope for a proposed rehearsal.
 *
 * @param {object} input structured blast-radius input
 * @returns {object} stable machine-readable envelope
 */
export function evaluateBlastRadius(input) {
	const parsed = parseBlastRadiusInput(input);
	assertPolicyConsistent(parsed.policy);

	if (!parsed.workspaceId || !parsed.workspaceId.trim()) {
		throw new BlastRadiusError(
			BLAST_RADIUS_ERROR_CODES.MISSING_IDENTITY,
			"A blast-radius evaluation requires a workspaceId.",
			{ field: "workspaceId" },
		);
	}
	if (!parsed.environmentId || !parsed.environmentId.trim()) {
		throw new BlastRadiusError(
			BLAST_RADIUS_ERROR_CODES.MISSING_IDENTITY,
			"A blast-radius evaluation requires an environmentId.",
			{ field: "environmentId" },
		);
	}

	const workspaceId = parsed.workspaceId.trim();
	const snapshotId = parsed.snapshotId ? parsed.snapshotId.trim() : null;
	const environmentId = parsed.environmentId.trim();
	// The rehearsal target defaults to the environment when the caller has not
	// named a separate target. This is an identity resolution, not a policy
	// widening: the environment allowlist still applies to the resolved value.
	const targetEnvironmentId =
		parsed.targetEnvironmentId === undefined || parsed.targetEnvironmentId === null
			? environmentId
			: parsed.targetEnvironmentId.trim();

	const policy = normalizePolicy(parsed.policy);
	const requests = normalizeRequests(parsed.requests);

	// Environment is a set-level decision. When it fails, every request is
	// blocked for the same reason and no budget is consumed.
	const environmentDecision = evaluateEnvironment(policy, targetEnvironmentId);
	const environmentBlocked = environmentDecision.state === ADMISSION_STATES.BLOCKED;

	const budgets = { total: 0, mutating: 0, perHost: new Map() };
	const entries = [];
	const executionEntries = [];
	const violationMap = new Map();
	const confirmationMap = new Map();
	const unknownMap = new Map();

	requests.forEach((request, ordinal) => {
		const classification = classifyMethod(request.method);
		const mutating = isMutatingClassification(classification);

		const decision = environmentBlocked
			? {
					state: ADMISSION_STATES.BLOCKED,
					reasons: [...environmentDecision.reasons],
					classification,
					mutating,
					host: request.hostIdentity,
					reservesTotal: false,
					reservesMutating: false,
				}
			: admitRequest({ request, policy, budgets });

		entries.push(buildResultEntry({ request, decision, ordinal }));

		if (decision.state === ADMISSION_STATES.ADMITTED) {
			executionEntries.push(buildExecutionEntry({ request, decision }));
		} else {
			// Requests needing confirmation are still enumerable for a rehearsal
			// engine to gate, but they are not admitted to run unprompted.
			executionEntries.push({ ...buildExecutionEntry({ request, decision }), admission: decision.state });
		}

		if (decision.state === ADMISSION_STATES.BLOCKED) {
			for (const reason of decision.reasons) {
				register(violationMap, reason, { requestId: request.requestId, host: decision.host.host || null, method: request.method || null });
			}
		}
		if (decision.state === ADMISSION_STATES.REQUIRES_CONFIRMATION) {
			for (const reason of decision.reasons) {
				register(confirmationMap, reason, { requestId: request.requestId, host: decision.host.host || null, method: request.method || null });
			}
		}
		if (decision.state === ADMISSION_STATES.UNKNOWN) {
			for (const reason of decision.reasons) {
				register(unknownMap, reason, { requestId: request.requestId, host: decision.host.host || null, method: request.method || null });
			}
		}

		if (decision.reservesTotal) budgets.total += 1;
		if (decision.reservesMutating) budgets.mutating += 1;
		if (decision.reservesTotal && decision.host.resolved) {
			budgets.perHost.set(decision.host.key, (budgets.perHost.get(decision.host.key) ?? 0) + 1);
		}
	});

	// Three disjoint buckets. An UNKNOWN-method request is neither mutating nor
	// non-mutating: its mutability is not proven, so counting it as
	// "nonMutating" would overstate what the policy actually cleared.
	const counts = {
		mutating: entries.filter((entry) => entry.classification === REQUEST_CLASSIFICATIONS.MUTATING).length,
		nonMutating: entries.filter((entry) => entry.classification === REQUEST_CLASSIFICATIONS.NON_MUTATING).length,
		unknown: entries.filter((entry) => entry.classification === REQUEST_CLASSIFICATIONS.UNKNOWN).length,
	};

	const reasonCodes = [...new Set(entries.flatMap((entry) => entry.reasonCodes))].sort();

	return buildEnvelope({
		workspaceId,
		snapshotId,
		environmentId,
		targetEnvironmentId,
		policyRef: {
			kind: BLAST_RADIUS_POLICY_KIND,
			version: BLAST_RADIUS_POLICY_VERSION,
			identity: policyIdentity(policy),
		},
		admissionState: deriveAdmissionState(entries),
		entries,
		executionEntries,
		effectiveLimits: effectiveLimitsOf(policy),
		violations: materialize(violationMap),
		confirmations: materialize(confirmationMap),
		abortConditions: abortConditionsOf(policy),
		reasonCodes,
		classificationCounts: counts,
	});
}

function register(map, reason, detail) {
	if (!map.has(reason)) map.set(reason, []);
	map.get(reason).push(detail);
}

function materialize(map) {
	return [...map.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([reasonCode, requests]) => ({
			reasonCode,
			count: requests.length,
			requestIds: requests.map((request) => request.requestId),
		}));
}

/**
 * Set-level admission state. UNKNOWN outranks ADMITTED but never becomes
 * ADMITTED; BLOCKED outranks UNKNOWN because it is an explicit violation.
 */
function deriveAdmissionState(entries) {
	if (entries.length === 0) return ADMISSION_STATES.UNKNOWN;
	if (entries.some((entry) => entry.admission === ADMISSION_STATES.BLOCKED)) return ADMISSION_STATES.BLOCKED;
	if (entries.some((entry) => entry.admission === ADMISSION_STATES.UNKNOWN)) return ADMISSION_STATES.UNKNOWN;
	if (entries.some((entry) => entry.admission === ADMISSION_STATES.REQUIRES_CONFIRMATION)) {
		return ADMISSION_STATES.REQUIRES_CONFIRMATION;
	}
	return ADMISSION_STATES.ADMITTED;
}

export { canonicalJson as blastRadiusCanonicalJson };
