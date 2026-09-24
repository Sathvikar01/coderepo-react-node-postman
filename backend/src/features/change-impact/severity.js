// Deterministic severity rules for change impact.
//
// Severity is a pure function of (a) the proposed change's operation and target
// kind and (b) the graph distance from the changed node. There is no scoring,
// weighting, or heuristics: the same change always produces the same severity.

export const SEVERITY_ORDER = Object.freeze(["none", "low", "medium", "high"]);

const SEVERITY_RANK = new Map(SEVERITY_ORDER.map((level, index) => [level, index]));

export function maxSeverity(left, right) {
	return (SEVERITY_RANK.get(left) ?? 0) >= (SEVERITY_RANK.get(right) ?? 0) ? left : right;
}

export function downgrade(severity) {
	const index = SEVERITY_RANK.get(severity) ?? 0;
	return SEVERITY_ORDER[Math.max(0, index - 1)];
}

const REMOVED_SEVERITY = {
	environmentVariable: "high",
	collectionVariable: "high",
	requestVariable: "high",
	environment: "high",
	collection: "high",
	folder: "high",
	request: "high",
	auth: "high",
	header: "medium",
};

const CHANGED_SEVERITY = {
	environmentVariable: "medium",
	collectionVariable: "medium",
	requestVariable: "medium",
	environment: "medium",
	collection: "medium",
	folder: "medium",
	request: "medium",
	auth: "high",
	header: "low",
};

// Severity of the change itself, before distance is considered.
export function changeSeverity(change) {
	const table = change.operation === "removed" ? REMOVED_SEVERITY : CHANGED_SEVERITY;
	return table[change.target.kind] ?? "medium";
}

// A directly dependent node carries the change severity; anything reached through
// one or more further dependencies is one step less severe, floored at "low".
export function severityForImpact(base, hop) {
	return hop <= 1 ? base : downgrade(base);
}
