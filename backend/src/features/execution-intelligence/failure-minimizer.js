import { AppError } from "../../shared/errors/app-error.js";

export const MINIMIZATION_MAX_PROBES = 12;

export function matchesFailurePredicate(result, predicate) {
	if (predicate?.type === "outcome") return result?.outcome === predicate.equals;
	if (predicate?.type === "status") return result?.response?.status === predicate.equals;
	if (predicate?.type === "assertion") {
		return (result?.scriptResults?.tests ?? []).some(
			(test) => test?.assertionId === predicate.assertionId && test?.status !== "passed",
		);
	}
	return false;
}

function jsonKeys(request) {
	if (request?.body?.mode !== "json") return [];
	try {
		const value = JSON.parse(request.body.text);
		return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
	} catch {
		return [];
	}
}

function components(request) {
	return [
		...(request.query ?? [])
			.filter((row) => row?.enabled !== false)
			.map((row) => ({ kind: "query", id: row.id, key: row.key })),
		...(request.headers ?? [])
			.filter((row) => row?.enabled !== false)
			.map((row) => ({ kind: "header", id: row.id, key: row.key })),
		...jsonKeys(request).map((key) => ({ kind: "json", key })),
	];
}

function withoutComponent(request, component) {
	const candidate = structuredClone(request);
	if (component.kind === "query") candidate.query = candidate.query.filter((row) => row.id !== component.id);
	if (component.kind === "header") candidate.headers = candidate.headers.filter((row) => row.id !== component.id);
	if (component.kind === "json") {
		const value = JSON.parse(candidate.body.text);
		delete value[component.key];
		candidate.body.text = JSON.stringify(value);
	}
	return candidate;
}

function cancellation(signal) {
	if (signal?.aborted) throw new AppError(409, "MINIMIZATION_CANCELLED", "Failure minimization was cancelled.");
}

export async function minimizeFailure({ request, predicate, probe, signal = null, maxProbes = MINIMIZATION_MAX_PROBES }) {
	const budget = Math.min(Math.max(Number(maxProbes) || MINIMIZATION_MAX_PROBES, 2), MINIMIZATION_MAX_PROBES);
	let probesUsed = 0;
	const run = async (candidate) => {
		cancellation(signal);
		if (probesUsed >= budget) throw new AppError(409, "MINIMIZATION_BUDGET", "The failure minimization probe budget is exhausted.");
		probesUsed += 1;
		return probe(structuredClone(candidate), signal);
	};

	const first = await run(request);
	const firstMatches = matchesFailurePredicate(first, predicate);
	if (!firstMatches)
		throw new AppError(409, "MINIMIZATION_PREDICATE_NOT_MET", "The source request no longer reproduces the selected failure.");
	const second = await run(request);
	const secondMatches = matchesFailurePredicate(second, predicate);
	if (firstMatches !== secondMatches || !secondMatches)
		throw new AppError(409, "MINIMIZATION_FLAKY", "The selected failure is not stable across baseline probes.");

	let current = structuredClone(request);
	const candidates = components(request);
	const removed = [];
	let visited = 0;
	for (const component of candidates) {
		cancellation(signal);
		if (probesUsed >= budget) break;
		visited += 1;
		const candidate = withoutComponent(current, component);
		const result = await run(candidate);
		if (matchesFailurePredicate(result, predicate)) {
			current = candidate;
			removed.push({ kind: component.kind, key: component.key, ...(component.id ? { id: component.id } : {}) });
		}
	}

	return {
		schemaVersion: 1,
		kind: "tracer.minimization-result",
		status: "completed",
		stable: true,
		probesUsed,
		probeBudget: budget,
		budgetExhausted: visited < candidates.length,
		originalComponentCount: candidates.length,
		remainingComponentCount: components(current).length,
		removed,
		request: current,
	};
}
