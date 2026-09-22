import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { buildExecutionReceipt } from "./execution-receipt.js";

const SECRET = "flight-recorder-secret";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase27_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase27-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase27-test-jwt-secret";

beforeAll(() => {
	initConfig();
});

function input(overrides = {}) {
	return {
		executionId: "11111111-1111-4111-8111-111111111111",
		fingerprint: "admission-fingerprint",
		fingerprintKeyId: "test-key",
		startedAt: new Date("2026-09-22T10:00:00.000Z"),
		finishedAt: new Date("2026-09-22T10:00:00.125Z"),
		outcome: "response",
		effectCertainty: "may_have_reached_target",
		request: {
			schemaVersion: 1,
			id: "22222222-2222-4222-8222-222222222222",
			name: "Create order",
			method: "POST",
			urlTemplate: "https://api.example.test/orders?token={{token}}",
			query: [{ id: "33333333-3333-4333-8333-333333333333", key: "trace", value: "{{trace_id}}", enabled: true }],
			headers: [{ id: "44444444-4444-4444-8444-444444444444", key: "Authorization", value: SECRET, enabled: true }],
			body: { mode: "json", text: JSON.stringify({ password: SECRET, item: { id: 7 }, tags: ["one"] }) },
			auth: { mode: "bearer", tokenTemplate: "{{token}}" },
			scripts: { preRequest: "", test: "" },
			assertions: [],
			settings: { timeoutMs: 15000 },
		},
		source: {
			type: "collection",
			collectionId: "aaaaaaaaaaaaaaaaaaaaaaaa",
			collectionRevision: 4,
			requestId: "22222222-2222-4222-8222-222222222222",
		},
		environment: { environmentId: "bbbbbbbbbbbbbbbbbbbbbbbb", environmentRevision: 3, name: "QA" },
		compiled: {
			method: "POST",
			url: `https://api.example.test/orders?token=${SECRET}&trace=abc`,
			executedUrl: "https://api.example.test/orders?token=%5BREDACTED%5D&trace=abc",
			headers: [
				{ name: "Authorization", value: SECRET },
				{ name: "Content-Type", value: "application/json" },
			],
			body: Buffer.from(JSON.stringify({ password: SECRET, item: { id: 7 }, tags: ["one"] })),
			authMode: "bearer",
			authSource: "request",
			authTemplate: { mode: "bearer", tokenTemplate: "{{token}}" },
			trace: [
				{ field: "auth.tokenTemplate", variable: "token", scope: "environment" },
				{ field: "query.value", variable: "trace_id", scope: "collection" },
			],
			redaction: { values: [SECRET], headerNames: ["authorization"], queryKeys: ["token"] },
		},
		target: {
			scheme: "https",
			originalHostname: "api.example.test",
			authority: "api.example.test",
			port: 443,
			ip: "203.0.113.42",
			family: 4,
			policyVersion: "1.0",
			local: false,
		},
		response: {
			status: 201,
			statusText: "Created",
			httpVersion: "1.1",
			headers: [
				{ name: "Content-Type", value: "application/json" },
				{ name: "Set-Cookie", value: SECRET },
			],
			body: {
				encoding: "utf8",
				value: JSON.stringify({ order: { id: 7, token: SECRET }, tags: ["one"] }),
				mediaType: "application/json",
				truncated: false,
				omittedReason: null,
			},
			timing: { totalMs: 125, firstByteMs: 80 },
			size: { receivedBodyBytes: 80, decodedBodyBytes: 80, capturedBodyBytes: 80, persistedBodyBytes: 80 },
		},
		error: null,
		scriptResults: { version: 1, counts: { passed: 1, failed: 0, error: 0 }, tests: [] },
		warnings: [],
		...overrides,
	};
}

describe("ExecutionReceiptV1", () => {
	test("records deterministic request, source, policy, transport, and contract evidence", () => {
		const receipt = buildExecutionReceipt(input());

		expect(receipt.schemaVersion).toBe(1);
		expect(receipt.kind).toBe("tracer.execution-receipt");
		expect(receipt.executionId).toBe("11111111-1111-4111-8111-111111111111");
		expect(receipt.request.method).toBe("POST");
		expect(receipt.request.headerNames).toEqual(["authorization", "content-type"]);
		expect(receipt.request.queryKeys).toEqual(["token", "trace"]);
		expect(receipt.request.auth).toEqual({ mode: "bearer", source: "request", referenceKeys: ["token"] });
		expect(receipt.request.variableSources).toEqual([
			{ field: "auth.tokenTemplate", key: "token", scope: "environment" },
			{ field: "query.value", key: "trace_id", scope: "collection" },
		]);
		expect(receipt.source.collectionRevision).toBe(4);
		expect(receipt.source.environmentRevision).toBe(3);
		expect(receipt.policy).toEqual({ decision: "allowed", version: "1.0", local: false });
		expect(receipt.target).toEqual({ scheme: "https", hostname: "api.example.test", port: 443, address: "203.0.113.42", family: 4 });
		expect(receipt.response.contract.status).toBe(201);
		expect(receipt.response.contract.headers).toEqual([
			{ name: "content-type", count: 1 },
			{ name: "set-cookie", count: 1 },
		]);
		expect(receipt.response.contract.bodyShape).toContainEqual({ path: "$.order.id", type: "number" });
		expect(receipt.response.contract.bodyShape).toContainEqual({ path: "$.tags[]", type: "string" });
		expect(receipt.transport.durationMs).toBe(125);
		expect(receipt.request.authoredFingerprint).toHaveLength(64);
		expect(receipt.request.compiledFingerprint).toHaveLength(64);
		expect(receipt.response.bodyFingerprint).toHaveLength(64);
	});

	test("never serializes resolved secret values", () => {
		const base = input();
		const receipt = buildExecutionReceipt(
			input({
				request: { ...base.request, urlTemplate: `https://api.example.test/orders?password=${SECRET}` },
				error: { code: "UPSTREAM", message: `Target rejected ${SECRET}` },
			}),
		);
		const serialized = JSON.stringify(receipt);

		expect(serialized).not.toContain(SECRET);
		expect(receipt.request.displayUrl).toBe("https://api.example.test/orders?password=[REDACTED]");
		expect(serialized).not.toContain("Set-Cookie");
	});

	test("produces a bounded receipt for a pre-dispatch failure", () => {
		const receipt = buildExecutionReceipt(
			input({
				outcome: "validation_error",
				effectCertainty: "not_dispatched",
				compiled: null,
				target: null,
				response: null,
				error: { code: "VARIABLE_MISSING", message: "A required variable is missing.", details: { variables: ["token"] } },
			}),
		);

		expect(receipt.policy.decision).toBe("not_evaluated");
		expect(receipt.target).toBeNull();
		expect(receipt.response).toBeNull();
		expect(receipt.error).toEqual({ code: "VARIABLE_MISSING" });
	});
});
