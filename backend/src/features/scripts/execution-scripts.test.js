import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { createOperationRegistry } from "../executions/active-registry.js";
import { createExecutionService, terminalResult } from "../executions/execution.service.js";
import { createTargetPolicy } from "../executions/target-policy.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase11_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase11-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase11-test-jwt-secret";

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
		name: "Scripted request",
		method: "GET",
		urlTemplate: "https://example.test/ping",
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		scripts: { preRequest: "", test: "" },
		settings: { timeoutMs: 5000 },
		...overrides,
	};
}

function setPath(target, path, value) {
	const parts = path.split(".");
	let cursor = target;
	for (let index = 0; index < parts.length - 1; index += 1) {
		if (typeof cursor[parts[index]] !== "object" || cursor[parts[index]] === null) cursor[parts[index]] = {};
		cursor = cursor[parts[index]];
	}
	cursor[parts[parts.length - 1]] = value;
}

function applyUpdate(record, update) {
	const next = structuredClone(record);
	for (const [key, value] of Object.entries(update)) {
		if (key.includes(".")) setPath(next, key, value);
		else next[key] = value;
	}
	return next;
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
			records.set(keyOf(entry.ownerProfileId, entry.executionId), structuredClone(entry));
			return structuredClone(entry);
		},
		async finalize(profileId, executionId, update) {
			const key = keyOf(profileId, executionId);
			const record = records.get(key);
			if (!record || record.status !== "running") return null;
			const next = applyUpdate(record, { ...update, status: "terminal" });
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
	pathAndQuery: "/ping",
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

const disabledLocalRuntime = { forExecution: async () => ({ enabled: false, hosts: [] }) };

function makeService({ history = fakeHistory(), transport, policy } = {}) {
	const registry = createOperationRegistry();
	const calls = { transport: [], policy: [] };
	const service = createExecutionService({
		registry,
		history,
		localRuntime: disabledLocalRuntime,
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

const sendInput = (overrides = {}) => ({
	executionId: randomUUID(),
	tabId: "tab-1",
	draftVersion: 1,
	request: draft(),
	context: {},
	...overrides,
});

describe("execution script integration", () => {
	test("pre-request variable writes flow through the compiler into the target", async () => {
		const { service, calls } = makeService();
		const input = sendInput({
			request: draft({
				urlTemplate: "https://{{host}}/ping",
				scripts: { preRequest: 'pm.variables.set("host", "script.test");', test: "" },
			}),
		});

		const result = await service.send(nextProfile(), input);

		expect(calls.policy[0].url).toBe("https://script.test/ping");
		expect(result.outcome).toBe("response");
		expect(result.scriptResults.preRequest.status).toBe("passed");
		expect(result.scriptResults.preRequest.mutations.variables).toEqual([{ op: "set", key: "host" }]);
	});

	test("pre-request header mutations reach the transport and cannot smuggle managed headers", async () => {
		const { service, calls } = makeService();
		const input = sendInput({
			request: draft({
				headers: [{ id: randomUUID(), key: "Accept", value: "application/json", enabled: true }],
				scripts: {
					preRequest: 'pm.request.headers.add("X-Script", "1"); pm.request.headers.add("Host", "evil.test"); pm.request.headers.remove("Accept");',
					test: "",
				},
			}),
		});

		const result = await service.send(nextProfile(), input);

		expect(calls.transport[0].headers).toEqual([{ name: "X-Script", value: "1" }]);
		expect(calls.transport[0].headers.some((header) => header.name.toLowerCase() === "host")).toBe(false);
		expect(result.warnings.map((warning) => warning.code)).toContain("SCRIPT_HEADER_RESERVED");
		expect(result.scriptResults.counts.errors).toBe(0);
	});

	test("post-response tests persist with the history record and surface on status reads", async () => {
		const history = fakeHistory();
		const { service } = makeService({ history });
		const profileId = nextProfile();
		const input = sendInput({
			request: draft({
				scripts: {
					preRequest: "",
					test: 'pm.test("status is 200", function () { pm.expect(pm.response.code).toBe(200); }); pm.test("body", function () { pm.expect(pm.response.json().ok).toBe(true); });',
				},
			}),
		});

		const result = await service.send(profileId, input);

		expect(result.scriptResults.counts).toEqual({ passed: 2, failed: 0, errors: 0 });
		expect(result.scriptResults.postResponse.status).toBe("passed");
		const stored = history.records.get(`${profileId}:${input.executionId}`);
		expect(stored.snapshot.scriptResults.tests).toEqual(result.scriptResults.tests);
		const status = await service.status(profileId, input.executionId);
		expect(status.scriptResults.counts.passed).toBe(2);
	});

	test("test failures and script errors are distinguishable from HTTP failures", async () => {
		const history = fakeHistory();
		const { service, calls } = makeService({ history });
		const profileId = nextProfile();
		const input = sendInput({
			request: draft({
				scripts: {
					preRequest: 'pm.request.headers.add("X-Pre", "1");',
					test: 'pm.test("fails", function () { pm.expect(1).toBe(2); });',
				},
			}),
		});

		const result = await service.send(profileId, input);

		expect(result.outcome).toBe("response");
		expect(result.response.status).toBe(200);
		expect(result.scriptResults.counts).toEqual({ passed: 0, failed: 1, errors: 0 });
		expect(result.scriptResults.tests[0].message).toBe("Expected 2 but received 1.");
		expect(calls.transport).toHaveLength(1);

		const broken = nextProfile();
		const brokenInput = sendInput({
			request: draft({ scripts: { preRequest: "function broken( {", test: "" } }),
		});
		const brokenResult = await service.send(broken, brokenInput);
		expect(brokenResult.outcome).toBe("response");
		expect(brokenResult.scriptResults.counts.errors).toBe(1);
		expect(brokenResult.scriptResults.preRequest.error.code).toBe("SCRIPT_SYNTAX_ERROR");
		expect(brokenResult.warnings.map((warning) => warning.code)).toContain("SCRIPT_SYNTAX_ERROR");
	});

	test("the test script still runs when the target responds with an HTTP error status", async () => {
		const { service } = makeService({
			transport: async (input) => {
				input.onDispatch?.();
				return okTransport({ state: { status: 404, statusText: "Not Found", httpVersion: "1.1", headers: [] }, encoded: Buffer.from("missing") });
			},
		});
		const input = sendInput({
			request: draft({
				scripts: { preRequest: "", test: 'pm.test("not found", function () { pm.expect(pm.response.code).toBe(404); });' },
			}),
		});

		const result = await service.send(nextProfile(), input);
		expect(result.outcome).toBe("response");
		expect(result.scriptResults.counts.passed).toBe(1);
	});

	test("a script cannot bypass target policy by rewriting a variable used in the URL", async () => {
		const registry = createOperationRegistry();
		const calls = { transport: [] };
		const service = createExecutionService({
			registry,
			history: fakeHistory(),
			localRuntime: disabledLocalRuntime,
			transport: async (input) => {
				calls.transport.push(input);
				input.onDispatch?.();
				return okTransport();
			},
			policy: createTargetPolicy(),
		});
		const input = sendInput({
			request: draft({
				urlTemplate: "http://{{target}}/demo/v1/echo",
				scripts: { preRequest: 'pm.variables.set("target", "169.254.169.254");', test: "" },
			}),
		});

		const result = await service.send(nextProfile(), input);

		expect(calls.transport).toHaveLength(0);
		expect(result.outcome).toBe("validation_error");
		expect(result.error.code).toBe("TARGET_BLOCKED");
		expect(result.scriptResults.preRequest.status).toBe("passed");
	});

	test("scripts are isolated between executions while pre-request writes reach the test phase", async () => {
		const { service } = makeService();
		const first = sendInput({
			request: draft({
				scripts: {
					preRequest: 'pm.variables.set("marker", "first");',
					test: 'pm.test("marker visible in tests", function () { pm.expect(pm.variables.get("marker")).toBe("first"); });',
				},
			}),
		});
		const firstResult = await service.send(nextProfile(), first);
		expect(firstResult.scriptResults.counts).toEqual({ passed: 1, failed: 0, errors: 0 });

		const second = sendInput({
			request: draft({
				scripts: { preRequest: "", test: 'pm.test("marker isolated", function () { pm.expect(pm.variables.get("marker")).toBe(undefined); });' },
			}),
		});
		const result = await service.send(nextProfile(), second);
		expect(result.scriptResults.counts).toEqual({ passed: 1, failed: 0, errors: 0 });
	});

	test("terminalResult exposes script results for replay reads", () => {
		const record = { executionId: "exec-1", snapshot: { scriptResults: { counts: { passed: 3, failed: 0, errors: 0 } } } };
		expect(terminalResult(record).scriptResults.counts.passed).toBe(3);
	});
});
