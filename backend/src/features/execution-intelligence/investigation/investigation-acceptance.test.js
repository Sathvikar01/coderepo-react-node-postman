// Phase 37 — Investigation acceptance + final freeze.
//
// One deterministic end-to-end scenario that proves the complete differentiating
// workflow the product claims:
//
//   Tracer records API executions, identifies where a regression began,
//   experimentally isolates the causal change, minimizes the failing request,
//   verifies whether the failure reproduces reliably, and creates a safe
//   reproducible artifact.
//
// The scenario runs the REAL merged Phase 31–35 engines (counterfactual cause
// verification, structured delta debugging, regression timeline, reproduction
// stability, InvestigationV1 assembly, ReproCapsuleV1) behind the investigation
// orchestrator, with a deterministic in-memory history/transport harness.
//
// It also pins the mandatory causality invariant: a `verified_cause` may appear
// ONLY when applying the delta to the known-good case reproduces the failure AND
// reverting it from the failing case removes the failure. Chronology,
// comparison ordering, correlation, and first divergence alone must never be
// promoted to a cause. That negative case is asserted explicitly below.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../../shared/config/index.js";
import { requestDefinitionSchema } from "../../../shared/utils/schemas.js";
import { AppError } from "../../../shared/errors/app-error.js";
import { createRegressionService } from "../regression/regression.service.js";
import { createCounterfactualService } from "../counterfactual/counterfactual.service.js";
import { createExecutionIntelligenceService } from "../execution-intelligence.service.js";
import { minimizeFailure } from "../failure-minimizer.js";
import { runReproductionSeries } from "../reproducibility/reproduction-series.js";
import { buildReproCapsule, parseReproCapsule, serializeReproCapsule } from "../repro-capsule.js";
import { buildInvestigationV1 } from "./investigation.js";
import { INVESTIGATION_STAGE_ORDER, VERIFIED_CAUSE_LABEL } from "./investigation-model.js";
import { createInvestigationService } from "./investigation.service.js";

beforeAll(() => {
	process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/tracer-phase37-acceptance";
	process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY ?? "phase37-acceptance-fingerprint-key";
	process.env.JWT_SECRET = process.env.JWT_SECRET ?? "phase37-acceptance-jwt-secret";
	initConfig();
});

const PROFILE_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const PROFILE_B = "22222222-bbbb-4bbb-8bbb-222222222222";
const COLLECTION_ID = "33333333-cccc-4ccc-8ccc-333333333333";
const REQUEST_ID = "44444444-dddd-4ddd-8ddd-444444444444";

// A resolved credential that must never surface in the investigation or capsule.
const SECRET = "sk-phase37-secret-2f9c4d1e";
const SECRET_HEADER = "Bearer sk-phase37-secret-2f9c4d1e";

function sharedRow(key, value) {
	return { id: randomUUID(), key, value, enabled: true };
}
function rowLike(row, value) {
	return { ...row, value };
}

function makeRequest({ name = "status probe", method = "GET", url = "http://127.0.0.1:8000/demo/v1/status/200", query = [], headers = [], body = { mode: "none" } } = {}) {
	return requestDefinitionSchema.parse({
		schemaVersion: 1,
		id: randomUUID(),
		name,
		method,
		urlTemplate: url,
		query,
		headers,
		body,
		auth: { mode: "none" },
		scripts: { preRequest: "", test: "" },
		assertions: [],
		settings: { timeoutMs: 5000 },
	});
}

let probeClock = 0;

function makeRecord({
	profileId = PROFILE_A,
	executionId = randomUUID(),
	request,
	outcome = "http_error",
	status = 500,
	policy = { decision: "allowed", local: false },
	source = { type: "collection", collectionId: COLLECTION_ID, requestId: REQUEST_ID },
	startedAt = new Date("2026-09-17T00:00:00.000Z"),
} = {}) {
	return {
		executionId,
		ownerProfileId: profileId,
		status: "terminal",
		visible: true,
		expired: false,
		startedAt,
		finishedAt: startedAt,
		expiresAt: new Date(Date.now() + 86400000),
		outcome,
		request,
		context: { source, environment: null },
		receipt: {
			schemaVersion: 1,
			kind: "tracer.execution-passport",
			executionId,
			request: {
				authoredFingerprint: `fp-auth-${executionId}`,
				compiledFingerprint: `fp-compiled-${executionId}`,
				auth: { mode: "none" },
			},
			response: { contract: { status, headers: [{ name: "content-type", count: 1 }], bodyPaths: [] } },
			policy: { decision: policy.decision, local: policy.local },
			source: { collectionRevision: 1, environmentRevision: 1 },
			target: { hostname: "127.0.0.1", address: "127.0.0.1" },
			transport: { durationMs: 4 },
			outcome,
			tests: { counts: { total: 0, passed: 0, failed: 0 }, failureFingerprint: null },
		},
		response: { status, binary: false, truncated: false, bodyFingerprint: `fp-body-${status}`, headers: [{ name: "content-type", value: "application/json", count: 1 }], bodyPreview: "" },
		scriptResults: [],
		snapshot: { scriptResults: [] },
	};
}

/**
 * Deterministic harness: in-memory history records shared by the real engines'
 * history lookups, and an execution transport that evaluates a scripted failure
 * rule and stores every probe as a normal history record. `send` is returned so
 * the acceptance test can perform the final manual reproduction of an imported
 * capsule through the same path a user's Send button uses.
 */
function makeHarness({ failWhen = () => true, policy = { decision: "allowed", local: false } } = {}) {
	const records = new Map();
	const investigations = new Map();
	const state = { sendCalls: 0, networkDispatches: 0 };

	const history = {
		async get(profileId, executionId) {
			const record = records.get(executionId);
			return record && record.ownerProfileId === profileId ? record : null;
		},
	};

	const executions = {
		async send(profileId, payload) {
			state.sendCalls += 1;
			const request = payload.request;
			const matched = Boolean(failWhen({ request, index: state.sendCalls }));
			const executionId = payload.executionId ?? randomUUID();
			const blocked = policy.decision !== "allowed";
			if (!blocked) state.networkDispatches += 1;
			// Probes are recorded well after the seeded evidence, so the Phase 33
			// timeline window (records at or before the failing run) never picks a
			// probe up as a "known good".
			const record = makeRecord({
				profileId,
				executionId,
				request,
				outcome: blocked ? "policy_blocked" : matched ? "http_error" : "success",
				status: blocked ? null : matched ? 500 : 200,
				policy,
				startedAt: new Date(Date.parse("2026-09-17T12:00:00.000Z") + (probeClock += 1) * 1000),
			});
			records.set(executionId, record);
			return { executionId, outcome: record.outcome, response: { status: record.response.status }, scriptResults: [], durationMs: 5 };
		},
	};

	const mocks = {
		async resolve() {
			throw new Error("mock resolution is not used by the Phase 37 acceptance scenario");
		},
	};

	const regressionRepository = {
		async findAnchor(profileId, executionId) {
			const record = records.get(executionId);
			return record && record.ownerProfileId === profileId ? record : null;
		},
		async findLineageWindow(profileId, lineage, { startedAt, executionId }, limit) {
			const at = new Date(startedAt).getTime();
			return [...records.values()]
				.filter(
					(record) =>
						record.ownerProfileId === profileId &&
						record.executionId !== executionId &&
						record.context?.source?.type === "collection" &&
						record.context.source.collectionId === lineage.collectionId &&
						record.context.source.requestId === lineage.requestId &&
						new Date(record.startedAt).getTime() <= at,
				)
				.sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
				.slice(0, limit);
		},
	};

	const repository = {
		async create(entry) {
			investigations.set(entry.investigationId, structuredClone(entry));
			return structuredClone(entry);
		},
		async get(profileId, investigationId) {
			const entry = investigations.get(investigationId);
			return entry && entry.ownerProfileId === profileId ? structuredClone(entry) : null;
		},
		async update(profileId, investigationId, patch) {
			const entry = investigations.get(investigationId);
			if (!entry || entry.ownerProfileId !== profileId) return null;
			Object.assign(entry, structuredClone(patch));
			return structuredClone(entry);
		},
	};

	const service = createInvestigationService({
		repository,
		history,
		executions,
		mocks,
		regression: createRegressionService({ repository: regressionRepository }),
		intelligence: createExecutionIntelligenceService({ history }),
		counterfactual: createCounterfactualService({ history, executions, mocks }),
		minimize: minimizeFailure,
		reproduce: runReproductionSeries,
	});

	function seed(record) {
		records.set(record.executionId, record);
		return record;
	}

	return { service, history, executions, records, investigations, seed, state };
}

async function runToCompletion(harness, input, profileId = PROFILE_A) {
	const created = await harness.service.start(profileId, input);
	return harness.service.wait(profileId, created.investigationId);
}

// ───────────────────────────────────────────────────────────────────────────
// The deterministic acceptance scenario.
//
//   good:    GET /demo/v1/status/200?debug=0   (saved request, succeeds)
//   failing: GET /demo/v1/status/500?debug=1   (one replayable change + one
//                                               unrelated recorded change)
//
// Only the URL change drives the failure; `debug=1` is an unrelated recorded
// change that must remain explicitly unverified.
// ───────────────────────────────────────────────────────────────────────────
function buildScenario() {
	const debugRow = sharedRow("debug", "0");
	const authRow = sharedRow("Authorization", SECRET_HEADER);
	const harness = makeHarness({ failWhen: ({ request }) => String(request.urlTemplate).includes("/status/500") });
	const good = harness.seed(
		makeRecord({
			request: makeRequest({ url: "http://127.0.0.1:8000/demo/v1/status/200", query: [debugRow], headers: [authRow] }),
			outcome: "success",
			status: 200,
			startedAt: new Date("2026-09-17T00:00:00.000Z"),
		}),
	);
	const failing = harness.seed(
		makeRecord({
			request: makeRequest({ url: "http://127.0.0.1:8000/demo/v1/status/500", query: [rowLike(debugRow, "1")], headers: [authRow] }),
			startedAt: new Date("2026-09-17T01:00:00.000Z"),
		}),
	);
	return { harness, good, failing };
}

describe("Phase 37 investigation acceptance — the complete evidence chain", () => {
	test("one deterministic scenario proves all sixteen acceptance points", async () => {
		const { harness, good, failing } = buildScenario();

		// (1) a saved request succeeds — the seeded known-good run.
		expect(good.outcome).toBe("success");
		expect(good.response.status).toBe(200);
		expect(good.context.source).toMatchObject({ type: "collection", collectionId: COLLECTION_ID, requestId: REQUEST_ID });

		const record = await runToCompletion(harness, { failingExecutionId: failing.executionId });
		const result = record.result;

		// (4) a later execution fails.
		expect(failing.outcome).toBe("http_error");
		expect(record.status).toBe("completed");
		expect(result.status).toBe("completed");
		expect(result.stages.completed).toEqual([...INVESTIGATION_STAGE_ORDER]);
		expect(result.stages.interruptedAt).toBeNull();

		// (5) Tracer identifies the trustworthy regression boundary.
		expect(result.regressionBoundary.resolved).toBe(true);
		expect(result.regressionBoundary.source).toBe("phase33");
		expect(result.regressionBoundary.goodExecutionId).toBe(good.executionId);
		expect(result.summary.text).toContain("Failure begins between");
		// The boundary is chronological evidence, never a cause claim.
		expect(result.regressionBoundary.caveat).toContain("chronological evidence");

		// (6) comparison shows all relevant recorded changes.
		expect(result.comparison.available).toBe(true);
		const comparisonPaths = result.comparison.changes.map((change) => change.path);
		expect(comparisonPaths).toContain("outcome");
		// ...and the reconstructed request deltas are all accounted for as
		// interventions (proven or explicitly unverified), never dropped.
		const interventionPaths = result.interventions.items.map((item) => item.delta.path);
		expect(interventionPaths).toEqual(expect.arrayContaining(["request.url", "request.query.debug"]));

		// (7) counterfactual verification experimentally proves the actual cause.
		expect(result.verifiedCauses).toHaveLength(1);
		const cause = result.verifiedCauses[0];
		expect(cause.label).toBe(VERIFIED_CAUSE_LABEL);
		expect(cause.delta.path).toBe("request.url");
		expect(cause.evidence.applied.predicateMatched).toBe(true);
		expect(cause.evidence.reverted.predicateMatched).toBe(false);
		expect(cause.evidence.appliedProbeExecutionId).toBeTruthy();
		expect(cause.evidence.revertedProbeExecutionId).toBeTruthy();
		expect(harness.records.has(cause.evidence.appliedProbeExecutionId)).toBe(true);
		expect(harness.records.has(cause.evidence.revertedProbeExecutionId)).toBe(true);
		expect(result.summary.text).toContain("Verified cause(s): request.url");

		// (2)+(8) the unrelated recorded change stays explicitly unverified /
		// not_causal — never silently promoted.
		const unrelated = result.unverifiedChanges.find((change) => change.change.path === "request.query.debug");
		expect(unrelated).toBeDefined();
		expect(["unverified", "not_causal"]).toContain(unrelated.label);
		expect(result.verifiedCauses.map((entry) => entry.delta.path)).not.toContain("request.query.debug");

		// (9) no unsupported difference is shown as a cause.
		for (const entry of result.unverifiedChanges) {
			expect(entry.label).not.toBe(VERIFIED_CAUSE_LABEL);
		}

		// (10) structured delta-debugging produces the smallest supported reproducer.
		expect(result.minimization.status).toBe("completed");
		expect(result.minimization.remainingComponentCount).toBeLessThan(result.minimization.originalComponentCount);
		expect(result.minimization.request).toBeDefined();
		expect(result.minimization.request.urlTemplate).toContain("/status/500");

		// (11) minimality is reported truthfully.
		expect(["one_minimal", "budget_limited", "inconclusive"]).toContain(result.minimization.minimality);
		expect(result.minimization.removed.length).toBeGreaterThan(0);

		// (12) reproduction stability verifies whether the minimized failure
		// is reproducible/flaky/not reproduced.
		expect(result.reproducibility.status).toBe("completed");
		expect(result.reproducibility.appliedTo).toBe("minimized");
		expect(result.reproducibility.classification).toBe("reproducible");
		expect(result.reproducibility.matches).toBe(result.reproducibility.attempts);
		expect(result.reproducibility.statement).toContain("reproduced");

		// (13) a secret-safe Repro Capsule is produced.
		const capsule = await harness.service.exportCapsule(PROFILE_A, record.investigationId);
		expect(capsule.text).toContain("tracer.repro-capsule");
		expect(result.reproductionCapsule.available).toBe(true);
		expect(result.reproductionCapsule.requestSource).toBe("minimized");
		expect(capsule.text).not.toContain(SECRET);

		// (14) the capsule imports as an unsent, unsaved dirty draft.
		const imported = createExecutionIntelligenceService({ history: harness.history }).importCapsule(capsule.text);
		expect(imported.dirty).toBe(true);
		expect(imported.autoSend).toBe(false);
		expect(imported.autoSave).toBe(false);
		expect(imported.draft.urlTemplate).toContain("/status/500");

		// (15) no auto-send / auto-save occurs — import performs no execution.
		const sendsBeforeImport = harness.state.sendCalls;
		createExecutionIntelligenceService({ history: harness.history }).importCapsule(capsule.text);
		expect(harness.state.sendCalls).toBe(sendsBeforeImport);

		// (16) the imported draft can manually reproduce the failure through the
		// normal execution path.
		const manual = await harness.executions.send(PROFILE_A, { executionId: randomUUID(), request: imported.draft });
		expect(manual.outcome).toBe("http_error");
		expect(manual.response.status).toBe(500);

		// Every conclusion is linked to concrete execution/probe ids.
		for (const conclusion of result.evidence.conclusions) {
			if (conclusion.section === "minimization" || conclusion.section === "reproducibility") continue;
			expect(conclusion.executionIds.length).toBeGreaterThan(0);
		}

		// Zero resolved-secret leakage anywhere in the investigation document.
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	test("identical evidence produces a byte-identical investigation", async () => {
		const normalize = (value) =>
			JSON.stringify(value)
				.replace(/investigation-[0-9a-f]{8}/g, "investigation-<id>")
				.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
				.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<time>")
				.replace(/(durationMs|minMs|medianMs|maxMs)[^0-9-]{0,4}[0-9.]+/g, "$1:<ms>");

		const first = buildScenario();
		const firstResult = (await runToCompletion(first.harness, { failingExecutionId: first.failing.executionId })).result;
		const second = buildScenario();
		const secondResult = (await runToCompletion(second.harness, { failingExecutionId: second.failing.executionId })).result;

		expect(firstResult.verifiedCauses).toHaveLength(1);
		expect(normalize(firstResult)).toBe(normalize(secondResult));
	});
});

describe("Phase 37 causality invariant — verified cause requires intervention evidence", () => {
	test("chronology, first divergence, and correlation alone never produce a verified cause", async () => {
		// The failure is caused by server-side drift: it fails on every request.
		// The only recorded request change (debug=0 → debug=1) is unrelated.
		const debugRow = sharedRow("debug", "0");
		const harness = makeHarness({ failWhen: () => true });
		const good = harness.seed(makeRecord({ request: makeRequest({ query: [debugRow] }), outcome: "success", status: 200, startedAt: new Date("2026-09-17T00:00:00.000Z") }));
		const failing = harness.seed(makeRecord({ request: makeRequest({ query: [rowLike(debugRow, "1")] }), startedAt: new Date("2026-09-17T01:00:00.000Z") }));

		const result = (await runToCompletion(harness, { failingExecutionId: failing.executionId })).result;

		// There IS a clear chronological boundary and a clear first divergence...
		expect(result.regressionBoundary.resolved).toBe(true);
		expect(result.regressionBoundary.goodExecutionId).toBe(good.executionId);
		expect(result.comparison.available).toBe(true);
		expect(result.comparison.firstDivergence).not.toBeNull();
		expect(result.comparison.changes.length).toBeGreaterThan(0);
		// ...but neither may be turned into a cause.
		expect(result.verifiedCauses).toHaveLength(0);
		expect(result.summary.text).toContain("No change was experimentally verified as the cause.");
		for (const change of result.unverifiedChanges) {
			expect(change.label).not.toBe(VERIFIED_CAUSE_LABEL);
		}
	});

	test("a causal classification without both apply and revert probes is rejected by the builder", () => {
		const proven = {
			applied: { probeExecutionId: "44444444-4444-4444-8444-444444444444", predicateMatched: true, outcome: "response", status: 500 },
			reverted: { probeExecutionId: "55555555-5555-4555-8555-555555555555", predicateMatched: false, outcome: "response", status: 200 },
		};
		const base = {
			investigationId: "66666666-6666-4666-8666-666666666666",
			failingExecutionId: "33333333-3333-4333-8333-333333333333",
			goodExecutionId: "22222222-2222-4222-8222-222222222222",
			predicate: { type: "status", equals: 500 },
			targetMode: "execution",
			status: "completed",
			error: null,
			regression: { source: "phase33", timeline: { schemaVersion: 1, kind: "tracer.regression-timeline", caveat: "This boundary is chronological evidence, not proof of cause.", boundary: { lastKnownGoodExecutionId: "22222222-2222-4222-8222-222222222222", firstKnownBadExecutionId: "33333333-3333-4333-8333-333333333333" }, unresolved: null } },
			comparison: { baseExecutionId: "22222222-2222-4222-8222-222222222222", candidateExecutionId: "33333333-3333-4333-8333-333333333333", firstDivergence: { category: "request", path: "request.url", message: "changed" }, changes: [{ category: "request", path: "request.url", message: "changed" }], contract: { breaking: true, changes: [] } },
			minimization: { status: "skipped", reason: "not_reached", minimality: "inconclusive", originalComponentCount: 0, remainingComponentCount: 0, removed: [], probeTrace: [], executionIds: [] },
			reproducibility: { status: "skipped", reason: "not_reached", appliedTo: "failing", classification: "inconclusive", statement: "", probes: [], executionIds: [] },
			capsule: null,
			stageOutputs: { completed: ["preparing"], interruptedAt: null },
		};
		const intervention = (classification, evidence) => ({
			schemaVersion: 1,
			kind: "tracer.counterfactual-intervention",
			delta: { id: "url", path: "request.url", kind: "url", replayable: classification !== "not_replayable", before: null, after: { value: "500" } },
			classification,
			reason: null,
			evidence,
		});

		const causalWithoutEvidence = () => buildInvestigationV1({ ...base, counterfactual: { available: true, status: "completed", reason: null, probeBudget: 24, probesUsed: 0, budgetExhausted: false, items: [intervention("causal", { applied: null, reverted: null })], probeExecutionIds: [] } });
		expect(causalWithoutEvidence).toThrow(AppError);

		const causalWithOnlyApplied = () => buildInvestigationV1({ ...base, counterfactual: { available: true, status: "completed", reason: null, probeBudget: 24, probesUsed: 1, budgetExhausted: false, items: [intervention("causal", { ...proven, reverted: { probeExecutionId: "55555555-5555-4555-8555-555555555555", predicateMatched: true, outcome: "response", status: 500 } })], probeExecutionIds: [] } });
		expect(causalWithOnlyApplied).toThrow(AppError);

		// A perfectly proven-looking delta classified not_causal is never promoted.
		const notCausal = buildInvestigationV1({ ...base, counterfactual: { available: true, status: "completed", reason: null, probeBudget: 24, probesUsed: 2, budgetExhausted: false, items: [intervention("not_causal", proven)], probeExecutionIds: [] } });
		expect(notCausal.verifiedCauses).toHaveLength(0);

		// Only a causal classification with both probes is promoted.
		const causal = buildInvestigationV1({ ...base, counterfactual: { available: true, status: "completed", reason: null, probeBudget: 24, probesUsed: 2, budgetExhausted: false, items: [intervention("causal", proven)], probeExecutionIds: [] } });
		expect(causal.verifiedCauses).toHaveLength(1);
		expect(causal.verifiedCauses[0].label).toBe(VERIFIED_CAUSE_LABEL);
	});

	test("comparison-only changes are labelled leading divergence / correlated change, never causes", async () => {
		// No request change at all: the failure began without a reconstructable
		// delta. Comparison must still describe the drift honestly.
		const harness = makeHarness({ failWhen: () => true });
		const good = harness.seed(makeRecord({ request: makeRequest(), outcome: "success", status: 200, startedAt: new Date("2026-09-17T00:00:00.000Z") }));
		const failing = harness.seed(makeRecord({ request: makeRequest(), startedAt: new Date("2026-09-17T01:00:00.000Z") }));

		const result = (await runToCompletion(harness, { failingExecutionId: failing.executionId })).result;

		expect(result.verifiedCauses).toHaveLength(0);
		expect(result.comparison.available).toBe(true);
		expect(result.comparison.changes.length).toBeGreaterThan(0);
		const labels = new Set(result.unverifiedChanges.map((change) => change.label));
		expect(labels.has("leading_divergence")).toBe(true);
		expect(labels.has("correlated_change")).toBe(true);
		expect(labels.has(VERIFIED_CAUSE_LABEL)).toBe(false);
	});
});

describe("Phase 37 capsule safety — redaction, profile isolation, and no auto-send", () => {
	test("a secret-bearing request is redacted in the capsule and never auto-sent or auto-saved", () => {
		const request = makeRequest({ headers: [sharedRow("Authorization", SECRET_HEADER)], query: [sharedRow("debug", "1")] });
		const record = makeRecord({ request, outcome: "http_error", status: 500 });
		const capsule = buildReproCapsule({ request: record.request, receipt: record.receipt, response: record.response });
		const text = serializeReproCapsule(capsule);
		expect(text).not.toContain(SECRET);
		const parsed = parseReproCapsule(text);
		expect(JSON.stringify(parsed)).not.toContain(SECRET);
		expect(parsed.requiredInputs.some((input) => /authorization/i.test(input.name))).toBe(true);

		const imported = createExecutionIntelligenceService({ history: { async get() { return null; } } }).importCapsule(text);
		expect(imported.autoSend).toBe(false);
		expect(imported.autoSave).toBe(false);
		expect(imported.dirty).toBe(true);
		expect(JSON.stringify(imported.draft)).not.toContain(SECRET);
	});

	test("an investigation is invisible to every other profile", async () => {
		const { harness, failing } = buildScenario();
		const record = await runToCompletion(harness, { failingExecutionId: failing.executionId });

		const attempt = async (promise, code) => {
			try {
				await promise;
			} catch (error) {
				expect(error.code).toBe(code);
				return;
			}
			throw new Error(`expected ${code}`);
		};

		await attempt(harness.service.status(PROFILE_B, record.investigationId), "INVESTIGATION_NOT_FOUND");
		await attempt(harness.service.exportCapsule(PROFILE_B, record.investigationId), "INVESTIGATION_NOT_FOUND");
		await attempt(harness.service.cancel(PROFILE_B, record.investigationId), "INVESTIGATION_NOT_FOUND");
	});

	test("a policy-blocked (SSRF-style) target dispatches zero network calls", async () => {
		const blocked = { decision: "blocked", local: false };
		const harness = makeHarness({ policy: blocked, failWhen: () => true });
		const good = harness.seed(makeRecord({ request: makeRequest({ url: "http://169.254.169.254/latest/meta-data/" }), outcome: "success", status: 200, startedAt: new Date("2026-09-17T00:00:00.000Z") }));
		const failing = harness.seed(makeRecord({ request: makeRequest({ url: "http://169.254.169.254/latest/meta-data/" }), outcome: "policy_blocked", status: null, policy: blocked, startedAt: new Date("2026-09-17T01:00:00.000Z") }));

		const result = (await runToCompletion(harness, { failingExecutionId: failing.executionId, goodExecutionId: good.executionId })).result;

		expect(harness.state.networkDispatches).toBe(0);
		expect(result.status).toBe("completed");
		expect(result.verifiedCauses).toHaveLength(0);
	});
});
