import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { requestDefinitionSchema } from "../../shared/utils/schemas.js";
import {
	CAPSULE_MAX_BYTES,
	buildReproCapsule,
	parseReproCapsule,
	serializeReproCapsule,
} from "./repro-capsule.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase27_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase27-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase27-test-jwt-secret";

beforeAll(() => initConfig());

const SECRET = "capsule-secret-value";

function record(overrides = {}) {
	return {
		executionId: randomUUID(),
		outcome: "response",
		effectCertainty: "may_have_reached_target",
		request: {
			schemaVersion: 1,
			id: randomUUID(),
			folderId: null,
			name: "Create order",
			method: "POST",
			urlTemplate: `https://api.example.test/orders?token=${SECRET}&view=full`,
			query: [
				{ id: randomUUID(), key: "api_key", value: SECRET, enabled: true },
				{ id: randomUUID(), key: "region", value: "west", enabled: true },
			],
			headers: [
				{ id: randomUUID(), key: "Authorization", value: `Bearer ${SECRET}`, enabled: true },
				{ id: randomUUID(), key: "X-Tenant", value: "acme", enabled: true },
			],
			body: { mode: "json", text: JSON.stringify({ password: SECRET, quantity: 2, note: "keep me" }) },
			auth: { mode: "bearer", tokenTemplate: SECRET },
			scripts: { preRequest: "", test: "" },
			assertions: [],
			settings: { timeoutMs: 15000 },
		},
		snapshot: {
			scriptResults: {
				version: 1,
				counts: { passed: 0, failed: 1, error: 0 },
				tests: [{ status: "failed", assertionId: "assert-status", name: "status is 201", expected: "201", actual: "500" }],
			},
		},
		response: {
			status: 500,
			headers: [{ name: "Set-Cookie", value: SECRET }],
			body: { encoding: "utf8", value: `{"token":"${SECRET}"}`, mediaType: "application/json", truncated: false },
		},
		error: null,
		receipt: {
			schemaVersion: 1,
			kind: "tracer.execution-receipt",
			executionId: "receipt-id",
			fingerprint: "receipt-fingerprint",
			outcome: "response",
			effectCertainty: "may_have_reached_target",
			request: { authoredFingerprint: "authored", compiledFingerprint: "compiled" },
			policy: { decision: "allowed", local: false },
			target: { hostname: "api.example.test", address: "203.0.113.4", port: 443 },
			response: { contract: { status: 500, headers: [{ name: "set-cookie", count: 1 }], bodyShape: [] } },
			error: null,
			tests: { failureFingerprint: "failed-tests" },
		},
		...overrides,
	};
}

describe("ReproCapsuleV1", () => {
	test("exports a schema-valid request with credential placeholders and no resolved secrets", () => {
		const capsule = buildReproCapsule(record());
		const serialized = serializeReproCapsule(capsule);

		expect(capsule).toMatchObject({ schemaVersion: 1, kind: "tracer.repro-capsule" });
		expect(requestDefinitionSchema.safeParse(capsule.request).success).toBe(true);
		expect(capsule.request.auth).toEqual({ mode: "bearer", tokenTemplate: "{{capsule_auth_token}}" });
		expect(capsule.request.urlTemplate).toContain("token={{capsule_query_token}}");
		expect(capsule.request.query[0].value).toBe("{{capsule_query_api_key}}");
		expect(capsule.request.headers[0].value).toBe("{{capsule_header_authorization}}");
		expect(JSON.parse(capsule.request.body.text)).toEqual({ note: "keep me", password: "{{capsule_body_password}}", quantity: 2 });
		expect(capsule.requiredInputs.map((item) => item.name)).toEqual([
			"capsule_auth_token",
			"capsule_body_password",
			"capsule_header_authorization",
			"capsule_query_api_key",
			"capsule_query_token",
		]);
		expect(capsule.predicate).toEqual({ type: "assertion", assertionId: "assert-status", failureFingerprint: "failed-tests" });
		expect(serialized).not.toContain(SECRET);
		expect(serialized).not.toContain("Set-Cookie");
		expect(capsule.response).toBeUndefined();
	});

	test("includes only a scrubbed bounded response body when explicitly requested", () => {
		const capsule = buildReproCapsule(record(), { includeResponseBody: true });

		expect(capsule.response.body.value).toBe('{"token":"[REDACTED]"}');
		expect(JSON.stringify(capsule)).not.toContain(SECRET);
		expect(capsule.response.headers).toEqual([{ name: "set-cookie", count: 1 }]);
	});

	test("round trips deterministically and imports to an unsent draft", () => {
		const text = serializeReproCapsule(buildReproCapsule(record()));
		const parsed = parseReproCapsule(text);

		expect(serializeReproCapsule(parsed)).toBe(text);
		expect(parsed.request.name).toBe("Create order");
	});

	test("fails closed on malformed, unsupported, and oversized capsules", () => {
		expect(() => parseReproCapsule("not json")).toThrow();
		expect(() => parseReproCapsule(JSON.stringify({ schemaVersion: 2, kind: "tracer.repro-capsule" }))).toThrow();
		expect(() => parseReproCapsule(`{"schemaVersion":1,"kind":"tracer.repro-capsule","padding":"${"x".repeat(CAPSULE_MAX_BYTES)}"}`)).toThrow();
	});
});
