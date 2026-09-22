const CATEGORY_ORDER = ["source", "request", "auth", "target", "policy", "transport", "response"];

export function groupComparisonChanges(comparison) {
	const byCategory = new Map();
	for (const change of comparison?.changes ?? []) {
		const category = CATEGORY_ORDER.includes(change.category) ? change.category : "response";
		if (!byCategory.has(category)) byCategory.set(category, []);
		byCategory.get(category).push(change);
	}
	return CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => ({
		category,
		changes: byCategory.get(category),
	}));
}

export function contractBadge(contract) {
	if (contract?.breaking) return { tone: "danger", label: "Breaking change" };
	if ((contract?.changes ?? []).length > 0) return { tone: "info", label: "Additive change" };
	return { tone: "neutral", label: "No contract drift" };
}

export function capsuleDraftRequest(imported, id = crypto.randomUUID()) {
	if (!imported?.draft || imported.autoSend !== false || imported.autoSave !== false) return null;
	return { ...structuredClone(imported.draft), id, folderId: null };
}

export function minimizationSummary(job) {
	if (!job) return { tone: "neutral", label: "Ready to minimize this failure." };
	if (job.status === "running") return { tone: "info", label: "Probing safely…" };
	if (job.status === "completed") {
		const removed = job.result?.removed?.length ?? 0;
		const probes = job.result?.probesUsed ?? 0;
		return { tone: "success", label: `Removed ${removed} input${removed === 1 ? "" : "s"} in ${probes} probes.` };
	}
	if (job.status === "cancelled") return { tone: "warning", label: "Minimization cancelled." };
	return { tone: "danger", label: job.error?.message ?? "Minimization failed." };
}

export function recorderErrorMessage(error) {
	if (error?.code === "RECEIPT_UNAVAILABLE")
		return "This execution predates Flight Recorder evidence. Send it again to create a passport.";
	return error?.message ?? "Flight Recorder could not load this execution.";
}
