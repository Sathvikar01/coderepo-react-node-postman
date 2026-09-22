// Phase 14 — the exit-code contract is public: CI branches on these numbers, so
// they are pinned by tests rather than left to drift.

import { describe, expect, test } from "bun:test";
import { EXIT_CODES, EXIT_CODE_MEANINGS, exitCodeForRun, statusForExitCode } from "./cli-exit.js";

const run = (overrides = {}) => ({
	status: "completed",
	stopReason: null,
	summary: { outcome: "passed", passed: 1, failed: 0, skipped: 0, cancelled: 0 },
	...overrides,
});

describe("cli exit code contract", () => {
	test("the numeric codes and their meanings are stable and documented", () => {
		expect(EXIT_CODES).toEqual({ success: 0, runFailed: 1, invalidInput: 2, systemFailure: 3, timeout: 124, cancelled: 130 });
		for (const code of Object.values(EXIT_CODES)) expect(EXIT_CODE_MEANINGS[code]).toBeTruthy();
	});

	test("a passing run exits 0", () => {
		expect(exitCodeForRun(run())).toBe(EXIT_CODES.success);
	});

	test("a run with a failed step exits 1", () => {
		expect(exitCodeForRun(run({ summary: { outcome: "failed", passed: 1, failed: 1, skipped: 0, cancelled: 0 } }))).toBe(
			EXIT_CODES.runFailed,
		);
		// The summary can report a failure even when the top-line outcome was not set.
		expect(exitCodeForRun(run({ summary: { outcome: "passed", passed: 1, failed: 2, skipped: 0, cancelled: 0 } }))).toBe(
			EXIT_CODES.runFailed,
		);
	});

	test("a cancelled run exits 130, and cancellation wins over a failure", () => {
		expect(exitCodeForRun(run({ status: "cancelled", stopReason: "cancelled" }))).toBe(EXIT_CODES.cancelled);
		expect(exitCodeForRun(run({ summary: { outcome: "failed", passed: 0, failed: 1, skipped: 0, cancelled: 1 } }))).toBe(
			EXIT_CODES.cancelled,
		);
	});

	test("a run that failed to run at all exits 3", () => {
		expect(exitCodeForRun(run({ status: "failed", stopReason: "error" }))).toBe(EXIT_CODES.systemFailure);
		expect(exitCodeForRun(null)).toBe(EXIT_CODES.systemFailure);
	});

	test("status labels never require the caller to interpret a bare number", () => {
		expect(statusForExitCode(EXIT_CODES.success)).toBe("success");
		expect(statusForExitCode(EXIT_CODES.runFailed)).toBe("failed");
		expect(statusForExitCode(EXIT_CODES.invalidInput)).toBe("invalid");
		expect(statusForExitCode(EXIT_CODES.systemFailure)).toBe("error");
		expect(statusForExitCode(EXIT_CODES.timeout)).toBe("timed_out");
		expect(statusForExitCode(EXIT_CODES.cancelled)).toBe("cancelled");
	});
});
