import { describe, expect, test } from "bun:test";
import { projectFromDomain } from "./project-export.js";
import { projectToDomain } from "./project-import.js";
import { serializeProject } from "./project-serialize.js";

const REQUEST_1 = "11111111-1111-4111-8111-111111111111";
const REQUEST_2 = "22222222-2222-4222-8222-222222222222";
const VAR_1 = "55555555-5555-4555-8555-555555555551";
const VAR_2 = "55555555-5555-4555-8555-555555555552";
const VAR_3 = "55555555-5555-4555-8555-555555555553";
const ROW_1 = "44444444-4444-4444-8444-444444444441";
const ROW_2 = "44444444-4444-4444-8444-444444444442";
const ROW_3 = "44444444-4444-4444-8444-444444444443";

const RESOLVED = {
	variable: "resolved-orders-token-CANARY-2f9a",
	apiKey: "resolved-api-key-CANARY-77bd",
	password: "resolved-password-CANARY-c41e",
	sendOnly: "resolved-send-only-CANARY-9d02",
	cookie: "resolved-cookie-CANARY-5b71",
	history: "resolved-history-body-CANARY-b3e8",
};

function collectionDoc(overrides = {}) {
	return {
		_id: "68c0ffee00000000000000a1",
		ownerProfileId: "68c0ffee00000000000000b2",
		name: "Secrets API",
		nameKey: "secrets api",
		description: "",
		revision: 1,
		variables: [
			{ id: VAR_1, key: "orders_token", kind: "secretRef", alias: "local_token", enabled: true },
			{ id: VAR_2, key: "api_key", kind: "secretRef", alias: "local_api_key", enabled: true },
			{ id: VAR_3, key: "password", kind: "secretRef", alias: "local_password", enabled: true },
		],
		auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
		folders: [],
		requests: [
			{
				schemaVersion: 1,
				id: REQUEST_1,
				folderId: null,
				name: "Replay with references",
				method: "GET",
				urlTemplate: "https://api.test/orders",
				query: [{ id: ROW_1, key: "api_key", value: "{{api_key}}", enabled: true }],
				headers: [
					{ id: ROW_2, key: "Authorization", value: "Bearer {{orders_token}}", enabled: true },
					{ id: ROW_3, key: "X-Api-Key", value: "{{api_key}}", enabled: true },
				],
				body: { mode: "none" },
				auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
				scripts: { preRequest: "", test: "" },
				settings: { timeoutMs: 15000 },
			},
			{
				schemaVersion: 1,
				id: REQUEST_2,
				folderId: null,
				name: "Send password reference",
				method: "POST",
				urlTemplate: "https://api.test/session",
				query: [],
				headers: [],
				body: { mode: "json", text: '{"password":"{{password}}"}' },
				auth: { mode: "basic", usernameTemplate: "{{api_key}}", passwordTemplate: "{{password}}" },
				scripts: { preRequest: "", test: "" },
				settings: { timeoutMs: 15000 },
			},
		],
		...overrides,
	};
}

function executionState() {
	return {
		authOverride: { mode: "bearer", tokenTemplate: RESOLVED.sendOnly },
		resolvedVariables: { orders_token: RESOLVED.variable, api_key: RESOLVED.apiKey, password: RESOLVED.password },
		cookies: [{ name: "session", value: RESOLVED.cookie, domain: "api.test", path: "/" }],
		history: [{ executionId: REQUEST_1, snapshot: { response: { body: RESOLVED.history } } }],
	};
}

function caught(operation) {
	try {
		operation();
	} catch (error) {
		return error;
	}
	throw new Error("expected the operation to throw");
}

describe("resolved secrets never reach the portable file", () => {
	test("ignores execution state passed alongside the domain model", () => {
		const text = serializeProject(projectFromDomain({ collections: [collectionDoc()], ...executionState() }));
		for (const value of Object.values(RESOLVED)) expect(text).not.toContain(value);
		expect(text).not.toContain("authOverride");
		expect(text).not.toContain("resolvedVariables");
		expect(text).not.toContain("cookies");
		expect(text).not.toContain("history");
	});

	test("keeps templates and aliases so behavior can be reconstructed", () => {
		const text = serializeProject(projectFromDomain({ collections: [collectionDoc()], ...executionState() }));
		expect(text).toContain("{{orders_token}}");
		expect(text).toContain("{{api_key}}");
		expect(text).toContain("{{password}}");
		expect(text).toContain("local_token");
		expect(text).toContain("local_api_key");
		expect(text).toContain("local_password");
	});

	test("applying a portable file still yields references, not values", () => {
		const applied = projectToDomain(serializeProject(projectFromDomain({ collections: [collectionDoc()], ...executionState() })));
		const serializedDomain = JSON.stringify(applied.collections);
		expect(serializedDomain).toContain("{{orders_token}}");
		expect(serializedDomain).toContain("local_token");
		for (const value of Object.values(RESOLVED)) expect(serializedDomain).not.toContain(value);
	});
});

describe("export fails closed on unsafe domain documents", () => {
	test("rejects a secret reference that carries a value", () => {
		const doc = collectionDoc({
			variables: [{ id: VAR_1, key: "orders_token", kind: "secretRef", alias: "local_token", value: RESOLVED.variable, enabled: true }],
		});
		const error = caught(() => projectFromDomain({ collections: [doc] }));
		expect(error.code).toBe("PROJECT_SECRET_UNSAFE");
		expect(error.statusCode).toBe(422);
		expect(JSON.stringify(error.details)).not.toContain(RESOLVED.variable);
		expect(error.message).not.toContain(RESOLVED.variable);
	});

	test("rejects a secret reference without an alias", () => {
		const doc = collectionDoc({ variables: [{ id: VAR_1, key: "orders_token", kind: "secretRef", enabled: true }] });
		expect(caught(() => projectFromDomain({ collections: [doc] })).code).toBe("PROJECT_SECRET_UNSAFE");
	});

	test("rejects literal collection credentials", () => {
		const doc = collectionDoc({ auth: { mode: "apiKey", key: "X-Api-Key", valueTemplate: RESOLVED.apiKey, in: "header" } });
		const error = caught(() => projectFromDomain({ collections: [doc] }));
		expect(error.code).toBe("PROJECT_SECRET_UNSAFE");
		expect(error.message).not.toContain(RESOLVED.apiKey);
	});

	test("rejects literal request credentials", () => {
		const [request] = collectionDoc().requests;
		const doc = collectionDoc({ requests: [{ ...request, auth: { mode: "bearer", tokenTemplate: RESOLVED.variable } }] });
		const error = caught(() => projectFromDomain({ collections: [doc] }));
		expect(error.code).toBe("PROJECT_SECRET_UNSAFE");
		expect(JSON.stringify(error)).not.toContain(RESOLVED.variable);
	});

	test("rejects credential-bearing example match rules", () => {
		const example = {
			name: "Leaky example",
			source: { type: "response", requestId: REQUEST_1, collectionId: "68c0ffee00000000000000a1", executionId: REQUEST_2, requestName: "Replay" },
			match: { method: "GET", path: "/orders", query: [], headers: [{ key: "Authorization", value: "Bearer {{orders_token}}" }] },
			response: { status: 200, statusText: "OK", contentType: "", headers: [], body: { encoding: "utf8", value: "" } },
		};
		const error = caught(() => projectFromDomain({ collections: [collectionDoc()], examples: [example] }));
		expect(error.code).toBe("PROJECT_SECRET_UNSAFE");
		expect(error.message).not.toContain("Bearer");
	});

	test("rejects literal environment secret references", () => {
		const environment = {
			name: "Local",
			variables: [{ id: VAR_1, key: "orders_token", kind: "secretRef", alias: "local_token", value: RESOLVED.variable, enabled: true }],
		};
		expect(caught(() => projectFromDomain({ collections: [collectionDoc()], environments: [environment] })).code).toBe("PROJECT_SECRET_UNSAFE");
	});
});

describe("import fails closed on unsafe portable files", () => {
	test("rejects literal credentials without echoing the value", () => {
		const text = `{"schemaVersion":1,"kind":"tracer.project","description":"","collections":[{"name":"Unsafe","description":"","variables":[],"auth":{"mode":"none"},"folders":[],"requests":[{"schemaVersion":1,"id":"${REQUEST_1}","folderId":null,"name":"Unsafe request","method":"GET","urlTemplate":"https://api.test","query":[],"headers":[],"body":{"mode":"none"},"auth":{"mode":"bearer","tokenTemplate":"${RESOLVED.variable}"},"scripts":{"preRequest":"","test":""},"settings":{"timeoutMs":15000}}]}]}`;
		const error = caught(() => projectToDomain(text));
		expect(error.code).toBe("PROJECT_INVALID");
		expect(error.message).not.toContain(RESOLVED.variable);
		expect(JSON.stringify(error.details)).not.toContain(RESOLVED.variable);
	});

	test("rejects a secret reference carrying a value", () => {
		const text = `{"schemaVersion":1,"kind":"tracer.project","description":"","collections":[{"name":"Unsafe","description":"","variables":[{"id":"${VAR_1}","key":"orders_token","kind":"secretRef","alias":"local_token","value":"${RESOLVED.variable}","enabled":true}],"auth":{"mode":"none"},"folders":[],"requests":[]}]}`;
		expect(caught(() => projectToDomain(text)).code).toBe("PROJECT_INVALID");
	});
});
