import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { createOperationRegistry } from "../executions/active-registry.js";
import { createExecutionService } from "../executions/execution.service.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase12_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase12-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase12-test-jwt-secret";

beforeAll(() => {
	initConfig();
});

let profileSeq = 0;
const nextProfile = () => `profile-${(profileSeq += 1)}`;

function assertion(overrides = {}) {
	return {
		id: randomUUID(),
		name: "check",
		enabled: true,
		target: "status",
		operator: "equals",
		path: "",
		expected: "200",
		valueType: "string",
		min: null,
		max: null,
		...overrides,
	};
}

function draft(overrides = {}) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name: "Asserted request",
		method: "GET",
		urlTemplate: "https://example.test/ping",
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		scripts: { preRequest: "", test: "" },
		assertions: [],
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
		state: {
			status: 200,
			statusText: "OK",
			httpVersion: "1.1",
			headers: [
				{ name: "Content-Type", value: "application/json" },
				{ name: "X-Trace", value: "alpha" },
				{ name: "X-Trace", value: "beta" },
			],
		},
		encoded: Buffer.from('{"ok":true,"count":3}'),
		encodedBytes: 19,
		truncated: false,
		omittedReason: null,
		bytesSent: 64,
		timing: { totalMs: 5, firstByteMs: 2 },
		...overrides,
		ok: overrides.ok ?? true,
	};
}

const disabledLocalRuntime = { forExecution: async () => ({ enabled: false, hosts: [] }) };

function makeService({ history = fakeHistory(), transport } = {}) {
	const registry = createOperationRegistry();
	const calls = { transport: [] };
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
			async validate() {
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

describe("execution assertion integration", () => {
	test("assertions run through the execution path and persist in the history snapshot", async () => {
		const { service, history } = makeService();
		const profileId = nextProfile();
		const request = draft({
			assertions: [
				assertion({ name: "status is 200", target: "status", operator: "range", expected: "", min: 200, max: 299 }),
				assertion({ name: "json count", target: "json", operator: "equals", path: "count", valueType: "number", expected: "3" }),
				assertion({ name: "duplicate header", target: "header", operator: "equals", path: "x-trace", expected: "beta" }),
				assertion({ name: "missing", target: "json", operator: "exists", path: "missing.value" }),
			],
		});
		const input = sendInput({ request });

		const result = await service.send(profileId, input);

		expect(result.scriptResults.postResponse.status).toBe("passed");
		expect(result.scriptResults.counts).toEqual({ passed: 3, failed: 1, errors: 0 });
		expect(result.scriptResults.tests.map((entry) => entry.status)).toEqual(["passed", "passed", "passed", "failed"]);
		expect(result.scriptResults.tests[3]).toMatchObject({ kind: "json", path: "missing.value", actual: "<missing>" });
		expect(result.scriptResults.tests[2].actual).toBe("alpha, beta");

		const stored = await history.get(profileId, result.executionId);
		expect(stored.snapshot.scriptResults.tests.map((entry) => entry.status)).toEqual(["passed", "passed", "passed", "failed"]);
	});

	test("keeps assertion results immutable when the draft changes later", async () => {
		const { service, history } = makeService();
		const profileId = nextProfile();
		const first = await service.send(
			profileId,
			sendInput({ request: draft({ assertions: [assertion({ name: "expects 200", expected: "200" })] }) }),
		);
		expect(first.scriptResults.tests[0].status).toBe("passed");

		await service.send(
			profileId,
			sendInput({ request: draft({ assertions: [assertion({ name: "expects 500", expected: "500" })] }) }),
		);
		const stored = await history.get(profileId, first.executionId);

		expect(stored.snapshot.scriptResults.tests[0]).toMatchObject({ name: "expects 200", status: "passed", expected: "200" });
		expect(stored.request.assertions[0].expected).toBe("200");
	});

	test("reports assertion evaluation errors separately from failures", async () => {
		const { service } = makeService({
			transport: async () => okTransport({ encoded: Buffer.from("{not json"), encodedBytes: 9 }),
		});
		const input = sendInput({
			request: draft({
				assertions: [
					assertion({ name: "json path", target: "json", operator: "exists", path: "ok" }),
					assertion({ name: "status", target: "status", operator: "equals", expected: "404" }),
				],
			}),
		});

		const result = await service.send(nextProfile(), input);

		expect(result.scriptResults.tests.map((entry) => entry.status)).toEqual(["error", "failed"]);
		expect(result.scriptResults.counts).toEqual({ passed: 0, failed: 1, errors: 1 });
	});

	test("shares one ordered result model with the Phase 11 test script", async () => {
		const { service } = makeService();
		const input = sendInput({
			request: draft({
				scripts: { preRequest: "", test: 'pm.test("script check", function () { pm.expect(pm.response.code).toBe(200); });' },
				assertions: [assertion({ name: "assertion check", target: "header", operator: "exists", path: "content-type" })],
			}),
		});

		const result = await service.send(nextProfile(), input);

		expect(result.scriptResults.tests.map((entry) => entry.name)).toEqual(["script check", "assertion check"]);
		expect(result.scriptResults.tests[0].assertionId).toBeUndefined();
		expect(result.scriptResults.tests[1].assertionId).toBeTruthy();
	});

	test("runs assertions without any test script and skips when no response exists", async () => {
		const { service } = makeService();
		const sent = await service.send(
			nextProfile(),
			sendInput({ request: draft({ assertions: [assertion({ name: "only assertion" })] }) }),
		);
		expect(sent.scriptResults.postResponse.status).toBe("passed");
		expect(sent.scriptResults.tests).toHaveLength(1);

		const { service: failing } = makeService({
			transport: async () => ({
				ok: false,
				error: { kind: "network_error", message: "The target was unreachable." },
			}),
		});
		const failed = await failing.send(
			nextProfile(),
			sendInput({ request: draft({ assertions: [assertion({ name: "no response" })] }) }),
		);
		expect(failed.scriptResults.postResponse.status).toBe("skipped");
		expect(failed.scriptResults.tests).toEqual([]);
	});

	test("isolates assertion results by profile", async () => {
		const { service } = makeService();
		const owner = nextProfile();
		const sent = await service.send(owner, sendInput({ request: draft({ assertions: [assertion({ name: "mine" })] }) }));

		const ownerView = await service.status(owner, sent.executionId);
		expect(ownerView.scriptResults.tests[0].name).toBe("mine");

		let caught = null;
		try {
			await service.status(nextProfile(), sent.executionId);
		} catch (error) {
			caught = error;
		}
		expect(caught?.statusCode).toBe(404);
	});
});
