import { describe, expect, test } from "bun:test";
import { buildExecutionReceipt } from "./execution-receipt.js";
import { compareReceipts } from "./run-comparison.js";
import { buildReproCapsule, serializeReproCapsule } from "./repro-capsule.js";

// Phase 28 acceptance matrix: every change class the Flight Recorder claims to
// handle must produce comparison evidence, and no comparison artifact may carry
// a resolved secret.

const SECRET_TOKEN = "fr-secret-token-9f3a7c2b";
const STAGING_TOKEN = "fr-staging-token-1d4e8a6c";

function request(overrides = {}) {
	return {
		schemaVersion: 1,
		id: "11111111-1111-4111-8111-111111111111",
		folderId: null,
		name: "List orders",
		method: "GET",
		urlTemplate: "{{base_url}}/orders",
		query: [{ id: "22222222-2222-4222-8222-222222222222", key: "status", value: "paid", enabled: true }],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
		scripts: { preRequest: "", test: "" },
		assertions: [],
		settings: { timeoutMs: 15000 },
		...overrides,
	};
}

function compiled(overrides = {}) {
	return {
		method: "GET",
		url: "http://127.0.0.1:8000/demo/v1/local/orders?status=paid",
		executedUrl: "http://127.0.0.1:8000/demo/v1/local/orders?status=paid",
		headers: [
			{ name: "Authorization", value: `Bearer ${SECRET_TOKEN}` },
			{ name: "Accept", value: "application/json" },
		],
		body: null,
		authMode: "bearer",
		authSource: "request",
		trace: [{ field: "url", variable: "base_url", scope: "environment" }],
		redaction: { queryKeys: [], values: [SECRET_TOKEN] },
		...overrides,
	};
}

function target(overrides = {}) {
	return {
		scheme: "http",
		originalHostname: "127.0.0.1",
		port: 8000,
		ip: "127.0.0.1",
		family: 4,
		policyVersion: "1.0",
		local: true,
		...overrides,
	};
}

function response(overrides = {}) {
	return {
		status: 200,
		headers: [
			{ name: "content-type", value: "application/json" },
			{ name: "x-request-id", value: "a" },
			{ name: "x-request-id", value: "b" },
		],
		body: { encoding: "utf8", value: '{"items":[],"total":0}', truncated: false, mediaType: "application/json" },
		timing: { totalMs: 40, firstByteMs: 10 },
		size: { receivedBodyBytes: 20, capturedBodyBytes: 20 },
		httpVersion: "1.1",
		...overrides,
	};
}

function receiptFor(input = {}) {
	return buildExecutionReceipt({
		executionId: input.executionId ?? "33333333-3333-4333-8333-333333333333",
		fingerprint: "fingerprint",
		startedAt: new Date("2026-09-22T06:00:00Z"),
		finishedAt: new Date("2026-09-22T06:00:01Z"),
		outcome: input.outcome ?? "response",
		effectCertainty: input.effectCertainty ?? "may_have_reached_target",
		request: request(input.request),
		compiled: compiled(input.compiled),
		source: input.source ?? { type: "collection", collectionId: "aaaaaaaaaaaaaaaaaaaaaaaa", collectionRevision: 1, requestId: null },
		environment: input.environment ?? { environmentId: "bbbbbbbbbbbbbbbbbbbbbbbb", environmentRevision: 1 },
		target: input.target === null ? null : target(input.target ?? {}),
		response: input.response === null ? null : response(input.response ?? {}),
		error: input.error ?? null,
		scriptResults: input.scriptResults ?? null,
		warnings: input.warnings ?? [],
	});
}

function categoriesOf(comparison) {
	return [...new Set(comparison.changes.map((change) => change.category))];
}

describe("Phase 28 comparison coverage", () => {
	test("a request edit produces request evidence", () => {
		const comparison = compareReceipts(receiptFor({}), receiptFor({ request: request({ name: "Renamed" }) }));
		expect(comparison.changes.map((change) => change.path)).toContain("request.authoredFingerprint");
	});

	test("an environment change produces source evidence and leads the divergence", () => {
		const comparison = compareReceipts(receiptFor({}), receiptFor({ environment: { environmentId: "bbbbbbbbbbbbbbbbbbbbbbbb", environmentRevision: 2 } }));
		expect(comparison.firstDivergence?.path).toBe("source.environmentRevision");
	});

	test("an authentication change produces auth evidence", () => {
		const comparison = compareReceipts(
			receiptFor({}),
			receiptFor({ compiled: compiled({ authMode: "apiKey", authSource: "collection" }) }),
		);
		expect(categoriesOf(comparison)).toContain("auth");
		expect(comparison.changes.map((change) => change.path)).toContain("request.auth");
	});

	test("a script change produces request and test evidence", () => {
		const comparison = compareReceipts(
			receiptFor({}),
			receiptFor({
				request: request({ scripts: { preRequest: "", test: "pm.test('extra', () => {});" } }),
				scriptResults: { counts: { passed: 1, failed: 0, error: 0 }, tests: [{ status: "passed" }] },
			}),
		);
		expect(comparison.changes.map((change) => change.path)).toEqual(
			expect.arrayContaining(["request.authoredFingerprint", "tests.counts"]),
		);
		expect(categoriesOf(comparison)).toContain("tests");
	});

	test("a cookie change produces compiled request evidence", () => {
		const comparison = compareReceipts(
			receiptFor({}),
			receiptFor({
				compiled: compiled({
					headers: [
						{ name: "Authorization", value: `Bearer ${SECRET_TOKEN}` },
						{ name: "Accept", value: "application/json" },
						{ name: "Cookie", value: `session=${SECRET_TOKEN}` },
					],
				}),
			}),
		);
		expect(comparison.changes.map((change) => change.path)).toContain("request.compiledFingerprint");
	});

	test("a DNS destination change produces target evidence", () => {
		const comparison = compareReceipts(receiptFor({}), receiptFor({ target: target({ ip: "127.0.0.2" }) }));
		expect(comparison.changes.map((change) => change.path)).toContain("target.address");
	});

	test("a policy change produces policy evidence", () => {
		const comparison = compareReceipts(
			receiptFor({}),
			receiptFor({ outcome: "blocked", target: null, response: null, effectCertainty: "not_dispatched" }),
		);
		expect(comparison.changes.map((change) => change.path)).toContain("policy.decision");
	});

	test("a response change produces response and contract evidence", () => {
		const comparison = compareReceipts(
			receiptFor({}),
			receiptFor({
				response: response({
					status: 401,
					headers: [{ name: "content-type", value: "application/json" }],
					body: { encoding: "utf8", value: '{"error":"TARGET_AUTH_INVALID"}', truncated: false, mediaType: "application/json" },
				}),
			}),
		);
		expect(categoriesOf(comparison)).toContain("response");
		expect(comparison.contract.breaking).toBe(true);
		expect(comparison.contract.changes.map((change) => change.kind)).toEqual(
			expect.arrayContaining(["status_changed", "header_removed", "body_path_removed"]),
		);
	});

	test("comparisons never carry resolved secrets", () => {
		const before = receiptFor({});
		const after = receiptFor({
			compiled: compiled({ authMode: "apiKey", authSource: "collection" }),
			environment: { environmentId: "bbbbbbbbbbbbbbbbbbbbbbbb", environmentRevision: 2 },
		});
		const comparison = compareReceipts(before, after);
		const serialized = JSON.stringify(comparison);
		expect(serialized).not.toContain(SECRET_TOKEN);
		expect(serialized).not.toContain(STAGING_TOKEN);
		const capsuleText = serializeReproCapsule(
			buildReproCapsule({
				request: request(),
				receipt: before,
				response: { status: 200, body: { encoding: "utf8", value: `{"token":"${SECRET_TOKEN}"}`, truncated: false, mediaType: "application/json" } },
			}),
		);
		expect(capsuleText).not.toContain(SECRET_TOKEN);
	});
});
