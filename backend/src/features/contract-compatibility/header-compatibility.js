import { COMPATIBILITY_CODES, classForCode } from "./compatibility-schema.js";
import { isSensitiveHeader } from "../contract-registry/contract-schema.js";

// Phase 43A — Response header comparison.
//
// Compares only the headers the contract explicitly registers. An unregistered
// observed header is not a finding: a contract asserts what it cares about, and a
// response carrying extra headers is normal.
//
// Header comparison is case-insensitive, because HTTP field names are. Duplicate
// observed headers are folded by the normalizer before reaching here, so a repeated
// header cannot produce a duplicate finding.

// Build a finding with the class derived from the code table, so a rule site cannot
// disagree with the vocabulary.
function finding(code, { path, contractPath = null, parentPath = null, expected, actual }) {
	return {
		code,
		class: classForCode(code),
		path,
		contractPath,
		parentPath,
		expected,
		actual,
	};
}

function severityFor(code) {
	const cls = classForCode(code);
	if (cls === "BREAKING") return "breaking";
	if (cls === "UNKNOWN") return "unknown";
	return "non_breaking";
}

// Compare one expected header against the observed response.
//
// Semantics:
//   * A contract header marked `required` that is absent is BREAKING.
//   * A contract header not marked `required` that is absent is recorded as
//     NON_BREAKING only when the contract also declares an expected value; a purely
//     present-only optional header that is absent produces no finding at all.
//   * A contract header that declares an expected value compares that value. Values
//     are compared exactly (after trimming surrounding whitespace), because Phase 42
//     has no header-value wildcard or pattern vocabulary.
//
// A sensitive header can never reach this function: normalization drops it first.
// The guard below is a second line of defence that skips rather than compares.
export function compareHeader(expectedHeader, observedHeaders) {
	if (!expectedHeader || typeof expectedHeader.name !== "string" || expectedHeader.name.length === 0) return [];
	const name = expectedHeader.name.trim();
	const lower = name.toLowerCase();
	if (isSensitiveHeader(lower)) return [];

	const contractPath = `$.headers[${lower}]`;
	const path = `headers.${lower}`;
	const observed = observedHeaders.get(lower) ?? null;

	// Presence-only expectation (no declared value).
	if (expectedHeader.value === null || expectedHeader.value === undefined) {
		if (observed) {
			return [finding(COMPATIBILITY_CODES.RESPONSE_HEADER_PRESENT, { path, contractPath, expected: "present", actual: "present" })];
		}
		// An optional, presence-only header that is absent is not a compatibility claim.
		if (!expectedHeader.required) return [];
		return [finding(COMPATIBILITY_CODES.RESPONSE_HEADER_MISSING, { path, contractPath, expected: "present", actual: "absent" })];
	}

	// Value expectation. The value is echoed only when it is not credential-bearing;
	// Phase 42 refuses credential-shaped header values, so this is a defence in depth
	// and never the primary guarantee.
	const expectedValue = String(expectedHeader.value).trim();

	if (!observed) {
		// A declared value implies the header must be present to be satisfied. This is
		// true whether or not `required` was also set: a contract that pins a value is
		// asserting the header exists.
		return [finding(COMPATIBILITY_CODES.RESPONSE_HEADER_MISSING, { path, contractPath, expected: expectedValue, actual: "absent" })];
	}

	const actualValue = observed.value === null ? "" : String(observed.value).trim();
	if (actualValue === expectedValue) {
		return [
			finding(COMPATIBILITY_CODES.RESPONSE_HEADER_VALUE_MATCHES, {
				path,
				contractPath,
				expected: expectedValue,
				actual: actualValue,
			}),
		];
	}
	return [
		finding(COMPATIBILITY_CODES.RESPONSE_HEADER_VALUE_CHANGED, {
			path,
			contractPath,
			expected: expectedValue,
			actual: actualValue,
		}),
	];
}

// Compare every prompt-registered contract header. Findings are not sorted here;
// ordering is imposed once at result construction.
export function compareHeaders(expectedHeaders = [], observedHeaders = new Map()) {
	const findings = [];
	for (const expectedHeader of expectedHeaders) findings.push(...compareHeader(expectedHeader, observedHeaders));
	return findings;
}

export { severityFor };
