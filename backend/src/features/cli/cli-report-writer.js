// Report artifacts for CI.
//
// The JSON report from `cli-output.js` is the authoritative machine document.
// This module only *persists* it and derives a JUnit XML view of the same
// object, so the file artifacts can never disagree with stdout. Nothing here
// reads from the network or from the runner, and every string it writes is the
// already-redacted text carried by the report. The JUnit XML is emitted without
// a dependency so the CLI stays installable from a frozen lockfile.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "./cli-errors.js";
import { ERROR_REPORT_KIND, PLAN_REPORT_KIND, REPORT_KIND, VALIDATE_REPORT_KIND, stringifyReport } from "./cli-output.js";

// XML 1.0 forbids most C0 control characters. Report text is bounded and already
// redacted, but it can echo target-controlled bytes, so strip anything a parser
// would reject rather than emitting malformed XML.
function xmlText(value) {
	return String(value ?? "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function seconds(durationMs) {
	const value = Number(durationMs);
	if (!Number.isFinite(value) || value <= 0) return "0";
	return (value / 1000).toFixed(3);
}

function caseStatus(status) {
	if (status === "passed") return "passed";
	if (status === "failed") return "failed";
	return "skipped";
}

function runTestCase(step, iterationCount) {
	const name = iterationCount > 1 ? `${step.name} [iteration ${step.iteration}]` : step.name;
	const attrs = [`name="${xmlText(name)}"`, `classname="tracer"`, `time="${seconds(step.durationMs)}"`];
	const body = [];
	if (step.executionId) body.push(`    <system-out>executionId=${xmlText(step.executionId)}</system-out>`);
	if (step.status === "failed") {
		body.push(`    <failure message="${xmlText(step.failureReason ?? "Request failed.")}" type="failure"></failure>`);
	} else if (step.status === "cancelled") {
		body.push(`    <skipped message="cancelled"></skipped>`);
	} else if (step.status === "skipped") {
		body.push(`    <skipped message="${xmlText(step.failureReason ?? "skipped")}"></skipped>`);
	}
	if (body.length === 0) return `    <testcase ${attrs.join(" ")}/>`;
	return `    <testcase ${attrs.join(" ")}>\n${body.join("\n")}\n    </testcase>`;
}

function countsFor(results) {
	const failures = results.filter((step) => step.status === "failed").length;
	const skipped = results.filter((step) => step.status === "cancelled" || step.status === "skipped").length;
	return { tests: results.length, failures, errors: 0, skipped };
}

export function buildJUnitReport(report) {
	if (report.kind === REPORT_KIND) {
		const results = report.results ?? [];
		const counts = countsFor(results);
		const suiteName = report.collection?.name ?? "tracer";
		const totalTime = seconds(report.summary?.durationMs ?? 0);
		const cases = results.map((step) => runTestCase(step, report.plan?.iterations ?? 1));
		return [
			`<?xml version="1.0" encoding="UTF-8"?>`,
			`<testsuites name="tracer" tests="${counts.tests}" failures="${counts.failures}" errors="${counts.errors}" skipped="${counts.skipped}" time="${totalTime}">`,
			`  <testsuite name="${xmlText(suiteName)}" tests="${counts.tests}" failures="${counts.failures}" errors="${counts.errors}" skipped="${counts.skipped}" time="${totalTime}">`,
			...cases,
			`  </testsuite>`,
			`</testsuites>`,
			``,
		].join("\n");
	}

	// Plan, validation, and error reports have no executed test cases. Emit a
	// well-formed suite so CI always has a parseable artifact; for an error, the
	// single test case carries the failure so the pipeline view is not silent.
	if (report.kind === ERROR_REPORT_KIND) {
		const code = report.error?.code ?? "CLI_FAILURE";
		const message = report.error?.message ?? "The CLI failed.";
		return [
			`<?xml version="1.0" encoding="UTF-8"?>`,
			`<testsuites name="tracer" tests="1" failures="0" errors="1" skipped="0" time="0">`,
			`  <testsuite name="tracer" tests="1" failures="0" errors="1" skipped="0" time="0">`,
			`    <testcase name="${xmlText(code)}" classname="tracer" time="0">`,
			`      <error message="${xmlText(message)}" type="${xmlText(code)}"></error>`,
			`    </testcase>`,
			`  </testsuite>`,
			`</testsuites>`,
			``,
		].join("\n");
	}

	const label = report.kind === PLAN_REPORT_KIND ? "plan" : report.kind === VALIDATE_REPORT_KIND ? "validate" : "report";
	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<testsuites name="tracer" tests="0" failures="0" errors="0" skipped="0" time="0">`,
		`  <testsuite name="${xmlText(label)}" tests="0" failures="0" errors="0" skipped="0" time="0"></testsuite>`,
		`</testsuites>`,
		``,
	].join("\n");
}

function writeFile(absolute, contents) {
	try {
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, contents, { encoding: "utf8" });
	} catch (error) {
		throw new CliError(`Could not write the report to ${absolute}: ${error?.message ?? "unknown error"}`, {
			code: "CLI_REPORT_WRITE",
			details: { path: absolute },
			exitCode: 3,
		});
	}
	return absolute;
}

export function writeJsonReport(filePath, report, { cwd = process.cwd() } = {}) {
	return writeFile(path.resolve(cwd, String(filePath)), stringifyReport(report));
}

export function writeJUnitReport(filePath, report, { cwd = process.cwd() } = {}) {
	return writeFile(path.resolve(cwd, String(filePath)), buildJUnitReport(report));
}
