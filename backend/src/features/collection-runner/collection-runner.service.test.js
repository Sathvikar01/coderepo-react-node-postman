import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { createOperationRegistry } from "../executions/active-registry.js";
import { createExecutionService } from "../executions/execution.service.js";
import { TransportError } from "../executions/http-transport.js";
import { createCollectionRunnerService } from "./collection-runner.service.js";
import { RUN_LIMITS } from "./run-limits.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase13_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase13-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase13-test-jwt-secret";

beforeAll(() => {
	initConfig();
});

const COLLECTION_ID = "64b000000000000000000001";
const ENVIRONMENT_ID = "64b000000000000000000002";
const PROFILE_A = "profile-a";
const PROFILE_B = "profile-b";
const FOLDER_ID = "11111111-1111-4111-8111-111111111111";
const MINT_ID = "33333333-3333-4333-8333-333333333331";
const USE_ID = "33333333-3333-4333-8333-333333333332";
const PROBE_ID = "33333333-3333-4333-8333-333333333333";
const CHECKED_ID = "33333333-3333-4333-8333-333333333334";

async function captureError(promise) {
	try {
		await promise;
		return null;
	} catch (error) {
		return error;
	}
}

function request(overrides = {}) {
	const id = overrides.id ?? randomUUID();
	return {
		schemaVersion: 1,
		id,
		folderId: null,
		name: `Request ${id.slice(0, 4)}`,
		method: "GET",
		urlTemplate: "{{base_url}}/probe",
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "inherit" },
		scripts: { preRequest: "", test: "" },
		assertions: [],
		settings: { timeoutMs: 5000 },
		...overrides,
	};
}

// A folder request that mints run-scope variables, the request that consumes them,
// a root request with a pre-request header mutation, and a failing checked request.
function buildFixture() {
	const mint = request({
		id: MINT_ID,
		name: "Mint token",
		method: "POST",
		folderId: FOLDER_ID,
		urlTemplate: "{{base_url}}/token",
		scripts: {
			preRequest: "",
			test:
				'pm.variables.set("auth_token", "tok-" + pm.response.json().token);\n' +
				'pm.variables.set("log", (pm.variables.get("log") || "") + "x");',
		},
	});
	const use = request({
		id: USE_ID,
		name: "Use token",
		folderId: FOLDER_ID,
		urlTemplate: "{{base_url}}/{{auth_token}}",
		headers: [{ id: "44444444-4444-4444-8444-000000000001", key: "X-Log", value: "{{log}}", enabled: true }],
	});
	const probe = request({
		id: PROBE_ID,
		name: "Root probe",
		urlTemplate: "{{base_url}}/probe",
		scripts: { preRequest: 'pm.request.headers.add("X-Run", "yes");', test: "" },
	});
	const checked = request({
		id: CHECKED_ID,
		name: "Checked",
		urlTemplate: "{{base_url}}/missing",
		assertions: [
			{ id: "44444444-4444-4444-8444-000000000002", name: "Status is 200", target: "status", operator: "equals", expected: "200", valueType: "number" },
		],
		scripts: { preRequest: "", test: 'pm.test("minted", function () { pm.expect(pm.response.status).toBe(200); });' },
	});
	return {
		_id: COLLECTION_ID,
		ownerProfileId: PROFILE_A,
		name: "Orders API",
		revision: 1,
		variables: [{ id: "44444444-4444-4444-8444-000000000003", key: "api_version", kind: "plain", value: "v1", enabled: true }],
		auth: { mode: "bearer", tokenTemplate: "{{api_token}}" },
		folders: [{ id: FOLDER_ID, name: "Flow" }],
		requests: [mint, use, probe, checked],
	};
}

function buildEnvironment() {
	return {
		_id: ENVIRONMENT_ID,
		ownerProfileId: PROFILE_A,
		name: "Local",
		revision: 1,
		variables: [
			{ id: "55555555-5555-4555-8555-000000000001", key: "base_url", kind: "plain", value: "http://target.test/local", enabled: true },
			{ id: "55555555-5555-4555-8555-000000000002", key: "api_token", kind: "plain", value: "plain-token-value", enabled: true },
			{ id: "55555555-5555-4555-8555-000000000003", key: "orders_token", kind: "secretRef", alias: "local_token", enabled: true },
		],
	};
}

function fakeHistory() {
	const records = new Map();
	const keyOf = (profileId, executionId) => `${profileId}:${executionId}`;
	return {
		records,
		async get(profileId, executionId) {
			const record = records.get(keyOf(profileId, executionId));
			return record ? structuredClone(record) : null;
		},
		async admit(entry) {
			const key = keyOf(entry.ownerProfileId, entry.executionId);
			if (records.has(key)) {
				const error = new Error("duplicate key");
				error.code = 11000;
				throw error;
			}
			records.set(key, structuredClone(entry));
			return structuredClone(entry);
		},
		async finalize(profileId, executionId, update) {
			const key = keyOf(profileId, executionId);
			const record = records.get(key);
			if (!record || record.status !== "running") return null;
			const patch = {};
			for (const [field, value] of Object.entries(update)) {
				// Mongo's $set expands dotted paths; the fake must behave the same way.
				if (!field.includes(".")) {
					patch[field] = value;
					continue;
				}
				const [head, tail] = field.split(".");
				patch[head] = { ...(record[head] ?? {}), [tail]: value };
			}
			const next = { ...record, ...patch, status: "terminal" };
			records.set(key, next);
			return structuredClone(next);
		},
		async reconcileStale() {
			return null;
		},
	};
}

function fakeRunRepository() {
	const runs = new Map();
	const keyOf = (profileId, runId) => `${profileId}:${runId}`;
	return {
		runs,
		async create(entry) {
			const stored = structuredClone(entry);
			runs.set(keyOf(entry.ownerProfileId, entry.runId), stored);
			return structuredClone(stored);
		},
		async get(profileId, runId) {
			const record = runs.get(keyOf(profileId, runId));
			return record ? structuredClone(record) : null;
		},
		async update(profileId, runId, patch) {
			const current = runs.get(keyOf(profileId, runId));
			if (!current) return null;
			const next = { ...current, ...structuredClone(patch) };
			runs.set(keyOf(profileId, runId), next);
			return structuredClone(next);
		},
		// Compare-and-set mirror of the Mongo repository. The check and the mutation run
		// with no await in between, so it is atomic for the single-threaded fake.
		async transition(profileId, runId, expectedStatus, patch) {
			if (expectedStatus === "completed" || expectedStatus === "cancelled" || expectedStatus === "failed") return null;
			const current = runs.get(keyOf(profileId, runId));
			if (!current || current.status !== expectedStatus) return null;
			const next = { ...current, ...structuredClone(patch) };
			runs.set(keyOf(profileId, runId), next);
			return structuredClone(next);
		},
		async list(profileId, { collectionId = null, limit = 20 } = {}) {
			return [...runs.values()]
				.filter((record) => record.ownerProfileId === profileId && (!collectionId || record.collectionId === collectionId))
				.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
				.slice(0, limit)
				.map((record) => structuredClone(record));
		},
	};
}

function fakeCookies() {
	const applied = [];
	const stored = [];
	return {
		applied,
		stored,
		async applyToRequest({ profileId, url, headers }) {
			applied.push({ profileId, url });
			return {
				headers: [...headers, { name: "Cookie", value: "session=run-cookie" }],
				warnings: [],
				secretValues: ["run-cookie"],
			};
		},
		async storeResponseCookies({ profileId, url, responseHeaders }) {
			stored.push({ profileId, url, responseHeaders });
			return { warnings: [] };
		},
	};
}

const publicTarget = (url) => {
	const parsed = new URL(url);
	return {
		scheme: parsed.protocol.replace(":", ""),
		originalHostname: parsed.hostname,
		authority: parsed.host,
		port: 443,
		pathAndQuery: `${parsed.pathname}${parsed.search}`,
		ip: "93.184.216.34",
		family: 4,
		isIpLiteral: false,
		policyVersion: "1.0",
		local: false,
	};
};

function okResult(body = { ok: true }, status = 200, statusText = "OK") {
	return {
		state: { status, statusText, httpVersion: "1.1", headers: [{ name: "Content-Type", value: "application/json" }] },
		encoded: Buffer.from(JSON.stringify(body)),
		encodedBytes: 32,
		truncated: false,
		omittedReason: null,
		bytesSent: 64,
		timing: { totalMs: 4, firstByteMs: 2 },
		ok: true,
	};
}

function failedResult(kind, message) {
	return {
		state: { status: 0, statusText: "", httpVersion: "1.1", headers: [] },
		encoded: Buffer.alloc(0),
		encodedBytes: 0,
		truncated: false,
		omittedReason: null,
		bytesSent: 0,
		timing: { totalMs: 1, firstByteMs: null },
		ok: false,
		error: new TransportError(kind, message),
	};
}

const dispatch = (input, result) => {
	input.onDispatch?.();
	return result;
};

// Path-aware responders keep each step's behavior deterministic no matter which
// request runs first. The default answers 200 with a mintable token body.
const respondByPath = (routes, fallback = (input) => dispatch(input, okResult({ token: "abc" }))) => (input) => {
	for (const [fragment, responder] of routes) {
		if (input.target.pathAndQuery.includes(fragment)) return responder(input);
	}
	return fallback(input);
};

function makeHarness({
	responder = null,
	collection = buildFixture(),
	environment = buildEnvironment(),
	// Admission holds: `collectionGate` delays the collection lookup and `createGate`
	// delays the run-record insert, so tests can interleave concurrent starts at a
	// deterministic point without sleeping.
	collectionGate = null,
	createGate = null,
	collectionLookup = null,
	runRepository = null,
	createRun = null,
	executionsClient = null,
} = {}) {
	const history = fakeHistory();
	const cookies = fakeCookies();
	const transportCalls = [];
	const policyCalls = [];
	const registry = createOperationRegistry();
	const respond = responder ?? respondByPath([]);
	const lookup =
		collectionLookup ??
		(async (id, ownerProfileId) =>
			String(collection._id) === String(id) && collection.ownerProfileId === ownerProfileId ? collection : null);
	const executions =
		executionsClient ??
		createExecutionService({
			registry,
			history,
			cookies,
			localRuntime: { forExecution: async () => ({ enabled: false, hosts: [] }) },
			policy: {
				async validate(url) {
					policyCalls.push(url);
					return publicTarget(url);
				},
			},
			transport: async (input) => {
				transportCalls.push(input);
				return respond(input);
			},
			collections: { findById: lookup },
			environments: {
				findById: async (id, ownerProfileId) =>
					environment && String(environment._id) === String(id) && environment.ownerProfileId === ownerProfileId
						? environment
						: null,
			},
			environmentSecrets: { resolveSecretAlias: () => undefined },
		});
	const repository = runRepository ?? fakeRunRepository();
	if (createRun) repository.create = createRun;
	const baseLookup = lookup;
	const runners = createCollectionRunnerService({
		repository,
		collections: {
			findById: async (id, ownerProfileId) => {
				if (collectionGate) await collectionGate;
				return baseLookup(id, ownerProfileId);
			},
		},
		environments: {
			findById: async (id, ownerProfileId) =>
				environment && String(environment._id) === String(id) && environment.ownerProfileId === ownerProfileId
					? environment
					: null,
		},
		executions,
	});
	if (createGate) {
		const baseCreate = repository.create.bind(repository);
		repository.create = async (entry) => {
			await createGate;
			return baseCreate(entry);
		};
	}
	return { runners, repository, history, cookies, transportCalls, policyCalls };
}

const startInput = (overrides = {}) => ({
	collectionId: COLLECTION_ID,
	collectionRevision: 1,
	selection: { mode: "requests", requestIds: [] },
	environmentId: ENVIRONMENT_ID,
	environmentRevision: 1,
	iterations: 1,
	stopOnFailure: true,
	variables: [],
	...overrides,
});

const fixtureIds = () => {
	const fixture = buildFixture();
	return fixture.requests.map((entry) => entry.id);
};

describe("collection runner ordering and pipeline use", () => {
	test("executes saved requests in explicit order through the normal execution pipeline", async () => {
		const harness = makeHarness();
		const [mint, use, probe] = fixtureIds();
		const started = await harness.runners.start(
			PROFILE_A,
			startInput({ selection: { mode: "requests", requestIds: [probe, mint, use] }, stopOnFailure: false }),
		);
		const run = await harness.runners.wait(PROFILE_A, started.runId);

		// The explicit selection order wins, and every step is an ordinary execution:
		// compiled, policy-checked, dispatched, captured, and admitted to history.
		expect(harness.transportCalls.map((call) => call.target.pathAndQuery)).toEqual([
			"/local/probe",
			"/local/token",
			"/local/tok-abc",
		]);
		expect(harness.policyCalls).toHaveLength(3);
		expect(harness.history.records.size).toBe(3);
		expect(run.status).toBe("completed");
		expect(run.results.map((step) => step.index)).toEqual([0, 1, 2]);
		expect(run.results.map((step) => step.requestId)).toEqual([probe, mint, use]);
		expect(run.results.every((step) => step.status === "passed")).toBe(true);
		expect(run.results.every((step) => step.executionId)).toBe(true);
		expect(run.summary).toMatchObject({ total: 3, passed: 3, failed: 0, outcome: "passed" });
	});

	test("runs folder selections in stored request order", async () => {
		const harness = makeHarness();
		const [mint, use] = fixtureIds();
		const started = await harness.runners.start(PROFILE_A, startInput({ selection: { mode: "folder", folderId: FOLDER_ID } }));
		const run = await harness.runners.wait(PROFILE_A, started.runId);
		expect(run.results.map((step) => step.requestId)).toEqual([mint, use]);
		expect(run.results.every((step) => step.status === "passed")).toBe(true);
	});
});

describe("collection runner variables", () => {
	test("initial run inputs, script writes, and persisted scopes resolve deterministically", async () => {
		const harness = makeHarness();
		const environmentSnapshot = structuredClone(buildEnvironment());
		const [mint, use] = fixtureIds();
		const started = await harness.runners.start(
			PROFILE_A,
			startInput({
				selection: { mode: "requests", requestIds: [mint, use] },
				stopOnFailure: false,
				// base_url cannot be overridden here: the persisted environment wins over
				// initial run inputs. `seed` resolves because no persisted scope defines it.
				variables: [
					{ key: "base_url", value: "http://run-input.test/never" },
					{ key: "seed", value: "from-run" },
				],
			}),
		);
		const run = await harness.runners.wait(PROFILE_A, started.runId);

		expect(harness.transportCalls[0].target.pathAndQuery).toBe("/local/token");
		// The test script's write folded into run scope and reached the next request.
		expect(harness.transportCalls[1].target.pathAndQuery).toBe("/local/tok-abc");
		expect(run.results.every((step) => step.status === "passed")).toBe(true);
		// Persisted scopes are never mutated by run or script writes.
		expect(buildEnvironment()).toEqual(environmentSnapshot);
	});

	test("run-scope writes propagate to later iterations without touching persisted scopes", async () => {
		const harness = makeHarness();
		const [mint, use] = fixtureIds();
		const started = await harness.runners.start(
			PROFILE_A,
			startInput({ selection: { mode: "requests", requestIds: [mint, use] }, iterations: 2, stopOnFailure: false }),
		);
		const run = await harness.runners.wait(PROFILE_A, started.runId);

		expect(run.results.map((step) => `${step.iteration}:${step.method}`)).toEqual(["1:POST", "1:GET", "2:POST", "2:GET"]);
		const logHeaders = harness.transportCalls
			.filter((call) => call.target.pathAndQuery.includes("tok-"))
			.map((call) => call.headers.find((header) => header.name === "X-Log")?.value);
		expect(logHeaders).toEqual(["x", "xx"]);
	});

	test("run inputs cannot substitute a secret reference", async () => {
		const harness = makeHarness();
		const [mint] = fixtureIds();
		const error = await captureError(
			harness.runners.start(
				PROFILE_A,
				startInput({ selection: { mode: "requests", requestIds: [mint] }, variables: [{ key: "orders_token", value: "leak" }] }),
			),
		);
		expect(error).toMatchObject({ code: "RUN_VARIABLE_RESERVED" });
	});
});

describe("collection runner scripts, assertions, cookies, and auth", () => {
	test("scripts and assertions run per request and shape the step result", async () => {
		const harness = makeHarness({
			responder: respondByPath([
				["/missing", (input) => dispatch(input, okResult({ ok: false }, 404, "Not Found"))],
			]),
		});
		const [, , probe, checked] = fixtureIds();
		const started = await harness.runners.start(
			PROFILE_A,
			startInput({ selection: { mode: "requests", requestIds: [probe, checked] }, stopOnFailure: false }),
		);
		const run = await harness.runners.wait(PROFILE_A, started.runId);

		// The pre-request script mutated the dispatched headers of the first step.
		expect(harness.transportCalls[0].headers.find((header) => header.name === "X-Run")?.value).toBe("yes");
		expect(run.results[0].status).toBe("passed");
		const failedStep = run.results[1];
		expect(failedStep.status).toBe("failed");
		expect(failedStep.assertions.failed + failedStep.assertions.errors).toBeGreaterThan(0);
		expect(failedStep.failureReason.length).toBeGreaterThan(0);
		expect(run.summary.outcome).toBe("failed");
	});

	test("the cookie jar and collection auth apply to every dispatched step", async () => {
		const harness = makeHarness();
		const [mint, use] = fixtureIds();
		const started = await harness.runners.start(
			PROFILE_A,
			startInput({ selection: { mode: "requests", requestIds: [mint, use] }, stopOnFailure: false }),
		);
		await harness.runners.wait(PROFILE_A, started.runId);

		expect(harness.cookies.applied).toHaveLength(2);
		expect(harness.cookies.stored).toHaveLength(2);
		for (const call of harness.transportCalls) {
			expect(call.headers.find((header) => header.name === "Cookie")?.value).toBe("session=run-cookie");
			expect(call.headers.find((header) => header.name === "Authorization")?.value).toBe("Bearer plain-token-value");
		}
	});
});

describe("collection runner failure policy and cancellation", () => {
	const failingChecked = respondByPath([
		["/missing", (input) => dispatch(input, okResult({ ok: false }, 404, "Not Found"))],
	]);

	test("stop-on-failure skips the remaining requests with a reason", async () => {
		const harness = makeHarness({ responder: failingChecked });
		const [mint, , probe, checked] = fixtureIds();
		const started = await harness.runners.start(
			PROFILE_A,
			startInput({ selection: { mode: "requests", requestIds: [probe, checked, mint] }, stopOnFailure: true }),
		);
		const run = await harness.runners.wait(PROFILE_A, started.runId);

		expect(run.status).toBe("completed");
		expect(run.stopReason).toBe("stop_on_failure");
		expect(run.results.map((step) => step.status)).toEqual(["passed", "failed", "skipped"]);
		expect(run.results[2].failureReason).toContain("first failure");
		expect(run.summary).toMatchObject({ executed: 2, passed: 1, failed: 1, skipped: 1, outcome: "failed" });
		expect(harness.transportCalls).toHaveLength(2);
	});

	test("continue-on-failure keeps executing later requests", async () => {
		const harness = makeHarness({ responder: failingChecked });
		const [, , probe, checked] = fixtureIds();
		const started = await harness.runners.start(
			PROFILE_A,
			startInput({ selection: { mode: "requests", requestIds: [checked, probe] }, stopOnFailure: false }),
		);
		const run = await harness.runners.wait(PROFILE_A, started.runId);

		expect(run.stopReason).toBeNull();
		expect(run.status).toBe("completed");
		expect(run.results.map((step) => step.status)).toEqual(["failed", "passed"]);
		expect(harness.transportCalls).toHaveLength(2);
	});

	test("records a failed request with its failure reason and passport", async () => {
		const harness = makeHarness({
			responder: (input) => dispatch(input, failedResult("network_error", "The connection was refused.")),
		});
		const [, , probe] = fixtureIds();
		const started = await harness.runners.start(
			PROFILE_A,
			startInput({ selection: { mode: "requests", requestIds: [probe] }, stopOnFailure: false }),
		);
		const run = await harness.runners.wait(PROFILE_A, started.runId);

		const step = run.results[0];
		expect(step.status).toBe("failed");
		expect(step.outcome).toBe("network_error");
		expect(step.failureReason).toBe("The connection was refused.");
		expect(step.executionId).toBeTruthy();
	});

	test("cancellation aborts the in-flight execution and skips the rest", async () => {
		let releaseBlocked = () => {};
		const blockedStarted = new Promise((resolve) => {
			releaseBlocked = resolve;
		});
		const harness = makeHarness({
			responder: respondByPath(
				[
					[
						"/tok-",
						(input) => {
							releaseBlocked();
							return new Promise((resolve) => {
								const finish = () => resolve(failedResult("cancelled", "This execution was cancelled."));
								if (input.signal?.aborted) return finish();
								input.signal?.addEventListener("abort", finish, { once: true });
							});
						},
					],
				],
			),
		});
		const [mint, use, probe] = fixtureIds();
		const started = await harness.runners.start(
			PROFILE_A,
			startInput({ selection: { mode: "requests", requestIds: [mint, use, probe] }, stopOnFailure: false }),
		);
		await blockedStarted;
		const cancelled = await harness.runners.cancel(PROFILE_A, started.runId);

		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.stopReason).toBe("cancelled");
		expect(cancelled.results.map((step) => step.status)).toEqual(["passed", "cancelled", "skipped"]);
		expect(cancelled.results[1].outcome).toBe("cancelled");
		expect(cancelled.results[2].failureReason).toContain("cancelled");
	});
});

describe("collection runner limits and isolation", () => {
	test("a second run for the same profile is refused while one is active", async () => {
		let releaseBlocked = () => {};
		const blockedStarted = new Promise((resolve) => {
			releaseBlocked = resolve;
		});
		const harness = makeHarness({
			responder: (input) => {
				releaseBlocked();
				return new Promise((resolve) => {
					const finish = () => resolve(failedResult("cancelled", "This execution was cancelled."));
					if (input.signal?.aborted) return finish();
					input.signal?.addEventListener("abort", finish, { once: true });
				});
			},
		});
		const [mint] = fixtureIds();
		const first = await harness.runners.start(PROFILE_A, startInput({ selection: { mode: "requests", requestIds: [mint] } }));
		await blockedStarted;
		const error = await captureError(
			harness.runners.start(PROFILE_A, startInput({ selection: { mode: "requests", requestIds: [mint] } })),
		);
		expect(error).toMatchObject({ code: "RUN_CONCURRENCY_LIMIT" });
		const cancelled = await harness.runners.cancel(PROFILE_A, first.runId);
		expect(cancelled.status).toBe("cancelled");
	});

	test("the runaway-run budget stops a run and skips the remaining requests", async () => {
		const originalDuration = RUN_LIMITS.durationMs;
		RUN_LIMITS.durationMs = 250;
		try {
			const slow = async (input) => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				return dispatch(input, okResult({ token: "abc" }));
			};
			const harness = makeHarness({ responder: slow });
			const [mint, use, probe] = fixtureIds();
			const started = await harness.runners.start(
				PROFILE_A,
				startInput({ selection: { mode: "requests", requestIds: [mint, use, probe] }, stopOnFailure: false }),
			);
			const run = await harness.runners.wait(PROFILE_A, started.runId);
			expect(run.stopReason).toBe("duration");
			expect(run.summary.skipped).toBeGreaterThanOrEqual(1);
			expect(run.summary.executed).toBeLessThan(3);
		} finally {
			RUN_LIMITS.durationMs = originalDuration;
		}
	});

	test("run selections are bounded before anything dispatches", async () => {
		const harness = makeHarness();
		const [mint] = fixtureIds();
		const error = await captureError(
			harness.runners.start(
				PROFILE_A,
				startInput({ selection: { mode: "requests", requestIds: [mint] }, iterations: RUN_LIMITS.iterationsPerRun + 1 }),
			),
		);
		expect(error).toMatchObject({ code: "RUN_TOO_LARGE" });
		expect(harness.transportCalls).toHaveLength(0);
		expect(harness.repository.runs.size).toBe(0);
	});

	test("runs are isolated between profiles", async () => {
		const harness = makeHarness();
		const [mint] = fixtureIds();
		const started = await harness.runners.start(PROFILE_A, startInput({ selection: { mode: "requests", requestIds: [mint] } }));
		const run = await harness.runners.wait(PROFILE_A, started.runId);

		expect(await harness.runners.list(PROFILE_B)).toEqual([]);
		expect(await captureError(harness.runners.status(PROFILE_B, run.runId))).toMatchObject({ code: "RUN_NOT_FOUND" });
		expect(await captureError(harness.runners.cancel(PROFILE_B, run.runId))).toMatchObject({ code: "RUN_NOT_FOUND" });
		expect(await captureError(harness.runners.rerun(PROFILE_B, run.runId))).toMatchObject({ code: "RUN_NOT_FOUND" });
	});
});

describe("collection runner flight recorder linkage", () => {
	test("every executed step links to its execution passport and a rerun starts a fresh run", async () => {
		const harness = makeHarness();
		const [mint, use] = fixtureIds();
		const started = await harness.runners.start(
			PROFILE_A,
			startInput({ selection: { mode: "requests", requestIds: [mint, use] }, stopOnFailure: false }),
		);
		const run = await harness.runners.wait(PROFILE_A, started.runId);

		for (const step of run.results) {
			const record = await harness.history.get(PROFILE_A, step.executionId);
			expect(record.status).toBe("terminal");
			expect(record.receipt).toMatchObject({ kind: "tracer.execution-receipt", executionId: step.executionId });
		}

		const rerunStart = await harness.runners.rerun(PROFILE_A, run.runId);
		expect(rerunStart.runId).not.toBe(run.runId);
		const rerun = await harness.runners.wait(PROFILE_A, rerunStart.runId);
		expect(rerun.status).toBe("completed");
		expect(rerun.results.map((step) => step.requestId)).toEqual([mint, use]);
	});
});

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// A minimal execution client whose every send blocks on one shared gate. Because the
// runner does not hand its AbortSignal to send(), completion is driven by releasing the
// gate; keep selections to a single request so one release finalizes the run.
function gatedExecutions() {
	const gate = deferred();
	const calls = [];
	return {
		calls,
		release: () => gate.resolve(),
		async send(profileId, input) {
			calls.push({ profileId, input });
			await gate.promise;
			return {
				outcome: "response",
				response: { status: 200, headers: [], body: "" },
				scriptResults: null,
				executionId: input.executionId,
			};
		},
		async cancel() {},
	};
}

function runningRecord(runId = randomUUID()) {
	return {
		ownerProfileId: PROFILE_A,
		runId,
		schemaVersion: 1,
		kind: "tracer.collection-run",
		collectionId: COLLECTION_ID,
		collectionRevision: 1,
		collectionName: "Orders API",
		environmentId: null,
		environmentRevision: null,
		input: { selection: { mode: "collection" }, iterations: 1, stopOnFailure: true, variables: [] },
		status: "running",
		stopReason: null,
		results: [],
		summary: null,
		error: null,
		startedAt: new Date(),
		finishedAt: null,
		expiresAt: new Date(Date.now() + 60_000),
	};
}

describe("collection runner atomic terminal transitions (#75)", () => {
	test("recovery fails closed and reloads the canonical terminal record when its CAS loses", async () => {
		const harness = makeHarness();
		const runId = randomUUID();
		const recordKey = `${PROFILE_A}:${runId}`;
		harness.repository.runs.set(recordKey, runningRecord(runId));
		const baseTransition = harness.repository.transition.bind(harness.repository);
		let injected = false;
		harness.repository.transition = async (profileId, id, expectedStatus, patch) => {
			if (!injected) {
				// A concurrent writer finalizes the run between status()'s read and its write.
				injected = true;
				const current = harness.repository.runs.get(`${profileId}:${id}`);
				harness.repository.runs.set(`${profileId}:${id}`, {
					...current,
					status: "completed",
					finishedAt: new Date(),
				});
			}
			return baseTransition(profileId, id, expectedStatus, patch);
		};

		const recovered = await harness.runners.status(PROFILE_A, runId);

		expect(recovered.status).toBe("completed");
		expect(recovered.error).toBeNull();
		expect(harness.repository.runs.get(recordKey).status).toBe("completed");
	});

	test("a failed recovery leaves a stored terminal outcome unchanged", async () => {
		const harness = makeHarness();
		const runId = randomUUID();
		const recordKey = `${PROFILE_A}:${runId}`;
		harness.repository.runs.set(recordKey, { ...runningRecord(runId), status: "cancelled", stopReason: "cancelled" });

		const recovered = await harness.runners.status(PROFILE_A, runId);

		expect(recovered.status).toBe("cancelled");
		expect(harness.repository.runs.get(recordKey).status).toBe("cancelled");
	});

	test("terminal writes require the run to still be running", async () => {
		const harness = makeHarness();
		const runId = randomUUID();
		harness.repository.runs.set(`${PROFILE_A}:${runId}`, {
			...runningRecord(runId),
			status: "completed",
			finishedAt: new Date(),
		});

		// A duplicate completion and a late cancellation both fail closed and return the
		// canonical completed record instead of overwriting it.
		const duplicateCompletion = await harness.repository.transition(PROFILE_A, runId, "running", { status: "completed" });
		const lateCancellation = await harness.repository.transition(PROFILE_A, runId, "running", { status: "cancelled" });
		expect(duplicateCompletion).toBeNull();
		expect(lateCancellation).toBeNull();
		expect(harness.repository.runs.get(`${PROFILE_A}:${runId}`).status).toBe("completed");
	});
});

describe("collection runner atomic admission (#77)", () => {
	const withGlobalLimit = async (limit, body) => {
		const original = RUN_LIMITS.activeRunsPerProcess;
		RUN_LIMITS.activeRunsPerProcess = limit;
		try {
			await body();
		} finally {
			RUN_LIMITS.activeRunsPerProcess = original;
		}
	};

	const oneRequestInput = () => {
		const [mint] = fixtureIds();
		return startInput({ selection: { mode: "requests", requestIds: [mint] }, environmentId: undefined });
	};

	const admissionHarness = (overrides = {}) => {
		const executions = gatedExecutions();
		return {
			executions,
			harness: makeHarness({
				collectionLookup: async () => buildFixture(),
				executionsClient: executions,
				...overrides,
			}),
		};
	};

	test("two simultaneous starts with a global limit of one admit exactly one", async () => {
		await withGlobalLimit(1, async () => {
			const gate = deferred();
			const { harness, executions } = admissionHarness({ collectionGate: gate.promise });

			const first = harness.runners.start(PROFILE_A, oneRequestInput());
			const second = harness.runners.start(PROFILE_B, oneRequestInput());

			const refused = await captureError(second);
			expect(refused).toMatchObject({ code: "RUN_CONCURRENCY_LIMIT", details: { scope: "process", limit: 1 } });
			// The first start holds the only reservation while its collection still loads.
			expect(harness.runners.stats()).toEqual({ active: 0, reserved: 1 });

			gate.resolve();
			const started = await first;
			expect(started.status).toBe("running");
			expect(harness.runners.stats()).toEqual({ active: 1, reserved: 0 });
			expect((await harness.repository.get(PROFILE_A, started.runId)).status).toBe("running");

			const third = await captureError(harness.runners.start(PROFILE_A, oneRequestInput()));
			expect(third).toMatchObject({ code: "RUN_CONCURRENCY_LIMIT" });

			executions.release();
			expect((await harness.runners.wait(PROFILE_A, started.runId)).status).toBe("completed");
			expect(harness.runners.stats()).toEqual({ active: 0, reserved: 0 });
		});
	});

	test("a per-profile limit of one admits exactly one simultaneous start", async () => {
		const gate = deferred();
		const { harness, executions } = admissionHarness({ collectionGate: gate.promise });

		const first = harness.runners.start(PROFILE_A, oneRequestInput());
		const second = harness.runners.start(PROFILE_A, oneRequestInput());

		const refused = await captureError(second);
		expect(refused).toMatchObject({ code: "RUN_CONCURRENCY_LIMIT", details: { scope: "profile", limit: 1 } });
		expect(harness.runners.stats()).toEqual({ active: 0, reserved: 1 });

		gate.resolve();
		const started = await first;
		expect(started.status).toBe("running");
		expect(harness.runners.stats()).toEqual({ active: 1, reserved: 0 });

		executions.release();
		expect((await harness.runners.wait(PROFILE_A, started.runId)).status).toBe("completed");
	});

	test("different profiles claim independent slots", async () => {
		const gate = deferred();
		const { harness, executions } = admissionHarness({ collectionGate: gate.promise });

		const first = harness.runners.start(PROFILE_A, oneRequestInput());
		const second = harness.runners.start(PROFILE_B, oneRequestInput());

		expect(harness.runners.stats()).toEqual({ active: 0, reserved: 2 });

		gate.resolve();
		const [runA, runB] = await Promise.all([first, second]);
		expect([runA.status, runB.status]).toEqual(["running", "running"]);
		expect(harness.runners.stats()).toEqual({ active: 2, reserved: 0 });

		executions.release();
		const [doneA, doneB] = await Promise.all([
			harness.runners.wait(PROFILE_A, runA.runId),
			harness.runners.wait(PROFILE_B, runB.runId),
		]);
		expect([doneA.status, doneB.status]).toEqual(["completed", "completed"]);
		expect(harness.runners.stats()).toEqual({ active: 0, reserved: 0 });
	});

	test("a collection load failure releases the reservation and writes no run", async () => {
		const harness = makeHarness({ collectionLookup: async () => null });

		const error = await captureError(harness.runners.start(PROFILE_A, startInput()));

		expect(error).toMatchObject({ code: "COLLECTION_NOT_FOUND" });
		expect(harness.runners.stats()).toEqual({ active: 0, reserved: 0 });
		expect(harness.repository.runs.size).toBe(0);
	});

	test("a repository create failure releases the reservation and leaves no ghost run", async () => {
		const harness = makeHarness({
			createRun: async () => {
				throw new Error("run record insert failed");
			},
		});

		const error = await captureError(harness.runners.start(PROFILE_A, oneRequestInput()));

		expect(error.message).toBe("run record insert failed");
		expect(harness.runners.stats()).toEqual({ active: 0, reserved: 0 });
		expect(harness.repository.runs.size).toBe(0);
	});

	test("a later valid run starts after an earlier admission failure", async () => {
		const executions = gatedExecutions();
		let attempts = 0;
		const harness = makeHarness({
			executionsClient: executions,
			collectionLookup: async () => {
				attempts += 1;
				return attempts === 1 ? null : buildFixture();
			},
		});

		const firstError = await captureError(harness.runners.start(PROFILE_A, oneRequestInput()));
		expect(firstError).toMatchObject({ code: "COLLECTION_NOT_FOUND" });
		expect(harness.runners.stats()).toEqual({ active: 0, reserved: 0 });

		const started = await harness.runners.start(PROFILE_A, oneRequestInput());
		expect(started.status).toBe("running");
		expect(harness.runners.stats()).toEqual({ active: 1, reserved: 0 });

		executions.release();
		expect((await harness.runners.wait(PROFILE_A, started.runId)).status).toBe("completed");
	});

	test("the in-use count never exceeds the global limit at any interleaving point", async () => {
		await withGlobalLimit(1, async () => {
			const gate = deferred();
			const { harness, executions } = admissionHarness({ collectionGate: gate.promise });
			const within = (limit) => {
				const { active, reserved } = harness.runners.stats();
				expect(active + reserved).toBeLessThanOrEqual(limit);
			};

			const first = harness.runners.start(PROFILE_A, oneRequestInput());
			within(1);
			expect(await captureError(harness.runners.start(PROFILE_B, oneRequestInput()))).toMatchObject({
				code: "RUN_CONCURRENCY_LIMIT",
			});
			within(1);

			gate.resolve();
			const started = await first;
			within(1);

			expect(await captureError(harness.runners.start(PROFILE_A, oneRequestInput()))).toMatchObject({
				code: "RUN_CONCURRENCY_LIMIT",
			});
			within(1);

			executions.release();
			await harness.runners.wait(PROFILE_A, started.runId);
			within(1);
			expect(harness.runners.stats()).toEqual({ active: 0, reserved: 0 });
		});
	});
});
