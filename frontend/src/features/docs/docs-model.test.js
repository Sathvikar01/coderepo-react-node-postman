import { describe, expect, test } from "bun:test";
import { AUTH_LABELS, buildCollectionDocs, DOCS_LIMITS, maskTemplate, referencedVariables, VARIABLE_SCOPES } from "./docs-model.js";

let counter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const row = (key, value, enabled = true) => ({ id: nextId(), key, value, enabled });
const variable = (key, value, enabled = true) => ({ id: nextId(), key, kind: "plain", value, enabled });
const secretRef = (key, alias, enabled = true) => ({ id: nextId(), key, kind: "secretRef", alias, enabled });

function request(overrides = {}) {
	return {
		schemaVersion: 1,
		id: nextId(),
		folderId: null,
		name: "List orders",
		method: "GET",
		urlTemplate: "http://127.0.0.1:8000/demo/v1/orders",
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "inherit" },
		settings: { timeoutMs: 15000 },
		...overrides,
	};
}

function collection(overrides = {}) {
	return {
		_id: "64b00000000000000000c001",
		name: "Orders API",
		description: "Order management endpoints for the local demo target.",
		variables: [variable("api_version", "v1"), secretRef("orders_token", "local_token")],
		auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
		folders: [],
		requests: [request()],
		revision: 3,
		updatedAt: "2026-09-21T06:00:00.000Z",
		...overrides,
	};
}

const only = (model) => model.requests[0];

describe("docs model: request shapes", () => {
	test("projects method, URL, query, headers, and a formatted JSON body", () => {
		const model = buildCollectionDocs(
			collection({
				requests: [
					request({
						name: "Create order",
						method: "POST",
						urlTemplate: "{{base_url}}/orders",
						query: [row("dry_run", "true")],
						headers: [row("Content-Type", "application/json"), row("X-Trace", "{{trace_id}}", false)],
						body: { mode: "json", text: '{"customer":"Ada","items":[1,2]}' },
					}),
				],
			}),
		);
		const docs = only(model);
		expect(docs.method).toBe("POST");
		expect(docs.url).toBe("{{base_url}}/orders");
		expect(docs.query).toEqual([expect.objectContaining({ key: "dry_run", value: "true", enabled: true })]);
		expect(docs.headers.map((header) => [header.key, header.enabled])).toEqual([
			["Content-Type", true],
			["X-Trace", false],
		]);
		expect(docs.body.format).toBe("json");
		expect(docs.body.text).toBe('{\n  "customer": "Ada",\n  "items": [\n    1,\n    2\n  ]\n}');
		expect(docs.body.notices).toEqual([]);
	});

	test("keeps duplicate query keys in order", () => {
		const model = buildCollectionDocs(
			collection({ requests: [request({ query: [row("tag", "a"), row("tag", "b"), row("tag", "a")] })] }),
		);
		expect(only(model).query.map((entry) => entry.value)).toEqual(["a", "b", "a"]);
	});

	test("keeps duplicate urlencoded fields including disabled rows", () => {
		const model = buildCollectionDocs(
			collection({
				requests: [
					request({
						method: "POST",
						body: { mode: "urlencoded", rows: [row("item", "keyboard"), row("item", "cable"), row("note", "skip", false)] },
					}),
				],
			}),
		);
		expect(only(model).body.mode).toBe("urlencoded");
		expect(only(model).body.rows.map((entry) => [entry.key, entry.value, entry.enabled])).toEqual([
			["item", "keyboard", true],
			["item", "cable", true],
			["note", "skip", false],
		]);
	});

	test("keeps text bodies raw with their content type", () => {
		const model = buildCollectionDocs(
			collection({ requests: [request({ method: "POST", body: { mode: "text", text: "hello <world>", contentType: "text/csv" } })] }),
		);
		expect(only(model).body).toMatchObject({
			mode: "text",
			format: "text",
			text: "hello <world>",
			contentType: "text/csv",
			notices: [],
		});
	});

	test("falls back to raw text for malformed JSON instead of dropping the body", () => {
		const model = buildCollectionDocs(
			collection({ requests: [request({ method: "POST", body: { mode: "json", text: '{"unterminated": ' } })] }),
		);
		const body = only(model).body;
		expect(body.format).toBe("json");
		expect(body.text).toBe('{"unterminated": ');
		expect(body.notices).toHaveLength(1);
		expect(body.notices[0]).toContain("Raw text");
	});

	test("reports an absent body without inventing one", () => {
		expect(only(buildCollectionDocs(collection())).body).toMatchObject({ mode: "none", text: "", notices: [] });
	});

	test("carries a request description when the saved data has one", () => {
		const model = buildCollectionDocs(collection({ requests: [request({ description: "Lists every order." })] }));
		expect(only(model).description).toBe("Lists every order.");
	});
});

describe("docs model: auth", () => {
	test("renders no auth mode without credential fields", () => {
		const model = buildCollectionDocs(collection({ auth: { mode: "none" }, requests: [request({ auth: { mode: "none" } })] }));
		expect(only(model).auth).toMatchObject({ mode: "none", label: AUTH_LABELS.none, inherited: false, fields: [], references: [] });
	});

	test("resolves inherited auth from the collection and marks the source", () => {
		const model = buildCollectionDocs(collection({ requests: [request({ auth: { mode: "inherit" } })] }));
		const auth = only(model).auth;
		expect(auth).toMatchObject({ mode: "bearer", label: AUTH_LABELS.bearer, inherited: true, references: ["orders_token"] });
		expect(auth.fields[0]).toMatchObject({ label: "Token", text: "{{orders_token}}" });
	});

	test("describes basic auth through its variable references only", () => {
		const model = buildCollectionDocs(
			collection({
				requests: [
					request({
						auth: { mode: "basic", usernameTemplate: "{{demo_username}}", passwordTemplate: "{{orders_token}}" },
					}),
				],
			}),
		);
		const auth = only(model).auth;
		expect(auth.inherited).toBe(false);
		expect(auth.fields.map((field) => [field.label, field.text])).toEqual([
			["Username", "{{demo_username}}"],
			["Password", "{{orders_token}}"],
		]);
		expect(auth.references).toEqual(["demo_username", "orders_token"]);
	});

	test("describes an API key in query without exposing its value", () => {
		const model = buildCollectionDocs(
			collection({
				requests: [request({ auth: { mode: "apiKey", key: "api_key", valueTemplate: "{{orders_token}}", in: "query" } })],
			}),
		);
		const auth = only(model).auth;
		expect(auth.label).toBe(`${AUTH_LABELS.apiKey} (query string)`);
		expect(auth.fields).toEqual([
			expect.objectContaining({ label: "Query name", text: "api_key" }),
			expect.objectContaining({ label: "Value", text: "{{orders_token}}", references: ["orders_token"] }),
		]);
	});

	test("masks literal credential text and never emits it", () => {
		const masked = maskTemplate("{{user}}:hunter2-secret");
		expect(masked.text).toBe("{{user}}\u2022\u2022\u2022");
		expect(masked.references).toEqual(["user"]);
		const model = buildCollectionDocs(
			collection({ requests: [request({ auth: { mode: "bearer", tokenTemplate: "Bearer hunter2-secret" } })] }),
		);
		expect(JSON.stringify(model)).not.toContain("hunter2-secret");
		expect(only(model).auth.fields[0]).toMatchObject({ text: "\u2022\u2022\u2022", references: [] });
	});
});

describe("docs model: variables", () => {
	test("classifies collection, secret, environment, and disabled variables", () => {
		const model = buildCollectionDocs(
			collection({
				variables: [variable("api_version", "v1"), secretRef("orders_token", "local_token"), variable("retired", "x", false)],
				requests: [
					request({
						urlTemplate: "{{base_url}}/orders/{{order_id}}",
						query: [row("at", "{{api_version}}")],
						headers: [row("Authorization", "Bearer {{orders_token}}"), row("X-Retired", "{{retired}}")],
					}),
				],
			}),
		);
		const byName = Object.fromEntries(only(model).variables.map((entry) => [entry.name, entry]));
		expect(byName.base_url.label).toBe(VARIABLE_SCOPES.environment);
		expect(byName.order_id.scope).toBe("environment");
		expect(byName.api_version.label).toBe(VARIABLE_SCOPES.collection);
		expect(byName.orders_token.label).toBe(VARIABLE_SCOPES.secret);
		expect(byName.retired.label).toBe(VARIABLE_SCOPES.disabled);
		expect(only(model).variables.map((entry) => entry.name)).toEqual([
			"base_url",
			"order_id",
			"api_version",
			"orders_token",
			"retired",
		]);
	});

	test("summarises declared variables with usage counts and unreferenced entries", () => {
		const model = buildCollectionDocs(
			collection({
				variables: [variable("api_version", "v1"), variable("unused_key", "nope")],
				requests: [request({ query: [row("v", "{{api_version}}")] })],
			}),
		);
		expect(model.variables).toEqual([
			expect.objectContaining({
				key: "api_version",
				usedByCount: 1,
				usedBy: ["List orders"],
				label: VARIABLE_SCOPES.collection,
				declared: true,
			}),
			expect.objectContaining({ key: "unused_key", usedByCount: 0, usedBy: [] }),
			expect.objectContaining({ key: "orders_token", declared: false, label: VARIABLE_SCOPES.environment, usedByCount: 1 }),
		]);
	});

	test("counts only enabled rows as references", () => {
		const model = buildCollectionDocs(collection({ requests: [request({ query: [row("v", "{{api_version}}", false)] })] }));
		expect(only(model).variables.map((entry) => entry.name)).toEqual(["orders_token"]);
	});

	test("never copies a variable value, secret alias, or secret name into the document", () => {
		const model = buildCollectionDocs(
			collection({
				variables: [variable("api_version", "PLAIN-VALUE-SENTINEL"), secretRef("orders_token", "local_token")],
				requests: [request({ urlTemplate: "{{base_url}}/orders", headers: [row("Authorization", "Bearer {{orders_token}}")] })],
			}),
		);
		const serialised = JSON.stringify(model);
		expect(serialised).not.toContain("PLAIN-VALUE-SENTINEL");
		expect(serialised).not.toContain("local_token");
		expect(serialised).toContain("orders_token");
	});
});

describe("docs model: examples and responses", () => {
	test("projects nested response examples with status, headers, and body", () => {
		const model = buildCollectionDocs(
			collection({
				requests: [
					request({
						examples: [
							{
								name: "Paid order",
								response: {
									status: 200,
									headers: [{ name: "Content-Type", value: "application/json" }],
									body: '{"id":"ord_0001"}',
								},
							},
						],
					}),
				],
			}),
		);
		expect(only(model).examples).toEqual([
			expect.objectContaining({
				name: "Paid order",
				status: 200,
				contentType: "application/json",
				body: '{"id":"ord_0001"}',
				bodyTruncated: false,
			}),
		]);
	});

	test("tolerates flat example objects and unnamed entries", () => {
		const model = buildCollectionDocs(
			collection({ requests: [request({ examples: [{ status: 404, body: "missing" }, "not-an-example"] })] }),
		);
		expect(only(model).examples).toEqual([expect.objectContaining({ name: "Example 1", status: 404, body: "missing" })]);
	});

	test("bounds example bodies and header lists", () => {
		const model = buildCollectionDocs(
			collection({
				requests: [
					request({
						examples: [
							{
								name: "Huge",
								response: {
									status: 200,
									headers: Array.from({ length: 80 }, (unused, index) => ({ name: `X-${index}`, value: "v" })),
									body: "x".repeat(DOCS_LIMITS.exampleBodyChars + 500),
								},
							},
						],
					}),
				],
			}),
		);
		const example = only(model).examples[0];
		expect(example.body.length).toBe(DOCS_LIMITS.exampleBodyChars);
		expect(example.bodyTruncated).toBe(true);
		expect(example.headers.length).toBe(DOCS_LIMITS.headersPerExample);
		expect(only(model).examples.length).toBe(1);
	});

	test("has no examples when the saved request has none", () => {
		expect(only(buildCollectionDocs(collection())).examples).toEqual([]);
	});
});

describe("docs model: bounds, ordering, and missing data", () => {
	test("bounds a huge body and says so", () => {
		const model = buildCollectionDocs(
			collection({ requests: [request({ method: "POST", body: { mode: "text", text: "a".repeat(DOCS_LIMITS.bodyChars + 100) } })] }),
		);
		const body = only(model).body;
		expect(body.text.length).toBe(DOCS_LIMITS.bodyChars);
		expect(body.notices[0]).toContain(String(DOCS_LIMITS.bodyChars));
	});

	test("bounds rendered requests and reports the remainder", () => {
		const requests = Array.from({ length: DOCS_LIMITS.renderedRequests + 3 }, () => request());
		const model = buildCollectionDocs(collection({ requests }));
		expect(model.requests.length).toBe(DOCS_LIMITS.renderedRequests);
		expect(model.requestCount).toBe(DOCS_LIMITS.renderedRequests + 3);
		expect(model.overflow).toBe(3);
	});

	test("orders folders first in collection order, then unfiled requests", () => {
		const write = { id: "write-folder", name: "Write" };
		const read = { id: "read-folder", name: "Read" };
		const model = buildCollectionDocs(
			collection({
				folders: [read, write],
				requests: [
					request({ name: "Root" }),
					request({ name: "Delete", folderId: write.id }),
					request({ name: "List", folderId: read.id }),
					request({ name: "Get", folderId: read.id }),
				],
			}),
		);
		expect(model.requests.map((entry) => [entry.name, entry.group.name])).toEqual([
			["List", "Read"],
			["Get", "Read"],
			["Delete", "Write"],
			["Root", "Requests"],
		]);
	});

	test("keeps a request whose folder is missing visible in the root group", () => {
		const model = buildCollectionDocs(
			collection({ folders: [{ id: "known", name: "Known" }], requests: [request({ folderId: "gone" })] }),
		);
		expect(model.requests[0].group).toEqual({ id: null, name: "Requests" });
	});

	test("tolerates an empty, partial, or malformed aggregate without throwing", () => {
		const empty = buildCollectionDocs(collection({ requests: [], folders: [], variables: [], description: "" }));
		expect(empty).toMatchObject({ requestCount: 0, overflow: 0, requests: [], variables: [], description: "" });
		expect(buildCollectionDocs(null).requests).toEqual([]);
		expect(buildCollectionDocs({}).requests).toEqual([]);
		const partial = buildCollectionDocs({ name: "Half", requests: [{}] });
		expect(partial.requests[0]).toMatchObject({ name: "Untitled request", method: "GET", url: "", body: { mode: "none" } });
		expect(buildCollectionDocs({ variables: "nope", requests: "nope", folders: 7 }).requests).toEqual([]);
	});
});

describe("docs model: escaping, isolation, and freshness", () => {
	test("keeps XSS payloads as inert text", () => {
		const payload = '<script>alert("xss")</script>';
		const model = buildCollectionDocs(
			collection({
				name: payload,
				description: payload,
				requests: [
					request({
						name: payload,
						urlTemplate: `http://127.0.0.1:8000/${payload}`,
						headers: [row("X-Payload", payload)],
						body: { mode: "text", text: payload },
						examples: [{ name: payload, response: { status: 200, body: payload } }],
					}),
				],
			}),
		);
		expect(model.name).toBe(payload);
		expect(only(model).headers[0].value).toBe(payload);
		expect(only(model).body.text).toBe(payload);
		expect(only(model).examples[0].body).toBe(payload);
		expect(JSON.stringify(model)).not.toContain("<img");
	});

	test("keeps profiles isolated: one collection never leaks into another", () => {
		const alex = buildCollectionDocs(collection({ requests: [request({ name: "Alex request", urlTemplate: "{{base_url}}/alex" })] }));
		const jordan = buildCollectionDocs(
			collection({
				_id: "64b00000000000000000c003",
				name: "Jordan API",
				variables: [],
				requests: [request({ name: "Jordan request", urlTemplate: "{{base_url}}/jordan" })],
			}),
		);
		expect(alex.requests.map((entry) => entry.name)).toEqual(["Alex request"]);
		expect(jordan.requests.map((entry) => entry.name)).toEqual(["Jordan request"]);
		const afterMutation = buildCollectionDocs(collection({ requests: [request({ name: "Alex request" })] }));
		expect(afterMutation.requests.map((entry) => entry.name)).toEqual(["Alex request"]);
	});

	test("is deterministic and reflects saved edits on the next build", () => {
		const before = collection({ requests: [request({ name: "Get order", urlTemplate: "{{base_url}}/orders/{{order_id}}" })] });
		const first = buildCollectionDocs(before);
		const second = buildCollectionDocs(before);
		expect(second).toEqual(first);
		const edited = collection({
			revision: 4,
			requests: [request({ name: "Get one order", urlTemplate: "{{base_url}}/orders/{{order_id}}" })],
		});
		const updated = buildCollectionDocs(edited);
		expect(updated.requests[0].name).toBe("Get one order");
		expect(updated.revision).toBe(4);
		expect(updated.requests[0].anchor).not.toBe(first.requests[0].anchor);
	});

	test("reference extraction matches the send-time placeholder syntax", () => {
		expect(referencedVariables("{{ a }} {{b}} {{a}} {{not-valid}} {{1bad}}")).toEqual(["a", "b"]);
		expect(referencedVariables("no variables")).toEqual([]);
	});
});
