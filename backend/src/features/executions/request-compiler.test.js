import { describe, expect, test } from "bun:test";
import { compileRequest, redactUrl } from "./request-compiler.js";

const baseRequest = (overrides = {}) => ({
	schemaVersion: 1,
	id: "0f8fad5b-d9cb-469f-a165-70867728950e",
	folderId: null,
	name: "List orders",
	method: "GET",
	urlTemplate: "{{base_url}}/orders",
	query: [],
	headers: [],
	body: { mode: "none" },
	auth: { mode: "inherit" },
	settings: { timeoutMs: 15000 },
	...overrides,
});

const collection = {
	name: "Orders API",
	variables: [{ id: "a", key: "api_version", kind: "plain", value: "v1", enabled: true }],
	auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
};
const environment = {
	name: "Local",
	variables: [
		{ id: "b", key: "base_url", kind: "plain", value: "http://127.0.0.1:8000/demo/v1/local", enabled: true },
		{ id: "c", key: "orders_token", kind: "secretRef", alias: "local_token", enabled: true },
	],
};

describe("request compiler", () => {
	test("interpolates environment and secret variables", () => {
		const compiled = compileRequest({
			request: baseRequest(),
			collection,
			environment,
			secrets: new Map([["orders_token", "s3cret-token"]]),
		});
		expect(compiled.url).toBe("http://127.0.0.1:8000/demo/v1/local/orders");
		expect(compiled.headers.find((header) => header.name === "Authorization").value).toBe("Bearer s3cret-token");
		expect(compiled.redaction.values).toContain("s3cret-token");
		expect(compiled.authMode).toBe("bearer");
		expect(compiled.authSource).toBe("collection");
	});

	test("collection defaults lose to environment values", () => {
		const compiled = compileRequest({
			request: baseRequest({ urlTemplate: "http://example.com/{{region}}", auth: { mode: "none" } }),
			collection: { ...collection, variables: [{ id: "d", key: "region", kind: "plain", value: "collection", enabled: true }] },
			environment: { name: "Local", variables: [{ id: "e", key: "region", kind: "plain", value: "environment", enabled: true }] },
		});
		expect(compiled.url).toBe("http://example.com/environment");
		expect(compiled.trace.find((entry) => entry.variable === "region").scope).toBe("environment");
	});

	test("fails before dispatch on an unknown variable", () => {
		expect(() => compileRequest({ request: baseRequest({ urlTemplate: "{{missing}}/orders" }), collection, environment })).toThrow(
			expect.objectContaining({ code: "VARIABLE_UNKNOWN" }),
		);
	});

	test("existing URL query pairs precede editor rows and encode once", () => {
		const compiled = compileRequest({
			request: baseRequest({
				auth: { mode: "none" },
				urlTemplate: "http://example.com/orders?page=2",
				query: [{ id: "q1", key: "status", value: "paid & open", enabled: true }],
			}),
			collection: null,
			environment: null,
		});
		expect(compiled.url).toBe("http://example.com/orders?page=2&status=paid+%26+open");
	});

	test("preserves ordered duplicate query keys", () => {
		const compiled = compileRequest({
			request: baseRequest({
				auth: { mode: "none" },
				urlTemplate: "http://example.com/orders?status=paid",
				query: [
					{ id: "q1", key: "status", value: "open", enabled: true },
					{ id: "q2", key: "status", value: "closed", enabled: true },
				],
			}),
			collection: null,
			environment: null,
		});
		expect(compiled.url).toBe("http://example.com/orders?status=paid&status=open&status=closed");
	});

	test("treats query, header, and form names as literals", () => {
		const compiled = compileRequest({
			request: baseRequest({
				method: "POST",
				urlTemplate: "http://example.com/orders",
				query: [{ id: "q1", key: "{{field}}", value: "{{value}}", enabled: true }],
				headers: [{ id: "h1", key: "X-Field", value: "{{value}}", enabled: true }],
				body: { mode: "urlencoded", rows: [{ id: "b1", key: "{{field}}", value: "{{value}}", enabled: true }] },
				auth: { mode: "none" },
			}),
			collection: null,
			environment: {
				name: "Test",
				variables: [
					{ id: "f", key: "field", kind: "plain", value: "real", enabled: true },
					{ id: "v", key: "value", kind: "plain", value: "resolved", enabled: true },
				],
			},
		});
		expect(compiled.url).toContain("%7B%7Bfield%7D%7D=resolved");
		expect(compiled.headers).toContainEqual({ name: "X-Field", value: "resolved" });
		expect(compiled.body.toString("utf8")).toBe("%7B%7Bfield%7D%7D=resolved");
	});

	test("rejects placeholder-bearing header names instead of interpolating them", () => {
		expect(() =>
			compileRequest({
				request: baseRequest({
					urlTemplate: "http://example.com/orders",
					headers: [{ id: "h1", key: "X-{{field}}", value: "{{value}}", enabled: true }],
					auth: { mode: "none" },
				}),
				collection: null,
				environment: {
					name: "Test",
					variables: [
						{ id: "f", key: "field", kind: "plain", value: "real", enabled: true },
						{ id: "v", key: "value", kind: "plain", value: "resolved", enabled: true },
					],
				},
			}),
		).toThrow(expect.objectContaining({ code: "HEADER_INVALID" }));
	});

	test("rejects transport-managed and duplicate headers", () => {
		expect(() =>
			compileRequest({
				request: baseRequest({
					auth: { mode: "none" },
					urlTemplate: "http://example.com/orders",
					headers: [{ id: "h1", key: "Host", value: "evil.test", enabled: true }],
				}),
				collection: null,
				environment: null,
			}),
		).toThrow(expect.objectContaining({ code: "HEADER_RESERVED" }));
		expect(() =>
			compileRequest({
				request: baseRequest({
					auth: { mode: "none" },
					urlTemplate: "http://example.com/orders",
					headers: [
						{ id: "h1", key: "X-Trace", value: "one", enabled: true },
						{ id: "h2", key: "x-trace", value: "two", enabled: true },
					],
				}),
				collection: null,
				environment: null,
			}),
		).toThrow(expect.objectContaining({ code: "HEADER_INVALID" }));
	});

	test("rejects header values containing line breaks", () => {
		expect(() =>
			compileRequest({
				request: baseRequest({
					auth: { mode: "none" },
					urlTemplate: "http://example.com/orders",
					headers: [{ id: "h1", key: "X-Trace", value: "value\r\nInjected: true", enabled: true }],
				}),
				collection: null,
				environment: null,
			}),
		).toThrow(expect.objectContaining({ code: "HEADER_INVALID" }));
	});

	test("validates JSON after interpolation", () => {
		const jsonRequest = baseRequest({
			method: "POST",
			urlTemplate: "http://example.com/orders",
			auth: { mode: "none" },
			body: { mode: "json", text: '{"customer": "{{customer}}"}' },
		});
		const compiled = compileRequest({
			request: jsonRequest,
			collection: null,
			environment: { name: "Local", variables: [{ id: "f", key: "customer", kind: "plain", value: "Ada", enabled: true }] },
		});
		expect(compiled.body.toString("utf8")).toBe('{"customer": "Ada"}');
		const invalid = { ...jsonRequest, body: { mode: "json", text: '{"customer": {{customer}}}' } };
		expect(() =>
			compileRequest({
				request: invalid,
				collection: null,
				environment: { name: "Local", variables: [{ id: "f", key: "customer", kind: "plain", value: "Ada", enabled: true }] },
			}),
		).toThrow(expect.objectContaining({ code: "BODY_JSON_INVALID" }));
	});

	test("generates basic credentials and redacts them", () => {
		const compiled = compileRequest({
			request: baseRequest({
				urlTemplate: "http://example.com/orders",
				auth: { mode: "basic", usernameTemplate: "ada", passwordTemplate: "hunter2" },
			}),
			collection: null,
			environment: null,
		});
		const header = compiled.headers.find((item) => item.name === "Authorization");
		expect(header.value).toBe(`Basic ${Buffer.from("ada:hunter2").toString("base64")}`);
		expect(compiled.redaction.values).toContain("hunter2");
	});

	test("auth override wins over the saved definition without persisting it", () => {
		const compiled = compileRequest({
			request: baseRequest(),
			collection,
			environment,
			authOverride: { mode: "none" },
			secrets: new Map([["orders_token", "s3cret-token"]]),
		});
		expect(compiled.headers.some((header) => header.name === "Authorization")).toBe(false);
		expect(compiled.authSource).toBe("override");
	});

	test("api key conflicts with an explicit header", () => {
		expect(() =>
			compileRequest({
				request: baseRequest({
					urlTemplate: "http://example.com/orders",
					headers: [{ id: "h1", key: "X-Key", value: "manual", enabled: true }],
					auth: { mode: "apiKey", key: "X-Key", valueTemplate: "generated", in: "header" },
				}),
				collection: null,
				environment: null,
			}),
		).toThrow(expect.objectContaining({ code: "AUTH_CONFLICT" }));
	});

	test("enforces the URL and header budgets", () => {
		expect(() =>
			compileRequest({
				request: baseRequest({ auth: { mode: "none" }, urlTemplate: `http://example.com/${"a".repeat(9000)}` }),
				collection: null,
				environment: null,
			}),
		).toThrow(expect.objectContaining({ code: "URL_TOO_LARGE" }));
		expect(() =>
			compileRequest({
				request: baseRequest({
					auth: { mode: "none" },
					urlTemplate: "http://example.com/orders",
					headers: Array.from({ length: 40 }, (_, index) => ({
						id: `h${index}`,
						key: `X-${index}`,
						value: "v".repeat(500),
						enabled: true,
					})),
				}),
				collection: null,
				environment: null,
			}),
		).toThrow(expect.objectContaining({ code: "HEADER_LIMIT" }));
	});


	test("rejects generated auth/header injection and conflicts", () => {
		expect(() =>
			compileRequest({
				request: baseRequest({
					urlTemplate: "http://example.com/orders",
					headers: [{ id: "h1", key: "Authorization", value: "manual", enabled: true }],
					auth: { mode: "bearer", tokenTemplate: "generated" },
				}),
				collection: null,
				environment: null,
			}),
		).toThrow(expect.objectContaining({ code: "AUTH_CONFLICT" }));

		expect(() =>
			compileRequest({
				request: baseRequest({
					urlTemplate: "http://example.com/orders",
					auth: { mode: "bearer", tokenTemplate: "safe\r\nInjected: true" },
				}),
				collection: null,
				environment: null,
			}),
		).toThrow(expect.objectContaining({ code: "HEADER_INVALID" }));

		expect(() =>
			compileRequest({
				request: baseRequest({
					method: "POST",
					urlTemplate: "http://example.com/orders",
					body: { mode: "text", text: "hello", contentType: "text/plain\r\nX-Evil: yes" },
					auth: { mode: "none" },
				}),
				collection: null,
				environment: null,
			}),
		).toThrow(expect.objectContaining({ code: "HEADER_INVALID" }));

		expect(() =>
			compileRequest({
				request: baseRequest({
					urlTemplate: "http://example.com/orders",
					auth: { mode: "apiKey", key: "Host", valueTemplate: "evil.test", in: "header" },
				}),
				collection: null,
				environment: null,
			}),
		).toThrow(expect.objectContaining({ code: "HEADER_RESERVED" }));
	});

	test("preserves the authored URL for policy and redacts known secrets from URLs", () => {
		const compiled = compileRequest({
			request: baseRequest({
				urlTemplate: "http://2130706433:8000/demo/v1/local/orders?token={{token}}",
				auth: { mode: "none" },
			}),
			collection: null,
			environment: { name: "Local", variables: [{ id: "s", key: "token", kind: "plain", value: "abc123", enabled: true }] },
		});
		expect(compiled.authoredUrl).toBe("http://2130706433:8000/demo/v1/local/orders?token=abc123");
		expect(redactUrl(compiled.url, { queryKeys: [], values: ["abc123"] })).not.toContain("abc123");
	});

	test("inherit without a collection is rejected", () => {
		expect(() =>
			compileRequest({ request: baseRequest({ urlTemplate: "http://example.com/orders" }), collection: null, environment: null }),
		).toThrow(expect.objectContaining({ code: "INHERIT_WITHOUT_COLLECTION" }));
	});
});
