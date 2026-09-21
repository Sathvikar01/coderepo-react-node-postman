export const SENSITIVE_MATCH_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);

export function normalizeTarget(target = {}) {
	return {
		method: String(target.method ?? "").toUpperCase(),
		path: String(target.path ?? ""),
		query: (target.query ?? []).map((row) => ({ key: String(row.key ?? ""), value: String(row.value ?? "") })),
		headers: (target.headers ?? []).map((row) => ({
			key: String(row.key ?? row.name ?? "").toLowerCase(),
			value: String(row.value ?? ""),
		})),
	};
}

export function exampleSpecificity(example) {
	return (example?.match?.query?.length ?? 0) + (example?.match?.headers?.length ?? 0);
}

export function matchesTarget(example, target) {
	if (String(example?.match?.method ?? "").toUpperCase() !== target.method) return false;
	if (String(example?.match?.path ?? "") !== target.path) return false;
	for (const rule of example?.match?.query ?? []) {
		if (!target.query.some((item) => item.key === rule.key && item.value === rule.value)) return false;
	}
	for (const rule of example?.match?.headers ?? []) {
		const name = String(rule.key ?? "").toLowerCase();
		if (!target.headers.some((item) => item.key === name && item.value === rule.value)) return false;
	}
	return true;
}

export function compareCandidates(first, second) {
	const specificity = exampleSpecificity(second) - exampleSpecificity(first);
	if (specificity !== 0) return specificity;
	const created = new Date(first?.createdAt ?? 0).getTime() - new Date(second?.createdAt ?? 0).getTime();
	if (created !== 0) return created;
	return String(first?._id ?? "").localeCompare(String(second?._id ?? ""));
}

export function selectExampleMatch(examples = [], rawTarget = {}) {
	const target = normalizeTarget(rawTarget);
	const ordered = [...examples].filter((example) => matchesTarget(example, target)).sort(compareCandidates);
	return { matched: ordered.length > 0, example: ordered[0] ?? null, target, considered: examples.length };
}
