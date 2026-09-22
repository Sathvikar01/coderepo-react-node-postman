import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { createMinimizationService } from "./minimization.service.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase27_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase27-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase27-test-jwt-secret";
beforeAll(() => initConfig());

const PROFILE = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_PROFILE = "bbbbbbbbbbbbbbbbbbbbbbbb";
const SOURCE = "11111111-1111-4111-8111-111111111111";

function row(key) {
	return { id: randomUUID(), key, value: key, enabled: true };
}

function sourceRecord({ method = "GET", local = false } = {}) {
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
			query: [row("required"), row("unused")],
			headers: [],
			body: ["GET", "HEAD"].includes(method) ? { mode: "none" } : { mode: "json", text: '{"required":true,"unused":true}' },
			auth: { mode: "none" },
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
	const key = (profileId, jobId) => `${profileId}:${jobId}`;
	return {
		records,
		async create(value) {
			records.set(key(value.ownerProfileId, value.jobId), structuredClone(value));
			return structuredClone(value);
		},
		async get(profileId, jobId) {
			const value = records.get(key(profileId, jobId));
			return value ? structuredClone(value) : null;
		},
		async update(profileId, jobId, patch) {
			const current = records.get(key(profileId, jobId));
			if (!current) return null;
			const next = { ...current, ...structuredClone(patch), updatedAt: new Date() };
			records.set(key(profileId, jobId), next);
			return structuredClone(next);
		},
	};
}

function harness({ source = sourceRecord(), execute, mockResolve } = {}) {
	const repository = memoryRepository();
	const executeCalls = [];
	const mockCalls = [];
	const service = createMinimizationService({
		repository,
		history: { get: async (profileId, executionId) => (profileId === PROFILE && executionId === SOURCE ? source : null) },
		executions: {
			async send(profileId, input, options) {
				executeCalls.push({ profileId, input, options });
				if (execute) return execute(input, options);
				const failed = input.request.query.some((item) => item.key === "required");
				return { outcome: "response", response: { status: failed ? 500 : 200 }, scriptResults: null };
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
	return { service, repository, executeCalls, mockCalls };
}

async function errorOf(promise) {
	try {
		await promise;
		return null;
	} catch (error) {
		return error;
	}
}

describe("MinimizationJobV1 service", () => {
	test("runs safe probes through hidden normal executions and persists a sanitized result", async () => {
		const { service, executeCalls } = harness();
		const started = await service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: { type: "status", equals: 500 } });
		const completed = await service.wait(PROFILE, started.jobId);

		expect(completed).toMatchObject({ schemaVersion: 1, kind: "tracer.minimization-job", status: "completed" });
		expect(completed.ownerProfileId).toBeUndefined();
		expect(completed.result.request.query.map((item) => item.key)).toEqual(["required"]);
		expect(executeCalls.length).toBeLessThanOrEqual(12);
		expect(executeCalls.every((call) => call.options.rateLimit === false && call.options.visible === false)).toBe(true);
		expect(executeCalls.every((call) => call.input.context.replayHistoryId === SOURCE)).toBe(true);
		expect((await errorOf(service.status(OTHER_PROFILE, started.jobId))).code).toBe("MINIMIZATION_NOT_FOUND");
	});

	test("blocks unsafe methods unless the source used approved local access and the user opted in", async () => {
		const blocked = harness({ source: sourceRecord({ method: "POST", local: false }) }).service;
		expect((await errorOf(blocked.start(PROFILE, { sourceExecutionId: SOURCE, predicate: { type: "status", equals: 500 } }))).code).toBe(
			"MINIMIZATION_UNSAFE_METHOD",
		);

		const local = harness({ source: sourceRecord({ method: "POST", local: true }) });
		expect(
			(await errorOf(local.service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: { type: "status", equals: 500 } }))).code,
		).toBe("MINIMIZATION_CONFIRMATION_REQUIRED");
		const started = await local.service.start(PROFILE, {
			sourceExecutionId: SOURCE,
			predicate: { type: "status", equals: 500 },
			allowUnsafeLocal: true,
		});
		expect((await local.service.wait(PROFILE, started.jobId)).status).toBe("completed");
	});

	test("uses the existing zero-network mock path when mock mode is selected", async () => {
		const { service, executeCalls, mockCalls } = harness({ source: sourceRecord({ method: "DELETE", local: false }) });
		const started = await service.start(PROFILE, {
			sourceExecutionId: SOURCE,
			predicate: { type: "status", equals: 500 },
			targetMode: "mock",
		});
		const completed = await service.wait(PROFILE, started.jobId);

		expect(completed.status).toBe("completed");
		expect(executeCalls).toHaveLength(0);
		expect(mockCalls.length).toBeGreaterThan(1);
	});

	test("cancels an active job and reconciles an orphaned running job", async () => {
		let release;
		const pending = new Promise((resolve) => {
			release = resolve;
		});
		const running = harness({ execute: async () => pending });
		const started = await running.service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: { type: "status", equals: 500 } });
		const cancelPromise = running.service.cancel(PROFILE, started.jobId);
		release({ outcome: "response", response: { status: 500 }, scriptResults: null });
		expect((await cancelPromise).status).toBe("cancelled");

		const orphan = harness();
		const jobId = randomUUID();
		await orphan.repository.create({
			ownerProfileId: PROFILE,
			jobId,
			schemaVersion: 1,
			kind: "tracer.minimization-job",
			status: "running",
			sourceExecutionId: SOURCE,
		});
		const reconciled = await orphan.service.status(PROFILE, jobId);
		expect(reconciled).toMatchObject({ status: "failed", error: { code: "MINIMIZATION_INTERRUPTED" } });
	});
});
