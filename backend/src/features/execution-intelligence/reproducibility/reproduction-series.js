import { performance } from "node:perf_hooks";
import { AppError } from "../../../shared/errors/app-error.js";
import { matchesFailurePredicate } from "../failure-minimizer.js";

// ReproductionStabilityV1: a bounded verification series that answers
// "does this failure reproduce reliably, or was it a one-off?" using the
// normal execution path. Evidence is reported directly (matches/attempts);
// no probabilistic confidence is derived from small samples.
export const REPRODUCTION_KIND = "tracer.reproduction-series";
export const REPRODUCTION_SCHEMA_VERSION = 1;

export const REPRODUCTION_DEFAULT_PROBES = 3;
// A single probe cannot establish stability, so the series never shrinks below 2
// (same floor the failure minimizer uses for its probe budget).
export const REPRODUCTION_MIN_PROBES = 2;
// Hard probe cap. No caller, route, or future feature may exceed this.
export const REPRODUCTION_MAX_PROBES = 5;

export const REPRODUCTION_CLASSIFICATIONS = ["reproducible", "flaky", "not_reproduced", "inconclusive"];

const PREDICATE_TYPES = new Set(["outcome", "status", "assertion"]);

export function validateFailurePredicate(predicate) {
	if (!predicate || typeof predicate !== "object" || !PREDICATE_TYPES.has(predicate.type))
		throw new AppError(422, "REPRO_PREDICATE_INVALID", "Use an outcome, status, or assertion failure predicate.");
	return predicate;
}

export function normalizeProbeCount(value) {
	const requested = Math.trunc(Number(value));
	const count = Number.isFinite(requested) && requested > 0 ? requested : REPRODUCTION_DEFAULT_PROBES;
	return Math.min(Math.max(count, REPRODUCTION_MIN_PROBES), REPRODUCTION_MAX_PROBES);
}

// Deterministic rule application, never a probability:
// - a complete series where every probe matched is "reproducible";
// - a complete series where no probe matched is "not_reproduced";
// - a complete series with mixed outcomes is "flaky";
// - anything shorter than planned (cancel, probe error, restart) is "inconclusive".
export function classifyReproduction({ planned, attempts, matches, completed }) {
	if (completed !== true || attempts !== planned || attempts < 1) return "inconclusive";
	if (matches >= attempts) return "reproducible";
	if (matches === 0) return "not_reproduced";
	return "flaky";
}

export function reproductionStatement({ matches, attempts, completed }) {
	return `${matches}/${attempts} probes reproduced the failure${completed === true ? "" : " (series incomplete)"}`;
}

export function timingSummary(durations) {
	if (!Array.isArray(durations) || durations.length === 0) return null;
	const sorted = [...durations].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	// These are bounded small samples (2-5 probes), so only min/median/max are
	// reported. Percentiles such as p95/p99 would be misleading here.
	return {
		sampleCount: sorted.length,
		minMs: sorted[0],
		medianMs: Math.round(median * 1000) / 1000,
		maxMs: sorted[sorted.length - 1],
	};
}

function cancelledError() {
	return { code: "REPRO_CANCELLED", message: "The reproduction series was cancelled." };
}

export async function runReproductionSeries({ request, predicate, probe, probeCount = REPRODUCTION_DEFAULT_PROBES, signal = null }) {
	if (!request || typeof request !== "object")
		throw new AppError(400, "REPRO_REQUEST_INVALID", "A replayable request is required.");
	validateFailurePredicate(predicate);
	if (typeof probe !== "function")
		throw new AppError(500, "REPRO_PROBE_UNAVAILABLE", "A verification probe runner is required.");

	const planned = normalizeProbeCount(probeCount);
	const records = [];
	let status = "completed";
	let error = null;

	for (let index = 1; index <= planned; index += 1) {
		if (signal?.aborted) {
			status = "cancelled";
			error = cancelledError();
			break;
		}
		const started = performance.now();
		let result;
		try {
			result = await probe(structuredClone(request), signal);
		} catch (caught) {
			if (signal?.aborted) {
				status = "cancelled";
				error = cancelledError();
			} else {
				status = "failed";
				error = { code: caught?.code ?? "REPRO_PROBE_FAILED", message: String(caught?.message ?? "A verification probe failed.") };
			}
			break;
		}
		const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
		records.push({
			index,
			executionId: result?.executionId ?? null,
			outcome: result?.outcome ?? "unknown",
			responseStatus: result?.response?.status ?? null,
			predicateMatched: matchesFailurePredicate(result, predicate) === true,
			durationMs,
		});
	}

	const attempts = records.length;
	const completed = status === "completed" && attempts === planned;
	const matches = records.filter((record) => record.predicateMatched).length;
	return {
		schemaVersion: REPRODUCTION_SCHEMA_VERSION,
		kind: REPRODUCTION_KIND,
		status,
		completed,
		plannedProbes: planned,
		attempts,
		matches,
		classification: classifyReproduction({ planned, attempts, matches, completed }),
		statement: reproductionStatement({ matches, attempts, completed }),
		probes: records,
		timing: timingSummary(records.map((record) => record.durationMs)),
		error,
	};
}
