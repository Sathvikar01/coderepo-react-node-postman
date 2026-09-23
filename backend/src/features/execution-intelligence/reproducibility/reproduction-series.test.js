import { describe, expect, test } from "bun:test";
import {
	REPRODUCTION_DEFAULT_PROBES,
	REPRODUCTION_MAX_PROBES,
	REPRODUCTION_MIN_PROBES,
	classifyReproduction,
	normalizeProbeCount,
	runReproductionSeries,
	timingSummary,
	validateFailurePredicate,
} from "./reproduction-series.js";

const REQUEST = { method: "GET", urlTemplate: "https://api.test/fail" };
const STATUS_PREDICATE = { type: "status", equals: 500 };

function failingResult(executionId) {
	return { executionId, outcome: "response", response: { status: 500 }, scriptResults: null };
}

function passingResult(executionId) {
	return { executionId, outcome: "response", response: { status: 200 }, scriptResults: null };
}

describe("ReproductionStabilityV1 classification", () => {
	test("applies deterministic rules without probabilistic claims", () => {
		expect(classifyReproduction({ planned: 3, attempts: 3, matches: 3, completed: true })).toBe("reproducible");
		expect(classifyReproduction({ planned: 3, attempts: 3, matches: 0, completed: true })).toBe("not_reproduced");
		expect(classifyReproduction({ planned: 3, attempts: 3, matches: 2, completed: true })).toBe("flaky");
		expect(classifyReproduction({ planned: 3, attempts: 3, matches: 1, completed: true })).toBe("flaky");
		expect(classifyReproduction({ planned: 3, attempts: 1, matches: 1, completed: false })).toBe("inconclusive");
		expect(classifyReproduction({ planned: 3, attempts: 0, matches: 0, completed: false })).toBe("inconclusive");
		expect(classifyReproduction({ planned: 3, attempts: 2, matches: 2, completed: true })).toBe("inconclusive");
	});

	test("normalizes the probe count with a hard cap of 5 and a floor of 2", () => {
		expect(normalizeProbeCount(undefined)).toBe(REPRODUCTION_DEFAULT_PROBES);
		expect(normalizeProbeCount(null)).toBe(REPRODUCTION_DEFAULT_PROBES);
		expect(normalizeProbeCount(0)).toBe(REPRODUCTION_DEFAULT_PROBES);
		expect(normalizeProbeCount("4")).toBe(4);
		expect(normalizeProbeCount(99)).toBe(REPRODUCTION_MAX_PROBES);
		expect(normalizeProbeCount(5)).toBe(REPRODUCTION_MAX_PROBES);
		expect(normalizeProbeCount(1)).toBe(REPRODUCTION_MIN_PROBES);
		expect(REPRODUCTION_MAX_PROBES).toBe(5);
		expect(REPRODUCTION_DEFAULT_PROBES).toBe(3);
	});

	test("reports min/median/max timing only and never percentiles", () => {
		expect(timingSummary([])).toBeNull();
		const odd = timingSummary([30, 10, 20]);
		expect(odd).toEqual({ sampleCount: 3, minMs: 10, medianMs: 20, maxMs: 30 });
		const even = timingSummary([10, 40, 30, 20]);
		expect(even).toEqual({ sampleCount: 4, minMs: 10, medianMs: 25, maxMs: 40 });
		for (const summary of [odd, even]) {
			expect(summary.p95).toBeUndefined();
			expect(summary.p99).toBeUndefined();
			expect(Object.keys(summary).sort()).toEqual(["maxMs", "medianMs", "minMs", "sampleCount"]);
		}
	});
});

describe("runReproductionSeries", () => {
	test("captures per-probe evidence and reports direct match counts", async () => {
		const seen = [];
		const result = await runReproductionSeries({
			request: REQUEST,
			predicate: STATUS_PREDICATE,
			probeCount: 3,
			probe: async (candidate) => {
				seen.push(candidate);
				return failingResult(`exec-${seen.length}`);
			},
		});

		expect(seen).toHaveLength(3);
		expect(seen[0]).not.toBe(REQUEST);
		expect(result).toMatchObject({
			schemaVersion: 1,
			kind: "tracer.reproduction-series",
			status: "completed",
			completed: true,
			plannedProbes: 3,
			attempts: 3,
			matches: 3,
			classification: "reproducible",
			statement: "3/3 probes reproduced the failure",
			error: null,
		});
		expect(result.probes).toHaveLength(3);
		result.probes.forEach((probe, index) => {
			expect(probe).toMatchObject({
				index: index + 1,
				executionId: `exec-${index + 1}`,
				outcome: "response",
				responseStatus: 500,
				predicateMatched: true,
			});
			expect(probe.durationMs).toBeGreaterThanOrEqual(0);
		});
		expect(result.timing.minMs).toBeLessThanOrEqual(result.timing.medianMs);
		expect(result.timing.medianMs).toBeLessThanOrEqual(result.timing.maxMs);
	});

	test("reports 0/3 and mixed 2/3 evidence with their deterministic classifications", async () => {
		const none = await runReproductionSeries({
			request: REQUEST,
			predicate: STATUS_PREDICATE,
			probeCount: 3,
			probe: async () => passingResult("exec-ok"),
		});
		expect(none).toMatchObject({ matches: 0, attempts: 3, classification: "not_reproduced", statement: "0/3 probes reproduced the failure" });

		let calls = 0;
		const mixed = await runReproductionSeries({
			request: REQUEST,
			predicate: STATUS_PREDICATE,
			probeCount: 3,
			probe: async () => {
				calls += 1;
				return calls === 2 ? passingResult("exec-ok") : failingResult("exec-fail");
			},
		});
		expect(mixed).toMatchObject({ matches: 2, attempts: 3, classification: "flaky", statement: "2/3 probes reproduced the failure" });
		expect(mixed.probes.map((probe) => probe.predicateMatched)).toEqual([true, false, true]);
	});

	test("keeps partial evidence and marks an interrupted series inconclusive", async () => {
		let calls = 0;
		const result = await runReproductionSeries({
			request: REQUEST,
			predicate: STATUS_PREDICATE,
			probeCount: 3,
			probe: async () => {
				calls += 1;
				if (calls === 2) throw new Error("socket hang up");
				return failingResult("exec-fail");
			},
		});

		expect(result).toMatchObject({
			status: "failed",
			completed: false,
			attempts: 1,
			matches: 1,
			classification: "inconclusive",
			statement: "1/1 probes reproduced the failure (series incomplete)",
		});
		expect(result.error).toEqual({ code: "REPRO_PROBE_FAILED", message: "socket hang up" });
		expect(result.probes).toHaveLength(1);
	});

	test("stops between probes on cancellation and reports what was observed", async () => {
		const controller = new AbortController();
		let calls = 0;
		const result = await runReproductionSeries({
			request: REQUEST,
			predicate: STATUS_PREDICATE,
			probeCount: 3,
			signal: controller.signal,
			probe: async () => {
				calls += 1;
				if (calls === 1) controller.abort();
				return failingResult("exec-fail");
			},
		});

		expect(result).toMatchObject({
			status: "cancelled",
			completed: false,
			attempts: 1,
			matches: 1,
			classification: "inconclusive",
			statement: "1/1 probes reproduced the failure (series incomplete)",
		});
		expect(result.error).toEqual({ code: "REPRO_CANCELLED", message: "The reproduction series was cancelled." });
		expect(calls).toBe(1);
	});

	test("treats an in-flight probe rejection after abort as cancellation", async () => {
		const controller = new AbortController();
		const result = await runReproductionSeries({
			request: REQUEST,
			predicate: STATUS_PREDICATE,
			probeCount: 3,
			signal: controller.signal,
			probe: async () => {
				controller.abort();
				throw new Error("The execution was cancelled.");
			},
		});
		expect(result).toMatchObject({ status: "cancelled", attempts: 0, classification: "inconclusive" });
		expect(result.statement).toBe("0/0 probes reproduced the failure (series incomplete)");
	});

	test("hard-caps the series even when a larger probe count is requested", async () => {
		let calls = 0;
		const result = await runReproductionSeries({
			request: REQUEST,
			predicate: STATUS_PREDICATE,
			probeCount: 99,
			probe: async () => {
				calls += 1;
				return failingResult("exec-fail");
			},
		});
		expect(calls).toBe(REPRODUCTION_MAX_PROBES);
		expect(result.plannedProbes).toBe(REPRODUCTION_MAX_PROBES);
		expect(result.attempts).toBe(REPRODUCTION_MAX_PROBES);
	});

	test("rejects invalid predicates and missing probes", async () => {
		const invalid = (() => {
			try {
				validateFailurePredicate({ type: "guess" });
				return null;
			} catch (error) {
				return error;
			}
		})();
		expect(invalid?.code).toBe("REPRO_PREDICATE_INVALID");
		await expect(
			runReproductionSeries({ request: REQUEST, predicate: { type: "guess" }, probe: async () => failingResult("x") }),
		).rejects.toThrow("Use an outcome, status, or assertion failure predicate.");
		await expect(runReproductionSeries({ request: null, predicate: STATUS_PREDICATE, probe: async () => failingResult("x") })).rejects.toThrow(
			"A replayable request is required.",
		);
		await expect(runReproductionSeries({ request: REQUEST, predicate: STATUS_PREDICATE, probe: undefined })).rejects.toThrow(
			"A verification probe runner is required.",
		);
	});
});
