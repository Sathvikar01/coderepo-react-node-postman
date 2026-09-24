import { COMPATIBILITY_CODES, classForCode } from "./compatibility-schema.js";
import { compareHeaders } from "./header-compatibility.js";
import { compareBody } from "./body-compatibility.js";

// Phase 43A — Compatibility rules.
//
// Pure rules over the contract and the normalized observed response. Each rule
// takes facts and returns typed findings; none of them reads a clock, a database,
// the network, or the environment. Ordering is not imposed here — it is imposed
// once at result construction.

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

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
//
// A Phase-42 contract declares either a single expected status or an allowed set.
// The observed status must be in that set. The set is authoritative: the engine
// never widens it from an observation and never narrows it to one sample.
export function evaluateStatus(contractBody, observedStatus) {
	const allowed = new Set();
	if (typeof contractBody?.status === "number") allowed.add(contractBody.status);
	for (const code of contractBody?.statuses ?? []) if (typeof code === "number") allowed.add(code);
	if (allowed.size === 0) return [];

	const allowedList = [...allowed].sort((left, right) => left - right);
	if (allowed.has(observedStatus)) {
		return [
			finding(COMPATIBILITY_CODES.STATUS_ALLOWED, {
				path: "status",
				contractPath: "$.body.status",
				expected: allowedList,
				actual: observedStatus,
			}),
		];
	}
	return [
		finding(COMPATIBILITY_CODES.STATUS_NOT_ALLOWED, {
			path: "status",
			contractPath: "$.body.status",
			expected: allowedList,
			actual: observedStatus,
		}),
	];
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
//
// The caller may attach request/workspace/profile identity to a sample. Where the
// caller supplies an identity that contradicts the contract, the comparison is
// refused: comparing another request's response against this contract would
// produce a confident result about the wrong thing.
//
// The check is one-directional on purpose. The engine rejects a *contradiction*;
// it never requires an identity the caller did not supply, because a contract
// comparison is meaningful with only a contract and a body.
export const IDENTITY_CODES = Object.freeze({
	REQUEST_MISMATCH: "COMPATIBILITY_REQUEST_MISMATCH",
	WORKSPACE_MISMATCH: "COMPATIBILITY_WORKSPACE_MISMATCH",
	PROFILE_MISMATCH: "COMPATIBILITY_PROFILE_MISMATCH",
	COLLECTION_MISMATCH: "COMPATIBILITY_COLLECTION_MISMATCH",
	SNAPSHOT_MISMATCH: "COMPATIBILITY_SNAPSHOT_MISMATCH",
});

function sameId(left, right) {
	if (left === null || left === undefined || right === null || right === undefined) return true;
	return String(left) === String(right);
}

// Returns a list of contradictions. An empty list means the supplied identity is
// consistent with the contract (or was not supplied).
export function evaluateIdentity(contract, observedIdentity) {
	if (!observedIdentity || !contract) return [];
	const mismatches = [];

	if (!sameId(observedIdentity.requestId, contract.requestId))
		mismatches.push({ code: IDENTITY_CODES.REQUEST_MISMATCH, field: "requestId", expected: contract.requestId ?? null, actual: observedIdentity.requestId ?? null });
	if (!sameId(observedIdentity.workspaceId, contract.workspaceId))
		mismatches.push({ code: IDENTITY_CODES.WORKSPACE_MISMATCH, field: "workspaceId", expected: contract.workspaceId ?? null, actual: observedIdentity.workspaceId ?? null });
	if (!sameId(observedIdentity.collectionId, contract.collectionId))
		mismatches.push({ code: IDENTITY_CODES.COLLECTION_MISMATCH, field: "collectionId", expected: contract.collectionId ?? null, actual: observedIdentity.collectionId ?? null });
	if (!sameId(observedIdentity.profileId, contract.ownerProfileId))
		mismatches.push({ code: IDENTITY_CODES.PROFILE_MISMATCH, field: "ownerProfileId", expected: contract.ownerProfileId ?? null, actual: observedIdentity.profileId ?? null });
	if (!sameId(observedIdentity.snapshotId, contract.snapshotId))
		mismatches.push({ code: IDENTITY_CODES.SNAPSHOT_MISMATCH, field: "snapshotId", expected: contract.snapshotId ?? null, actual: observedIdentity.snapshotId ?? null });
	if (!sameId(observedIdentity.snapshotFingerprint, contract.snapshotFingerprint))
		mismatches.push({
			code: IDENTITY_CODES.SNAPSHOT_MISMATCH,
			field: "snapshotFingerprint",
			expected: contract.snapshotFingerprint ?? null,
			actual: observedIdentity.snapshotFingerprint ?? null,
		});

	return mismatches;
}

// ---------------------------------------------------------------------------
// Full comparison
// ---------------------------------------------------------------------------
//
// Runs every rule and returns raw findings plus the check counters the result
// summary needs. No filtering or ordering happens here.
export function runCompatibilityRules({ contract, observed }) {
	const contractBody = contract?.content?.body ?? null;
	const statusFindings = evaluateStatus(contractBody, observed.status);
	const headerFindings = compareHeaders(contractBody?.headers ?? [], observed.headers);
	const bodyFindings = compareBody({ contractBody, observed });

	// Counters describe what was actually examined, not what was found, so a clean
	// report can still say "0 headers checked" honestly.
	const statusChecked = statusFindings.length;
	const headersChecked = (contractBody?.headers ?? []).filter((header) => {
		const name = String(header?.name ?? "").trim().toLowerCase();
		return name.length > 0;
	}).length;
	// A body structure check runs when the contract describes one and the observed
	// body was interpretable, or when a body node exists and produced a finding.
	const bodyStructureChecked = bodyFindings.length > 0 ? 1 : 0;

	return {
		findings: [...statusFindings, ...headerFindings, ...bodyFindings],
		statusChecked,
		headersChecked,
		bodyStructureChecked,
	};
}
