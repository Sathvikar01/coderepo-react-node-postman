// Pure view model for the Collection Runner dialog. The ordering rules mirror the
// backend run plan (sidebar tree order: folders first in `folders` order, then root
// requests, each in `requests` order) so the preview lists exactly what will run.

export const RUN_LIMITS = {
	requestsPerRun: 100,
	iterationsPerRun: 25,
	stepsPerRun: 200,
	variablesPerRun: 50,
};

export function plannedRequests(collection, selection) {
	const requests = collection?.requests ?? [];
	if (selection?.mode === "requests") {
		const byId = new Map(requests.map((entry) => [entry.id, entry]));
		return selection.requestIds.map((id) => byId.get(id)).filter(Boolean);
	}
	if (selection?.mode === "folder") {
		return requests.filter((entry) => (entry.folderId ?? null) === selection.folderId);
	}
	const ordered = [];
	for (const folder of collection?.folders ?? []) {
		for (const entry of requests) if ((entry.folderId ?? null) === folder.id) ordered.push(entry);
	}
	for (const entry of requests) if (!entry.folderId) ordered.push(entry);
	return ordered;
}

export function selectionLabel(selection, collection) {
	if (selection?.mode === "folder") {
		const folder = (collection?.folders ?? []).find((entry) => entry.id === selection.folderId);
		return folder ? `Folder “${folder.name}”` : "Folder";
	}
	if (selection?.mode === "requests") return `${selection.requestIds.length} selected request(s)`;
	return "Whole collection";
}

export function planLimitError(iterations, requestCount) {
	if (requestCount === 0) return "The run selection does not include any requests.";
	if (requestCount > RUN_LIMITS.requestsPerRun) return `A run may include at most ${RUN_LIMITS.requestsPerRun} requests.`;
	if (!Number.isInteger(iterations) || iterations < 1 || iterations > RUN_LIMITS.iterationsPerRun)
		return `Iterations must be between 1 and ${RUN_LIMITS.iterationsPerRun}.`;
	if (requestCount * iterations > RUN_LIMITS.stepsPerRun)
		return `A run may execute at most ${RUN_LIMITS.stepsPerRun} requests in total.`;
	return "";
}

export function cleanRunVariables(rows) {
	const variables = [];
	const seen = new Set();
	for (const row of rows ?? []) {
		const key = String(row.key ?? "").trim();
		if (!key) continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, error: `“${key}” is not a valid variable name.`, variables: [] };
		if (seen.has(key)) return { ok: false, error: `The variable “${key}” is listed twice.`, variables: [] };
		seen.add(key);
		if (variables.length >= RUN_LIMITS.variablesPerRun)
			return { ok: false, error: `A run may define at most ${RUN_LIMITS.variablesPerRun} variables.`, variables: [] };
		variables.push({ key, value: String(row.value ?? "") });
	}
	return { ok: true, error: "", variables };
}

export function buildRunInput({ collection, selection, environment, iterations, stopOnFailure, variables }) {
	return {
		collectionId: collection._id,
		collectionRevision: collection.revision,
		selection,
		...(environment ? { environmentId: environment._id, environmentRevision: environment.revision } : {}),
		iterations: Number(iterations) || 1,
		stopOnFailure: stopOnFailure !== false,
		variables,
	};
}

export const STEP_LABELS = {
	pending: "Pending",
	running: "Running",
	passed: "Passed",
	failed: "Failed",
	skipped: "Skipped",
	cancelled: "Cancelled",
};

export function stepStatusLabel(step) {
	return STEP_LABELS[step?.status] ?? "Pending";
}

export function stepTone(step) {
	if (step?.status === "passed") return "success";
	if (step?.status === "failed") return "danger";
	if (step?.status === "cancelled") return "warning";
	return "unknown";
}

export function runProgress(run) {
	const steps = run?.results ?? [];
	const total = run?.progress?.total ?? steps.length;
	const completed = run?.progress?.completed ?? steps.filter((step) => step.status !== "pending" && step.status !== "running").length;
	const current = steps.find((step) => step.status === "running") ?? null;
	return { total, completed, current, percent: total > 0 ? Math.round((completed / total) * 100) : 0 };
}

export function summaryLine(summary) {
	if (!summary) return "";
	const checks = summary.assertions?.passed ?? 0;
	const parts = [`${summary.passed} passed`, `${summary.failed} failed`];
	if (summary.cancelled > 0) parts.push(`${summary.cancelled} cancelled`);
	if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
	const line = parts.join(" · ");
	return checks > 0 ? `${line} · ${checks} check(s) passed` : line;
}

export function stopReasonLine(stopReason) {
	if (stopReason === "stop_on_failure") return "The run stopped at the first failure.";
	if (stopReason === "duration") return "The run reached its time budget.";
	if (stopReason === "cancelled") return "The run was cancelled.";
	if (stopReason === "interrupted" || stopReason === "error") return "The run ended before it finished.";
	return "";
}

export function previousExecutedStep(results, index) {
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const step = results[cursor];
		if (step?.executionId) return step;
	}
	return null;
}

export function assertionLine(step) {
	const counts = step?.assertions;
	if (!counts) return "";
	const total = (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.errors ?? 0);
	if (total === 0) return "";
	return `${counts.passed}/${total} checks`;
}
