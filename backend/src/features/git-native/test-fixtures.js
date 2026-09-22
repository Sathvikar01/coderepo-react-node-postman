// Shared domain fixtures for git-native tests. Not a test file (no .test.js).

export const REQUEST_1 = "11111111-1111-4111-8111-111111111111";
export const REQUEST_2 = "22222222-2222-4222-8222-222222222222";
export const FOLDER_1 = "33333333-3333-4333-8333-333333333333";
const Q_1 = "44444444-4444-4444-8444-444444444441";
const Q_2 = "44444444-4444-4444-8444-444444444442";
const Q_3 = "44444444-4444-4444-8444-444444444443";
const H_1 = "44444444-4444-4444-8444-444444444451";
const H_2 = "44444444-4444-4444-8444-444444444452";
const H_3 = "44444444-4444-4444-8444-444444444453";
const H_4 = "44444444-4444-4444-8444-444444444454";
const VAR_PLAIN = "55555555-5555-4555-8555-555555555551";
const VAR_SECRET = "55555555-5555-4555-8555-555555555552";
const ENV_VAR = "66666666-6666-4666-8666-666666666661";
export const ASSERT_1 = "99999999-9999-4999-8999-999999999991";

export const PRE_REQUEST = "tracer.variables.set('tenant', 'acme');";
export const TEST_SCRIPT = "tracer.test('status is 200', () => tracer.expect(tracer.response.status).toBe(200));";

export const RESOLVED = {
	variable: "resolved-orders-token-CANARY-2f9a",
	apiKey: "resolved-api-key-CANARY-77bd",
	password: "resolved-password-CANARY-c41e",
	sendOnly: "resolved-send-only-CANARY-9d02",
	cookie: "resolved-cookie-CANARY-5b71",
	history: "resolved-history-body-CANARY-b3e8",
};

export const ASSERTIONS = [
	{
		id: ASSERT_1,
		name: "status is 200",
		enabled: true,
		target: "status",
		operator: "equals",
		path: "",
		expected: "200",
		valueType: "string",
		min: null,
		max: null,
	},
];

export function collectionDoc(overrides = {}) {
	return {
		_id: "68c0ffee00000000000000a1",
		ownerProfileId: "68c0ffee00000000000000b2",
		name: "Orders API",
		nameKey: "orders api",
		description: "Order management",
		revision: 7,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-02T00:00:00.000Z",
		variables: [
			{ id: VAR_PLAIN, key: "baseUrl", kind: "plain", value: "https://api.test", enabled: true },
			{ id: VAR_SECRET, key: "orders_token", kind: "secretRef", alias: "local_token", enabled: true },
		],
		auth: { mode: "none" },
		folders: [{ id: FOLDER_1, name: "Read" }],
		requests: [
			{
				schemaVersion: 1,
				id: REQUEST_1,
				folderId: FOLDER_1,
				name: "List orders",
				method: "GET",
				urlTemplate: "{{baseUrl}}/orders",
				query: [
					{ id: Q_1, key: "status", value: "{{status}}", enabled: true },
					{ id: Q_2, key: "status", value: "{{fallback}}", enabled: true },
					{ id: Q_3, key: "page", value: "1", enabled: false },
				],
				headers: [
					{ id: H_1, key: "Accept", value: "application/json", enabled: true },
					{ id: H_2, key: "Accept", value: "text/plain", enabled: false },
					{ id: H_3, key: "X-Tenant", value: "{{tenant}}", enabled: true },
				],
				body: { mode: "none" },
				auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
				scripts: { preRequest: PRE_REQUEST, test: TEST_SCRIPT },
				settings: { timeoutMs: 15000 },
				assertions: ASSERTIONS,
			},
			{
				schemaVersion: 1,
				id: REQUEST_2,
				folderId: null,
				name: "Create order",
				method: "POST",
				urlTemplate: "{{baseUrl}}/orders",
				query: [],
				headers: [{ id: H_4, key: "Content-Type", value: "application/json", enabled: true }],
				body: { mode: "json", text: '{"sku":"{{sku}}","note":"日本語 🚀"}' },
				auth: { mode: "inherit" },
				scripts: { preRequest: "", test: "" },
				settings: { timeoutMs: 30000 },
			},
		],
		...overrides,
	};
}

export function environmentDoc(overrides = {}) {
	return {
		_id: "68c0ffee00000000000000e1",
		ownerProfileId: "68c0ffee00000000000000b2",
		name: "Local",
		nameKey: "local",
		revision: 3,
		variables: [{ id: ENV_VAR, key: "host", kind: "plain", value: "127.0.0.1:8000", enabled: true }],
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		...overrides,
	};
}

export function exampleDoc(overrides = {}) {
	return {
		_id: "68c0ffee00000000000000f1",
		ownerProfileId: "68c0ffee00000000000000b2",
		name: "List orders example",
		nameKey: "list orders example",
		source: {
			type: "response",
			executionId: "99999999-9999-4999-8999-999999999999",
			requestId: REQUEST_1,
			collectionId: "68c0ffee00000000000000a1",
			requestName: "List orders",
		},
		match: {
			method: "GET",
			path: "/orders",
			query: [{ key: "status", value: "paid" }],
			headers: [{ key: "accept", value: "application/json" }],
		},
		response: {
			status: 200,
			statusText: "OK",
			contentType: "application/json",
			headers: [{ name: "Content-Type", value: "application/json" }],
			body: {
				encoding: "utf8",
				value: '{"orders":[{"id":"o1"}]}',
				mediaType: "application/json",
				truncated: false,
				omittedReason: null,
			},
		},
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		...overrides,
	};
}

export function domainInput(overrides = {}) {
	return {
		collections: [collectionDoc()],
		environments: [environmentDoc()],
		examples: [exampleDoc()],
		...overrides,
	};
}

export function executionState() {
	return {
		authOverride: { mode: "bearer", tokenTemplate: RESOLVED.sendOnly },
		resolvedVariables: { orders_token: RESOLVED.variable, api_key: RESOLVED.apiKey, password: RESOLVED.password },
		cookies: [{ name: "session", value: RESOLVED.cookie, domain: "api.test", path: "/" }],
		history: [{ executionId: REQUEST_1, snapshot: { response: { body: RESOLVED.history } } }],
	};
}

export function caught(operation) {
	try {
		operation();
	} catch (error) {
		return error;
	}
	throw new Error("expected the operation to throw");
}

export function filesToObject(files) {
	return Object.fromEntries(files);
}
