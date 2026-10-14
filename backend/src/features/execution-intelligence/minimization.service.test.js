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
		async transition(profileId, jobId, expectedStatus, patch) {
			const current = records.get(key(profileId, jobId));
			if (!current || current.status !== expectedStatus) return null;
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

function serviceOverRepository(repository, { execute } = {}) {
	return createMinimizationService({
		repository,
		history: {
			get: async (profileId, executionId) => (profileId === PROFILE && executionId === SOURCE ? sourceRecord() : null),
		},
		executions: {
			async send(profileId, input) {
				if (execute) return execute(input);
				const failed = input.request.query.some((item) => item.key === "required");
				return { outcome: "response", response: { status: failed ? 500 : 200 }, scriptResults: null };
			},
		},
		mocks: {
			async resolve() {
				return { result: { outcome: "mock", response: { status: 500 }, scriptResults: null } };
			},
		},
	});
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

describe("MinimizationJobV1 atomic terminal transitions", () => {
	function runningJob(jobId) {
		return {
			ownerProfileId: PROFILE,
			jobId,
			schemaVersion: 1,
			kind: "tracer.minimization-job",
			sourceExecutionId: SOURCE,
			status: "running",
			predicate: { type: "status", equals: 500 },
			targetMode: "execution",
			probeBudget: 12,
			result: null,
			error: null,
			startedAt: new Date(),
			finishedAt: null,
			expiresAt: new Date(Date.now() + 60_000),
		};
	}

	test("running → completed persists the canonical terminal state", async () => {
		const { service, repository } = harness();
		const started = await service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: { type: "status", equals: 500 } });
		const completed = await service.wait(PROFILE, started.jobId);

		expect(completed.status).toBe("completed");
		const persisted = await repository.get(PROFILE, started.jobId);
		expect(persisted.status).toBe("completed");
		expect(persisted.result.request.query.map((item) => item.key)).toEqual(["required"]);
	});

	test("running → failed persists the canonical terminal state", async () => {
		const { service, repository } = harness({
			execute: async () => ({ outcome: "response", response: { status: 200 }, scriptResults: null }),
		});
		const started = await service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: { type: "status", equals: 500 } });
		const failed = await service.wait(PROFILE, started.jobId);

		expect(failed.status).toBe("failed");
		expect(failed.error.code).toBe("MINIMIZATION_PREDICATE_NOT_MET");
		const persisted = await repository.get(PROFILE, started.jobId);
		expect(persisted.status).toBe("failed");
		expect(persisted.error.code).toBe("MINIMIZATION_PREDICATE_NOT_MET");
	});

	test("running → cancelled persists the canonical terminal state", async () => {
		let release;
		const pending = new Promise((resolve) => {
			release = resolve;
		});
		const running = harness({ execute: async () => pending });
		const started = await running.service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: { type: "status", equals: 500 } });
		const cancelPromise = running.service.cancel(PROFILE, started.jobId);
		release({ outcome: "response", response: { status: 500 }, scriptResults: null });
		const cancelled = await cancelPromise;

		expect(cancelled.status).toBe("cancelled");
		const persisted = await running.repository.get(PROFILE, started.jobId);
		expect(persisted.status).toBe("cancelled");
	});

	test("completion racing a cancellation never overwrites the cancelled state", async () => {
		const base = memoryRepository();
		const repository = {
			...base,
			async transition(profileId, jobId, expectedStatus, patch) {
				if (expectedStatus === "running" && patch.status === "completed") {
					// Deterministically let a concurrent cancellation win before completion's
					// conditional write lands, exactly like two atomic database writers.
					await base.transition(profileId, jobId, "running", {
						status: "cancelled",
						result: null,
						error: { code: "MINIMIZATION_CANCELLED", message: "Failure minimization was cancelled." },
						finishedAt: new Date(),
					});
				}
				return base.transition(profileId, jobId, expectedStatus, patch);
			},
		};
		const service = serviceOverRepository(repository);
		const started = await service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: { type: "status", equals: 500 } });
		const result = await service.wait(PROFILE, started.jobId);

		expect(result.status).toBe("cancelled");
		expect(result.result).toBeNull();
		const persisted = await base.get(PROFILE, started.jobId);
		expect(persisted.status).toBe("cancelled");
		expect(persisted.result).toBeNull();
	});

	test("interrupted recovery never overwrites a job completed concurrently", async () => {
		const base = memoryRepository();
		const jobId = randomUUID();
		await base.create(runningJob(jobId));
		const repository = {
			...base,
			async transition(profileId, id, expectedStatus, patch) {
				if (expectedStatus === "running" && patch.error?.code === "MINIMIZATION_INTERRUPTED") {
					// A concurrent completion wins before recovery's conditional write lands.
					await base.transition(profileId, id, "running", {
						status: "completed",
						result: { minimal: true },
						error: null,
						finishedAt: new Date(),
					});
				}
				return base.transition(profileId, id, expectedStatus, patch);
			},
		};
		const service = serviceOverRepository(repository);
		const result = await service.status(PROFILE, jobId);

		expect(result.status).toBe("completed");
		expect(result.error).toBeNull();
		const persisted = await base.get(PROFILE, jobId);
		expect(persisted.status).toBe("completed");
		expect(persisted.error).toBeNull();
	});

	test("a terminal state cannot transition again", async () => {
		const { service, repository } = harness();
		const started = await service.start(PROFILE, { sourceExecutionId: SOURCE, predicate: { type: "status", equals: 500 } });
		await service.wait(PROFILE, started.jobId);

		const late = await repository.transition(PROFILE, started.jobId, "running", {
			status: "failed",
			error: { code: "MINIMIZATION_INTERRUPTED", message: "stale write" },
			finishedAt: new Date(),
		});
		expect(late).toBeNull();
		const persisted = await repository.get(PROFILE, started.jobId);
		expect(persisted.status).toBe("completed");
		expect(persisted.error).toBeNull();
	});
});
