/**
 * Phase 31 — Counterfactual Cause Verification.
 *
 * Versioned result model plus the secret-safety primitives shared by the
 * delta compiler, the pure verification engine, and the service wrapper.
 *
 * Everything in this directory is additive: it reads execution receipts and
 * request definitions through the existing execution-intelligence boundary and
 * never mutates Phase 27 contracts or the shared `run-comparison` module.
 */

export const COUNTERFACTUAL_VERSION = 1;
export const COUNTERFACTUAL_KIND = "tracer.counterfactual-result";
export const COUNTERFACTUAL_INTERVENTION_KIND = "tracer.counterfactual-intervention";

/** Hard ceiling on probes per analysis (baseline + interventions). */
export const COUNTERFACTUAL_MAX_PROBES = 24;

/** Methods that may be replayed automatically without an explicit opt-in. */
export const COUNTERFACTUAL_SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/** Matches credential-ish names in headers, query rows, and JSON keys. */
const SENSITIVE_NAME = /(^|[-_.])(auth|authorization|cookie|key|password|passwd|secret|session|token|credential)([-_.]|$)/i;

/** Placeholder the capsule/import layers use for values they refuse to resolve. */
export const REQUIRED_INPUT_PLACEHOLDER = "[REQUIRED_INPUT]";

const SECRET_VALUE_PATTERNS = [
	/^Bearer\s+\S+/i,
	/^Basic\s+[A-Za-z0-9+/=]{4,}/i,
	/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
	/^(sk|pk|ghp|gho|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_-]{12,}$/i,
	// Long opaque token-like runs (hex/base64/JWT segments) are treated as
	// secrets so we fail closed instead of echoing a resolved credential.
	/[A-Za-z0-9+/_=-]{40,}/,
];

export function isSensitiveName(name) {
	return SENSITIVE_NAME.test(String(name ?? ""));
}

export function isSecretValue(value) {
	const text = String(value ?? "");
	if (text.includes(REQUIRED_INPUT_PLACEHOLDER)) return true;
	return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

/** A field is unsafe to replay when either its name or its value looks secret. */
export function isSecretField(name, value) {
	return isSensitiveName(name) || isSecretValue(value);
}

export const REDACTED = "[REDACTED]";

/**
 * Deterministic JSON encoding. Object keys are sorted so two semantically
 * equal requests produce the same probe-cache key and the same delta identity.
 */
export function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

export function canonicalEqual(left, right) {
	return canonicalJson(left) === canonicalJson(right);
}

export function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSafeMethod(method) {
	return COUNTERFACTUAL_SAFE_METHODS.includes(String(method ?? "").toUpperCase());
}
