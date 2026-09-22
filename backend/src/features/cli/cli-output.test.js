// Phase 14 — the JSON report is the machine contract and the human report is
// derived from it, so both are pinned here. A report must always be stable and
// must never carry a resolved secret value.

import { describe, expect, test } from "bun:test";
import { buildErrorReport, buildPlanReport, buildRunReport, buildValidateReport, renderErrorHuman, renderPlanHuman, renderReportHuman, renderRunHuman, renderValidateHuman, stringifyReport } from "./cli-output.js";

const source = { path: "/tmp/project", kind: "directory", name: "CLI fixtures", fingerprint: "abc123" };
const resolved = {
	collection: { _id: "c1", name: "Alpha", revision: 1 },
	environment: { _id: "e1", name: "Local", revision: 1 },
	selection: { mode: "collection" },
	selectionLabel: 'collection "Alpha"',
};
const plan = {
	iterations: 1,
	requestCount: 2,
	totalSteps: 2,
	steps: [
		{ index: 0, iteration: 1, requestId: "r1", name: "Create order", method: "POST" },
		{ index: 1, iteration: 1, requestId: "r2", name: "Read order", method: "GET" },
	],
};
const run = {
	runId: "run-1",
	collection: { id: "c1", name: "Alpha", revision: 1 },
	environment: { id: "e1", revision: 1 },
	options: { selection: { mode: "collection" }, iterations: 1, stopOnFailure: true, variableKeys: ["token"] },
	status: "completed",
	stopReason: "stop_on_failure",
	progress: { total: 2, completed: 2 },
	summary: { total: 2, executed: 2, passed: 1, failed: 1, skipped: 0, cancelled: 0, assertions: { passed: 1, failed: 0, errors: 0 }, outcome: "failed" },
	results: [
		{ index: 0, iteration: 1, requestId: "r1", name: "Create order", method: "POST", status: "passed", httpStatus: 201, durationMs: 12, failureReason: null },
		{ index: 1, iteration: 1, requestId: "r2", name: "Read order", method: "GET", status: "failed", httpStatus: 500, durationMs: 3, failureReason: "Test script failed: expected 200." },
	],
	error: null,
	startedAt: "2026-01-01T00:00:00.000Z",
	finishedAt: "2026-01-01T00:00:01.000Z",
};

describe("cli json report", () => {
	test("the run report has a fixed, documented shape", () => {
		const report = buildRunReport({ source, resolved, plan, run, exitCode: 1, allowLocal: ["127.0.0.1"] });
		expect(Object.keys(report)).toEqual([
			"schemaVersion",
			"kind",
			"tool",
			"project",
			"collection",
			"environment",
			"options",
			"plan",
			"runId",
			"status",
			"stopReason",
			"progress",
			"summary",
			"results",
			"error",
			"startedAt",
			"finishedAt",
			"timedOut",
			"exitCode",
		]);
		expect(report.kind).toBe("tracer.cli-run");
		expect(report.options).toMatchObject({ selectionLabel: 'collection "Alpha"', allowLocal: ["127.0.0.1"] });
		expect(report.plan.steps[0]).toEqual({ index: 0, iteration: 1, requestId: "r1", name: "Create order", method: "POST" });
		expect(report.options.timeoutMs).toBeNull();
		expect(report.timedOut).toBe(false);
	});

	test("a timed-out run records the budget and the timeout flag", () => {
		const report = buildRunReport({ source, resolved, plan, run: { ...run, status: "cancelled", stopReason: "cancelled" }, exitCode: 124, timeoutMs: 1500, timedOut: true });
		expect(report.options.timeoutMs).toBe(1500);
		expect(report.timedOut).toBe(true);
		expect(report.exitCode).toBe(124);
		const text = renderRunHuman(report);
		expect(text).toContain("Timed out:   exceeded 1500ms budget");
	});

	test("two identical runs serialize byte-for-byte the same", () => {
		const first = stringifyReport(buildRunReport({ source, resolved, plan, run, exitCode: 1 }));
		const second = stringifyReport(buildRunReport({ source, resolved, plan, run, exitCode: 1 }));
		expect(first).toBe(second);
		expect(first.endsWith("\n")).toBe(true);
	});

	test("reports never carry a resolved secret value, only variable keys", () => {
		const secret = "super-secret-token-value";
		const report = buildRunReport({ source, resolved, plan, run, exitCode: 0, allowLocal: [] });
		const text = stringifyReport(report);
		expect(text).toContain("token");
		expect(text).not.toContain(secret);
	});

	test("the plan report is marked as a plan and records the selection", () => {
		const report = buildPlanReport({
			source,
			resolved,
			plan,
			options: { iterations: 1, stopOnFailure: true, allowLocal: [] },
			variables: [{ key: "token", value: "x" }],
		});
		expect(report.kind).toBe("tracer.cli-plan");
		expect(report.collection.id).toBe("c1");
		expect(report.options.variableKeys).toEqual(["token"]);
		expect(report.exitCode).toBe(0);
	});

	test("the validate report states the project and its counts", () => {
		const report = buildValidateReport({
			source,
			domain: { collections: [{ requests: [{}, {}] }, { requests: [{}] }], environments: [{}] },
		});
		expect(report.kind).toBe("tracer.cli-validate");
		expect(report.valid).toBe(true);
		expect(report.counts).toEqual({ collections: 2, requests: 3, environments: 1 });
		const text = renderValidateHuman(report);
		expect(text).toContain("Valid:       2 collection(s) · 3 request(s) · 1 environment(s)");
	});

	test("the error report is invalid for caller mistakes and an error otherwise", () => {
		expect(buildErrorReport({ error: { code: "CLI_USAGE", message: "bad", details: null }, exitCode: 2 })).toMatchObject({
			kind: "tracer.cli-error",
			status: "invalid",
			exitCode: 2,
		});
		expect(buildErrorReport({ error: { code: "CLI_FAILURE", message: "x", details: null }, exitCode: 3 }).status).toBe("error");
	});
});

describe("cli human report", () => {
	test("the run summary states outcome, counts, stop reason, and exit code", () => {
		const text = renderRunHuman(buildRunReport({ source, resolved, plan, run, exitCode: 1, allowLocal: [] }));
		expect(text).toContain("PASS");
		expect(text).toContain("FAIL");
		expect(text).toContain("2 executed of 2");
		expect(text).toContain("Stop reason: stop_on_failure");
		expect(text).toContain("Exit code:   1");
		expect(text).toContain("Variables:   token (values are never printed)");
	});

	test("the plan report says nothing was sent", () => {
		const text = renderPlanHuman(
			buildPlanReport({ source, resolved, plan, options: { iterations: 1, stopOnFailure: true, variables: [], allowLocal: [] } }),
		);
		expect(text).toContain("No requests were sent (plan mode).");
	});

	test("the error report shows the code and exit code, and the dispatcher routes it", () => {
		const report = buildErrorReport({ error: { code: "CLI_USAGE", message: "Unknown option --nope.", details: null }, exitCode: 2 });
		const text = renderErrorHuman(report);
		expect(text).toContain("CLI_USAGE: Unknown option --nope.");
		expect(text).toContain("Exit code: 2");
		expect(renderReportHuman(report)).toBe(text);
	});
});
