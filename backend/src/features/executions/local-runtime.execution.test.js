import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { createLocalRuntimeService } from "../local-runtime/local-runtime.service.js";
import { createOperationRegistry } from "./active-registry.js";
import { createExecutionService } from "./execution.service.js";
import { TransportError } from "./http-transport.js";
import { createTargetPolicy } from "./target-policy.js";
import { pinnedResolver } from "./address-resolver.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase18_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase18-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase18-test-jwt-secret";

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
		name: "Local probe",
		method: "GET",
		urlTemplate: "http://dev.lan:9000/status",
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		settings: { timeoutMs: 5000 },
		...overrides,
	};
}

function applyUpdate(record, update) {
	const next = structuredClone(record);
	for (const [key, value] of Object.entries(update)) {
		if (!key.includes(".")) {
			next[key] = value;
			continue;
		}
		const parts = key.split(".");
		let cursor = next;
		for (const part of parts.slice(0, -1)) {
			if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
			cursor = cursor[part];
		}
		cursor[parts.at(-1)] = value;
	}
	return next;
}

function fakeHistory() {
	const records = new Map();
	const keyOf = (profileId, executionId) => `${profileId}:${executionId}`;
	return {
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
			const next = { ...applyUpdate(record, update), status: "terminal" };
			records.set(key, next);
			return structuredClone(next);
		},
		async reconcileStale() {
			return null;
		},
	};
}

function fakeRepository() {
	const documents = new Map();
	return {
		async findByProfile(ownerProfileId) {
			const document = documents.get(String(ownerProfileId));
			return document ? structuredClone(document) : null;
		},
		async create(input) {
			documents.set(String(input.ownerProfileId), structuredClone(input));
			return structuredClone(input);
		},
		async replace(ownerProfileId, expectedRevision, update) {
			const key = String(ownerProfileId);
			const document = documents.get(key);
			if (!document || document.revision !== expectedRevision) return null;
			const next = { ...document, ...structuredClone(update), revision: expectedRevision + 1 };
			documents.set(key, next);
			return structuredClone(next);
		},
	};
}

function okTransport(overrides = {}) {
	return {
		state: { status: 200, statusText: "OK", httpVersion: "1.1", headers: [{ name: "Content-Type", value: "text/plain" }] },
		encoded: Buffer.from("local ok"),
		encodedBytes: 8,
		truncated: false,
		omittedReason: null,
		bytesSent: 32,
		timing: { totalMs: 3, firstByteMs: 1 },
		...overrides,
		ok: overrides.ok ?? true,
	};
}

function makeHarness({ transport } = {}) {
	const repository = fakeRepository();
	const localRuntime = createLocalRuntimeService({ repository });
	const service = createExecutionService({
		registry: createOperationRegistry(),
		history: fakeHistory(),
		localRuntime,
		policy: createTargetPolicy({ resolver: pinnedResolver([{ address: "192.168.1.20", family: 4 }]) }),
		transport: async (input) => {
			harness.calls.transport.push(input);
			if (transport) return transport(input);
			input.onDispatch?.();
			return okTransport();
		},
	});
	const harness = { service, localRuntime, repository, calls: { transport: [] } };
	return harness;
}

const sendInput = (overrides = {}) => ({
	executionId: randomUUID(),
	tabId: "tab-1",
	draftVersion: 1,
	request: draft(),
	context: {},
	...overrides,
});

async function approve(harness, profileId, hosts, enabled = true) {
	return harness.localRuntime.update(profileId, { expectedRevision: 0, enabled, targets: hosts.map((host) => ({ host })) });
}

describe("local runtime execution gate", () => {
	test("normal mode still blocks localhost and private targets", async () => {
		const harness = makeHarness();
		for (const urlTemplate of ["http://localhost:3000/health", "http://127.0.0.1/", "http://10.0.0.5/", "http://dev.lan:9000/status"]) {
			const result = await harness.service.send(nextProfile(), sendInput({ request: draft({ urlTemplate }) }));
			expect(result.outcome).toBe("validation_error");
			expect(result.error.code).toBe("TARGET_BLOCKED");
			expect(result.effectCertainty).toBe("not_dispatched");
		}
		expect(harness.calls.transport).toHaveLength(0);
	});

	test("localhost becomes reachable only after explicit opt-in", async () => {
		const harness = makeHarness();
		const profileId = nextProfile();
		const before = await harness.service.send(profileId, sendInput({ request: draft({ urlTemplate: "http://localhost:3000/health" }) }));
		expect(before.error.code).toBe("TARGET_BLOCKED");

		await approve(harness, profileId, ["localhost"]);
		const after = await harness.service.send(profileId, sendInput({ request: draft({ urlTemplate: "http://localhost:3000/health" }) }));
		expect(after.outcome).toBe("response");
		expect(after.localAccess).toBe(true);
		expect(harness.calls.transport).toHaveLength(1);
		expect(harness.calls.transport[0].target).toMatchObject({ ip: "192.168.1.20", local: true, originalHostname: "localhost" });
	});

	test("an approved LAN host is dialed through its pinned private address", async () => {
		const harness = makeHarness();
		const profileId = nextProfile();
		await approve(harness, profileId, ["dev.lan"]);
		const result = await harness.service.send(profileId, sendInput());
		expect(result.outcome).toBe("response");
		expect(result.localAccess).toBe(true);
		expect(result.warnings).toContainEqual(
			expect.objectContaining({ code: "LOCAL_RUNTIME", message: "This request used Local Runtime access to dev.lan." }),
		);
		expect(harness.calls.transport[0].target).toMatchObject({ ip: "192.168.1.20", local: true });
	});

	test("an unapproved private target stays blocked while Local Runtime is on", async () => {
		const harness = makeHarness();
		const profileId = nextProfile();
		await approve(harness, profileId, ["dev.lan"]);
		const result = await harness.service.send(profileId, sendInput({ request: draft({ urlTemplate: "http://10.0.0.5/" }) }));
		expect(result.outcome).toBe("validation_error");
		expect(result.error.code).toBe("TARGET_BLOCKED");
		expect(harness.calls.transport).toHaveLength(0);
	});

	test("disabling Local Runtime immediately restores the normal policy", async () => {
		const harness = makeHarness();
		const profileId = nextProfile();
		await approve(harness, profileId, ["dev.lan"]);
		const enabled = await harness.service.send(profileId, sendInput());
		expect(enabled.outcome).toBe("response");

		await harness.localRuntime.update(profileId, { expectedRevision: 1, enabled: false, targets: [{ host: "dev.lan" }] });
		const disabled = await harness.service.send(profileId, sendInput());
		expect(disabled.outcome).toBe("validation_error");
		expect(disabled.error.code).toBe("TARGET_BLOCKED");
		expect(harness.calls.transport).toHaveLength(1);
	});

	test("approved hosts are isolated per profile", async () => {
		const harness = makeHarness();
		const allowed = nextProfile();
		const other = nextProfile();
		await approve(harness, allowed, ["dev.lan"]);
		const result = await harness.service.send(other, sendInput());
		expect(result.outcome).toBe("validation_error");
		expect(result.error.code).toBe("TARGET_BLOCKED");
		expect(harness.calls.transport).toHaveLength(0);
	});

	test("local timeouts and cancellations keep the existing outcome mapping", async () => {
		const harness = makeHarness({
			transport: async (input) => {
				input.onDispatch?.();
				return {
					...okTransport(),
					ok: false,
					error: new TransportError("timeout", "This execution exceeded its time budget."),
					encoded: Buffer.alloc(0),
					encodedBytes: 0,
				};
			},
		});
		const profileId = nextProfile();
		await approve(harness, profileId, ["dev.lan"]);
		const result = await harness.service.send(profileId, sendInput());
		expect(result.outcome).toBe("timeout");
		expect(result.localAccess).toBe(true);
		expect(result.effectCertainty).toBe("may_have_reached_target");
	});

	test("a metadata address can never be approved into execution", async () => {
		const harness = makeHarness();
		const profileId = nextProfile();
		await expect(approve(harness, profileId, ["169.254.169.254"])).rejects.toMatchObject({ code: "LOCAL_HOST_METADATA" });
		const metadataDraft = draft({ urlTemplate: "http://169.254.169.254/latest/meta-data/" });
		const result = await harness.service.send(profileId, sendInput({ request: metadataDraft }));
		expect(result.error.code).toBe("TARGET_BLOCKED");
		expect(harness.calls.transport).toHaveLength(0);
	});
});
