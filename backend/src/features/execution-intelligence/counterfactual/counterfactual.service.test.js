import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "../../../shared/errors/app-error.js";
import { initConfig } from "../../../shared/config/index.js";
import { createCounterfactualService } from "./counterfactual.service.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase31_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase31-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase31-test-jwt-secret";
beforeAll(() => initConfig());

const PROFILE = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_PROFILE = "bbbbbbbbbbbbbbbbbbbbbbbb";
const BASE_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
const MODE_ROW = "33333333-3333-4333-8333-333333333333";

function headerRow(value) {
	return { id: MODE_ROW, key: "X-Mode", value, enabled: true };
}

function record({ executionId, method = "GET", local = false, headerValue: value = "ok", url = "https://api.test/checkout", status = 200 }) {
	return {
		executionId,
		outcome: "response",
		request: {
			schemaVersion: 1,
			id: randomUUID(),
			folderId: null,
			name: "Checkout",
			method,
			urlTemplate: url,
			query: [],
			headers: [headerRow(value)],
			body: { mode: "none" },
			auth: { mode: "none" },
			scripts: { preRequest: "", test: "" },
			assertions: [],
			settings: { timeoutMs: 15000 },
		},
		context: { environment: { environmentId: "cccccccccccccccccccccccc", environmentRevision: 1 } },
		snapshot: { scriptResults: null },
		response: { status },
		receipt: {
			schemaVersion: 1,
			kind: "tracer.execution-receipt",
			executionId,
			outcome: "response",
			request: { authoredFingerprint: `a-${executionId}`, compiledFingerprint: `c-${executionId}` },
			source: { environmentId: "cccccccccccccccccccccccc", environmentRevision: 1, collectionId: null, collectionRevision: null },
			policy: { decision: "allowed", local },
			target: { hostname: "api.test", address: local ? "127.0.0.1" : "203.0.113.1" },
			response: { contract: { status, headers: [], bodyShape: [] } },
			tests: { failureFingerprint: "none" },
		},
	};
}

const goodRecord = () => record({ executionId: BASE_ID, headerValue: "ok", status: 200 });
const failingRecord = () => record({ executionId: CANDIDATE_ID, headerValue: "fail", status: 500 });

function statusFrom(source) {
	const value = source.request.headers.find((row) => row.key === "X-Mode")?.value;
	return value === "fail" ? 500 : 200;
}

function harness({ base = goodRecord(), candidate = failingRecord(), execute, mockResolve } = {}) {
	const executeCalls = [];
	const mockCalls = [];
	const records = new Map([
		[`${PROFILE}:${BASE_ID}`, base],
		[`${PROFILE}:${CANDIDATE_ID}`, candidate],
	]);
	const service = createCounterfactualService({
		history: {
			async get(profileId, executionId) {
				return records.get(`${profileId}:${executionId}`) ?? null;
			},
		},
		executions: {
			async send(profileId, input, options) {
				executeCalls.push({ profileId, input, options });
				if (execute) return execute(input, options);
				return { executionId: input.executionId, outcome: "response", response: { status: statusFrom(input) }, scriptResults: null };
			},
		},
		mocks: {
			async resolve(profileId, input) {
				mockCalls.push({ profileId, input });
				if (mockResolve) return mockResolve(input);
				return { result: { outcome: "mock", response: { status: statusFrom(input) }, scriptResults: null } };
			},
		},
	});
	return { service, executeCalls, mockCalls, records };
}

async function errorOf(promise) {
	try {
		await promise;
		return null;
	} catch (error) {
		return error;
	}
}

const INPUT = { baseExecutionId: BASE_ID, candidateExecutionId: CANDIDATE_ID, predicate: { type: "status", equals: 500 } };

describe("counterfactual service", () => {
	test("runs probes through hidden normal executions and isolates profiles", async () => {
		const { service, executeCalls } = harness();
		const result = await service.analyze(PROFILE, INPUT);

		expect(result).toMatchObject({ kind: "tracer.counterfactual-result", status: "completed" });
		expect(result.causalDeltaIds).toEqual([`header:${MODE_ROW}`]);
		expect(executeCalls.length).toBeGreaterThan(0);
		expect(executeCalls.every((call) => call.options.rateLimit === false && call.options.visible === false)).toBe(true);
		expect(executeCalls.every((call) => call.input.context.replayHistoryId === CANDIDATE_ID)).toBe(true);
		expect((await errorOf(service.analyze(OTHER_PROFILE, INPUT))).code).toBe("COUNTERFACTUAL_NOT_FOUND");
	});

	test("blocks unsafe methods unless the target is approved local and the user opted in", async () => {
		const blocked = harness({ candidate: record({ executionId: CANDIDATE_ID, method: "POST", headerValue: "fail", status: 500 }) });
		expect((await errorOf(blocked.service.analyze(PROFILE, INPUT))).code).toBe("COUNTERFACTUAL_UNSAFE_METHOD");

		const local = harness({ candidate: record({ executionId: CANDIDATE_ID, method: "POST", local: true, headerValue: "fail", status: 500 }) });
		expect((await errorOf(local.service.analyze(PROFILE, INPUT))).code).toBe("COUNTERFACTUAL_CONFIRMATION_REQUIRED");
		const confirmed = await local.service.analyze(PROFILE, { ...INPUT, allowUnsafeLocal: true });
		expect(confirmed.status).toBe("completed");
	});

	test("uses the zero-network mock path and makes no real executions", async () => {
		const { service, executeCalls, mockCalls } = harness({
			candidate: record({ executionId: CANDIDATE_ID, method: "DELETE", headerValue: "fail", status: 500 }),
		});
		const result = await service.analyze(PROFILE, { ...INPUT, targetMode: "mock" });

		expect(result.status).toBe("completed");
		expect(executeCalls).toHaveLength(0);
		expect(mockCalls.length).toBeGreaterThan(1);
	});

	test("propagates the normal target-policy rejection", async () => {
		const { service } = harness({
			candidate: record({ executionId: CANDIDATE_ID, headerValue: "fail", status: 500, url: "https://blocked.test/checkout" }),
			execute: async (input) => {
				if (String(input.request.urlTemplate).includes("blocked.test"))
					throw new AppError(400, "TARGET_BLOCKED", "The target is not permitted.");
				return { executionId: input.executionId, outcome: "response", response: { status: statusFrom(input) }, scriptResults: null };
			},
		});
		expect((await errorOf(service.analyze(PROFILE, INPUT))).code).toBe("TARGET_BLOCKED");
	});

	test("replays a method delta when the mutating source used approved local access", async () => {
		const { service } = harness({
			base: record({ executionId: BASE_ID, method: "POST", local: true, headerValue: "ok", status: 200 }),
			candidate: record({ executionId: CANDIDATE_ID, method: "GET", headerValue: "fail", status: 500 }),
			execute: async (input) => ({
				executionId: input.executionId,
				outcome: "response",
				response: { status: input.request.method === "GET" ? 500 : 200 },
				scriptResults: null,
			}),
		});

		const result = await service.analyze(PROFILE, { ...INPUT, allowUnsafeLocal: true });
		expect(result.status).toBe("completed");
		expect(result.causalDeltaIds).toContain("method");
		const method = result.interventions.find((entry) => entry.delta.id === "method");
		expect(method.classification).toBe("causal");
	});

	test("validates inputs and requires a passport plus a request definition", async () => {
		const { service, records } = harness();
		expect((await errorOf(service.analyze(PROFILE, { baseExecutionId: BASE_ID, candidateExecutionId: BASE_ID }))).code).toBe(
			"COUNTERFACTUAL_INPUT",
		);

		const noReceipt = harness();
		noReceipt.records.get(`${PROFILE}:${BASE_ID}`).receipt = null;
		expect((await errorOf(noReceipt.service.analyze(PROFILE, INPUT))).code).toBe("COUNTERFACTUAL_RECEIPT_UNAVAILABLE");

		const noRequest = harness();
		noRequest.records.get(`${PROFILE}:${CANDIDATE_ID}`).request = null;
		expect((await errorOf(noRequest.service.analyze(PROFILE, INPUT))).code).toBe("COUNTERFACTUAL_REQUEST_UNAVAILABLE");

		expect(records.size).toBe(2);
	});

	test("honours an already-aborted cancellation signal", async () => {
		const { service } = harness();
		const controller = new AbortController();
		controller.abort();
		expect((await errorOf(service.analyze(PROFILE, INPUT, { signal: controller.signal }))).code).toBe("COUNTERFACTUAL_CANCELLED");
	});
});
