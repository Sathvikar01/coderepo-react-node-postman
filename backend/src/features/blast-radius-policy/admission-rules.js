// Phase 45A — deterministic admission rules.
//
// Precedence (first matching rule wins, evaluated per request and then
// re-evaluated with running budgets):
//
//   1. BLOCKED  — environment not in a configured allowlist
//   2. BLOCKED  — mutating request while `allowMutating` is explicitly false
//   3. BLOCKED  — method not in a configured method allowlist
//   4. BLOCKED  — method classification is UNKNOWN
//   5. UNKNOWN  — host unresolved, or host not in a configured host allowlist
//   6. BLOCKED  — total-request budget exhausted (zero or reached)
//   7. BLOCKED  — mutating-request budget exhausted
//   8. BLOCKED  — per-host budget exhausted
//   9. REQUIRES_CONFIRMATION — mutating and confirmation demanded by policy
//  10. ADMITTED — everything the policy can prove
//
// Invariants:
//   * UNKNOWN never becomes ADMITTED.
//   * A blocked request never consumes a budget, so the budget reflects what a
//     rehearsal could actually start rather than what was proposed.
//   * Mutating does not automatically mean unsafe; it may be ADMITTED when the
//     policy permits mutation and does not demand confirmation.

import { ADMISSION_STATES, REASON_CODES, REQUEST_CLASSIFICATIONS } from "./reason-codes.js";
import { classifyMethod, isMutatingClassification } from "./request-classification.js";

/**
 * Evaluate whether the target environment is admissible.
 *
 * @returns {{state: string, reasons: string[]}}
 */
function evaluateEnvironment(policy, targetEnvironmentId) {
	if (!policy.allowedEnvironmentIds.configured) {
		// No environment allowlist: nothing to enforce, and we do not invent one.
		return { state: ADMISSION_STATES.ADMITTED, reasons: [] };
	}
	const allowed = policy.allowedEnvironmentIds.values.includes(targetEnvironmentId);
	if (allowed) return { state: ADMISSION_STATES.ADMITTED, reasons: [] };
	return { state: ADMISSION_STATES.BLOCKED, reasons: [REASON_CODES.ENVIRONMENT_NOT_ALLOWED] };
}

function limitReached(limit, used) {
	return limit.configured && used >= limit.value;
}

/**
 * Admit a single request against the normalized policy and the budgets that
 * earlier requests in the (semantically ordered) set have already consumed.
 *
 * Pure: it reads `budgets` but performs no mutation. The caller applies the
 * returned reservation.
 *
 * @param {object} args
 * @param {object} args.request normalized request descriptor
 * @param {object} args.policy normalized policy
 * @param {{total: number, mutating: number, perHost: Map<string, number>}} args.budgets
 * @returns {{state: string, reasons: string[], reservesTotal: boolean,
 *   reservesMutating: boolean, hostKey: string|null}}
 */
export function admitRequest({ request, policy, budgets }) {
	const classification = classifyMethod(request.method);
	const mutating = isMutatingClassification(classification);
	const host = request.hostIdentity;

	// 1. Method allowlist (checked before classification-independent rules so a
	//    disallowed custom method reports the explicit violation).
	if (policy.allowedMethods.configured && !policy.allowedMethods.values.includes(request.method)) {
		return blocked([REASON_CODES.METHOD_NOT_ALLOWED], { classification, mutating, host });
	}

	// 2. Explicit "no mutation" policy.
	if (mutating && policy.allowMutatingConfigured && policy.allowMutating !== true) {
		return blocked([REASON_CODES.MUTATING_REQUEST_NOT_ALLOWED], { classification, mutating, host });
	}

	// 3. Unknown methods are never safe.
	if (classification === REQUEST_CLASSIFICATIONS.UNKNOWN) {
		return blocked([REASON_CODES.UNKNOWN_METHOD], { classification, mutating, host });
	}

	// 4. Host resolution and host allowlist.
	if (!host.resolved) {
		return unknown([REASON_CODES.UNKNOWN_HOST], { classification, mutating, host });
	}
	if (policy.allowedHosts.configured) {
		if (!policy.allowedHosts.values.includes(host.host)) {
			return blocked([REASON_CODES.HOST_NOT_ALLOWED], { classification, mutating, host });
		}
	}

	// 5. Budgets. A request that cannot fit any budget is blocked and consumes
	//    nothing, so later requests still see the true remaining capacity.
	const totalUsed = budgets.total;
	const mutatingUsed = budgets.mutating;
	const hostUsed = budgets.perHost.get(host.key) ?? 0;

	const reasons = [];
	if (limitReached(policy.limits.maxTotalRequests, totalUsed)) reasons.push(REASON_CODES.REQUEST_LIMIT_EXCEEDED);
	if (mutating && limitReached(policy.limits.maxMutatingRequests, mutatingUsed)) {
		reasons.push(REASON_CODES.MUTATING_LIMIT_EXCEEDED);
	}
	if (limitReached(policy.limits.maxRequestsPerHost, hostUsed)) reasons.push(REASON_CODES.HOST_REQUEST_LIMIT_EXCEEDED);
	if (reasons.length > 0) {
		return blocked(reasons, { classification, mutating, host });
	}

	// 6. Mutation permitted only with an explicit confirmation.
	if (mutating && policy.requireMutatingConfirmation) {
		return {
			state: ADMISSION_STATES.REQUIRES_CONFIRMATION,
			reasons: [REASON_CODES.MUTATING_CONFIRMATION_REQUIRED],
			classification,
			mutating,
			host,
			reservesTotal: true,
			reservesMutating: true,
		};
	}

	return {
		state: ADMISSION_STATES.ADMITTED,
		reasons: [],
		classification,
		mutating,
		host,
		reservesTotal: true,
		reservesMutating: mutating,
	};
}

function blocked(reasons, context) {
	return {
		state: ADMISSION_STATES.BLOCKED,
		reasons,
		classification: context.classification,
		mutating: context.mutating,
		host: context.host,
		reservesTotal: false,
		reservesMutating: false,
	};
}

function unknown(reasons, context) {
	return {
		state: ADMISSION_STATES.UNKNOWN,
		reasons,
		classification: context.classification,
		mutating: context.mutating,
		host: context.host,
		reservesTotal: false,
		reservesMutating: false,
	};
}

export { evaluateEnvironment };
