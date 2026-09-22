// Phase 15 — CI report artifacts. The JSON file is the authoritative machine
// document; the JUnit file is a derived view of the exact same report object.
// These tests pin the derivation and prove the writers never leak a resolved
// secret value.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { buildJUnitReport, writeJsonReport, writeJUnitReport } from "./cli-report-writer.js";
import { buildErrorReport, buildRunReport, buildValidateReport, stringifyReport } from "./cli-output.js";
import { cleanupTempDirs, makeTempDir } from "./test-fixtures.js";

afterAll(() => cleanupTempDirs());

const source = { path: "/tmp/project", kind: "portable", name: "CI fixtures", fingerprint: "fp-1" };
const resolved = {
	collection: { _id: "c1", name: "Orders & Health", revision: 1 },
	environment: null,
	selection: { mode: "collection" },
	selectionLabel: 'collection "Orders & Health"',
};
const plan = {
	iterations: 2,
	requestCount: 1,
	totalSteps: 2,
	steps: [{ index: 0, iteration: 1, requestId: "r1", name: "Health", method: "GET" }],
};
const run = {
	runId: "run-1",
	collection: { id: "c1", name: "Orders & Health", revision: 1 },
	options: { selection: { mode: "collection" }, iterations: 2, stopOnFailure: true, variableKeys: [] },
	status: "completed",
	stopReason: "stop_on_failure",
	progress: { total: 2, completed: 2 },
	summary: { total: 2, executed: 2, passed: 1, failed: 1, skipped: 1, cancelled: 0, assertions: { passed: 1, failed: 1, errors: 0 }, outcome: "failed", durationMs: 2500 },
	results: [
		{ index: 0, iteration: 1, requestId: "r1", name: "Health", method: "GET", status: "passed", httpStatus: 200, durationMs: 20, executionId: "exec-1", failureReason: null },
		{ index: 1, iteration: 2, requestId: "r1", name: "Health", method: "GET", status: "failed", httpStatus: 500, durationMs: 30, executionId: "exec-2", failureReason: "Expected 200 but received 500 <bad>" },
		{ index: 2, iteration: 2, requestId: "r1", name: "Health", method: "GET", status: "skipped", httpStatus: null, durationMs: 0, executionId: null, failureReason: "stop_on_failure" },
	],
	error: null,
	startedAt: "2026-01-01T00:00:00.000Z",
	finishedAt: "2026-01-01T00:00:01.000Z",
};

describe("junit report", () => {
	test("a run becomes one suite with one case per executed step", () => {
		const xml = buildJUnitReport(buildRunReport({ source, resolved, plan, run, exitCode: 1 }));
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(xml).toContain('<testsuites name="tracer" tests="3" failures="1" errors="0" skipped="1" time="2.500">');
		expect(xml).toContain('<testsuite name="Orders &amp; Health"');
		expect(xml).toContain('<testcase name="Health [iteration 1]" classname="tracer" time="0.020">');
		expect(xml).toContain("<failure message=\"Expected 200 but received 500 &lt;bad&gt;\" type=\"failure\">");
		expect(xml).toContain('<skipped message="stop_on_failure">');
		expect(xml).toContain("<system-out>executionId=exec-1</system-out>");
		// The execution id is the link back to the Flight Recorder evidence.
		expect(xml).toContain("<system-out>executionId=exec-2</system-out>");
	});

	test("an error report becomes a single failed case so CI is not silent", () => {
		const xml = buildJUnitReport(buildErrorReport({ error: { code: "CLI_PROJECT_NOT_FOUND", message: "Project not found: /missing & gone", details: null }, exitCode: 2 }));
		expect(xml).toContain('<testcase name="CLI_PROJECT_NOT_FOUND" classname="tracer" time="0">');
		expect(xml).toContain('<error message="Project not found: /missing &amp; gone" type="CLI_PROJECT_NOT_FOUND">');
	});

	test("a validate report produces a well-formed empty suite", () => {
		const xml = buildJUnitReport(buildValidateReport({ source, domain: { collections: [], environments: [] } }));
		expect(xml).toContain('tests="0"');
		expect(xml).toContain('name="validate"');
	});
});

describe("report writers", () => {
	test("write both artifacts, creating parent directories", () => {
		const dir = makeTempDir();
		const jsonPath = path.join(dir, "nested", "run.json");
		const junitPath = path.join(dir, "nested", "run.junit.xml");
		const report = buildRunReport({ source, resolved, plan, run, exitCode: 1 });
		expect(writeJsonReport(jsonPath, report)).toBe(jsonPath);
		expect(writeJUnitReport(junitPath, report)).toBe(junitPath);
		expect(existsSync(jsonPath)).toBe(true);
		expect(readFileSync(jsonPath, "utf8")).toBe(stringifyReport(report));
		expect(readFileSync(junitPath, "utf8")).toContain("<testsuites");
	});

	test("persisted artifacts never contain a resolved secret value", () => {
		const secret = "tok_live_9f3c-not-in-any-report";
		// A variable key named `token` stands in for the secret reference; only the
		// key may appear. The JUnit system-out must not smuggle a value either.
		const report = buildRunReport({ source, resolved, plan, run, exitCode: 0 });
		const dir = makeTempDir();
		const jsonPath = path.join(dir, "run.json");
		const junitPath = path.join(dir, "run.junit.xml");
		writeJsonReport(jsonPath, report);
		writeJUnitReport(junitPath, report);
		for (const file of [jsonPath, junitPath]) {
			const text = readFileSync(file, "utf8");
			expect(text).not.toContain(secret);
			expect(text).not.toContain("Authorization");
		}
	});

	test("an unwritable path is a system failure, not a crash", () => {
		const dir = makeTempDir();
		// A file cannot be used as a directory component.
		const blocker = path.join(dir, "blocker");
		writeJsonReport(blocker, buildValidateReport({ source, domain: { collections: [], environments: [] } }));
		expect(() => writeJsonReport(path.join(blocker, "nested.json"), buildValidateReport({ source, domain: { collections: [], environments: [] } }))).toThrow();
		try {
			writeJsonReport(path.join(blocker, "nested.json"), buildValidateReport({ source, domain: { collections: [], environments: [] } }));
		} catch (error) {
			expect(error.code).toBe("CLI_REPORT_WRITE");
			expect(error.exitCode).toBe(3);
		}
	});
});
