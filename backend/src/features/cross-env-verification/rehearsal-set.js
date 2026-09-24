import { compareStrings } from "./ordering.js";

// Phase 41A — Minimal rehearsal set.
//
// The smallest deterministic set of requests that must be rehearsed before the
// move can be verified. There is no heuristics and no scoring: the rules below are
// the whole algorithm, and they are exhaustive over the impact rows a
// change-impact result can produce.
//
// Rules:
//   * direct impact row                    -> required
//   * indirect impact row with exact
//     confidence                           -> optional (proven reachable, not proven
//                                             to matter; the caller may still
//                                             rehearse it, but it does not block)
//   * indirect impact row with conditional
//     or unknown confidence                -> required (cannot be proven irrelevant)
//   * unaffected request                   -> not required
//   * unknown/dynamic dependency           -> the boundary request it names is
//                                             required; when the boundary is not
//                                             identifiable the whole rehearsal set
//                                             is marked as incomplete so the
//                                             engine can fail closed.
//
// "Indirect rows with exact confidence are not required" is not an optimization:
// an exact edge means the dependency is proven to exist, but impact is only proven
// for the direct target. Requiring the whole transitive closure would inflate the
// rehearsal set without proving anything, and this phase explicitly avoids
// inventing optimization heuristics in the other direction too.

export const REHEARSAL_REASONS = Object.freeze({
	DIRECT_IMPACT: "direct-impact",
	INDIRECT_CONDITIONAL: "indirect-conditional",
	DYNAMIC_BOUNDARY: "dynamic-boundary",
	UNRESOLVED_IMPACT: "unresolved-impact",
});

function requestIdOf(row) {
	const id = row?.requestId;
	return id === undefined || id === null ? null : String(id);
}

function isRequestRow(row) {
	// A row without an explicit node kind is assumed to be a request row, matching
	// the impact result contract where request rows are the request-bearing rows.
	return row?.nodeKind === undefined || row?.nodeKind === "request";
}

function normalizeImpactRow(row, bucket) {
	const requestId = requestIdOf(row);
	if (requestId === null || !isRequestRow(row)) return null;
	return {
		requestId,
		impact: row.impact ?? bucket,
		confidence: row.confidence ?? "exact",
		hop: Number.isInteger(row.hop) ? row.hop : bucket === "direct" ? 1 : 2,
	};
}

// Collect the unique request rows the impact result reports, in a deterministic
// order that does not depend on how the caller ordered the input.
export function collectImpactRows(changeImpact) {
	const rows = [];
	const direct = changeImpact?.requests?.direct ?? [];
	const indirect = changeImpact?.requests?.indirect ?? [];
	for (const row of direct) {
		const normalized = normalizeImpactRow(row, "direct");
		if (normalized) rows.push(normalized);
	}
	for (const row of indirect) {
		const normalized = normalizeImpactRow(row, "indirect");
		if (normalized) rows.push(normalized);
	}

	// A request can appear in both buckets when a caller builds the input by hand.
	// The strongest claim wins: direct beats indirect, and higher confidence beats
	// lower confidence.
	const byRequest = new Map();
	for (const row of rows) {
		const current = byRequest.get(row.requestId);
		if (!current) {
			byRequest.set(row.requestId, row);
			continue;
		}
		const currentRank = impactRank(current);
		const nextRank = impactRank(row);
		if (nextRank > currentRank) byRequest.set(row.requestId, row);
	}
	return [...byRequest.values()].sort((left, right) => compareStrings(left.requestId, right.requestId));
}

function impactRank(row) {
	const boundRank = row.impact === "direct" ? 2 : 1;
	const confidenceRank = row.confidence === "exact" ? 2 : row.confidence === "conditional" ? 1 : 0;
	// Direct rows always outrank indirect rows; within a bucket, lower confidence
	// outranks higher confidence so the conservative claim survives.
	if (row.impact === "direct") return 10 + (row.confidence === "exact" ? 1 : 2);
	return boundRank * 10 + (confidenceRank === 2 ? 1 : 2);
}

// Compute the minimal rehearsal set. Returns required/optional requests plus a
// flag that reports whether the impact boundary itself was incomplete, so the
// caller can refuse to treat an empty required set as "nothing to do".
export function computeRehearsalSet(changeImpact) {
	if (!changeImpact) {
		return {
			available: false,
			complete: false,
			required: [],
			optional: [],
			dynamicBoundaryRequestIds: [],
			unresolvedReferenceCount: 0,
			truncated: false,
		};
	}

	const rows = collectImpactRows(changeImpact);
	const required = new Map();
	const optional = new Map();

	for (const row of rows) {
		if (row.impact === "direct") {
			required.set(row.requestId, REHEARSAL_REASONS.DIRECT_IMPACT);
			continue;
		}
		// Indirect rows only bind the caller when reachability is not proven exact.
		if (row.confidence === "exact") optional.set(row.requestId, REHEARSAL_REASONS.INDIRECT_CONDITIONAL);
		else required.set(row.requestId, REHEARSAL_REASONS.INDIRECT_CONDITIONAL);
	}

	// Dynamic/unknown references are handled conservatively: when the report names
	// the request at the boundary, that request is required. When it cannot name a
	// request, the set is marked incomplete and the engine fails closed rather than
	// reporting a smaller set than reality.
	const dynamicBoundary = new Set();
	const unknownReferences = changeImpact.unknown ?? [];
	for (const reference of unknownReferences) {
		const requestId = requestIdOf(reference);
		if (requestId !== null) {
			dynamicBoundary.add(requestId);
			required.set(requestId, REHEARSAL_REASONS.DYNAMIC_BOUNDARY);
		}
	}

	// An unresolved target means the impact report could not anchor the change at
	// all, so no request list can be trusted to be complete.
	const unresolvedImpact = changeImpact.resolved === false;
	const truncated = changeImpact.truncated === true;

	const requiredIds = [...required.keys()].filter((requestId) => !optional.has(requestId)).sort(compareStrings);

	return {
		available: true,
		complete: !unresolvedImpact && !truncated && dynamicBoundaryUnresolved(unknownReferences) === false,
		required: requiredIds,
		optional: [...optional.keys()].filter((requestId) => !required.has(requestId)).sort(compareStrings),
		requiredReasons: Object.fromEntries(requiredIds.map((requestId) => [requestId, required.get(requestId)])),
		optionalReasons: Object.fromEntries(
			[...optional.keys()]
				.filter((requestId) => !required.has(requestId))
				.sort(compareStrings)
				.map((requestId) => [requestId, optional.get(requestId)]),
		),
		dynamicBoundaryRequestIds: [...dynamicBoundary].sort(compareStrings),
		unresolvedReferenceCount: unknownReferences.length,
		truncated,
		unresolvedImpact,
	};
}

function dynamicBoundaryUnresolved(unknownReferences) {
	return (unknownReferences ?? []).some((reference) => requestIdOf(reference) === null);
}
