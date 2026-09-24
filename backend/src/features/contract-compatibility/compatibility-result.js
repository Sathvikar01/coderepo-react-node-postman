import { fingerprintOf } from "../history/fingerprint.js";
import {
	COMPATIBILITY_KIND,
	COMPATIBILITY_SCHEMA_VERSION,
	COMPATIBILITY_CLASS,
	assertCompatibilityResult,
} from "./compatibility-schema.js";

// Phase 43A — Result construction and determinism.
//
// Turns raw rule output into the stable, machine-readable envelope the phase
// promises. Ordering and deduplication happen exactly once, here, so byte-stability
// is a structural property of the builder rather than something each rule has to
// remember.
//
// There is no prose: every field is a code, a path, a scalar, or a count.

// Stable string comparison that does not depend on locale or ICU data.
export function compareStrings(left, right) {
	const a = String(left ?? "");
	const b = String(right ?? "");
	return a < b ? -1 : a > b ? 1 : 0;
}

// Severity is derived from the class so a finding cannot disagree with itself.
export function severityOf(cls) {
	if (cls === COMPATIBILITY_CLASS.BREAKING) return "breaking";
	if (cls === COMPATIBILITY_CLASS.UNKNOWN) return "unknown";
	return "non_breaking";
}

// Sort key: path, then code, then a stable tie-breaker over the expected/actual
// scalars. The prompt requires ordering by path then reason code; the tie-breaker
// exists so two findings that share a path and code (for example two array items)
// still order deterministically.
export function findingSortKey(finding) {
	return [
		String(finding.path ?? ""),
		String(finding.code ?? ""),
		String(finding.contractPath ?? ""),
		scalarKey(finding.expected),
		scalarKey(finding.actual),
	].join("\u0000");
}

function scalarKey(value) {
	if (Array.isArray(value)) return `[${value.map(scalarKey).join(",")}]`;
	if (value === null || value === undefined) return "";
	return `${typeof value}:${String(value)}`;
}

// Stable, order-independent key used to remove duplicate findings. Two findings
// that agree on every meaningful field are the same claim, however they arose.
function dedupeKey(finding) {
	return [finding.code, finding.path, finding.contractPath ?? "", finding.parentPath ?? "", scalarKey(finding.expected), scalarKey(finding.actual)].join(
		"\u0000",
	);
}

export function dedupeFindings(findings) {
	const byKey = new Map();
	for (const finding of findings) {
		const key = dedupeKey(finding);
		if (!byKey.has(key)) byKey.set(key, normalizeFinding(finding));
	}
	return [...byKey.values()];
}

// Normalize a raw finding into the exact serialized shape, deriving severity from
// the class so the two can never drift.
function normalizeFinding(finding) {
	return {
		code: finding.code,
		class: finding.class,
		path: String(finding.path ?? ""),
		contractPath: finding.contractPath ?? null,
		parentPath: finding.parentPath ?? null,
		expected: normalizeScalar(finding.expected),
		actual: normalizeScalar(finding.actual),
		severity: severityOf(finding.class),
	};
}

// Reduce any value to something the finding schema can carry. A structural value is
// summarized as its type so an observed body can never be echoed wholesale into a
// report (which is both a size and a secret-leak risk).
function normalizeScalar(value) {
	if (Array.isArray(value)) {
		// Enum expectations are the only array-valued field the vocabulary produces.
		return value.map((item) => (item === null || ["string", "number", "boolean"].includes(typeof item) ? item : typeof item));
	}
	if (value === null || value === undefined) return null;
	if (["string", "number", "boolean"].includes(typeof value)) return value;
	return typeof value;
}

export function sortFindings(findings) {
	return [...findings].sort((left, right) => compareStrings(findingSortKey(left), findingSortKey(right)));
}

// Resolve the aggregate `compatible` flag.
//
// Positive compatibility requires at least one satisfied check and no objection.
// An empty report is therefore NOT compatible: the engine refuses to assert
// compatibility it did not establish.
export function resolveCompatible(findings) {
	const breaking = findings.filter((finding) => finding.class === COMPATIBILITY_CLASS.BREAKING).length;
	const unknown = findings.filter((finding) => finding.class === COMPATIBILITY_CLASS.UNKNOWN).length;
	const nonBreaking = findings.filter((finding) => finding.class === COMPATIBILITY_CLASS.NON_BREAKING).length;
	if (breaking > 0 || unknown > 0) return false;
	return nonBreaking > 0;
}

// Build the final result. The result fingerprint commits to the content that
// defines this comparison — contract identity, observed identity, and the ordered
// findings — so identical inputs produce an identical fingerprint and a changed
// finding changes it.
export function buildCompatibilityResult({ contract, observed, findings, statusChecked, headersChecked, bodyStructureChecked }) {
	const ordered = sortFindings(dedupeFindings(findings));

	const summary = {
		total: ordered.length,
		breaking: ordered.filter((finding) => finding.class === COMPATIBILITY_CLASS.BREAKING).length,
		nonBreaking: ordered.filter((finding) => finding.class === COMPATIBILITY_CLASS.NON_BREAKING).length,
		unknown: ordered.filter((finding) => finding.class === COMPATIBILITY_CLASS.UNKNOWN).length,
		statusChecked,
		headersChecked,
		bodyStructureChecked,
	};

	const compatible = resolveCompatible(ordered);

	const contractIdentity = {
		contractId: contract.contractId,
		sequence: contract.sequence,
		state: contract.state,
		contentFingerprint: contract.contentFingerprint,
		fingerprintKeyId: contract.fingerprintKeyId,
		requestId: contract.requestId,
		profileId: contract.ownerProfileId ? String(contract.ownerProfileId) : null,
	};

	const observedIdentity = {
		status: observed.status,
		executionId: observed.identity?.executionId ?? null,
		label: observed.identity?.label ?? null,
	};

	const resultFingerprint = fingerprintOf({
		kind: COMPATIBILITY_KIND,
		contract: contractIdentity,
		observed: observedIdentity,
		compatible,
		findings: ordered,
		summary,
	});

	const result = {
		schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
		kind: COMPATIBILITY_KIND,
		resultFingerprint,
		contract: contractIdentity,
		observed: observedIdentity,
		compatible,
		findings: ordered,
		summary,
	};

	// Validate our own output before returning it: a malformed result is a bug, not
	// data, and it must fail loudly rather than leak an inconsistent shape.
	return assertCompatibilityResult(result);
}
