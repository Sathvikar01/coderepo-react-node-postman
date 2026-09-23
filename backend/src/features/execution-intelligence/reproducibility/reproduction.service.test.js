import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../../shared/config/index.js";
import { createReproductionService } from "./reproduction.service.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase34_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase34-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase34-test-jwt-secret";
beforeAll(() => initConfig());

const PROFILE = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_PROFILE = "bbbbbbbbbbbbbbbbbbbbbbbb";
const SOURCE = "11111111-1111-4111-8111-111111111111";
const STATUS_PREDICATE = { type: "status", equals: 500 };

const SECRETS = ["sk-auth-secret-7", "Bearer sk-header-secret-1", "sk-query-secret-99", "sk-body-secret-3"];

function row(key, value = key) {
	return { id: randomUUID(), key, value, enabled: true };
}

function sourceRecord({ method = "GET", local = false, withSecrets = false } = {}) {
	const isBodyless = ["GET", "HEAD"].includes(method);
	return {
		executionId: SOURCE,
		outcome: "response",
		request: {
			schemaVersion: 1,
			id: randomUUID(),
			folderId: null,
			name: "Failing request",
			method,
			urlTemplate: "https://api.test/fail",
			query: [row("required"), row("unused"), ...(withSecrets ? [row("api_key", "sk-query-secret-99")] : [])],
			headers: withSecrets ? [row("Authorization", "Bearer sk-header-secret-1")] : [],
			body: isBodyless
				? { mode: "none" }
				: { mode: "json", text: withSecrets ? '{"required":true,"password":"sk-body-secret-3"}' : '{"required":true,"unused":true}' },
			auth: withSecrets ? { mode: "bearer", tokenTemplate: "sk-auth-secret-7" } : { mode: "none" },
			scripts: { preRequest: "", test: "" },
			assertions: [],
			settings: { timeoutMs: 15000 },
		},
		context: { environment: { environmentId: "cccccccccccccccccccccccc", environmentRevision: 2 } },
		snapshot: { scriptResults: null },
		response: { status: 500 },
		receipt: {
			schemaVersion: 1,
			kind: "tracer.execution-receipt",
			executionId: SOURCE,
			outcome: "response",
			request: { authoredFingerprint: "a", compiledFingerprint: "b" },
			policy: { decision: "allowed", local },
			target: { hostname: "api.test", address: local ? "127.0.0.1" : "203.0.113.1" },
			response: { contract: { status: 500, headers: [], bodyShape: [] } },
			tests: { failureFingerprint: "none" },
		},
	};
}

function memoryRepository() {
	const records = new Map();
	const key = (profileId, seriesId) => `${profileId}:${seriesId}`;
	return {
		records,
		async create(value) {
			records.set(key(value.ownerProfileId, value.seriesId), structuredClone(value));
			return structuredClone(value);
		},
		async get(profileId, seriesId) {
			const value = records.get(key(profileId, seriesId));
			return value ? structuredClone(value) : null;
		},
		async update(profileId, seriesId, patch) {
			const current = records.get(key(profileId, seriesId));
			if (!current) return null;
			const next = { ...current, ...structuredClone(patch), updatedAt: new Date() };
			records.set(key(profileId, seriesId), next);
			return structuredClone(next);
		},
	};
}

function harness({ source = sourceRecord(), execute, mockResolve } = {}) {
	const repository = memoryRepository();
	const executeCalls = [];
	const mockCalls = [];
	const historyCalls = [];
	const service = createReproductionService({
		repository,
		history: {
			async get(profileId, executionId) {
				historyCalls.push({ profileId, executionId });
				return profileId === PROFILE && executionId === SOURCE ? source : null;
			},
		},
		executions: {
			async send(profileId, input, options) {
				executeCalls.push({ profileId, input, options });
				if (execute) return execute(input, options);
				const failed = input.request.query.some((item) => item.key === "required");
				return { executionId: input.executionId, outcome: "response", response: { status: failed ? 500 : 200 }, scriptResults: null };
			},
		},
		mocks: {
			async resolve(profileId, input) {
				mockCalls.push({ profileId, input });
				if (mockResolve) return mockResolve(input);
				return { result: { outcome: "mock", response: { status: 500 }, scriptResults: null } };
			},
		},
	});
	return { service, repository, executeCalls, mockCalls, historyCalls };
}

async function errorOf(promise) {
	try {
		await promise;
		return null;
	} catch (error) {
		return error;
	}
}

describe("ReproductionStabilityV1 service", () => {
	test("reports 3/3 evidence and a reproducible classification for a deterministic failure", async () => {
		const { service, executeCalls } = harness();
		const started = await service.start(PROFILE, { sourceExecutionId: SOURCE });
		expect(started.predicate).toEqual(STATUS_PREDICATE);

		const completed = await service.wait(PROFILE, started.seriesId);
		expect(completed).toMatchObject({
			schemaVersion: 1,
			kind: "tracer.reproduction-series",
			status: "completed",
			probeBudget: 3,
			targetMode: "execution",
		});
		expect(completed.ownerProfileId).toBeUndefined();

		const result = completed.result;
		expect(result).toMatchObject({
			completed: true,
			plannedProbes: 3,
			attempts: 3,
			matches: 3,
			classification: "reproducible",
			statement: "3/3 probes reproduced the failure",
			error: null,
		});
		result.probes.forEach((probe) => {
			expect(Object.keys(probe).sort()).toEqual(["durationMs", "executionId", "index", "outcome", "predicateMatched", "responseStatus"]);
			expect(probe).toMatchObject({ outcome: "response", responseStatus: 500, predicateMatched: true });
			expect(probe.durationMs).toBeGreaterThanOrEqual(0);
		});
		expect(result.timing).toMatchObject({ sampleCount: 3 });
		expect(result.timing.p95).toBeUndefined();
		expect(result.timing.p99).toBeUndefined();

		expect(executeCalls).toHaveLength(3);
		expect(executeCalls.every((call) => call.profileId === PROFILE)).toBe(true);
		expect(executeCalls.every((call) => call.options.rateLimit === false && call.options.visible === false)).toBe(true);
		expect(executeCalls.every((call) => call.input.context.replayHistoryId === SOURCE)).toBe(true);
		expect(executeCalls.every((call) => String(call.input.tabId).startsWith("repro:"))).toBe(true);
	});

	test("reports 0/3 evidence as not_reproduced when the failure never appears", async () => {
		const { service } = harness({
			execute: async (input) => ({ executionId: input.executionId, outcome: "response", response: { status: 200 }, scriptResults: null }),
		});
		const started = await service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: STATUS_PREDICATE });
		const completed = await service.wait(PROFILE, started.seriesId);

		expect(completed.result).toMatchObject({
			matches: 0,
			attempts: 3,
			classification: "not_reproduced",
			statement: "0/3 probes reproduced the failure",
		});
		expect(completed.result.probes.every((probe) => probe.predicateMatched === false)).toBe(true);
	});

	test("classifies an intermittent failure as flaky and keeps the per-probe pattern", async () => {
		let calls = 0;
		const { service } = harness({
			execute: async (input) => {
				calls += 1;
				const failed = calls !== 2;
				return { executionId: input.executionId, outcome: "response", response: { status: failed ? 500 : 200 }, scriptResults: null };
			},
		});
		const started = await service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: STATUS_PREDICATE });
		const completed = await service.wait(PROFILE, started.seriesId);

		expect(completed.result).toMatchObject({
			matches: 2,
			attempts: 3,
			classification: "flaky",
			statement: "2/3 probes reproduced the failure",
		});
		expect(completed.result.probes.map((probe) => probe.predicateMatched)).toEqual([true, false, true]);
	});

	test("marks a series interrupted by a probe failure inconclusive with partial evidence", async () => {
		let calls = 0;
		const { service } = harness({
			execute: async () => {
				calls += 1;
				if (calls === 2) throw new Error("socket hang up");
				return { executionId: "exec-fail", outcome: "response", response: { status: 500 }, scriptResults: null };
			},
		});
		const started = await service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: STATUS_PREDICATE });
		const failed = await service.wait(PROFILE, started.seriesId);

		expect(failed.status).toBe("failed");
		expect(failed.result).toMatchObject({
			completed: false,
			attempts: 1,
			matches: 1,
			classification: "inconclusive",
			statement: "1/1 probes reproduced the failure (series incomplete)",
		});
		expect(failed.result.error).toEqual({ code: "REPRO_PROBE_FAILED", message: "socket hang up" });
		expect(failed.error).toEqual({ code: "REPRO_PROBE_FAILED", message: "socket hang up" });
	});

	test("reconciles an orphaned running series after a server restart", async () => {
		const harnessState = harness();
		const seriesId = randomUUID();
		await harnessState.repository.create({
			ownerProfileId: PROFILE,
			seriesId,
			schemaVersion: 1,
			kind: "tracer.reproduction-series",
			status: "running",
			sourceExecutionId: SOURCE,
			predicate: STATUS_PREDICATE,
			targetMode: "execution",
			probeBudget: 3,
			startedAt: new Date(),
		});
		const reconciled = await harnessState.service.status(PROFILE, seriesId);
		expect(reconciled).toMatchObject({ status: "failed", error: { code: "REPRO_INTERRUPTED" } });
	});

	test("records timed-out probes as observed evidence without inventing a match", async () => {
		const timeoutResult = (input) => ({ executionId: input.executionId, outcome: "timeout", response: null, error: { kind: "timeout" } });

		const againstStatus = harness({ execute: async (input) => timeoutResult(input) });
		const timedOut = await againstStatus.service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: STATUS_PREDICATE });
		const observed = await againstStatus.service.wait(PROFILE, timedOut.seriesId);
		expect(observed.result).toMatchObject({ matches: 0, attempts: 3, classification: "not_reproduced" });
		observed.result.probes.forEach((probe) => {
			expect(probe).toMatchObject({ outcome: "timeout", responseStatus: null, predicateMatched: false });
			expect(probe.durationMs).toBeGreaterThanOrEqual(0);
		});

		const againstOutcome = harness({ execute: async (input) => timeoutResult(input) });
		const timeoutSeries = await againstOutcome.service.start(PROFILE, {
			sourceExecutionId: SOURCE,
			predicate: { type: "outcome", equals: "timeout" },
		});
		const reproduced = await againstOutcome.service.wait(PROFILE, timeoutSeries.seriesId);
		expect(reproduced.result).toMatchObject({ matches: 3, attempts: 3, classification: "reproducible" });
	});

	test("blocks repeated mutating probes outside approved local or mock targets", async () => {
		const remote = harness({ source: sourceRecord({ method: "POST" }) });
		expect((await errorOf(remote.service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: STATUS_PREDICATE }))).code).toBe(
			"REPRO_UNSAFE_METHOD",
		);
		expect(remote.executeCalls).toHaveLength(0);

		const local = harness({ source: sourceRecord({ method: "POST", local: true }) });
		expect((await errorOf(local.service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: STATUS_PREDICATE }))).code).toBe(
			"REPRO_CONFIRMATION_REQUIRED",
		);
		expect(local.executeCalls).toHaveLength(0);
		const confirmed = await local.service.start(PROFILE, {
			sourceExecutionId: SOURCE,
			predicate: STATUS_PREDICATE,
			allowUnsafeLocal: true,
		});
		expect((await local.service.wait(PROFILE, confirmed.seriesId)).status).toBe("completed");
		expect(local.executeCalls).toHaveLength(3);

		const mocked = harness({ source: sourceRecord({ method: "DELETE" }) });
		const mockSeries = await mocked.service.start(PROFILE, {
			sourceExecutionId: SOURCE,
			predicate: STATUS_PREDICATE,
			targetMode: "mock",
		});
		const mockDone = await mocked.service.wait(PROFILE, mockSeries.seriesId);
		expect(mockDone.status).toBe("completed");
		expect(mocked.executeCalls).toHaveLength(0);
		expect(mocked.mockCalls).toHaveLength(3);
		expect(mocked.mockCalls.every((call) => call.profileId === PROFILE)).toBe(true);
	});

	test("cancels an active series and reports the evidence observed so far", async () => {
		let release;
		const pending = new Promise((resolve) => {
			release = resolve;
		});
		const running = harness({ execute: async () => pending });
		const started = await running.service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: STATUS_PREDICATE });
		const cancelPromise = running.service.cancel(PROFILE, started.seriesId);
		release({ executionId: "exec-1", outcome: "response", response: { status: 500 }, scriptResults: null });
		const cancelled = await cancelPromise;

		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.result).toMatchObject({
			completed: false,
			attempts: 1,
			matches: 1,
			classification: "inconclusive",
			statement: "1/1 probes reproduced the failure (series incomplete)",
		});
		expect(cancelled.result.error).toEqual({ code: "REPRO_CANCELLED", message: "The reproduction series was cancelled." });
		expect(cancelled.result.probes).toHaveLength(1);
		expect(running.executeCalls).toHaveLength(1);
	});

	test("keeps series profile-scoped and hides ownership from presenters", async () => {
		const { service, repository, executeCalls, historyCalls } = harness();
		expect((await errorOf(service.start(OTHER_PROFILE, { sourceExecutionId: SOURCE, predicate: STATUS_PREDICATE }))).code).toBe(
			"HISTORY_NOT_FOUND",
		);
		expect(historyCalls[0]).toEqual({ profileId: OTHER_PROFILE, executionId: SOURCE });

		const started = await service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: STATUS_PREDICATE });
		await service.wait(PROFILE, started.seriesId);
		expect((await errorOf(service.status(OTHER_PROFILE, started.seriesId))).code).toBe("REPRO_NOT_FOUND");
		expect((await errorOf(service.wait(OTHER_PROFILE, started.seriesId))).code).toBe("REPRO_NOT_FOUND");
		expect((await errorOf(service.cancel(OTHER_PROFILE, started.seriesId))).code).toBe("REPRO_NOT_FOUND");
		expect(executeCalls.every((call) => call.profileId === PROFILE)).toBe(true);

		const presented = await service.status(PROFILE, started.seriesId);
		expect(presented.ownerProfileId).toBeUndefined();
		expect(presented.result.probes[0].ownerProfileId).toBeUndefined();
		const raw = await repository.get(PROFILE, started.seriesId);
		expect(raw.ownerProfileId).toBe(PROFILE);
		expect((await repository.get(OTHER_PROFILE, started.seriesId)) ?? null).toBeNull();
	});

	test("enforces the hard probe cap and the default of three probes", async () => {
		const capped = harness();
		const cappedSeries = await capped.service.start(PROFILE, {
			sourceExecutionId: SOURCE,
			predicate: STATUS_PREDICATE,
			probes: 99,
		});
		expect(cappedSeries.probeBudget).toBe(5);
		await capped.service.wait(PROFILE, cappedSeries.seriesId);
		expect(capped.executeCalls).toHaveLength(5);

		const floored = harness();
		const flooredSeries = await floored.service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: STATUS_PREDICATE, probes: 1 });
		expect(flooredSeries.probeBudget).toBe(2);
		await floored.service.wait(PROFILE, flooredSeries.seriesId);
		expect(floored.executeCalls).toHaveLength(2);

		const defaulted = harness();
		const defaultedSeries = await defaulted.service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: STATUS_PREDICATE });
		expect(defaultedSeries.probeBudget).toBe(3);
		await defaulted.service.wait(PROFILE, defaultedSeries.seriesId);
		expect(defaulted.executeCalls).toHaveLength(3);

		const invalid = harness();
		expect((await errorOf(invalid.service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: { type: "guess" } }))).code).toBe(
			"REPRO_PREDICATE_INVALID",
		);
	});

	test("never persists resolved credentials in stored series or error text", async () => {
		const leak = SECRETS.join(" ");
		const failing = harness({
			source: sourceRecord({ method: "POST", local: true, withSecrets: true }),
			execute: async (input) => ({ executionId: input.executionId, outcome: "response", response: { status: 500 }, scriptResults: null }),
		});
		const completedSeries = await failing.service.start(PROFILE, {
			sourceExecutionId: SOURCE,
			predicate: STATUS_PREDICATE,
			allowUnsafeLocal: true,
		});
		const completed = await failing.service.wait(PROFILE, completedSeries.seriesId);
		expect(completed.status).toBe("completed");

		let calls = 0;
		const erroring = harness({
			source: sourceRecord({ method: "POST", local: true, withSecrets: true }),
			execute: async (input) => {
				calls += 1;
				if (calls === 2) throw new Error(`upstream echoed credentials: ${leak}`);
				return { executionId: input.executionId, outcome: "response", response: { status: 500 }, scriptResults: null };
			},
		});
		const errorSeries = await erroring.service.start(PROFILE, {
			sourceExecutionId: SOURCE,
			predicate: STATUS_PREDICATE,
			allowUnsafeLocal: true,
		});
		const errored = await erroring.service.wait(PROFILE, errorSeries.seriesId);
		expect(errored.status).toBe("failed");
		expect(errored.result.error.message).toContain("[REDACTED]");
		expect(errored.error.message).toBe(errored.result.error.message);

		for (const raw of [
			await failing.repository.get(PROFILE, completedSeries.seriesId),
			await erroring.repository.get(PROFILE, errorSeries.seriesId),
		]) {
			expect(raw.request).toBeUndefined();
			expect(raw.result.request).toBeUndefined();
			const serialized = JSON.stringify(raw);
			for (const secret of SECRETS) expect(serialized).not.toContain(secret);
			expect(serialized).not.toContain(leak);
		}
	});
});
