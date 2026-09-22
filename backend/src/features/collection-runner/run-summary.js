import { RUN_LIMITS } from "./run-limits.js";

// Step classification and run summaries are pure functions over the immutable step
// records, so progress, failure reasons, and totals stay deterministic and testable.

const OUTCOME_LABELS = {
	timeout: "The request timed out before a response arrived.",
	cancelled: "The request was cancelled.",
	size_limit: "The response exceeded the size limits of the workspace.",
	decode_error: "The response body could not be decoded.",
	network_error: "The request failed before a response arrived.",
	validation_error: "The request was refused before dispatch.",
	interrupted: "The request was interrupted before it finished.",
};

export const STEP_STATUSES = ["pending", "running", "passed", "failed", "skipped", "cancelled"];

function bounded(text) {
	const rendered = String(text ?? "");
	return rendered.length <= RUN_LIMITS.failureReasonBytes
		? rendered
		: `${rendered.slice(0, RUN_LIMITS.failureReasonBytes)}…`;
}

export function assertionCountsOf(scriptResults) {
	const counts = scriptResults?.counts;
	return {
		passed: counts?.passed ?? 0,
		failed: counts?.failed ?? 0,
		errors: counts?.errors ?? 0,
	};
}

export function stepPassed(result) {
	const counts = assertionCountsOf(result?.scriptResults);
	return result?.outcome === "response" && counts.failed === 0 && counts.errors === 0;
}

export function failureReasonOf(result) {
	if (!result) return "The request did not produce a recorded result.";
	if (result.outcome !== "response") {
		return bounded(result.error?.message ?? OUTCOME_LABELS[result.outcome] ?? `The request ended with "${result.outcome}".`);
	}
	const scriptResults = result.scriptResults ?? {};
	const phases = [
		["Pre-request script", scriptResults.preRequest],
		["Test script", scriptResults.postResponse],
	];
	for (const [label, phase] of phases) {
		if (phase?.status === "error" && phase.error?.message) return bounded(`${label} failed: ${phase.error.message}`);
	}
	for (const test of scriptResults.tests ?? []) {
		if (test?.status === "error") return bounded(`"${test.name ?? "Unnamed check"}" could not run: ${test.message ?? "script error"}`);
	}
	for (const test of scriptResults.tests ?? []) {
		if (test?.status === "failed")
			return bounded(`"${test.name ?? "Unnamed check"}" failed: ${test.message ?? "the check did not pass"}`);
	}
	return "The request finished but did not pass every check.";
}

export function summarizeSteps(steps) {
	const summary = {
		total: steps.length,
		executed: 0,
		passed: 0,
		failed: 0,
		cancelled: 0,
		skipped: 0,
		pending: 0,
		assertions: { passed: 0, failed: 0, errors: 0 },
		durationMs: 0,
	};
	for (const step of steps) {
		if (step.status === "skipped") summary.skipped += 1;
		else if (step.status === "cancelled") summary.cancelled += 1;
		else if (step.status === "pending" || step.status === "running") summary.pending += 1;
		else if (step.status === "passed") {
			summary.executed += 1;
			summary.passed += 1;
		} else {
			summary.executed += 1;
			summary.failed += 1;
		}
		summary.durationMs += step.durationMs ?? 0;
		summary.assertions.passed += step.assertions?.passed ?? 0;
		summary.assertions.failed += step.assertions?.failed ?? 0;
		summary.assertions.errors += step.assertions?.errors ?? 0;
	}
	summary.outcome = summary.failed > 0 || summary.cancelled > 0 ? "failed" : "passed";
	return summary;
}
