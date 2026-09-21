import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { createMockService } from "../mocks/mock.service.js";
import { mockTokenFor } from "../mocks/mock-token.js";
import { Example } from "./example.model.js";
import { createExampleService } from "./example.service.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase19_persistence_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase19-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase19-test-jwt-secret";
initConfig();

const ready = await connectTestDatabase();
if (ready) await Example.init();

const profileA = new mongoose.Types.ObjectId();
const profileB = new mongoose.Types.ObjectId();
const TEST_TIMEOUT_MS = 20000;
const mtest = (name, fn) => test(name, fn, TEST_TIMEOUT_MS);

async function expectRejection(promise, expected) {
	let caught = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toMatchObject(expected);
}

function requestDoc(overrides = {}) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name: "List orders",
		method: "GET",
		urlTemplate: "https://api.test/orders",
		query: [{ id: "q1", key: "status", value: "paid", enabled: true }],
		headers: [{ id: "h1", key: "X-Tenant", value: "acme", enabled: true }],
		body: { mode: "none" },
		auth: { mode: "none" },
		settings: { timeoutMs: 15000 },
		...overrides,
	};
}

function manualInput(name, overrides = {}) {
	return {
		mode: "manual",
		name,
		match: { method: "GET", path: "/orders", query: [], headers: [], ...(overrides.match ?? {}) },
		response: {
			status: 200,
			statusText: "OK",
			contentType: "application/json",
			headers: [{ name: "Content-Type", value: "application/json" }],
			body: { encoding: "utf8", value: '{"orders":[]}', mediaType: "application/json" },
			...(overrides.response ?? {}),
		},
	};
}

describe.skipIf(!ready)("example and mock persistence", () => {
	beforeEach(async () => {
		await Example.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } });
	});

	afterAll(async () => {
		await disconnectTestDatabase();
	});

	mtest("isolates examples between profiles in the database", async () => {
		const service = createExampleService();
		const created = await service.createManual(profileA, manualInput("Only mine"));
		expect((await service.list(profileB)).length).toBe(0);
		await expectRejection(service.get(profileB, created._id), { code: "EXAMPLE_NOT_FOUND" });
	});

	mtest("stores binary bodies byte-for-byte and serves them through the mock matcher", async () => {
		const service = createExampleService();
		const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);
		await service.createManual(profileA, manualInput("Binary example", { response: { body: { encoding: "base64", value: bytes.toString("base64"), mediaType: "application/octet-stream" } } }));
		const mocks = createMockService();
		const resolved = await mocks.resolve(profileA, { request: requestDoc() });
		expect(resolved.matched).toBe(true);
		const value = resolved.result.response.body.value;
		expect(Buffer.from(value, "base64")).toEqual(bytes);
		const route = mockTokenFor(profileA);
		const served = await mocks.serve(profileA, route, {
			method: "GET",
			path: "/orders",
			query: [{ key: "status", value: "paid" }],
			headers: [{ key: "x-tenant", value: "acme" }],
		});
		expect(served.example._id).toEqual((await service.list(profileA))[0]._id);
	});

	mtest("rejects a duplicate name through the unique index", async () => {
		const service = createExampleService();
		await service.createManual(profileA, manualInput("Duplicate"));
		await expectRejection(service.createManual(profileA, manualInput("Duplicate")), { code: "EXAMPLE_NAME_CONFLICT" });
	});

	mtest("does not write history or execution documents while saving examples", async () => {
		const ExecutionHistory = mongoose.model("ExecutionHistory");
		const before = await ExecutionHistory.countDocuments({ ownerProfileId: profileA });
		await createExampleService().createManual(profileA, manualInput("No history"));
		const after = await ExecutionHistory.countDocuments({ ownerProfileId: profileA });
		expect(after).toBe(before);
	});

	mtest("keeps examples across a database reconnect", async () => {
		const service = createExampleService();
		const created = await service.createManual(profileA, manualInput("Survives restart"));
		await disconnectTestDatabase();
		expect(await connectTestDatabase()).toBe(true);
		const reloaded = await service.list(profileA);
		expect(reloaded.map((item) => String(item._id))).toContain(String(created._id));
		expect(await service.get(profileA, created._id)).toMatchObject({ name: "Survives restart" });
	});
});
