// Phase 41A — Cross-Environment Verification Core.
//
// One place for the comparison primitives every module shares, so ordering is
// identical everywhere and byte-stable output is a structural property rather than
// something each module re-implements.

export function compareStrings(left, right) {
	const a = String(left ?? "");
	const b = String(right ?? "");
	return a < b ? -1 : a > b ? 1 : 0;
}

// Sorts a list of ids into the canonical order used by every id array in the
// verification result.
export function sortedIds(ids) {
	return [...new Set((ids ?? []).map((id) => String(id)))].filter((id) => id.length > 0).sort(compareStrings);
}

// Sort key for a finding, so finding order is deterministic and independent of the
// order rules happened to fire in.
export function findingSortKey(finding) {
	return [finding.code, finding.requestId ?? "", finding.evidenceId ?? "", finding.collectionId ?? ""].join("\u0000");
}

export function sortFindings(findings) {
	return [...findings].sort((left, right) => compareStrings(findingSortKey(left), findingSortKey(right)));
}
