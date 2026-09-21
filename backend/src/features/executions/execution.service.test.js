import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "../../shared/errors/app-error.js";
import { initConfig } from "../../shared/config/index.js";
import { fingerprintOf } from "../history/fingerprint.js";
import { createOperationRegistry } from "./active-registry.js";
import { createExecutionService, terminalResult } from "./execution.service.js";
import { TransportError } from "./http-transport.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase2_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase2-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase2-test-jwt-secret";

beforeAll(() => {
	initConfig();
});

let profileSeq = 0;
const nextProfile = () => `profile-${(profileSeq += 1)}`;

function draft(overrides = {}) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name: "Probe",
		method: "GET",
		urlTemplate: "https://example.test/probe",
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		settings: { timeoutMs: 5000 },
		...overrides,
	};
}

function fakeHistory() {
	const records = new Map();
	const keyOf = (profileId, executionId) => `${profileId}:${executionId}`;
	return {
		records,
		admissions: 0,
		finalizations: 0,
		async get(profileId, executionId) {
			const record = records.get(keyOf(profileId, executionId));
			return record ? structuredClone(record) : null;
		},
		async admit(entry) {
			this.admissions += 1;
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
			this.finalizations += 1;
			const key = keyOf(profileId, executionId);
			const record = records.get(key);
			if (!record || record.status !== "running") return null;
			const next = { ...record, ...update, status: "terminal" };
			records.set(key, next);
			return structuredClone(next);
		},
		async reconcileStale() {
			return null;
		},
	};
}

const publicTarget = {
	scheme: "https",
	originalHostname: "example.test",
	authority: "example.test",
	port: 443,
	pathAndQuery: "/probe",
	ip: "93.184.216.34",
	family: 4,
	isIpLiteral: false,
	policyVersion: "1.0",
	local: false,
};

function okTransport(overrides = {}) {
	return {
		state: { status: 200, statusText: "OK", httpVersion: "1.1", headers: [{ name: "Content-Type", value: "application/json" }] },
		encoded: Buffer.from('{"ok":true}'),
		encodedBytes: 11,
		truncated: false,
		omittedReason: null,
		bytesSent: 64,
		timing: { totalMs: 5, firstByteMs: 2 },
		...overrides,
		ok: overrides.ok ?? true,
	};
}

function makeService({ history = fakeHistory(), transport, policy } = {}) {
	const registry = createOperationRegistry();
	const calls = { transport: [], policy: [] };
	const service = createExecutionService({
		registry,
		history,
		transport: async (input) => {
			calls.transport.push(input);
			if (transport) return transport(input, service);
			input.onDispatch?.();
			return okTransport();
		},
		policy: {
			async validate(url, options) {
				calls.policy.push({ url, options });
				if (policy) return policy(url, options, service);
				return publicTarget;
			},
		},
	});
	return { service, registry, history, calls };
}

const sendInput = (overrides = {}) => ({ executionId: randomUUID(), tabId: "tab-1", draftVersion: 1, request: draft(), context: {}, ...overrides });

describe("execution pipeline order", () => {
	test("compiles, validates the target, dispatches, and returns a receipt that matches history", async () => {
		const history = fakeHistory();
		const { service, calls } = makeService({ history });
		const input = sendInput();

		const result = await service.send(nextProfile(), input);

		expect(calls.policy).toHaveLength(1);
		expect(calls.policy[0].url).toBe("https://example.test/probe");
		expect(calls.transport).toHaveLength(1);
		expect(calls.transport[0]).toMatchObject({ target: publicTarget, method: "GET" });
		expect(result.outcome).toBe("response");
		expect(result.response.status).toBe(200);
		expect(result.persistence).toEqual({ state: "saved" });

		const stored = [...history.records.values()][0];
		expect(stored.status).toBe("terminal");
		expect(stored.outcome).toBe(result.outcome);
		expect(stored.effectCertainty).toBe(result.effectCertainty);
		expect(stored.response.status).toBe(result.response.status);
		expect(history.admissions).toBe(1);
	});

	test("records a running admission before dispatch and marks effect certainty once bytes are written", async () => {
		const history = fakeHistory();
		let admitted = null;
		const originalAdmit = history.admit.bind(history);
		history.admit = async (entry) => {
			admitted = structuredClone(entry);
			return originalAdmit(entry);
		};
		const { service, calls } = makeService({ history });

		const result = await service.send(nextProfile(), sendInput());

		expect(admitted.status).toBe("running");
		expect(admitted.effectCertainty).toBe("not_dispatched");
		expect(calls.transport).toHaveLength(1);
		expect(result.effectCertainty).toBe("may_have_reached_target");
	});

	test("policy failure fails closed before dispatch", async () => {
		const { service, calls } = makeService({
			policy: async () => {
				throw new AppError(400, "TARGET_BLOCKED", "The target resolves to an address that is not permitted.");
			},
		});

		const result = await service.send(nextProfile(), sendInput());

		expect(calls.transport).toHaveLength(0);
		expect(result.outcome).toBe("validation_error");
		expect(result.effectCertainty).toBe("not_dispatched");
		expect(result.error.code).toBe("TARGET_BLOCKED");
		expect(result.persistence).toEqual({ state: "saved" });
	});

	test("carries the executed URL when a dispatched send fails", async () => {
		const history = fakeHistory();
		history.finalize = async () => null;
		const { service } = makeService({
			history,
			transport: async (input) => {
				input.onDispatch?.();
				return {
					ok: false,
					error: new TransportError("timeout", "This execution exceeded its time budget."),
					state: { status: 0, statusText: "", httpVersion: "1.1", headers: [] },
					encoded: Buffer.alloc(0),
					encodedBytes: 0,
					truncated: false,
					omittedReason: null,
					bytesSent: 64,
					timing: { totalMs: 5000, firstByteMs: null },
				};
			},
		});

		const result = await service.send(nextProfile(), sendInput());

		expect(result.outcome).toBe("timeout");
		expect(result.effectCertainty).toBe("may_have_reached_target");
		expect(result.executedUrl).toBe("https://example.test/probe");
		expect(result.response).toBeNull();
	});

	test("terminal results expose the recorded executed URL", () => {
		const result = terminalResult({
			executionId: "exec-1",
			outcome: "timeout",
			effectCertainty: "may_have_reached_target",
			snapshot: { executedUrl: "https://example.test/probe" },
		});

		expect(result.executedUrl).toBe("https://example.test/probe");
	});

	test("blocks a method that is not a supported HTTP token", async () => {
		const { service, calls } = makeService();

		const result = await service.send(nextProfile(), sendInput({ request: draft({ method: "GET / HTTP/1.1\r\nHost: evil" }) }));

		expect(calls.transport).toHaveLength(0);
		expect(result.outcome).toBe("validation_error");
		expect(result.error.code).toBe("METHOD_INVALID");
	});

	test("redacts resolved credentials before returning and persisting the result", async () => {
		const history = fakeHistory();
		const token = "literal-bearer-token-9d1f";
		const echo = Buffer.from(JSON.stringify({ echo: token }), "utf8");
		const { service, calls } = makeService({
			history,
			transport: (input) => {
				input.onDispatch();
				return okTransport({
					encoded: echo,
					encodedBytes: echo.length,
					state: {
						status: 200,
						statusText: "OK",
						httpVersion: "1.1",
						headers: [
							{ name: "Content-Type", value: "application/json" },
							{ name: "Set-Cookie", value: `session=${token}` },
						],
					},
				});
			},
		});

		const result = await service.send(nextProfile(), sendInput({ authOverride: { mode: "bearer", tokenTemplate: token } }));

		expect(calls.transport[0].headers).toContainEqual({ name: "Authorization", value: `Bearer ${token}` });
		expect(JSON.stringify(result)).not.toContain(token);
		expect(JSON.stringify([...history.records.values()])).not.toContain(token);
		expect(result.response.headers).toContainEqual({ name: "Set-Cookie", value: "[REDACTED]" });
		expect(result.response.body.value).toContain("[REDACTED]");
	});
});

describe("execution identity and receipt integrity", () => {
	test("returns the stored terminal record for a duplicate id without dispatching again", async () => {
		const history = fakeHistory();
		const profileId = nextProfile();
		const input = sendInput();
		const fingerprint = fingerprintOf({ request: input.request, authOverride: null, context: { collectionId: null, collectionRevision: null, replayHistoryId: null, environmentId: null, environmentRevision: null } });
		history.records.set(`${profileId}:${input.executionId}`, {
			ownerProfileId: profileId,
			executionId: input.executionId,
			fingerprint,
			fingerprintKeyId: "v1",
			status: "terminal",
			outcome: "response",
			effectCertainty: "may_have_reached_target",
			response: { status: 204 },
			error: null,
			persistence: { state: "saved" },
			startedAt: new Date(),
			finishedAt: new Date(),
			request: input.request,
			snapshot: {},
			compileTrace: [],
			warnings: [],
			visible: true,
		});
		const { service, calls } = makeService({ history });

		const result = await service.send(profileId, input);

		expect(result.duplicate).toBe(true);
		expect(result.response.status).toBe(204);
		expect(calls.transport).toHaveLength(0);
		expect(history.admissions).toBe(0);
	});

	test("refuses to reuse an execution id with different input", async () => {
		const history = fakeHistory();
		const profileId = nextProfile();
		const input = sendInput();
		history.records.set(`${profileId}:${input.executionId}`, {
			ownerProfileId: profileId,
			executionId: input.executionId,
			fingerprint: "different-fingerprint",
			fingerprintKeyId: "v1",
			status: "terminal",
			outcome: "response",
			effectCertainty: "not_dispatched",
			response: null,
			error: null,
			persistence: { state: "saved" },
			startedAt: new Date(),
			finishedAt: new Date(),
			request: input.request,
			snapshot: {},
			compileTrace: [],
			warnings: [],
			visible: true,
		});
		const { service, calls } = makeService({ history });

		await expect(service.send(profileId, input)).rejects.toMatchObject({ code: "EXECUTION_ID_CONFLICT", statusCode: 409 });
		expect(calls.transport).toHaveLength(0);
	});

	test("a concurrent terminal winner is returned instead of overwriting it", async () => {
		const history = fakeHistory();
		const profileId = nextProfile();
		const input = sendInput();
		let admitted = false;
		const admit = history.admit.bind(history);
		history.admit = async (entry) => {
			admitted = true;
			return admit(entry);
		};
		history.finalize = async () => null;
		history.get = async () =>
			admitted
				? {
						ownerProfileId: profileId,
						executionId: input.executionId,
						fingerprint: "f",
						status: "terminal",
						outcome: "interrupted",
						effectCertainty: "may_have_reached_target",
						response: null,
						error: null,
						persistence: { state: "saved" },
						startedAt: new Date(),
						finishedAt: new Date(),
						compileTrace: [],
						warnings: [],
						visible: true,
					}
				: null;
		const { service } = makeService({ history });

		const result = await service.send(profileId, input);

		expect(result.outcome).toBe("interrupted");
		expect(result.persistence).toEqual({ state: "saved" });
	});

	test("reports unknown persistence when finalization cannot be confirmed", async () => {
		const history = fakeHistory();
		const profileId = nextProfile();
		const input = sendInput();
		let admitted = false;
		const admit = history.admit.bind(history);
		history.admit = async (entry) => {
			admitted = true;
			return admit(entry);
		};
		history.finalize = async () => {
			throw new Error("database down");
		};
		history.get = async (owner, executionId) =>
			admitted
				? {
						ownerProfileId: owner,
						executionId,
						fingerprint: "f",
						status: "running",
						effectCertainty: "may_have_reached_target",
						startedAt: new Date(),
					}
				: null;
		const { service } = makeService({ history });

		const result = await service.send(profileId, input);

		expect(result.outcome).toBe("response");
		expect(result.persistence.state).toBe("unknown");
		expect(result.persistence.warning).toBeTruthy();
	});
});

describe("execution deadline and cancellation coverage", () => {
	test("times out while the target policy is still resolving", async () => {
		const { service, calls } = makeService({
			policy: () => new Promise((resolve) => setTimeout(() => resolve(publicTarget), 300)),
		});

		const started = Date.now();
		const result = await service.send(nextProfile(), sendInput({ request: draft({ settings: { timeoutMs: 100 } }) }));

		expect(Date.now() - started).toBeLessThan(250);
		expect(result.outcome).toBe("timeout");
		expect(result.effectCertainty).toBe("not_dispatched");
		expect(result.error.code).toBe("TIMEOUT");
		expect(calls.transport).toHaveLength(0);
	});

	test("cancels while the target policy is still resolving", async () => {
		const { service, calls } = makeService({
			policy: () => new Promise((resolve) => setTimeout(() => resolve(publicTarget), 500)),
		});
		const profileId = nextProfile();
		const input = sendInput();

		const pending = service.send(profileId, input);
		await new Promise((resolve) => setTimeout(resolve, 30));
		const cancelled = await service.cancel(profileId, input.executionId);
		const result = await pending;

		expect(cancelled.status).toBe("cancelling");
		expect(result.outcome).toBe("cancelled");
		expect(result.effectCertainty).toBe("not_dispatched");
		expect(calls.transport).toHaveLength(0);
	});

	test("cancels an in-flight dispatch and records the cancelled terminal state once", async () => {
		const history = fakeHistory();
		const { service, calls } = makeService({
			history,
			transport: (input) =>
				new Promise((resolve) => {
					input.onDispatch();
					input.signal.addEventListener(
						"abort",
						() =>
							resolve({
								ok: false,
								error: new TransportError("cancelled", "This execution was cancelled."),
								state: { status: 0, statusText: "", httpVersion: "1.1", headers: [] },
								encoded: Buffer.alloc(0),
								encodedBytes: 0,
								truncated: false,
								omittedReason: null,
								bytesSent: 0,
								timing: { totalMs: 1, firstByteMs: null },
							}),
						{ once: true },
					);
				}),
		});
		const profileId = nextProfile();
		const input = sendInput();

		const pending = service.send(profileId, input);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await service.cancel(profileId, input.executionId);
		const result = await pending;

		expect(calls.transport).toHaveLength(1);
		expect(result.outcome).toBe("cancelled");
		expect(result.effectCertainty).toBe("may_have_reached_target");
		expect(history.finalizations).toBe(1);
		const stored = [...history.records.values()][0];
		expect(stored.status).toBe("terminal");
		expect(stored.outcome).toBe("cancelled");
	});

	test("cancellation is observed during the decode phase after a response arrives", async () => {
		const history = fakeHistory();
		const registry = createOperationRegistry();
		const profileId = nextProfile();
		const input = sendInput();
		const service = createExecutionService({
			registry,
			history,
			transport: (transportInput) => {
				transportInput.onDispatch();
				registry.requestCancel(profileId, input.executionId);
				return okTransport();
			},
			policy: { async validate() { return publicTarget; } },
		});

		const result = await service.send(profileId, input);

		expect(result.outcome).toBe("cancelled");
		expect(result.effectCertainty).toBe("may_have_reached_target");
		const stored = [...history.records.values()][0];
		expect(stored.outcome).toBe("cancelled");
	});

	test("releases the execution id after a terminal result so status reports history", async () => {
		const { service, registry } = makeService();
		const profileId = nextProfile();
		const input = sendInput();

		await service.send(profileId, input);

		expect(registry.isActive(profileId, input.executionId)).toBe(false);
		const status = await service.status(profileId, input.executionId);
		expect(status.status).toBe("terminal");
		expect(status.outcome).toBe("response");
	});
});
