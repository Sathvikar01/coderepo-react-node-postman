import { describe, expect, test } from "bun:test";
import {
	INVESTIGATION_STAGES,
	boundaryLine,
	canInvestigateHistoryItem,
	canInvestigateStep,
	capsuleLine,
	changeLabel,
	failurePredicateForReceipt,
	investigationErrorMessage,
	investigationStatusBanner,
	isFailureResult,
	isRunning,
	isTerminalStatus,
	minimizationLine,
	predicateLine,
	reproducibilityLine,
	sanitizeEvidenceText,
	shortId,
	stageLabel,
	unverifiedChangeItems,
	verifiedCauseItems,
} from "./investigation-model.js";

const failingResult = (overrides = {}) => ({
	outcome: "response",
	response: { status: 500, headers: [], body: { text: "", contentType: "application/json", truncated: false } },
	scriptResults: [],
	...overrides,
});

describe("investigation entry-point gates", () => {
	test("exposes the entry point for genuine failures only", () => {
		expect(canInvestigateHistoryItem({ status: "completed", outcome: "response", statusCode: 503 })).toBe(true);
		expect(canInvestigateHistoryItem({ status: "completed", outcome: "network_error", statusCode: null })).toBe(true);
		expect(canInvestigateHistoryItem({ status: "completed", outcome: "timeout", statusCode: null })).toBe(true);
		expect(canInvestigateHistoryItem({ status: "completed", outcome: "response", statusCode: 200 })).toBe(false);
		expect(isFailureResult(failingResult())).toBe(true);
		expect(isFailureResult(failingResult({ response: { status: 200 } }))).toBe(false);
	});

	test("never offers the entry point for cancelled rows even with a captured 4xx status", () => {
		// Regression: the old gate checked statusCode >= 400 before excluding
		// cancelled outcomes, which exposed Investigate on cancelled rows.
		expect(canInvestigateHistoryItem({ status: "cancelled", outcome: "cancelled", statusCode: 503 })).toBe(false);
		expect(canInvestigateHistoryItem({ status: "cancelled", outcome: "cancelled", statusCode: 404 })).toBe(false);
		expect(isFailureResult(failingResult({ outcome: "cancelled", response: { status: 500 } }))).toBe(false);
	});

	test("never offers the entry point for running rows or mock results", () => {
		expect(canInvestigateHistoryItem({ status: "running", outcome: null, statusCode: null })).toBe(false);
		expect(canInvestigateHistoryItem({ status: "completed", outcome: "mock", statusCode: null })).toBe(false);
		expect(canInvestigateHistoryItem({ status: "completed", outcome: "mock_miss", statusCode: null })).toBe(false);
		expect(isFailureResult(failingResult({ mock: true }))).toBe(false);
		expect(isFailureResult(failingResult({ outcome: "mock" }))).toBe(false);
	});

	test("offers the entry point for failed runner steps with an execution record only", () => {
		// Regression: admission errors fail with executionId === null and have no
		// execution record/passport, so they must not offer the entry point.
		expect(canInvestigateStep({ status: "failed", executionId: "8b7cf242-2f34-4bd4-8ce4-2d7a5a2cb001", outcome: "response" })).toBe(true);
		expect(canInvestigateStep({ status: "failed", executionId: null, outcome: "validation_error" })).toBe(false);
		expect(canInvestigateStep({ status: "failed", executionId: "8b7cf242-2f34-4bd4-8ce4-2d7a5a2cb001", outcome: "cancelled" })).toBe(false);
		expect(canInvestigateStep({ status: "completed", executionId: "8b7cf242-2f34-4bd4-8ce4-2d7a5a2cb001", outcome: "response" })).toBe(false);
		expect(canInvestigateStep({ status: "cancelled", executionId: "8b7cf242-2f34-4bd4-8ce4-2d7a5a2cb001", outcome: "cancelled" })).toBe(false);
		expect(canInvestigateStep(null)).toBe(false);
	});

	test("keeps genuine transport failures investigatable", () => {
		expect(isFailureResult(failingResult({ outcome: "network_error", response: null }))).toBe(true);
		expect(isFailureResult(failingResult({ outcome: "timeout", response: null }))).toBe(true);
		expect(canInvestigateHistoryItem({ status: "completed", outcome: "interrupted", statusCode: null })).toBe(true);
	});
});

describe("investigation truthfulness", () => {
	test("takes verified causes only from InvestigationV1.verifiedCauses", () => {
		// A probed-but-unproven intervention must never surface as a cause even if
		// older shapes carried counterfactual items.
		const result = {
			verifiedCauses: [],
			unverifiedChanges: [{ label: "unverified", change: { id: "c1", path: "query.debug" } }],
			interventions: {
				available: true,
				items: [{ classification: "not_causal", delta: { id: "c1", path: "query.debug" } }],
			},
			phases: { counterfactuals: [{ verificationStatus: "verified_cause", delta: { id: "legacy" } }] },
		};
		expect(verifiedCauseItems(result)).toEqual([]);
		expect(unverifiedChangeItems(result)).toHaveLength(1);
		expect(verifiedCauseItems(null)).toEqual([]);
	});

	test("only the verified_cause label may read as a cause", () => {
		expect(changeLabel("verified_cause")).toBe("Verified cause");
		for (const label of ["leading_divergence", "correlated_change", "unverified", "not_replayable", "inconclusive"]) {
			const text = changeLabel(label);
			expect(text).not.toBe("Verified cause");
			expect(text.toLowerCase()).not.toMatch(/\bis (the |a )?cause\b|\bcauses? the\b|\bcaused by\b/);
		}
		expect(changeLabel(undefined)).toBe("Unverified difference");
	});

	test("the status banner states evidence counts without embellishment", () => {
		expect(investigationStatusBanner(null)).toBe(null);
		const running = investigationStatusBanner({ status: "running", stage: "counterfactual" });
		expect(running.tone).toBe("info");
		expect(running.text).toContain("Verify what caused it");
		const verified = investigationStatusBanner({ status: "completed", result: { verifiedCauses: [{}, {}] } });
		expect(verified.tone).toBe("success");
		expect(verified.text).toBe("Investigation complete — 2 verified causes identified.");
		const none = investigationStatusBanner({ status: "completed", result: { verifiedCauses: [] } });
		expect(none.tone).toBe("warning");
		expect(none.text).toBe("Investigation complete — no change was verified as the cause.");
		expect(investigationStatusBanner({ status: "failed", error: { message: "boom" } })).toEqual({ tone: "danger", text: "boom" });
		expect(investigationStatusBanner({ status: "cancelled" })).toEqual({ tone: "warning", text: "Investigation cancelled." });
	});
});

describe("investigation section lines", () => {
	test("predicate lines describe the failure predicate exactly", () => {
		expect(predicateLine({ type: "status", equals: 500 })).toBe("Response status is 500");
		expect(predicateLine({ type: "outcome", equals: "timeout" })).toBe("Execution outcome is timeout");
		expect(predicateLine({ type: "assertion", assertionId: "assert_1" })).toBe("Assertion assert_1 fails");
		expect(predicateLine(null)).toBe("Failure predicate not available");
	});

	test("boundary lines stay chronological, never causal", () => {
		expect(
			boundaryLine({ resolved: true, goodExecutionId: "aaaaaaaa-1111-2222-3333-444455556666", failingExecutionId: "bbbbbbbb-1111-2222-3333-444455556666" }),
		).toContain("Failure begins between passing run aaaaaaaa and failing run bbbbbbbb.");
		expect(boundaryLine({ resolved: false, unresolved: { reason: "no_earlier_passing_run", message: "No earlier passing run of this request in the last 50 sends." } })).toBe(
			"No earlier passing run of this request in the last 50 sends.",
		);
		expect(boundaryLine(null)).toBe("Boundary not determined.");
	});

	test("minimization and reproducibility lines cover completed, partial, flaky, cancelled, and skipped states", () => {
		expect(
			minimizationLine({ status: "completed", removed: ["header.x-debug"], originalComponentCount: 3, remainingComponentCount: 2, probesUsed: 5, minimality: "one_minimal" }),
		).toBe("Removed 1 of 3 structural inputs in 5 probes — no smaller reproducer exists.");
		expect(minimizationLine({ status: "completed", removed: [], originalComponentCount: 4, probesUsed: 2, minimality: "budget_limited" })).toContain(
			"stopped at the probe budget",
		);
		expect(minimizationLine({ status: "skipped", reason: "unsafe_method" })).toContain("mutating requests are not replayed");
		expect(minimizationLine({ status: "cancelled" })).toBe("Minimization was cancelled.");
		expect(minimizationLine(null)).toBe("Minimization was not run.");

		const flaky = "The failure reproduced in 1 of 3 attempts and is flaky.";
		expect(reproducibilityLine({ status: "completed", classification: "flaky", statement: flaky })).toBe(flaky);
		expect(reproducibilityLine({ status: "failed", error: { message: "probe broke" } })).toContain("probe broke");
		expect(reproducibilityLine(null)).toBe("Reproducibility was not checked.");
	});

	test("capsule lines report availability without leaking contents", () => {
		expect(capsuleLine({ available: true, text: "…", requestSource: "minimized", requiredInputs: [{ name: "token", source: "secret_ref" }] })).toBe(
			"Available — minimized request, 1 required input documented, secrets redacted.",
		);
		expect(capsuleLine({ available: false, text: null })).toBe("No reproduction capsule was produced for this investigation.");
		expect(capsuleLine(null)).toBe("No reproduction capsule was produced for this investigation.");
	});
});

describe("investigation record states and errors", () => {
	test("classifies record and stage states", () => {
		expect(isRunning({ status: "running", stage: "comparison" })).toBe(true);
		expect(isRunning({ status: "completed", stage: "capsule" })).toBe(false);
		expect(isTerminalStatus("completed")).toBe(true);
		expect(isTerminalStatus("failed")).toBe(true);
		expect(isTerminalStatus("cancelled")).toBe(true);
		expect(isTerminalStatus("running")).toBe(false);
		expect(stageLabel("minimization")).toBe("Isolate the smallest reproducer");
		expect(shortId("8b7cf242-2f34-4bd4-8ce4-2d7a5a2cb001")).toBe("8b7cf242");
		expect(shortId(null)).toBe("—");
		expect(INVESTIGATION_STAGES[0].id).toBe("preparing");
	});

	test("maps merged Phase 35 error codes to honest messages", () => {
		expect(investigationErrorMessage({ code: "INVESTIGATION_TARGET_NOT_FOUND", message: "raw" })).toContain("no longer in history");
		expect(investigationErrorMessage({ code: "INVESTIGATION_BASELINE_NOT_FOUND", message: "raw" })).toContain("good run");
		expect(investigationErrorMessage({ code: "CAPSULE_UNAVAILABLE", message: "raw" })).toContain("No reproduction capsule is available");
		expect(investigationErrorMessage({ code: "RECEIPT_UNAVAILABLE", message: "raw" })).toContain("execution passport");
		expect(investigationErrorMessage({ code: "INVESTIGATION_NOT_FOUND", message: "raw" })).toContain("no longer available");
		expect(investigationErrorMessage({ message: "Something else" })).toBe("Something else");
		expect(investigationErrorMessage(null)).toBe("The investigation could not be started.");
	});
});

describe("sanitizeEvidenceText", () => {
	test("keeps backend evidence prose but replaces raw model vocabulary", () => {
		expect(sanitizeEvidenceText("delta classified correlated_change after probes")).toBe("delta classified correlated change after probes");
		expect(sanitizeEvidenceText("label leading_divergence boundary")).toBe("label leading divergence boundary");
		expect(sanitizeEvidenceText("it was inconclusive")).toBe("it was inconclusive");
		expect(sanitizeEvidenceText(null)).toBe("");
	});
});

describe("failurePredicateForReceipt", () => {
	test("mirrors the backend derivation order over the real receipt shape: assertions, then status, then outcome", () => {
		expect(failurePredicateForReceipt(null)).toBeNull();
		expect(failurePredicateForReceipt({ tests: { counts: { passed: 0, failed: 2, error: 0 } }, response: { contract: { status: 500 } } })).toEqual({
			type: "assertion",
			display: "Request assertions fail",
		});
		expect(failurePredicateForReceipt({ response: { contract: { status: 500 } }, outcome: "response" })).toEqual({ type: "status", equals: 500 });
		expect(failurePredicateForReceipt({ outcome: "timeout" })).toEqual({ type: "outcome", equals: "timeout" });
	});

	test("renders as recorded-fact lines without causal language", () => {
		expect(predicateLine(failurePredicateForReceipt({ response: { contract: { status: 500 } } }))).toBe("Response status is 500");
		expect(predicateLine(failurePredicateForReceipt({ tests: { counts: { failed: 1, error: 0 } } }))).toBe("Request assertions fail");
		expect(predicateLine(failurePredicateForReceipt({ outcome: "timeout" }))).toBe("Execution outcome is timeout");
	});
});
