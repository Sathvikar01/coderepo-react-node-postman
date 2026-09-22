import { describe, expect, test } from "bun:test";
import { assertionCountsOf, failureReasonOf, stepPassed, summarizeSteps } from "./run-summary.js";

const counts = (passed = 0, failed = 0, errors = 0) => ({ passed, failed, errors });

describe("step classification", () => {
	test("a clean response passes", () => {
		expect(stepPassed({ outcome: "response", scriptResults: { counts: counts(2, 0, 0) } })).toBe(true);
	});

	test("failed assertions and script errors fail a response step", () => {
		expect(stepPassed({ outcome: "response", scriptResults: { counts: counts(1, 1, 0) } })).toBe(false);
		expect(stepPassed({ outcome: "response", scriptResults: { counts: counts(0, 0, 1) } })).toBe(false);
	});

	test("a non-response outcome fails regardless of assertions", () => {
		expect(stepPassed({ outcome: "timeout", scriptResults: null })).toBe(false);
		expect(assertionCountsOf(null)).toEqual(counts(0, 0, 0));
	});
});

describe("failure reasons", () => {
	test("prefers the transport or policy error for non-response outcomes", () => {
		expect(failureReasonOf({ outcome: "timeout", error: { code: "TIMEOUT", message: "This execution exceeded its time budget." } })).toBe(
			"This execution exceeded its time budget.",
		);
		expect(failureReasonOf({ outcome: "network_error", error: null })).toBe("The request failed before a response arrived.");
	});

	test("reports the first failing script phase, test error, or assertion in order", () => {
		expect(
			failureReasonOf({
				outcome: "response",
				scriptResults: {
					preRequest: { status: "error", error: { message: "boom" } },
					postResponse: { status: "error", error: { message: "later" } },
					tests: [],
				},
			}),
		).toBe("Pre-request script failed: boom");
		expect(
			failureReasonOf({
				outcome: "response",
				scriptResults: {
					preRequest: null,
					postResponse: { status: "passed", error: null },
					tests: [
						{ name: "Broken check", status: "error", message: "response body is empty" },
						{ name: "Failed check", status: "failed", message: "Expected status 200." },
					],
				},
			}),
		).toBe('"Broken check" could not run: response body is empty');
		expect(
			failureReasonOf({
				outcome: "response",
				scriptResults: {
					preRequest: null,
					postResponse: null,
					tests: [{ name: "Status check", status: "failed", message: "Expected status 200 but received 404." }],
				},
			}),
		).toBe('"Status check" failed: Expected status 200 but received 404.');
	});

	test("falls back to a generic reason and stays bounded", () => {
		expect(failureReasonOf({ outcome: "response", scriptResults: null })).toBe(
			"The request finished but did not pass every check.",
		);
		const long = failureReasonOf({
			outcome: "response",
			scriptResults: { tests: [{ name: "Noisy check", status: "failed", message: "x".repeat(1000) }] },
		});
		expect(long.length).toBeLessThanOrEqual(401);
		expect(long.endsWith("…")).toBe(true);
	});
});

describe("run summaries", () => {
	test("counts statuses, assertions, and duration deterministically", () => {
		const summary = summarizeSteps([
			{ status: "passed", durationMs: 10, assertions: counts(2, 0, 0) },
			{ status: "failed", durationMs: 20, assertions: counts(1, 1, 1) },
			{ status: "cancelled", durationMs: 5, assertions: counts(0, 0, 0) },
			{ status: "skipped", durationMs: null, assertions: counts(0, 0, 0) },
			{ status: "pending", durationMs: null, assertions: counts(0, 0, 0) },
		]);
		expect(summary).toEqual({
			total: 5,
			executed: 2,
			passed: 1,
			failed: 1,
			cancelled: 1,
			skipped: 1,
			pending: 1,
			assertions: { passed: 3, failed: 1, errors: 1 },
			durationMs: 35,
			outcome: "failed",
		});
	});

	test("a run with only passing steps is a pass", () => {
		const summary = summarizeSteps([
			{ status: "passed", durationMs: 1, assertions: counts(1, 0, 0) },
			{ status: "skipped", durationMs: null, assertions: counts(0, 0, 0) },
		]);
		expect(summary.outcome).toBe("passed");
	});
});
