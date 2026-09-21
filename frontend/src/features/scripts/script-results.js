export function scriptResultsOf(result) {
	if (!result) return null;
	if (result.scriptResults) return result.scriptResults;
	return result.snapshot?.scriptResults ?? null;
}

export function scriptCounts(results) {
	const counts = results?.counts ?? {};
	return {
		passed: Number(counts.passed) || 0,
		failed: Number(counts.failed) || 0,
		errors: Number(counts.errors) || 0,
	};
}

export function scriptTests(results) {
	return Array.isArray(results?.tests) ? results.tests : [];
}

export function scriptConsoleEntries(results) {
	const entries = [];
	for (const phase of [results?.preRequest, results?.postResponse]) {
		for (const entry of phase?.console ?? []) entries.push({ ...entry, phase: phase === results?.preRequest ? "pre-request" : "test" });
	}
	return entries;
}

export function phaseSummary(phase) {
	if (!phase) return { label: "Not configured", tone: "unknown" };
	if (phase.status === "error") return { label: "Script error", tone: "danger" };
	if (phase.status === "skipped") return { label: "Skipped (no response)", tone: "warning" };
	const headers = phase.mutations?.headers?.length ?? 0;
	const variables = phase.mutations?.variables?.length ?? 0;
	const changes = [];
	if (variables > 0) changes.push(`${variables} variable${variables === 1 ? "" : "s"}`);
	if (headers > 0) changes.push(`${headers} header${headers === 1 ? "" : "s"}`);
	return { label: changes.length > 0 ? `Ran \u00b7 changed ${changes.join(", ")}` : "Ran", tone: "success" };
}
