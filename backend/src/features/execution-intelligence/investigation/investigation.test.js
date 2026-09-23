// Phase 35 — InvestigationV1 assembly and strict-schema tests (pure).
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../../shared/config/index.js";
import { AppError } from "../../../shared/errors/app-error.js";
import { buildInvestigationV1, scrubSecrets } from "./investigation.js";
import { parseInvestigation, parseInvestigationInput } from "./investigation-model.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase35_model_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase35-model-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase35-model-test-jwt-secret";
beforeAll(() => initConfig());

const INVESTIGATION = "66666666-6666-4666-8666-666666666666";
const GOOD = "22222222-2222-4222-8222-222222222222";
const FAILING = "33333333-3333-4333-8333-333333333333";
const PROBE_APPLIED = "44444444-4444-4444-8444-444444444444";
const PROBE_REVERTED = "55555555-5555-4555-8555-555555555555";
const PROBE_OTHER = "77777777-7777-4777-8777-777777777777";

const PREDICATE = { type: "status", equals: 500 };

function provenEvidence() {
	return {
		applied: { probeExecutionId: PROBE_APPLIED, predicateMatched: true, outcome: "response", status: 500 },
		reverted: { probeExecutionId: PROBE_REVERTED, predicateMatched: false, outcome: "response", status: 200 },
	};
}

function item({ id = "query:row-debug", path = "query.debug", kind = "query", classification = "causal", reason = null, evidence = provenEvidence() } = {}) {
	return {
		schemaVersion: 1,
		kind: "tracer.counterfactual-intervention",
		delta: { id, path, kind, replayable: classification !== "not_replayable", before: null, after: { value: "1" } },
		classification,
		reason,
		evidence,
	};
}

const TIMELINE = {
	schemaVersion: 1,
	kind: "tracer.regression-timeline",
	boundary: { lastKnownGoodExecutionId: GOOD, firstKnownBadExecutionId: FAILING },
	unresolved: null,
	caveat: "Lineage is based on saved request identity; URL similarity is never used to group executions.",
};

function baseInput(overrides = {}) {
	return {
		investigationId: INVESTIGATION,
		failingExecutionId: FAILING,
		goodExecutionId: GOOD,
		predicate: PREDICATE,
		targetMode: "execution",
		status: "completed",
		error: null,
		regression: { source: "phase33", timeline: TIMELINE, unresolved: null },
		comparison: {
			baseExecutionId: GOOD,
			candidateExecutionId: FAILING,
			firstDivergence: { category: "request", path: "query.debug", message: "The saved request changed after the known-good run." },
			changes: [{ category: "request", path: "query.debug", message: "The saved request changed after the known-good run." }],
			contract: { breaking: true, changes: [{ kind: "status_changed", path: "status", before: 200, after: 500, severity: "breaking" }] },
		},
		counterfactual: {
			available: true,
			status: "completed",
			reason: null,
			probeBudget: 24,
			probesUsed: 6,
			budgetExhausted: false,
			items: [item()],
			probeExecutionIds: [PROBE_APPLIED, PROBE_REVERTED],
		},
		minimization: {
			status: "completed",
			reason: null,
			minimality: "one_minimal",
			budgetExhausted: false,
			probesUsed: 4,
			probeBudget: 12,
			originalComponentCount: 3,
			remainingComponentCount: 1,
			removed: [{ kind: "query", id: "row-unused", key: "unused" }],
			probeTrace: [{ index: 3, phase: "singleton", removals: [{ kind: "query", id: "row-unused", key: "unused" }], matched: true }],
			request: null,
			error: null,
			executionIds: [PROBE_OTHER],
		},
		reproducibility: {
			status: "completed",
			reason: null,
			appliedTo: "minimized",
			classification: "reproducible",
			statement: "The failure reproduced in 3 of 3 attempts.",
			plannedProbes: 3,
			attempts: 3,
			matches: 3,
			probes: [
				{ index: 0, probeExecutionId: "88888888-8888-4888-8888-888888888888", outcome: "response", responseStatus: 500, predicateMatched: true },
			],
			error: null,
			executionIds: ["88888888-8888-4888-8888-888888888888"],
		},
		capsule: {
			text: '{"schemaVersion":1,"kind":"tracer.repro-capsule"}',
			filename: "investigation-66666666.repro.json",
			requestSource: "minimized",
			requiredInputs: [{ name: "base_url", source: "environment" }],
		},
		stageOutputs: {
			completed: ["preparing", "regression_boundary", "comparison", "counterfactual", "minimization", "reproducibility", "capsule"],
			interruptedAt: null,
		},
		...overrides,
	};
}

function errorOf(fn) {
	try {
		fn();
		return null;
	} catch (error) {
		return error;
	}
}

describe("InvestigationV1 builder", () => {
	test("builds one coherent evidence-linked investigation and promotes only proven causes", () => {
		const result = buildInvestigationV1(baseInput());

		expect(result).toMatchObject({ schemaVersion: 1, kind: "tracer.investigation", status: "completed", failingExecutionId: FAILING, goodExecutionId: GOOD });
		expect(result.verifiedCauses).toHaveLength(1);
		expect(result.verifiedCauses[0]).toMatchObject({ label: "verified_cause" });
		expect(result.verifiedCauses[0].delta.path).toBe("query.debug");
		expect(result.verifiedCauses[0].evidence.appliedProbeExecutionId).toBe(PROBE_APPLIED);
		expect(result.verifiedCauses[0].evidence.revertedProbeExecutionId).toBe(PROBE_REVERTED);
		expect(result.verifiedCauses[0].executionIds).toEqual([PROBE_APPLIED, PROBE_REVERTED]);
		expect(result.summary.text).toContain("Verified cause(s): query.debug");
		expect(result.summary.counts).toEqual({ verifiedCauses: 1, unverifiedChanges: 0, interventions: 1, probes: 4 });
		expect(result.evidence.probeExecutionIds).toEqual([PROBE_APPLIED, PROBE_OTHER, PROBE_REVERTED, "88888888-8888-4888-8888-888888888888"].sort());

		// Every conclusion is linked to concrete execution/probe ids.
		for (const conclusion of result.evidence.conclusions) {
			expect(Array.isArray(conclusion.executionIds)).toBe(true);
		}
		const causeConclusions = result.evidence.conclusions.filter((entry) => entry.section === "verifiedCauses");
		expect(causeConclusions[0].executionIds).toEqual([PROBE_APPLIED, PROBE_REVERTED]);
	});

	test("is deterministic: identical stage outputs assemble identical documents and ordering", () => {
		const first = buildInvestigationV1(baseInput());
		const second = buildInvestigationV1(baseInput());
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));

		const multi = buildInvestigationV1(
			baseInput({
				counterfactual: {
					available: true,
					status: "completed",
					reason: null,
					probeBudget: 24,
					probesUsed: 10,
					budgetExhausted: false,
					items: [
						item({ id: "header:row-b", path: "headers.X-B", kind: "header", classification: "not_causal", reason: "not_causal_in_counterfactual_probe" }),
						item({ id: "header:row-a", path: "headers.X-A", kind: "header", classification: "inconclusive", reason: "probe_budget_exhausted" }),
					],
					probeExecutionIds: [PROBE_APPLIED, PROBE_REVERTED],
				},
				comparison: {
					baseExecutionId: GOOD,
					candidateExecutionId: FAILING,
					firstDivergence: { category: "source", path: "source.environmentRevision", message: "The environment revision changed." },
					changes: [
						{ category: "source", path: "source.environmentRevision", message: "The environment revision changed." },
						{ category: "request", path: "request.compiledFingerprint", message: "The compiled request fingerprint changed." },
					],
					contract: { breaking: false, changes: [] },
				},
			}),
		);
		expect(JSON.stringify(multi)).toBe(JSON.stringify(buildInvestigationV1(baseInput({
			counterfactual: JSON.parse(JSON.stringify({
				available: true,
				status: "completed",
				reason: null,
				probeBudget: 24,
				probesUsed: 10,
				budgetExhausted: false,
				items: [
					item({ id: "header:row-b", path: "headers.X-B", kind: "header", classification: "not_causal", reason: "not_causal_in_counterfactual_probe" }),
					item({ id: "header:row-a", path: "headers.X-A", kind: "header", classification: "inconclusive", reason: "probe_budget_exhausted" }),
				],
				probeExecutionIds: [PROBE_APPLIED, PROBE_REVERTED],
			})),
			comparison: JSON.parse(JSON.stringify({
				baseExecutionId: GOOD,
				candidateExecutionId: FAILING,
				firstDivergence: { category: "source", path: "source.environmentRevision", message: "The environment revision changed." },
				changes: [
					{ category: "source", path: "source.environmentRevision", message: "The environment revision changed." },
					{ category: "request", path: "request.compiledFingerprint", message: "The compiled request fingerprint changed." },
				],
				contract: { breaking: false, changes: [] },
			})),
		}))));
		// Intervention conclusions first (source order preserved), comparison-only after.
		expect(multi.unverifiedChanges.map((change) => change.change.path)).toEqual([
			"headers.X-B",
			"headers.X-A",
			"source.environmentRevision",
			"request.compiledFingerprint",
		]);
	});

	test("rejects a causal classification without successful Phase 31 intervention evidence", () => {
		const missingProbe = errorOf(() =>
			buildInvestigationV1(
				baseInput({ counterfactual: { available: true, status: "completed", reason: null, probeBudget: 24, probesUsed: 2, budgetExhausted: false, items: [item({ evidence: { applied: null, reverted: null } })], probeExecutionIds: [] } }),
			),
		);
		expect(missingProbe).toBeInstanceOf(AppError);
		expect(missingProbe.code).toBe("INVESTIGATION_EVIDENCE_INVALID");

		const notReproduced = errorOf(() =>
			buildInvestigationV1(
				baseInput({
					counterfactual: {
						available: true,
						status: "completed",
						reason: null,
						probeBudget: 24,
						probesUsed: 2,
						budgetExhausted: false,
						items: [item({ evidence: { ...provenEvidence(), applied: { probeExecutionId: PROBE_APPLIED, predicateMatched: false, outcome: "response", status: 200 } } })],
						probeExecutionIds: [],
					},
				}),
			),
		);
		expect(notReproduced).toBeInstanceOf(AppError);
		expect(notReproduced.code).toBe("INVESTIGATION_EVIDENCE_INVALID");

		const notReverted = errorOf(() =>
			buildInvestigationV1(
				baseInput({
					counterfactual: {
						available: true,
						status: "completed",
						reason: null,
						probeBudget: 24,
						probesUsed: 2,
						budgetExhausted: false,
						items: [item({ evidence: { ...provenEvidence(), reverted: { probeExecutionId: PROBE_REVERTED, predicateMatched: true, outcome: "response", status: 500 } } })],
						probeExecutionIds: [],
					},
				}),
			),
		);
		expect(notReverted).toBeInstanceOf(AppError);
		expect(notReverted.code).toBe("INVESTIGATION_EVIDENCE_INVALID");
	});

	test("never promotes non-causal interventions to verified causes, and maps labels truthfully", () => {
		const result = buildInvestigationV1(
			baseInput({
				counterfactual: {
					available: true,
					status: "completed",
					reason: null,
					probeBudget: 24,
					probesUsed: 8,
					budgetExhausted: false,
					items: [
						// Evidence that LOOKS perfect must not matter: the classification
						// comes from the Phase 31 engine, and only `causal` is promoted.
						item({ id: "query:row-x", path: "query.x", classification: "not_causal", reason: "not_causal_in_counterfactual_probe" }),
						item({ id: "auth:mode", path: "request.auth", kind: "auth", classification: "not_replayable", reason: "authentication_not_reconstructable", evidence: { applied: null, reverted: null } }),
						item({ id: "body:json", path: "request.body$.break", kind: "body.json", classification: "inconclusive", reason: "probe_budget_exhausted" }),
					],
					probeExecutionIds: [PROBE_APPLIED, PROBE_REVERTED],
				},
				comparison: {
					baseExecutionId: GOOD,
					candidateExecutionId: FAILING,
					firstDivergence: null,
					changes: [],
					contract: { breaking: true, changes: [] },
				},
			}),
		);
		expect(result.verifiedCauses).toHaveLength(0);
		expect(result.unverifiedChanges.map((change) => change.label)).toEqual(["unverified", "not_replayable", "inconclusive"]);
		expect(result.summary.text).toContain("No change was experimentally verified as the cause.");
	});

	test("labels comparison-only changes as leading divergence or correlated change, never as causes", () => {
		const result = buildInvestigationV1(
			baseInput({
				counterfactual: {
					available: true,
					status: "completed",
					reason: null,
					probeBudget: 24,
					probesUsed: 4,
					budgetExhausted: false,
					items: [item({ id: "auth:mode", path: "request.auth", kind: "auth", classification: "not_replayable", reason: "authentication_not_reconstructable", evidence: { applied: null, reverted: null } })],
					probeExecutionIds: [],
				},
				comparison: {
					baseExecutionId: GOOD,
					candidateExecutionId: FAILING,
					firstDivergence: { category: "source", path: "source.environmentRevision", message: "The environment revision changed." },
					changes: [
						{ category: "auth", path: "request.auth", message: "The recorded authentication mode changed." },
						{ category: "source", path: "source.environmentRevision", message: "The environment revision changed." },
						{ category: "request", path: "request.compiledFingerprint", message: "The compiled request fingerprint changed." },
					],
					contract: { breaking: true, changes: [] },
				},
			}),
		);
		expect(result.verifiedCauses).toHaveLength(0);
		// `request.auth` was already concluded by its intervention and is never
		// double-claimed from the comparison.
		const paths = result.unverifiedChanges.map((change) => `${change.source}:${change.change.path}`);
		expect(paths).toEqual(["intervention:request.auth", "comparison:source.environmentRevision", "comparison:request.compiledFingerprint"]);
		expect(result.unverifiedChanges[1].label).toBe("leading_divergence");
		expect(result.unverifiedChanges[2].label).toBe("correlated_change");
		expect(result.summary.text).toContain("No change was experimentally verified as the cause.");
		expect(result.summary.text).toContain("Leading divergence (correlated, not proven): source.environmentRevision.");
	});

	test("degrades truthfully without any historical baseline but still minimizes, reproduces, and exports", () => {
		const result = buildInvestigationV1(
			baseInput({
				goodExecutionId: null,
				regression: {
					source: "none",
					timeline: { schemaVersion: 1, kind: "tracer.regression-timeline", boundary: null, unresolved: { reason: "NO_HISTORY", message: "No earlier execution is recorded for this request lineage." }, caveat: "" },
					unavailableReason: "no_good_execution_no_history",
				},
				comparison: null,
				counterfactual: null,
				reproducibility: {
					status: "completed",
					reason: null,
					appliedTo: "failing",
					classification: "reproducible",
					statement: "The failure reproduced in 3 of 3 attempts.",
					plannedProbes: 3,
					attempts: 3,
					matches: 3,
					probes: [],
					error: null,
					executionIds: [PROBE_OTHER],
				},
				stageOutputs: { completed: ["preparing", "regression_boundary", "comparison", "counterfactual", "minimization", "reproducibility", "capsule"], interruptedAt: null },
			}),
		);
		expect(result.regressionBoundary).toMatchObject({ source: "none", resolved: false, goodExecutionId: null });
		expect(result.regressionBoundary.unresolved.reason).toBe("NO_HISTORY");
		expect(result.comparison.available).toBe(false);
		expect(result.comparison.unavailableReason).toBe("no_good_execution_no_history");
		expect(result.interventions.available).toBe(false);
		expect(result.verifiedCauses).toHaveLength(0);
		expect(result.minimization.status).toBe("completed");
		expect(result.minimization.minimality).toBe("one_minimal");
		expect(result.reproducibility.classification).toBe("reproducible");
		expect(result.reproductionCapsule.available).toBe(true);
		expect(result.summary.text).toContain("Start of the failure: unresolved (NO_HISTORY).");
	});

	test("carries an explicit user-provided comparison base even when history is ambiguous", () => {
		const result = buildInvestigationV1(
			baseInput({
				regression: {
					source: "provided",
					timeline: { schemaVersion: 1, kind: "tracer.regression-timeline", boundary: null, unresolved: { reason: "AMBIGUOUS_LINEAGE", message: "A trustworthy request lineage could not be established." }, caveat: "" },
				},
			}),
		);
		expect(result.regressionBoundary).toMatchObject({ source: "provided", resolved: true, goodExecutionId: GOOD });
		expect(result.regressionBoundary.unresolved.reason).toBe("AMBIGUOUS_LINEAGE");
		expect(result.comparison.available).toBe(true);
	});

	test("marks later stages not reached instead of inventing results when a run is cancelled", () => {
		const result = buildInvestigationV1(
			baseInput({
				status: "cancelled",
				error: { code: "INVESTIGATION_CANCELLED", message: "The investigation was cancelled." },
				comparison: null,
				counterfactual: null,
				minimization: null,
				reproducibility: null,
				capsule: null,
				stageOutputs: { completed: ["preparing", "regression_boundary"], interruptedAt: "comparison" },
			}),
		);
		expect(result.status).toBe("cancelled");
		expect(result.error.code).toBe("INVESTIGATION_CANCELLED");
		expect(result.stages).toEqual({ completed: ["preparing", "regression_boundary"], interruptedAt: "comparison" });
		expect(result.minimization).toMatchObject({ status: "skipped", reason: "not_reached_after_cancellation" });
		expect(result.reproducibility).toMatchObject({ status: "skipped", reason: "not_reached_after_cancellation" });
		expect(result.reproductionCapsule.available).toBe(false);
		expect(result.verifiedCauses).toHaveLength(0);
	});

	test("rejects malformed documents and schema drift (strict schemas)", () => {
		const valid = buildInvestigationV1(baseInput());
		expect(parseInvestigation(valid)).toEqual(valid);

		const withConfidence = { ...valid, confidence: 0.9 };
		expect(errorOf(() => parseInvestigation(withConfidence))).toBeInstanceOf(AppError);

		const withBadLabel = JSON.parse(JSON.stringify(valid));
		withBadLabel.verifiedCauses[0].label = "verified_causes";
		expect(errorOf(() => parseInvestigation(withBadLabel))).toBeInstanceOf(AppError);

		const withUnknownSection = { ...valid, hypotheses: [] };
		expect(errorOf(() => parseInvestigation(withUnknownSection))).toBeInstanceOf(AppError);

		const withWrongKind = { ...valid, kind: "tracer.hypothesis" };
		expect(errorOf(() => parseInvestigation(withWrongKind))).toBeInstanceOf(AppError);

		// No AI inference, no confidence values, no heuristic scoring anywhere.
		const forbidden = ["confidence", "probability", "likelihood", "ai", "model", "hypotheses", "score"];
		const flatKeys = new Set();
		const walk = (value) => {
			if (Array.isArray(value)) return value.forEach(walk);
			if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) { flatKeys.add(key); walk(entry); }
		};
		walk(valid);
		for (const key of forbidden) expect(flatKeys.has(key)).toBe(false);
	});

	test("scrubs resolved secrets and validates investigation input", () => {
		const scrubbed = scrubSecrets(
			{ text: "Authorization: Bearer sk-secret-value-1 and sk-secret-value-1 again", nested: ["sk-secret-value-1", { deep: "x sk-secret-value-1 y" }] },
			["sk-secret-value-1"],
		);
		expect(JSON.stringify(scrubbed)).not.toContain("sk-secret-value-1");
		expect(JSON.stringify(scrubbed)).toContain("[REDACTED]");

		const parsed = parseInvestigationInput({ failingExecutionId: FAILING });
		expect(parsed.targetMode).toBe("execution");
		expect(parsed.allowUnsafeLocal).toBe(false);
		expect(parsed.allowUnsafeConfirm).toBe(false);

		expect(errorOf(() => parseInvestigationInput({ failingExecutionId: FAILING, goodExecutionId: FAILING }))).toBeInstanceOf(AppError);
		expect(errorOf(() => parseInvestigationInput({ failingExecutionId: "not-a-uuid" }))).toBeInstanceOf(AppError);
		expect(errorOf(() => parseInvestigationInput({ failingExecutionId: FAILING, probeBudget: 999 }))).toBeInstanceOf(AppError);
		expect(errorOf(() => parseInvestigationInput({ failingExecutionId: FAILING, extra: true }))).toBeInstanceOf(AppError);
	});
});
