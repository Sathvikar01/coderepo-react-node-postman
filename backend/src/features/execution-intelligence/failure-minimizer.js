import { AppError } from "../../shared/errors/app-error.js";
import {
	componentRef,
	describeComponent,
	enumerateComponents,
	isDescendantPath,
	splitChunks,
	withoutComponents,
} from "./structured-delta.js";

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

function cancellation(signal) {
	if (signal?.aborted) throw new AppError(409, "MINIMIZATION_CANCELLED", "Failure minimization was cancelled.");
}

function commitRemoval(remaining, chunk) {
	const dropped = new Set(chunk.map(componentRef));
	const droppedJsonPaths = chunk.filter((component) => component.kind === "json").map((component) => component.path);
	for (let index = remaining.length - 1; index >= 0; index -= 1) {
		const component = remaining[index];
		const subsumed =
			component.kind === "json" && droppedJsonPaths.some((path) => isDescendantPath(component.path, path));
		if (dropped.has(componentRef(component)) || subsumed) remaining.splice(index, 1);
	}
}

export async function minimizeFailure({ request, predicate, probe, signal = null, maxProbes = MINIMIZATION_MAX_PROBES }) {
	const budget = Math.min(Math.max(Number(maxProbes) || MINIMIZATION_MAX_PROBES, 2), MINIMIZATION_MAX_PROBES);
	let probesUsed = 0;
	const probeTrace = [];
	const run = async (candidate, phase, removals) => {
		cancellation(signal);
		if (probesUsed >= budget) return null;
		probesUsed += 1;
		const result = await probe(structuredClone(candidate), signal);
		const matched = matchesFailurePredicate(result, predicate);
		probeTrace.push({ index: probesUsed, phase, removals: removals.map(describeComponent), matched });
		return matched;
	};

	const first = await run(request, "baseline", []);
	if (!first)
		throw new AppError(409, "MINIMIZATION_PREDICATE_NOT_MET", "The source request no longer reproduces the selected failure.");
	const second = await run(request, "baseline", []);
	if (first !== second || !second)
		throw new AppError(409, "MINIMIZATION_FLAKY", "The selected failure is not stable across baseline probes.");

	let current = structuredClone(request);
	const original = enumerateComponents(request);
	const remaining = [...original];
	const required = new Set();
	let n = 2;
	let cutShort = false;

	search: for (;;) {
		const candidates = remaining.filter((component) => !required.has(componentRef(component)));
		if (candidates.length === 0) break;
		const chunks = splitChunks(candidates, Math.min(n, candidates.length));
		let progress = false;
		for (const chunk of chunks) {
			const matched = await run(
				withoutComponents(current, chunk),
				chunk.length === 1 ? "singleton" : "group",
				chunk,
			);
			if (matched === null) {
				cutShort = true;
				break search;
			}
			if (matched) {
				current = withoutComponents(current, chunk);
				commitRemoval(remaining, chunk);
				progress = true;
				n = 2;
				break;
			}
			if (chunk.length === 1) required.add(componentRef(chunk[0]));
		}
		if (progress) continue;
		if (chunks.length === candidates.length) break;
		n = chunks.length * 2;
	}

	let minimality = "one_minimal";
	if (cutShort) minimality = "budget_limited";
	else {
		const verified = await run(current, "verify", []);
		if (verified === false) minimality = "inconclusive";
	}

	const remainingRefs = new Set(remaining.map(componentRef));
	const droppedRefs = new Set(original.map(componentRef).filter((ref) => !remainingRefs.has(ref)));
	const removed = original
		.filter((component) => droppedRefs.has(componentRef(component)))
		.filter((component) => {
			if (component.kind !== "json" || component.path.length === 1) return true;
			return !droppedRefs.has(`json:${JSON.stringify(component.path.slice(0, -1))}`);
		})
		.map(describeComponent);

	return {
		schemaVersion: 1,
		kind: "tracer.minimization-result",
		status: "completed",
		stable: true,
		minimality,
		budgetExhausted: minimality === "budget_limited",
		probesUsed,
		probeBudget: budget,
		probeTrace,
		originalComponentCount: original.length,
		remainingComponentCount: remaining.length,
		removed,
		request: current,
	};
}
