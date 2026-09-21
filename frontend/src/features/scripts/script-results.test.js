import { describe, expect, test } from "bun:test";
import { phaseSummary, scriptConsoleEntries, scriptCounts, scriptResultsOf, scriptTests } from "./script-results.js";

const results = () => ({
	version: 1,
	preRequest: { status: "passed", error: null, console: [{ level: "log", message: "pre" }], mutations: { headers: [{ op: "set", name: "X" }], variables: [{ op: "set", key: "host" }] } },
	postResponse: { status: "passed", error: null, console: [{ level: "warn", message: "post" }], mutations: { headers: [], variables: [] } },
	tests: [
		{ name: "a", status: "passed", message: null },
		{ name: "b", status: "failed", message: "nope" },
	],
	counts: { passed: 1, failed: 1, errors: 0 },
});

describe("script results helpers", () => {
	test("reads live and history-inspected results", () => {
		expect(scriptResultsOf({ scriptResults: { counts: { passed: 1 } } }).counts.passed).toBe(1);
		expect(scriptResultsOf({ snapshot: { scriptResults: { counts: { passed: 2 } } } }).counts.passed).toBe(2);
		expect(scriptResultsOf({})).toBeNull();
		expect(scriptResultsOf(null)).toBeNull();
	});

	test("normalizes counts and tests", () => {
		expect(scriptCounts({})).toEqual({ passed: 0, failed: 0, errors: 0 });
		expect(scriptCounts({ counts: { passed: 3, failed: "2", errors: null } })).toEqual({ passed: 3, failed: 2, errors: 0 });
		expect(scriptTests({ tests: [{ name: "x" }] })).toHaveLength(1);
		expect(scriptTests({})).toEqual([]);
	});

	test("collects console entries with their phase", () => {
		const entries = scriptConsoleEntries(results());
		expect(entries.map((entry) => `${entry.phase}:${entry.message}`)).toEqual(["pre-request:pre", "test:post"]);
	});

	test("summarizes phase status and mutations", () => {
		expect(phaseSummary(null)).toEqual({ label: "Not configured", tone: "unknown" });
		expect(phaseSummary({ status: "error", mutations: {} })).toEqual({ label: "Script error", tone: "danger" });
		expect(phaseSummary({ status: "skipped", mutations: {} }).tone).toBe("warning");
		expect(phaseSummary(results().preRequest).label).toBe("Ran \u00b7 changed 1 variable, 1 header");
		expect(phaseSummary({ status: "passed", mutations: { headers: [], variables: [] } }).label).toBe("Ran");
	});
});
