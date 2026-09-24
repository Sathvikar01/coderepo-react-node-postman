// Phase 49 — "Why?" Inspector view helpers.
//
// These helpers are pure presentation. They choose labels and group rows for the
// dialog; they never derive precedence, impact, drift, contract compatibility, a
// verification state, or a proof. Every string that carries meaning (scope
// labels, state, reason text, precedence order) comes from the backend
// explanation. When a value is missing the helper says so instead of inventing
// one.

export const WHY_TABS = [
	{ id: "configuration", label: "Configuration" },
	{ id: "execution", label: "Execution" },
	{ id: "change", label: "Change" },
	{ id: "evidence", label: "Evidence" },
];

export const SECTION_STATE_LABEL = {
	recorded: "Recorded",
	partial: "Partial",
	not_recorded: "Not recorded",
};

export function sectionStateLabel(state) {
	return SECTION_STATE_LABEL[state] ?? "Not recorded";
}

export function sectionStateTone(state) {
	if (state === "recorded") return "success";
	if (state === "partial") return "warning";
	return "neutral";
}

// Verification vocabulary is Phase 41's. The frontend only maps it to a tone; it
// never decides the state.
export const VERIFICATION_TONE = {
	VERIFIED: "success",
	BLOCKED: "danger",
	NEEDS_REHEARSAL: "warning",
	UNKNOWN: "neutral",
};

export function verificationTone(state) {
	return VERIFICATION_TONE[state] ?? "neutral";
}

// Basis is a backend-supplied explanation of where the state came from.
export const VERIFICATION_BASIS_LABEL = {
	linked_verification: "Linked verification artifact",
	target_policy: "Recorded target policy",
	recorded_assertions: "Recorded request assertions",
	none: "No verification evidence",
};

export function verificationBasisLabel(basis) {
	return VERIFICATION_BASIS_LABEL[basis] ?? "Unknown basis";
}

export const CONFIGURATION_GROUP_LABEL = {
	request: "Request",
	target: "Target",
	auth: "Authentication",
	policy: "Policy",
	timing: "Timing",
	source: "Source",
	persistence: "Persistence",
};

export const CONFIGURATION_GROUP_ORDER = ["request", "target", "auth", "policy", "timing", "source", "persistence"];

export const EVIDENCE_KIND_LABEL = {
	configuration: "Configuration",
	"execution-receipt": "Execution receipt",
	"compiled-request": "Compiled request",
	"response-body": "Captured response",
	"change-analysis": "Change analysis",
	verification: "Verification state",
};

export function evidenceKindLabel(kind) {
	return EVIDENCE_KIND_LABEL[kind] ?? "Evidence";
}

/** Group configuration entries in a fixed, backend-declared order. */
export function configurationGroups(entries) {
	const list = Array.isArray(entries) ? entries : [];
	const byGroup = new Map();
	for (const entry of list) {
		const group = entry?.group ?? "request";
		if (!byGroup.has(group)) byGroup.set(group, []);
		byGroup.get(group).push(entry);
	}
	const ordered = [...byGroup.keys()].sort((left, right) => {
		const leftIndex = CONFIGURATION_GROUP_ORDER.indexOf(left);
		const rightIndex = CONFIGURATION_GROUP_ORDER.indexOf(right);
		return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
	});
	return ordered.map((group) => ({
		group,
		label: CONFIGURATION_GROUP_LABEL[group] ?? "Other",
		entries: byGroup.get(group),
	}));
}

/**
 * The precedence ladder is the backend's, including its human labels. This only
 * pairs the backend's order with the backend's labels and marks which scopes
 * actually contributed a value to this execution.
 */
export function precedenceLadder(precedence) {
	if (!precedence?.order) return [];
	const labels = new Map((precedence.labels ?? []).map((item) => [item.scope, item.label]));
	const applied = new Set(precedence.appliedScopes ?? []);
	return precedence.order.map((scope, index) => ({
		scope,
		label: labels.get(scope) ?? "Unknown scope",
		rank: index + 1,
		applied: applied.has(scope),
	}));
}

export function variableRows(dependencies) {
	const variables = Array.isArray(dependencies?.variables) ? dependencies.variables : [];
	return variables.map((variable) => ({
		...variable,
		scopeText: variable.scopeLabel ?? "Unknown scope",
		precedenceText: typeof variable.precedence === "number" ? `#${variable.precedence + 1}` : "—",
	}));
}

export function hasRecordedChange(change) {
	return Boolean(change?.recorded) && (change?.comparisons?.length ?? 0) > 0;
}

/** True only when the backend actually returned a usable explanation. */
export function isExplanation(value) {
	return Boolean(value) && value.kind === "tracer.why-explanation" && value.schemaVersion === 1;
}

export function whyErrorMessage(error) {
	const code = error?.code;
	const messages = {
		EXECUTION_NOT_FOUND: "This execution is no longer in history, so there is nothing to explain.",
		VALIDATION_ERROR: "The execution identifier was not valid.",
		NETWORK_UNREACHABLE: "Tracer could not reach its API. Check that the backend is running, then try again.",
	};
	if (code && messages[code]) return messages[code];
	return error?.message || "The explanation could not be loaded.";
}
