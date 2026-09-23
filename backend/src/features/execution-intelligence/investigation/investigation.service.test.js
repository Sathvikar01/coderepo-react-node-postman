// Phase 35 — Investigation Engine orchestration (Workflow 5) tests.
//
// These tests run the REAL merged Phase 31-34 engines (regression boundary,
// deterministic comparison, counterfactual verification, failure minimizer,
// reproduction series, ReproCapsuleV1) behind the investigation orchestrator,
// with a deterministic in-memory history/execution harness standing in for
// Mongo and transport. They verify the required matrix end to end: causal vs
// unverified deltas, no baseline, ambiguous history, secret handling, nested
// JSON bodies, minimization, reproducibility, cancellation at every stage,
// server interruption, unsafe mutating requests, policy-blocked (SSRF-style)
// targets, profile isolation, capsule round-trip safety, and determinism.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../../shared/config/index.js";
import { requestDefinitionSchema } from "../../../shared/utils/schemas.js";
import { createRegressionService } from "../regression/regression.service.js";
import { createCounterfactualService } from "../counterfactual/counterfactual.service.js";
import { createExecutionIntelligenceService } from "../execution-intelligence.service.js";
import { minimizeFailure } from "../failure-minimizer.js";
import { runReproductionSeries } from "../reproducibility/reproduction-series.js";
import { failurePredicateForRecord, parseReproCapsule } from "../repro-capsule.js";
import { INVESTIGATION_STAGE_ORDER, VERIFIED_CAUSE_LABEL } from "./investigation-model.js";
import { createInvestigationService } from "./investigation.service.js";

beforeAll(() => {
	process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/tracer-test";
	process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY ?? "investigation-test-fingerprint-key";
	process.env.JWT_SECRET = process.env.JWT_SECRET ?? "investigation-test-jwt-secret";
	initConfig();
});

const PROFILE_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const PROFILE_B = "22222222-bbbb-4bbb-8bbb-222222222222";
const COLLECTION_ID = "33333333-cccc-4ccc-8ccc-333333333333";
const REQUEST_ID = "44444444-dddd-4ddd-8ddd-444444444444";

async function expectAppError(promise, code) {
	try {
		await promise;
	} catch (error) {
		expect(error.code).toBe(code);
		return;
	}
	throw new Error(`expected a rejection with code ${code}`);
}

// Row deltas are matched by row id, so a value change across the good and the
// failing run must share one row id to become exactly one value-change delta.
function sharedRow(key, value) {
	return { id: randomUUID(), key, value, enabled: true };
}
function rowLike(row, value) {
	return { ...row, value };
}

function makeRequest({ name = "status probe", method = "GET", url = "http://127.0.0.1:8000/demo/v1/status/500", query = [], headers = [], body = { mode: "none" } } = {}) {
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

let recordClock = 0;

function makeRecord({
	profileId = PROFILE_A,
	executionId = randomUUID(),
	request,
	outcome = "http_error",
	status = 500,
	policy = { decision: "allowed", local: false },
	source = { type: "collection", collectionId: COLLECTION_ID, requestId: REQUEST_ID },
	startedAt = new Date(1760000000000 + (recordClock += 1000)),
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
 * Deterministic harness: in-memory history records shared by the real
 * engines' history lookups, an execution "transport" that evaluates a
 * scripted failure rule and stores every probe as a normal history record,
 * and a fake regression repository exposing only the two methods the merged
 * Phase 33 service calls. `onRepositoryUpdate` and `onSend` hooks provide
 * deterministic cancellation entry points.
 */
function makeHarness({ failWhen = () => true, policy = { decision: "allowed", local: false }, onRepositoryUpdate, onSend, hangSend = false } = {}) {
	const records = new Map();
	const investigations = new Map();
	const state = { sendCalls: 0, networkDispatches: 0, stage: "preparing", released: false, hangResolve: null, investigationId: null, cancelled: false, cancelDone: null, minimizationSends: 0 };

	const history = {
		async get(profileId, executionId) {
			const record = records.get(executionId);
			return record && record.ownerProfileId === profileId ? record : null;
		},
	};

	const executions = {
		async send(profileId, payload, options = {}) {
			state.sendCalls += 1;
			if (onSend) await onSend({ payload, options, index: state.sendCalls, stage: state.stage });
			if (hangSend && !state.released) {
				await new Promise((resolve) => {
					state.hangResolve = resolve;
				});
			}
			const request = payload.request;
			const matched = Boolean(failWhen({ request, index: state.sendCalls, stage: state.stage }));
			const executionId = payload.executionId ?? randomUUID();
			const blocked = policy.decision !== "allowed";
			if (!blocked) state.networkDispatches += 1;
			const record = makeRecord({
				profileId,
				executionId,
				request,
				outcome: blocked ? "policy_blocked" : matched ? "http_error" : "success",
				status: blocked ? null : matched ? 500 : 200,
				policy,
			});
			records.set(executionId, record);
			return {
				executionId,
				outcome: record.outcome,
				response: { status: record.response.status },
				scriptResults: [],
				durationMs: 5,
			};
		},
	};

	const mocks = {
		async resolve() {
			throw new Error("mock resolution is not used by these tests");
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
			state.investigationId = entry.investigationId;
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
			if (patch.stage) state.stage = patch.stage;
			if (onRepositoryUpdate) await onRepositoryUpdate(patch, entry);
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

	return { service, history, records, investigations, seed, state, repository };
}

async function runToCompletion(harness, input, profileId = PROFILE_A) {
	const created = await harness.service.start(profileId, input);
	return harness.service.wait(profileId, created.investigationId);
}

function normalizeForComparison(value) {
	return JSON.stringify(value)
		.replace(/investigation-[0-9a-f]{8}/g, "investigation-<id>")
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
		.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<time>")
		.replace(/(durationMs|minMs|medianMs|maxMs)[^0-9-]{0,4}[0-9.]+/g, "$1:<ms>");
}

describe("investigation engine — verified causes and unverified changes", () => {
	test("a proven query change is the only verified cause; the unproven header change stays unverified", async () => {
		const debugRow = sharedRow("debug", "0");
		const xRow = sharedRow("X", "1");
		const headerRow = sharedRow("X-Extra", "0");
		const harness = makeHarness({ failWhen: ({ request }) => request.query.some((entry) => entry.key === "debug" && entry.value === "1") });
		const good = harness.seed(
			makeRecord({
				request: makeRequest({ query: [debugRow, xRow], headers: [headerRow] }),
				outcome: "success",
				status: 200,
			}),
		);
		const failing = harness.seed(
			makeRecord({
				request: makeRequest({
					query: [rowLike(debugRow, "1"), xRow],
					headers: [rowLike(headerRow, "1")],
				}),
				startedAt: new Date(1760000000000 + 60000),
			}),
		);

		const result = (await runToCompletion(harness, { failingExecutionId: failing.executionId })).result;

		expect(result.status).toBe("completed");
		expect(result.stages.completed).toEqual([...INVESTIGATION_STAGE_ORDER]);
		expect(result.stages.interruptedAt).toBeNull();
		expect(result.regressionBoundary.resolved).toBe(true);
		expect(result.regressionBoundary.goodExecutionId).toBe(good.executionId);
		expect(result.summary.text).toContain("Failure begins between");
		expect(result.summary.text).toContain("Verified cause(s): request.query.debug.");

		expect(result.verifiedCauses).toHaveLength(1);
		const cause = result.verifiedCauses[0];
		expect(cause.label).toBe(VERIFIED_CAUSE_LABEL);
		expect(cause.delta.path).toBe("request.query.debug");
		expect(cause.delta.before.value).toBe("0");
		expect(cause.delta.after.value).toBe("1");
		expect(cause.evidence.applied.predicateMatched).toBe(true);
		expect(cause.evidence.reverted.predicateMatched).toBe(false);
		expect(cause.executionIds).toHaveLength(2);
		expect(cause.evidenceSummary).toContain(cause.evidence.appliedProbeExecutionId);
		expect(cause.evidenceSummary).toContain(cause.evidence.revertedProbeExecutionId);

		const headerChange = result.unverifiedChanges.find((change) => change.change.path === "request.headers.X-Extra");
		expect(headerChange).toBeDefined();
		expect(headerChange.label).toBe("unverified");
		expect(headerChange.source).toBe("intervention");
		expect(headerChange.executionIds.length).toBeGreaterThan(0);

		// The same delta path is never claimed twice.
		const paths = [...result.verifiedCauses.map((c) => c.delta.path), ...result.unverifiedChanges.map((c) => c.change.path)];
		expect(new Set(paths).size).toBe(paths.length);

		expect(result.minimization.status).toBe("completed");
		expect(result.reproducibility.status).toBe("completed");
		expect(result.reproducibility.classification).toBe("reproducible");
		expect(result.reproducibility.statement).toContain("probes reproduced the failure");
		expect(result.reproductionCapsule.available).toBe(true);
		expect(result.reproductionCapsule.requestSource).toBe("minimized");

		// Every conclusion points at concrete execution/probe ids.
		for (const conclusion of result.evidence.conclusions) {
			if (conclusion.section === "minimization" || conclusion.section === "reproducibility") continue;
			expect(conclusion.executionIds.length).toBeGreaterThan(0);
		}
		for (const id of [...result.minimization.executionIds, ...result.reproducibility.executionIds]) {
			expect(harness.records.has(id)).toBe(true);
		}
	});

	test("without a known good run the investigation degrades truthfully and still delivers minimizer, reproduction, and capsule", async () => {
		const harness = makeHarness({ failWhen: () => true });
		const failing = harness.seed(makeRecord({ request: makeRequest({ query: [sharedRow("debug", "1")] }) }));

		const result = (await runToCompletion(harness, { failingExecutionId: failing.executionId })).result;

		expect(result.status).toBe("completed");
		expect(result.regressionBoundary.resolved).toBe(false);
		expect(result.regressionBoundary.goodExecutionId).toBeNull();
		expect(result.regressionBoundary.unresolved).not.toBeNull();
		expect(["NO_HISTORY", "NO_KNOWN_GOOD", "BOUNDARY_NOT_ADJACENT"]).toContain(result.regressionBoundary.unresolved.reason);
		expect(result.summary.text).toContain("Start of the failure: unresolved");
		expect(result.summary.text).toContain("No change was experimentally verified as the cause.");

		expect(result.comparison.available).toBe(false);
		expect(result.comparison.unavailableReason).toMatch(/no_good_execution/);
		expect(result.interventions.available).toBe(false);
		expect(result.verifiedCauses).toHaveLength(0);

		expect(result.minimization.status).toBe("completed");
		expect(result.reproducibility.status).toBe("completed");
		expect(result.reproductionCapsule.available).toBe(true);
	});

	test("a record without a saved collection identity reports AMBIGUOUS_LINEAGE even when a good base is provided", async () => {
		const debugRow = sharedRow("debug", "0");
		const harness = makeHarness({ failWhen: ({ request }) => request.query.some((entry) => entry.key === "debug" && entry.value === "1") });
		const good = harness.seed(
			makeRecord({ request: makeRequest({ query: [debugRow] }), outcome: "success", status: 200, source: { type: "scratch" } }),
		);
		const failing = harness.seed(
			makeRecord({
				request: makeRequest({ query: [rowLike(debugRow, "1")] }),
				source: { type: "scratch" },
				startedAt: new Date(1760000000000 + 60000),
			}),
		);

		const result = (await runToCompletion(harness, { failingExecutionId: failing.executionId, goodExecutionId: good.executionId })).result;

		expect(result.status).toBe("completed");
		expect(result.regressionBoundary.resolved).toBe(true);
		expect(result.regressionBoundary.unresolved?.reason).toBe("AMBIGUOUS_LINEAGE");
		expect(result.verifiedCauses).toHaveLength(1);
		expect(result.verifiedCauses[0].delta.path).toBe("request.query.debug");
	});

	test("comparison-only changes are labelled leading divergence / correlated change and never promoted to causes", async () => {
		// The failure started without any request change (server-side drift):
		// there is no reconstructable delta and nothing experimentally provable.
		const harness = makeHarness({ failWhen: () => true });
		const good = harness.seed(makeRecord({ request: makeRequest(), outcome: "success", status: 200 }));
		const failing = harness.seed(makeRecord({ request: makeRequest(), startedAt: new Date(1760000000000 + 60000) }));

		const result = (await runToCompletion(harness, { failingExecutionId: failing.executionId })).result;

		expect(result.verifiedCauses).toHaveLength(0);
		expect(result.summary.text).toContain("No change was experimentally verified as the cause.");
		expect(result.comparison.available).toBe(true);
		expect(result.comparison.changes.length).toBeGreaterThan(0);

		const leading = result.unverifiedChanges.filter((change) => change.label === "leading_divergence");
		const correlated = result.unverifiedChanges.filter((change) => change.label === "correlated_change");
		expect(leading.length).toBeGreaterThanOrEqual(1);
		expect(correlated.length).toBeGreaterThanOrEqual(1);
		expect(result.summary.text).toContain(`Leading divergence (correlated, not proven): ${leading[0].change.path}.`);
		for (const change of [...leading, ...correlated]) {
			expect(change.source).toBe("comparison");
			expect(change.executionIds).toEqual([good.executionId, failing.executionId]);
		}
	});

	test("a nested JSON body delta is verified, minimized, and reproduced", async () => {
		const bodyOf = (request) => (request.body.mode === "json" ? JSON.parse(request.body.text) : null);
		const harness = makeHarness({ policy: { decision: "allowed", local: true }, failWhen: ({ request }) => bodyOf(request)?.nested?.x === 2 });
		const local = { decision: "allowed", local: true };
		const good = harness.seed(
			makeRecord({
				request: makeRequest({ method: "POST", url: "http://127.0.0.1:8000/demo/v1/items", body: { mode: "json", text: '{"a":1,"nested":{"x":1}}' } }),
				outcome: "success",
				status: 200,
				policy: local,
			}),
		);
		const failing = harness.seed(
			makeRecord({
				request: makeRequest({ method: "POST", url: "http://127.0.0.1:8000/demo/v1/items", body: { mode: "json", text: '{"a":1,"nested":{"x":2}}' } }),
				policy: local,
				startedAt: new Date(1760000000000 + 60000),
			}),
		);

		const result = (
			await runToCompletion(harness, {
				failingExecutionId: failing.executionId,
				goodExecutionId: good.executionId,
				allowUnsafeLocal: true,
				allowUnsafeConfirm: true,
			})
		).result;

		expect(result.verifiedCauses).toHaveLength(1);
		const cause = result.verifiedCauses[0];
		expect(cause.delta.kind).toBe("body.json");
		expect(cause.delta.path).toContain("nested.x");

		expect(result.minimization.status).toBe("completed");
		expect(result.minimization.remainingComponentCount).toBeLessThan(result.minimization.originalComponentCount);
		expect(result.minimization.removed.some((entry) => entry.kind === "json")).toBe(true);
		expect(result.minimization.request.body.mode).toBe("json");

		expect(result.reproducibility.appliedTo).toBe("minimized");
		expect(result.reproducibility.classification).toBe("reproducible");
		expect(result.reproductionCapsule.requestSource).toBe("minimized");
		const capsuleRequest = JSON.parse(result.reproductionCapsule.text).request;
		expect(bodyOf(capsuleRequest).a).toBeUndefined();
		expect(bodyOf(capsuleRequest).nested.x).toBe(2);
	});

	test("two identical investigations over identical stage outputs are byte-identical after id/time normalization", async () => {
		const buildScenario = () => {
			const debugRow = sharedRow("debug", "0");
			const headerRow = sharedRow("X-Extra", "0");
			const harness = makeHarness({ failWhen: ({ request }) => request.query.some((entry) => entry.key === "debug" && entry.value === "1") });
			const good = harness.seed(makeRecord({ request: makeRequest({ query: [debugRow], headers: [headerRow] }), outcome: "success", status: 200 }));
			const failing = harness.seed(
				makeRecord({
					request: makeRequest({ query: [rowLike(debugRow, "1")], headers: [headerRow] }),
					startedAt: new Date(1760000000000 + 60000),
				}),
			);
			return { harness, good, failing };
		};
		const first = buildScenario();
		const second = buildScenario();
		const firstResult = (await runToCompletion(first.harness, { failingExecutionId: first.failing.executionId, goodExecutionId: first.good.executionId })).result;
		const secondResult = (await runToCompletion(second.harness, { failingExecutionId: second.failing.executionId, goodExecutionId: second.good.executionId })).result;

		expect(firstResult.verifiedCauses).toHaveLength(1);
		expect(normalizeForComparison(firstResult)).toBe(normalizeForComparison(secondResult));
	});
});


describe("investigation engine — minimization and reproducibility", () => {
	test("a low probe budget is reported as budget_limited with the budget exhausted flag", async () => {
		const debugRow = sharedRow("debug", "0");
		const noiseRow = sharedRow("noise", "1");
		const harness = makeHarness({ failWhen: ({ request }) => request.query.some((entry) => entry.key === "debug" && entry.value === "1") });
		const good = harness.seed(makeRecord({ request: makeRequest({ query: [debugRow, noiseRow] }), outcome: "success", status: 200 }));
		const failing = harness.seed(
			makeRecord({ request: makeRequest({ query: [rowLike(debugRow, "1"), noiseRow] }), startedAt: new Date(1760000000000 + 60000) }),
		);

		const result = (
			await runToCompletion(harness, {
				failingExecutionId: failing.executionId,
				goodExecutionId: good.executionId,
				minimizationProbes: 2,
				reproductionProbes: 2,
			})
		).result;

		expect(result.minimization.status).toBe("completed");
		expect(result.minimization.minimality).toBe("budget_limited");
		expect(result.minimization.budgetExhausted).toBe(true);
		expect(result.minimization.probeBudget).toBe(2);
		expect(result.reproducibility.status).toBe("completed");
		expect(result.reproducibility.attempts).toBe(2);
	});

	test("an unstable failure produces an honest MINIMIZATION_FLAKY record and a flaky reproduction series", async () => {
		const debugRow = sharedRow("debug", "0");
		// Deterministic counterfactual evidence, then an unstable failure: the
		// two minimization baselines disagree and reproduction alternates.
		const stageCalls = { minimization: 0, reproducibility: 0 };
		const harness = makeHarness({
			failWhen: ({ request, stage }) => {
				if (stage !== "minimization" && stage !== "reproducibility") {
					return request.query.some((entry) => entry.key === "debug" && entry.value === "1");
				}
				stageCalls[stage] += 1;
				return stageCalls[stage] % 2 === 1;
			},
		});
		const good = harness.seed(makeRecord({ request: makeRequest({ query: [debugRow] }), outcome: "success", status: 200 }));
		const failing = harness.seed(makeRecord({ request: makeRequest({ query: [rowLike(debugRow, "1")] }), startedAt: new Date(1760000000000 + 60000) }));

		const result = (
			await runToCompletion(harness, {
				failingExecutionId: failing.executionId,
				goodExecutionId: good.executionId,
				minimizationProbes: 6,
				reproductionProbes: 2,
			})
		).result;

		expect(result.verifiedCauses).toHaveLength(1);
		expect(result.minimization.status).toBe("failed");
		expect(result.minimization.error?.code).toBe("MINIMIZATION_FLAKY");
		expect(result.summary.text).toContain("Minimization: failed");
		expect(result.reproducibility.appliedTo).toBe("failing");
		expect(result.reproducibility.classification).toBe("flaky");
		expect(result.reproducibility.matches).toBeGreaterThan(0);
		expect(result.reproducibility.matches).toBeLessThan(result.reproducibility.attempts);
	});

	test("when the minimized reproducer stops failing, the series is classified not_reproduced", async () => {
		const harness = makeHarness({ failWhen: ({ stage }) => stage === "minimization" });
		const failing = harness.seed(makeRecord({ request: makeRequest({ query: [sharedRow("debug", "1")] }) }));

		const result = (await runToCompletion(harness, { failingExecutionId: failing.executionId })).result;

		expect(result.minimization.status).toBe("completed");
		expect(result.reproducibility.appliedTo).toBe("minimized");
		expect(result.reproducibility.classification).toBe("not_reproduced");
		expect(result.reproducibility.matches).toBe(0);
		expect(result.reproducibility.statement).toContain("0/");
	});
});

describe("investigation engine — secrets, capsules, and safety", () => {
	test("resolved secrets never appear in the result or the capsule; sensitive deltas stay not_replayable", async () => {
		const debugRow = sharedRow("debug", "0");
		const tokenRow = sharedRow("token", "sk-good-secret-3");
		const authRow = sharedRow("Authorization", "Bearer sk-good-auth-5");
		const harness = makeHarness({ failWhen: ({ request }) => request.query.some((entry) => entry.key === "debug" && entry.value === "1") });
		const good = harness.seed(makeRecord({ request: makeRequest({ query: [debugRow, tokenRow], headers: [authRow] }), outcome: "success", status: 200 }));
		const failing = harness.seed(
			makeRecord({
				request: makeRequest({
					query: [rowLike(debugRow, "1"), rowLike(tokenRow, "sk-failing-secret-7")],
					headers: [rowLike(authRow, "Bearer sk-header-secret-9")],
				}),
				startedAt: new Date(1760000000000 + 60000),
			}),
		);

		const record = await runToCompletion(harness, {
			failingExecutionId: failing.executionId,
			goodExecutionId: good.executionId,
			minimizationProbes: 2,
			reproductionProbes: 2,
		});
		const serialized = JSON.stringify(record.result);
		for (const secret of ["sk-failing-secret-7", "sk-header-secret-9", "sk-good-secret-3", "sk-good-auth-5"]) {
			expect(serialized).not.toContain(secret);
		}

		const sensitive = record.result.unverifiedChanges.filter((change) => /token|authorization/i.test(change.change.path));
		expect(sensitive.length).toBeGreaterThan(0);
		for (const change of sensitive) {
			expect(change.label).toBe("not_replayable");
			expect(JSON.stringify(change)).toContain("[REDACTED]");
		}
		expect(record.result.verifiedCauses.map((cause) => cause.delta.path)).toEqual(["request.query.debug"]);

		const capsule = await harness.service.exportCapsule(PROFILE_A, record.investigationId);
		expect(capsule.filename).toMatch(/^investigation-.+\.repro\.json$/);
		for (const secret of ["sk-failing-secret-7", "sk-header-secret-9", "sk-good-secret-3", "sk-good-auth-5"]) {
			expect(capsule.text).not.toContain(secret);
		}

		const parsed = parseReproCapsule(capsule.text);
		expect(parsed.request).toBeDefined();
		const imported = createExecutionIntelligenceService({ history: harness.history }).importCapsule(capsule.text);
		expect(imported.dirty).toBe(true);
		expect(imported.autoSend).toBe(false);
		expect(imported.autoSave).toBe(false);
		expect(JSON.stringify(imported.draft)).not.toContain("sk-failing-secret-7");
		expect(imported.draft.query.some((entry) => /\{\{/.test(entry.value))).toBe(true);
	});

	test("an unsafe mutating request is never silently executed: zero probes and truthful not_replayable/skipped stages", async () => {
		const harness = makeHarness({ failWhen: ({ request }) => request.body.mode === "json" });
		const good = harness.seed(
			makeRecord({
				request: makeRequest({ method: "POST", url: "http://127.0.0.1:8000/demo/v1/items", body: { mode: "urlencoded", rows: [sharedRow("a", "1")] } }),
				outcome: "success",
				status: 200,
			}),
		);
		const failing = harness.seed(
			makeRecord({
				request: makeRequest({ method: "POST", url: "http://127.0.0.1:8000/demo/v1/items", body: { mode: "json", text: '{"a":1}' } }),
				startedAt: new Date(1760000000000 + 60000),
			}),
		);

		const result = (await runToCompletion(harness, { failingExecutionId: failing.executionId, goodExecutionId: good.executionId })).result;

		expect(harness.state.sendCalls).toBe(0);
		expect(result.interventions.probesUsed).toBe(0);
		expect(result.interventions.reason).toBe("unsafe_mutating_request_not_replayed");
		expect(result.interventions.items.length).toBeGreaterThan(0);
		for (const item of result.interventions.items) {
			expect(item.classification).toBe("not_replayable");
			expect(item.evidence.applied).toBeNull();
			expect(item.evidence.reverted).toBeNull();
		}
		expect(result.minimization.status).toBe("skipped");
		expect(result.minimization.reason).toMatch(/unsafe/);
		expect(result.minimization.executionIds).toHaveLength(0);
		expect(result.reproducibility.status).toBe("skipped");
		expect(result.reproducibility.executionIds).toHaveLength(0);
		expect(result.verifiedCauses).toHaveLength(0);
		expect(result.unverifiedChanges.filter((change) => change.source === "intervention").every((change) => change.label === "not_replayable")).toBe(true);
		expect(result.reproductionCapsule.available).toBe(true);
	});

	test("the same unsafe request runs fully when the target is approved local and both confirmations are given", async () => {
		const local = { decision: "allowed", local: true };
		const harness = makeHarness({ policy: local, failWhen: ({ request }) => request.body.mode === "json" });
		const good = harness.seed(
			makeRecord({
				request: makeRequest({ method: "POST", url: "http://127.0.0.1:8000/demo/v1/items", body: { mode: "urlencoded", rows: [sharedRow("a", "1")] } }),
				outcome: "success",
				status: 200,
				policy: local,
			}),
		);
		const failing = harness.seed(
			makeRecord({
				request: makeRequest({ method: "POST", url: "http://127.0.0.1:8000/demo/v1/items", body: { mode: "json", text: '{"a":1}' } }),
				policy: local,
				startedAt: new Date(1760000000000 + 60000),
			}),
		);

		const result = (
			await runToCompletion(harness, {
				failingExecutionId: failing.executionId,
				goodExecutionId: good.executionId,
				allowUnsafeLocal: true,
				allowUnsafeConfirm: true,
			})
		).result;

		expect(harness.state.sendCalls).toBeGreaterThan(0);
		expect(result.minimization.status).toBe("completed");
		expect(result.reproducibility.status).toBe("completed");
		expect(result.status).toBe("completed");
	});

	test("a policy-blocked (SSRF-style) target records the policy decision in probe evidence and dispatches zero network calls", async () => {
		const harness = makeHarness({ policy: { decision: "blocked", local: false }, failWhen: () => true });
		const blocked = { decision: "blocked", local: false };
		const good = harness.seed(
			makeRecord({ request: makeRequest({ url: "http://169.254.169.254/latest/meta-data/" }), outcome: "success", status: 200 }),
		);
		const failing = harness.seed(
			makeRecord({
				request: makeRequest({ url: "http://169.254.169.254/latest/meta-data/" }),
				outcome: "policy_blocked",
				status: null,
				policy: blocked,
				startedAt: new Date(1760000000000 + 60000),
			}),
		);

		const result = (
			await runToCompletion(harness, {
				failingExecutionId: failing.executionId,
				goodExecutionId: good.executionId,
				predicate: failurePredicateForRecord(failing),
			})
		).result;

		expect(harness.state.networkDispatches).toBe(0);
		expect(harness.state.sendCalls).toBeGreaterThan(0);
		const probeIds = [...result.minimization.executionIds, ...result.reproducibility.executionIds];
		expect(probeIds.length).toBeGreaterThan(0);
		for (const id of probeIds) {
			expect(harness.records.get(id).receipt.policy.decision).toBe("blocked");
		}
		expect(result.status).toBe("completed");
	});

	test("an investigation for another profile's execution is refused everywhere", async () => {
		const harness = makeHarness({ failWhen: () => true });
		const failing = harness.seed(makeRecord({ request: makeRequest() }));

		await expectAppError(harness.service.start(PROFILE_B, { failingExecutionId: failing.executionId }), "INVESTIGATION_TARGET_NOT_FOUND");

		const record = await runToCompletion(harness, { failingExecutionId: failing.executionId });
		await expectAppError(harness.service.status(PROFILE_B, record.investigationId), "INVESTIGATION_NOT_FOUND");
		await expectAppError(harness.service.exportCapsule(PROFILE_B, record.investigationId), "INVESTIGATION_NOT_FOUND");
		await expectAppError(harness.service.cancel(PROFILE_B, record.investigationId), "INVESTIGATION_NOT_FOUND");
	});
});

describe("investigation engine — cancellation and interruption", () => {
	for (const targetStage of INVESTIGATION_STAGE_ORDER.filter((stage) => stage !== "preparing")) {
		test(`cancelling at the ${targetStage} stage entry keeps the partial record coherent`, async () => {
			const debugRow = sharedRow("debug", "0");
			const harness = makeHarness({
				failWhen: ({ request }) => request.query.some((entry) => entry.key === "debug" && entry.value === "1"),
				onRepositoryUpdate: async (patch) => {
					if (patch.stage === targetStage && patch.status === undefined && !harness.state.cancelled) {
						harness.state.cancelled = true;
						harness.state.cancelDone = harness.service.cancel(PROFILE_A, harness.state.investigationId).catch(() => undefined);
						// Let cancel()'s synchronous abort land before the stage may proceed.
						await new Promise((resolve) => setTimeout(resolve, 0));
					}
				},
			});
			const good = harness.seed(makeRecord({ request: makeRequest({ query: [debugRow] }), outcome: "success", status: 200 }));
			const failing = harness.seed(
				makeRecord({ request: makeRequest({ query: [rowLike(debugRow, "1")] }), startedAt: new Date(1760000000000 + 60000) }),
			);

			const created = await harness.service.start(PROFILE_A, { failingExecutionId: failing.executionId, goodExecutionId: good.executionId });
			const record = await harness.service.wait(PROFILE_A, created.investigationId);
			if (harness.state.cancelDone) await harness.state.cancelDone;
			const result = record.result;

			expect(record.status).toBe("cancelled");
			expect(record.error.code).toBe("INVESTIGATION_CANCELLED");
			expect(result.status).toBe("cancelled");
			expect(result.stages.interruptedAt).toBe(targetStage);
			const targetIndex = INVESTIGATION_STAGE_ORDER.indexOf(targetStage);
			expect(result.stages.completed).toEqual(INVESTIGATION_STAGE_ORDER.slice(0, targetIndex));

			// Stages that never ran degrade truthfully and invent nothing; stages
			// that already finished keep their real evidence.
			if (targetIndex <= INVESTIGATION_STAGE_ORDER.indexOf("counterfactual")) {
				expect(result.verifiedCauses).toEqual([]);
				for (const item of result.interventions.items) {
					expect(item.evidence.applied).toBeNull();
					expect(item.evidence.reverted).toBeNull();
				}
			} else {
				expect(result.verifiedCauses).toHaveLength(1);
			}
			if (targetIndex <= INVESTIGATION_STAGE_ORDER.indexOf("minimization")) {
				expect(result.minimization.status).toBe("skipped");
				expect(result.minimization.reason).toBe("not_reached_after_cancellation");
				expect(result.minimization.executionIds).toEqual([]);
			} else {
				expect(result.minimization.status).toBe("completed");
			}
			if (targetIndex <= INVESTIGATION_STAGE_ORDER.indexOf("reproducibility")) {
				expect(result.reproducibility.status).toBe("skipped");
				expect(result.reproducibility.reason).toBe("not_reached_after_cancellation");
				expect(result.reproducibility.executionIds).toEqual([]);
			} else {
				expect(result.reproducibility.status).toBe("completed");
			}
		});
	}

	test("cancellation in the middle of minimization keeps the partial probe evidence", async () => {
		const debugRow = sharedRow("debug", "1");
		const noiseRow = sharedRow("noise", "1");
		const harness = makeHarness({
			failWhen: ({ request }) => request.query.some((entry) => entry.key === "debug" && entry.value === "1"),
			onSend: async ({ stage }) => {
				if (stage !== "minimization") return;
				harness.state.minimizationSends += 1;
				// Cancel for real (the run's AbortController) mid-stage, without
				// awaiting: cancel() must not deadlock against the in-flight run.
				if (harness.state.minimizationSends === 2 && !harness.state.cancelled) {
					harness.state.cancelled = true;
					harness.state.cancelDone = harness.service.cancel(PROFILE_A, harness.state.investigationId).catch(() => undefined);
				}
			},
		});
		const good = harness.seed(makeRecord({ request: makeRequest({ query: [rowLike(debugRow, "0"), noiseRow] }), outcome: "success", status: 200 }));
		const failing = harness.seed(
			makeRecord({ request: makeRequest({ query: [debugRow, noiseRow] }), startedAt: new Date(1760000000000 + 60000) }),
		);

		const result = (await runToCompletion(harness, { failingExecutionId: failing.executionId, goodExecutionId: good.executionId })).result;
		if (harness.state.cancelDone) await harness.state.cancelDone;

		expect(result.status).toBe("cancelled");
		expect(result.stages.interruptedAt).toBe("minimization");
		expect(result.minimization.status).toBe("cancelled");
		expect(result.minimization.executionIds.length).toBeGreaterThan(0);
		expect(result.reproducibility.status).toBe("skipped");
		expect(result.reproducibility.reason).toBe("not_reached_after_cancellation");
		// The counterfactual stage already proved the cause before cancellation,
		// so the partial record keeps it.
		expect(result.verifiedCauses).toHaveLength(1);
	});

	test("a server restart mid-investigation leaves a usable record with INVESTIGATION_INTERRUPTED", async () => {
		const debugRow = sharedRow("debug", "1");
		const harness = makeHarness({
			failWhen: ({ request }) => request.query.some((entry) => entry.key === "debug" && entry.value === "1"),
			hangSend: true,
		});
		const good = harness.seed(makeRecord({ request: makeRequest({ query: [rowLike(debugRow, "0")] }), outcome: "success", status: 200 }));
		const failing = harness.seed(
			makeRecord({ request: makeRequest({ query: [debugRow] }), startedAt: new Date(1760000000000 + 60000) }),
		);

		const created = await harness.service.start(PROFILE_A, { failingExecutionId: failing.executionId, goodExecutionId: good.executionId });
		while (!harness.state.hangResolve) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		// The server "restarts": a fresh service instance shares only the
		// persistence layer and has no in-memory handle for this run.
		const restarted = createInvestigationService({ repository: harness.repository, history: harness.history });
		const observed = await restarted.status(PROFILE_A, created.investigationId);
		expect(observed.status).toBe("failed");
		expect(observed.error.code).toBe("INVESTIGATION_INTERRUPTED");

		harness.state.released = true;
		harness.state.hangResolve();
		await harness.service.wait(PROFILE_A, created.investigationId);
	});
});
