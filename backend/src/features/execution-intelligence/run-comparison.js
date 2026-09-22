export const RUN_COMPARISON_KIND = "tracer.run-comparison";
export const RUN_COMPARISON_VERSION = 1;

function same(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function label(path) {
	const labels = {
		"source.collectionRevision": "collection revision",
		"source.environmentRevision": "environment revision",
		"request.authoredFingerprint": "authored request",
		"request.compiledFingerprint": "compiled request",
		"request.auth": "authentication",
		"target.address": "resolved destination",
		"target.hostname": "target hostname",
		"policy.decision": "policy decision",
		"transport.durationMs": "total duration",
		outcome: "execution outcome",
		"response.bodyFingerprint": "response body",
		"tests.counts": "test results",
		"tests.failureFingerprint": "test failures",
	};
	return labels[path] ?? path;
}

function formatCounts(counts) {
	if (!counts) return "none";
	return `${counts.passed ?? 0} passed, ${counts.failed ?? 0} failed, ${counts.error ?? 0} error`;
}

function message(path, before, after) {
	const display = (value) => (value === null || value === undefined ? "none" : typeof value === "object" ? "a different value" : String(value));
	if (path === "source.collectionRevision") return `The collection revision changed from ${display(before)} to ${display(after)}.`;
	if (path === "source.environmentRevision") return `The environment revision changed from ${display(before)} to ${display(after)}.`;
	if (path === "tests.counts") return `The test results changed from ${formatCounts(before)} to ${formatCounts(after)}.`;
	return `The ${label(path)} changed from ${display(before)} to ${display(after)}.`;
}

function evidenceChange(category, path, before, after, severity = "info") {
	return { category, path, before: before ?? null, after: after ?? null, severity, message: message(path, before, after) };
}

function addIfChanged(changes, category, path, before, after, severity) {
	if (!same(before, after)) changes.push(evidenceChange(category, path, before, after, severity));
}

function contractChanges(base, candidate) {
	const changes = [];
	const left = base?.response?.contract ?? null;
	const right = candidate?.response?.contract ?? null;
	if (!left || !right) return { breaking: false, changes };
	if (left.status !== right.status)
		changes.push({ kind: "status_changed", path: "status", before: left.status ?? null, after: right.status ?? null, severity: "breaking" });

	const leftHeaders = new Map((left.headers ?? []).map((item) => [item.name, item.count]));
	const rightHeaders = new Map((right.headers ?? []).map((item) => [item.name, item.count]));
	for (const [name, count] of leftHeaders) {
		const next = rightHeaders.get(name) ?? 0;
		if (next < count)
			changes.push({
				kind: next === 0 ? "header_removed" : "header_count_decreased",
				path: `headers.${name}`,
				before: count,
				after: next,
				severity: "breaking",
			});
	}
	for (const [name, count] of rightHeaders) {
		const previous = leftHeaders.get(name) ?? 0;
		if (previous === 0)
			changes.push({ kind: "header_added", path: `headers.${name}`, before: 0, after: count, severity: "additive" });
		else if (count > previous)
			changes.push({ kind: "header_count_increased", path: `headers.${name}`, before: previous, after: count, severity: "additive" });
	}

	const shapeComparable = !base.response.binary && !base.response.truncated && !candidate.response.binary && !candidate.response.truncated;
	if (shapeComparable) {
		const leftShape = new Map((left.bodyShape ?? []).map((item) => [item.path, item.type]));
		const rightShape = new Map((right.bodyShape ?? []).map((item) => [item.path, item.type]));
		for (const [path, type] of rightShape) {
			if (!leftShape.has(path))
				changes.push({ kind: "body_path_added", path, before: null, after: type, severity: "additive" });
		}
		for (const [path, type] of leftShape) {
			if (rightShape.has(path) && rightShape.get(path) !== type)
				changes.push({ kind: "body_type_changed", path, before: type, after: rightShape.get(path), severity: "breaking" });
		}
		for (const [path, type] of leftShape) {
			if (!rightShape.has(path))
				changes.push({ kind: "body_path_removed", path, before: type, after: null, severity: "breaking" });
		}
	}
	return { breaking: changes.some((change) => change.severity === "breaking"), changes };
}

export function compareReceipts(base, candidate) {
	const changes = [];
	addIfChanged(changes, "source", "source.collectionRevision", base?.source?.collectionRevision, candidate?.source?.collectionRevision);
	addIfChanged(changes, "source", "source.environmentRevision", base?.source?.environmentRevision, candidate?.source?.environmentRevision);
	addIfChanged(changes, "request", "request.authoredFingerprint", base?.request?.authoredFingerprint, candidate?.request?.authoredFingerprint);
	addIfChanged(changes, "auth", "request.auth", base?.request?.auth, candidate?.request?.auth);
	addIfChanged(changes, "request", "request.compiledFingerprint", base?.request?.compiledFingerprint, candidate?.request?.compiledFingerprint);
	addIfChanged(changes, "target", "target.hostname", base?.target?.hostname, candidate?.target?.hostname, "warning");
	addIfChanged(changes, "target", "target.address", base?.target?.address, candidate?.target?.address, "warning");
	addIfChanged(changes, "policy", "policy.decision", base?.policy?.decision, candidate?.policy?.decision, "warning");
	addIfChanged(changes, "transport", "transport.durationMs", base?.transport?.durationMs, candidate?.transport?.durationMs);
	addIfChanged(changes, "response", "outcome", base?.outcome, candidate?.outcome, "warning");
	addIfChanged(changes, "response", "response.bodyFingerprint", base?.response?.bodyFingerprint, candidate?.response?.bodyFingerprint);
	addIfChanged(changes, "tests", "tests.counts", base?.tests?.counts, candidate?.tests?.counts, "warning");
	addIfChanged(changes, "tests", "tests.failureFingerprint", base?.tests?.failureFingerprint, candidate?.tests?.failureFingerprint, "warning");
	if (
		base?.response &&
		candidate?.response &&
		(base.response.binary !== candidate.response.binary || base.response.truncated !== candidate.response.truncated)
	) {
		changes.push({
			category: "response",
			path: "response.representation",
			before: { binary: base.response.binary, truncated: base.response.truncated },
			after: { binary: candidate.response.binary, truncated: candidate.response.truncated },
			severity: "warning",
			message: "The response representation changed, so a structured body comparison is unavailable.",
		});
	}

	const contract = contractChanges(base, candidate);
	const first = changes[0] ?? null;
	return {
		schemaVersion: RUN_COMPARISON_VERSION,
		kind: RUN_COMPARISON_KIND,
		baseExecutionId: base?.executionId ?? null,
		candidateExecutionId: candidate?.executionId ?? null,
		firstDivergence: first ? { category: first.category, path: first.path, message: first.message } : null,
		changes,
		contract,
	};
}
