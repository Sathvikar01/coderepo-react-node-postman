// Phase 45A — deterministic identity and policy normalization.
//
// Normalization exists so that equivalent inputs produce byte-stable output.
// It never widens a policy and never invents a value the caller did not supply.
//
// Normalized:
//   * host casing (lower-cased) and a trailing root dot stripped
//   * HTTP method casing (upper-cased)
//   * duplicate request references (collapsed, never double-counted)
//   * irrelevant input ordering (allowlists are sorted and de-duplicated)
//
// NOT normalized:
//   * execution ordering, when the caller supplies `dependsOn` semantics

import { BlastRadiusError } from "./blast-radius-schema.js";
import { BLAST_RADIUS_ERROR_CODES } from "./reason-codes.js";
import { isWellFormedMethod, normalizeMethod } from "./request-classification.js";

/**
 * Normalize a host identity supplied by the caller.
 *
 * This is pure string normalization. The engine never resolves DNS and never
 * consults the network. A caller must hand us an already-normalized identity;
 * we only make it case- and root-dot stable.
 *
 * @param {unknown} host
 * @returns {string} normalized host, or "" when the host cannot be normalized
 */
export function normalizeHost(host) {
	if (typeof host !== "string") return "";
	let value = host.trim().toLowerCase();
	if (!value) return "";
	// Strip a single trailing root dot, as in "example.test.".
	if (value.endsWith(".") && value.length > 1) value = value.slice(0, -1);
	// Reject values that are clearly not host identities. A host identity is
	// composed of labels separated by dots; each label is a letter/digit/hyphen
	// run that must start and end with a letter or digit.
	if (value.length > 253) return "";
	if (!/^[a-z0-9\-._]+$/.test(value)) return "";
	if (value.includes("..")) return "";
	for (const label of value.split(".")) {
		if (!label) return "";
		if (label.length > 63) return "";
		if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return "";
	}
	return value;
}

/**
 * Build a normalized host key including an optional port.
 *
 * @param {string} host
 * @param {number|null|undefined} port
 * @returns {string} stable host key, e.g. "api.example.test:8443"
 */
export function hostKey(host, port) {
	const normalized = normalizeHost(host);
	if (!normalized) return "";
	if (port === null || port === undefined) return normalized;
	return `${normalized}:${port}`;
}

/**
 * Normalize a host identity record.
 *
 * @param {{host?: unknown, port?: unknown}|null|undefined} identity
 * @returns {{host: string, port: number|null, key: string, resolved: boolean}}
 */
export function normalizeHostIdentity(identity) {
	if (!identity || typeof identity !== "object") {
		return { host: "", port: null, key: "", resolved: false };
	}
	const host = normalizeHost(identity.host);
	const port =
		typeof identity.port === "number" && Number.isInteger(identity.port) && identity.port >= 1 && identity.port <= 65535
			? identity.port
			: null;
	if (!host) return { host: "", port, key: "", resolved: false };
	return { host, port, key: hostKey(host, port), resolved: true };
}

/**
 * Normalize a method allowlist entry. Malformed entries are dropped rather
 * than silently accepted, so an allowlist can never contain an unreachable
 * token that would widen admission.
 *
 * @param {unknown[]} methods
 * @returns {string[]} sorted, de-duplicated, well-formed method tokens
 */
export function normalizeMethodList(methods) {
	if (!Array.isArray(methods)) return [];
	const seen = new Set();
	for (const method of methods) {
		if (!isWellFormedMethod(method)) continue;
		seen.add(normalizeMethod(method));
	}
	return [...seen].sort();
}

/**
 * Normalize an identifier allowlist (environments, hosts).
 *
 * @param {unknown[]} values
 * @param {(value: string) => string} normalizer
 * @returns {string[]} sorted, de-duplicated values
 */
export function normalizeIdList(values, normalizer) {
	if (!Array.isArray(values)) return [];
	const seen = new Set();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const normalized = normalizer(value);
		if (!normalized) continue;
		seen.add(normalized);
	}
	return [...seen].sort();
}

/**
 * Describe a tri-state limit.
 *
 *   not configured -> { configured: false, value: null }
 *   configured (0 or n) -> { configured: true, value: n }
 *
 * The distinction between "not configured" and "configured with zero" is
 * preserved exactly; the engine never substitutes a default.
 */
export function describeLimit(value) {
	if (value === undefined || value === null) return { configured: false, value: null };
	return { configured: true, value };
}

/**
 * Produce the normalized policy object. The raw policy is never mutated.
 *
 * @param {object} policy
 * @returns {object} normalized policy
 */
export function normalizePolicy(policy) {
	const source = policy ?? {};
	const allowedEnvironmentIds = source.allowedEnvironmentIds
		? normalizeIdList(source.allowedEnvironmentIds, (value) => value.trim())
		: null;
	const allowedHosts = source.allowedHosts ? normalizeIdList(source.allowedHosts, normalizeHost) : null;

	return {
		allowedEnvironmentIds: allowedEnvironmentIds
			? { configured: true, values: allowedEnvironmentIds }
			: { configured: false, values: null },
		allowedHosts: allowedHosts ? { configured: true, values: allowedHosts } : { configured: false, values: null },
		allowedMethods: source.allowedMethods
			? { configured: true, values: normalizeMethodList(source.allowedMethods) }
			: { configured: false, values: null },
		allowMutating: source.allowMutating === true,
		allowMutatingConfigured: source.allowMutating !== undefined,
		requireMutatingConfirmation: source.requireMutatingConfirmation === true,
		stopOnCriticalFailure: source.stopOnCriticalFailure === true,
		limits: {
			maxTotalRequests: describeLimit(source.maxTotalRequests),
			maxMutatingRequests: describeLimit(source.maxMutatingRequests),
			maxRequestsPerHost: describeLimit(source.maxRequestsPerHost),
			maxFailures: describeLimit(source.maxFailures),
			maxConsecutiveFailures: describeLimit(source.maxConsecutiveFailures),
		},
	};
}

/**
 * Normalize the proposed request set.
 *
 * Duplicate request IDs are a typed error. The engine refuses to guess which
 * of the duplicates the caller meant, and it must never double-count limits,
 * so the only safe behavior is to fail closed.
 *
 * @param {object[]} requests
 * @returns {object[]} normalized request descriptors, order of first
 *   appearance preserved
 */
export function normalizeRequests(requests) {
	const normalized = [];
	const seen = new Map();

	requests.forEach((request, index) => {
		const requestId = typeof request.requestId === "string" ? request.requestId.trim() : "";
		if (!requestId) {
			throw new BlastRadiusError(
				BLAST_RADIUS_ERROR_CODES.MISSING_IDENTITY,
				"Every proposed request must carry a non-empty requestId.",
				{ index },
			);
		}
		if (seen.has(requestId)) {
			throw new BlastRadiusError(
				BLAST_RADIUS_ERROR_CODES.DUPLICATE_REQUEST_ID,
				`Duplicate requestId "${requestId}" in the proposed request set.`,
				{ requestId, firstIndex: seen.get(requestId), duplicateIndex: index },
			);
		}
		seen.set(requestId, index);

		const dependsOn = Array.isArray(request.dependsOn)
			? [...new Set(request.dependsOn.map((id) => String(id).trim()).filter(Boolean))]
			: null;

		normalized.push({
			requestId,
			method: normalizeMethod(request.method),
			rawMethod: typeof request.method === "string" ? request.method : "",
			hostIdentity: normalizeHostIdentity(request.host),
			dependsOn,
			index,
		});
	});

	return normalized;
}
