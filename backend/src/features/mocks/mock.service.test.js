import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { createMockService } from "./mock.service.js";
import { mockBasePath, mockTokenFor, verifyMockToken } from "./mock-token.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase19_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase19-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase19-test-jwt-secret";

beforeAll(() => {
	initConfig();
});

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

function exampleDoc(overrides = {}) {
	return {
		_id: overrides._id ?? "e1",
		ownerProfileId: overrides.ownerProfileId ?? "profile-a",
		name: overrides.name ?? "Example",
		createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
		match: { method: "GET", path: "/orders", query: [], headers: [], ...(overrides.match ?? {}) },
		response: {
			status: 200,
			statusText: "OK",
			contentType: "application/json",
			headers: [{ name: "Content-Type", value: "application/json" }],
			body: { encoding: "utf8", value: '{"orders":[]}', mediaType: "application/json" },
			...overrides.response,
		},
	};
}

function createHarness(examples = []) {
	const queries = [];
	return {
		queries,
		service: createMockService({
			examples: {
				async findMatchable(profileId, method, examplePath) {
					queries.push({ profileId, method, path: examplePath });
					return examples.filter(
						(item) =>
							String(item.ownerProfileId) === String(profileId) &&
							item.match.method === method &&
							item.match.path === examplePath,
					);
				},
				async count(profileId) {
					return examples.filter((item) => String(item.ownerProfileId) === String(profileId)).length;
				},
			},
			environments: { findById: async () => null },
		}),
	};
}

describe("mock execution", () => {
	test("resolves a matching example into a result that never left the process", async () => {
		const harness = createHarness([exampleDoc()]);
		const resolved = await harness.service.resolve("profile-a", { request: requestDoc() });
		expect(resolved.matched).toBe(true);
		expect(resolved.example.name).toBe("Example");
		expect(resolved.result).toMatchObject({
			outcome: "mock",
			effectCertainty: "not_dispatched",
			persistence: { state: "not_persisted" },
			response: { status: 200, statusText: "OK", timing: { totalMs: 0, firstByteMs: 0 }, httpVersion: null },
			mock: { matched: true, exampleName: "Example" },
		});
		expect(resolved.result.response.body).toMatchObject({ encoding: "utf8", value: '{"orders":[]}' });
		expect(resolved.result.response.headers).toEqual([{ name: "Content-Type", value: "application/json" }]);
		expect(resolved.result.historyId).toBeNull();
	});

	test("returns a clear mock miss without a response body", async () => {
		const harness = createHarness([exampleDoc()]);
		const resolved = await harness.service.resolve("profile-a", { request: requestDoc({ urlTemplate: "https://api.test/nothing" }) });
		expect(resolved.matched).toBe(false);
		expect(resolved.example).toBeNull();
		expect(resolved.result).toMatchObject({
			outcome: "mock_miss",
			effectCertainty: "not_dispatched",
			response: null,
			error: { code: "MOCK_MISS" },
		});
		expect(resolved.result.error.message).toContain("No saved example matches GET /nothing");
	});

	test("applies the same deterministic priority as the matcher", async () => {
		const generic = exampleDoc({ _id: "generic", createdAt: new Date("2026-01-01T00:00:00Z"), response: { status: 200, body: { encoding: "utf8", value: "generic", mediaType: "" } } });
		const specific = exampleDoc({
			_id: "specific",
			createdAt: new Date("2026-02-01T00:00:00Z"),
			match: { query: [{ key: "status", value: "paid" }] },
			response: { status: 418, body: { encoding: "utf8", value: "specific", mediaType: "" } },
		});
		const harness = createHarness([generic, specific]);
		const resolved = await harness.service.resolve("profile-a", { request: requestDoc() });
		expect(resolved.example._id).toBe("specific");
		expect(resolved.result.response.status).toBe(418);
	});

	test("never serves another profile's examples", async () => {
		const harness = createHarness([exampleDoc({ ownerProfileId: "profile-b" })]);
		const resolved = await harness.service.resolve("profile-a", { request: requestDoc() });
		expect(resolved.matched).toBe(false);
		expect(resolved.considered).toBe(0);
		expect(harness.queries[0].profileId).toBe("profile-a");
	});

	test("serves mock routes only for a valid capability token", async () => {
		const harness = createHarness([exampleDoc()]);
		const token = mockTokenFor("profile-a");
		expect(verifyMockToken("profile-a", token)).toBe(true);
		expect(verifyMockToken("profile-a", `${token}x`)).toBe(false);
		expect(mockBasePath("profile-a")).toBe(`/api/v1/mocks/profile-a/${token}`);
		const served = await harness.service.serve("profile-a", token, {
			method: "GET",
			path: "/orders",
			query: [{ key: "status", value: "paid" }],
			headers: [{ key: "x-tenant", value: "acme" }],
		});
		expect(served.example.name).toBe("Example");
		let caught = null;
		try {
			await harness.service.serve("profile-a", "wrong-token", { method: "GET", path: "/orders" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ statusCode: 404, code: "MOCK_ROUTE_NOT_FOUND" });
		caught = null;
		try {
			await harness.service.serve("profile-a", token, { method: "GET", path: "/missing" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ statusCode: 404, code: "MOCK_MISS" });
	});

	test("never dispatches network traffic and never imports the execution transport", async () => {
		const liveFetch = globalThis.fetch;
		let networkCalls = 0;
		globalThis.fetch = () => {
			networkCalls += 1;
			throw new Error("mock execution must not touch the network");
		};
		try {
			const harness = createHarness([exampleDoc()]);
			await harness.service.resolve("profile-a", { request: requestDoc() });
			await harness.service.resolve("profile-a", { request: requestDoc({ urlTemplate: "https://api.test/missing" }) });
		} finally {
			globalThis.fetch = liveFetch;
		}
		expect(networkCalls).toBe(0);
		const directory = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
		for (const file of ["mock.service.js", "match-target.js", "mock-matcher.js", "mock-token.js", "mock.controller.js", "mock.routes.js"]) {
			const source = readFileSync(path.join(directory, file), "utf8");
			expect(source.includes("http-transport")).toBe(false);
			expect(source.includes("performRequest")).toBe(false);
			expect(/\bfetch\(/.test(source)).toBe(false);
		}
	});

	test("keeps the real execution pipeline untouched by mock routing", async () => {
		const executionRoutes = readFileSync(
			path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "executions", "execution.routes.js"),
			"utf8",
		);
		expect(executionRoutes).toContain("sendExecution");
		expect(executionRoutes.includes("mock")).toBe(false);
	});
});
