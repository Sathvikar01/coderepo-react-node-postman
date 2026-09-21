import { describe, expect, test } from "bun:test";
import { requestDefinitionSchema } from "../../../../backend/src/shared/utils/schemas.js";
import { parseCurl } from "../import/curl-parser.js";
import { importedRequestDefinition } from "../import/import-draft.js";
import { writeClipboard } from "./clipboard.js";
import { generateSnippet, SNIPPET_FORMATS } from "./snippets.js";

const target = "http://127.0.0.1:8000/demo/v1/echo";
const FORMATS = ["curl", "javascript", "node", "python"];
let counter = 0;
const row = (key, value, enabled = true) => ({
	id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
	key,
	value,
	enabled,
});

function makeRequest(overrides = {}) {
	return {
		schemaVersion: 1,
		id: "11111111-1111-4111-8111-111111111111",
		folderId: null,
		name: "Export test",
		method: "GET",
		urlTemplate: target,
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		settings: { timeoutMs: 15000 },
		...overrides,
	};
}

function snippetFor(request, format, options) {
	const snippet = generateSnippet(request, format, options);
	expect(snippet.errors).toEqual([]);
	expect(snippet.ok).toBe(true);
	return snippet;
}

const codeFor = (request, format, options) => snippetFor(request, format, options).code;

describe("snippet formats", () => {
	test("exposes exactly the four supported formats", () => {
		expect(SNIPPET_FORMATS.map((format) => format.value)).toEqual(FORMATS);
	});

	test("rejects an unknown format instead of guessing", () => {
		const snippet = generateSnippet(makeRequest(), "ruby");
		expect(snippet.ok).toBe(false);
		expect(snippet.code).toBe("");
		expect(snippet.errors[0].code).toBe("FORMAT_UNSUPPORTED");
	});

	test("every format is available as a labeled tab", () => {
		for (const format of SNIPPET_FORMATS) {
			expect(format.label.length).toBeGreaterThan(0);
		}
	});
});

describe("methods", () => {
	test.each(["GET", "POST", "PUT", "PATCH", "DELETE"])("%s exports in every format", (method) => {
		const request = makeRequest({
			method,
			body: method === "GET" ? { mode: "none" } : { mode: "json", text: '{"ok":true}' },
		});
		for (const format of FORMATS) {
			const code = codeFor(request, format);
			expect(code).toContain(method);
			expect(code).toContain(target);
		}
	});

	test("GET with a body fails clearly, like the executor", () => {
		const snippet = generateSnippet(makeRequest({ method: "GET", body: { mode: "json", text: "{}" } }), "curl");
		expect(snippet.ok).toBe(false);
		expect(snippet.errors[0].code).toBe("GET_BODY_UNSUPPORTED");
	});

	test("a missing URL fails clearly", () => {
		const snippet = generateSnippet(makeRequest({ urlTemplate: "   " }), "curl");
		expect(snippet.ok).toBe(false);
		expect(snippet.errors[0].code).toBe("URL_MISSING");
	});

	test("an unknown method fails clearly", () => {
		const snippet = generateSnippet(makeRequest({ method: "TRACE" }), "curl");
		expect(snippet.ok).toBe(false);
		expect(snippet.errors[0].code).toBe("METHOD_UNSUPPORTED");
	});
});

describe("query and headers", () => {
	test("curl preserves order and duplicates exactly", () => {
		const request = makeRequest({
			method: "POST",
			query: [row("tag", "a"), row("tag", "b"), row("page", "2")],
			headers: [row("X-Tag", "one"), row("X-Tag", "two"), row("Accept", "application/json")],
			body: { mode: "json", text: '{"name":"Ada"}' },
		});
		expect(codeFor(request, "curl")).toBe(
			[
				"curl --request POST \\",
				`  --url '${target}?tag=a&tag=b&page=2' \\`,
				"  --header 'X-Tag: one' \\",
				"  --header 'X-Tag: two' \\",
				"  --header 'Accept: application/json' \\",
				"  --header 'Content-Type: application/json' \\",
				'  --data-raw \'{"name":"Ada"}\'',
			].join("\n"),
		);
	});

	test("javascript, node, and python keep duplicate header pairs", () => {
		const request = makeRequest({ headers: [row("X-Tag", "one"), row("X-Tag", "two")] });
		expect(codeFor(request, "javascript")).toContain('    ["X-Tag", "one"],\n    ["X-Tag", "two"],');
		expect(codeFor(request, "node")).toContain('"X-Tag": ["one", "two"],');
		expect(codeFor(request, "python")).toContain('        "X-Tag": "one, two",');
	});

	test("curl turns globbing off for a URL that holds a variable reference", () => {
		const request = makeRequest({ urlTemplate: "{{baseUrl}}/orders", query: [row("id", "{{orderId}}")] });
		expect(codeFor(request, "curl")).toContain("curl --globoff --request GET");
		expect(codeFor(makeRequest({ urlTemplate: target }), "curl")).toContain("curl --request GET");
	});

	test("duplicate query keys survive in every format", () => {
		const request = makeRequest({ query: [row("tag", "a"), row("tag", "b")] });
		for (const format of FORMATS) expect(codeFor(request, format)).toContain("tag=a&tag=b");
	});

	test("rows appended to a URL that already has a query keep the URL query first", () => {
		const request = makeRequest({ urlTemplate: `${target}?first=1#frag`, query: [row("second", "2")] });
		expect(codeFor(request, "curl")).toContain(`'${target}?first=1&second=2#frag'`);
	});

	test("disabled rows are left out", () => {
		const request = makeRequest({
			query: [row("live", "1"), row("dead", "x", false)],
			headers: [row("X-Live", "1"), row("X-Dead", "x", false)],
		});
		const code = codeFor(request, "curl");
		expect(code).toContain("live=1");
		expect(code).not.toContain("dead");
		expect(code).not.toContain("X-Dead");
	});

	test("duplicate enabled headers are preserved with a warning", () => {
		const snippet = snippetFor(makeRequest({ headers: [row("X-Tag", "one"), row("X-Tag", "two")] }), "curl");
		expect(snippet.warnings.map((warning) => warning.code)).toContain("DUPLICATE_HEADERS");
	});

	test("the fetch snippet explains that fetch combines repeated header names", () => {
		const request = makeRequest({ headers: [row("X-Tag", "one"), row("X-Tag", "two")] });
		expect(codeFor(request, "javascript")).toContain(
			"// Note: fetch sends the repeated header names (X-Tag) as one comma-separated header.",
		);
		expect(codeFor(request, "python")).toContain("# Note: Python requests combines the repeated header names (X-Tag)");
		expect(codeFor(request, "node")).not.toContain("// Note:");
		expect(codeFor(request, "node")).not.toContain("# Note:");
	});

	test("a reserved transport header fails clearly", () => {
		const snippet = generateSnippet(makeRequest({ headers: [row("Host", "example.test")] }), "curl");
		expect(snippet.ok).toBe(false);
		expect(snippet.errors[0].code).toBe("HEADER_RESERVED");
	});

	test("an enabled header without a name fails clearly", () => {
		const snippet = generateSnippet(makeRequest({ headers: [row("", "value")] }), "curl");
		expect(snippet.ok).toBe(false);
		expect(snippet.errors[0].code).toBe("HEADER_INVALID");
	});

	test("a header value with a line break fails clearly", () => {
		const snippet = generateSnippet(makeRequest({ headers: [row("X-Tag", "one\ntwo")] }), "curl");
		expect(snippet.ok).toBe(false);
		expect(snippet.errors[0].code).toBe("HEADER_INVALID");
	});
});

describe("bodies", () => {
	test("json adds a generated content type and keeps the exact text", () => {
		const request = makeRequest({ method: "POST", body: { mode: "json", text: '{"a":[1,2]}' } });
		expect(codeFor(request, "curl")).toContain("--header 'Content-Type: application/json'");
		expect(codeFor(request, "javascript")).toContain('body: "{\\"a\\":[1,2]}",');
		expect(codeFor(request, "node")).toContain('request.write("{\\"a\\":[1,2]}");');
		expect(codeFor(request, "python")).toContain("data='{\"a\":[1,2]}',");
	});

	test("text bodies use the requested content type", () => {
		const request = makeRequest({ method: "PUT", body: { mode: "text", text: "hello", contentType: "text/csv" } });
		for (const format of FORMATS) expect(codeFor(request, format)).toContain("text/csv");
	});

	test("an explicit content type is not duplicated", () => {
		const request = makeRequest({
			method: "POST",
			headers: [row("Content-Type", "application/vnd.api+json")],
			body: { mode: "json", text: "{}" },
		});
		const code = codeFor(request, "curl");
		expect(code).toContain("application/vnd.api+json");
		expect(code).not.toContain("application/json'");
	});

	test("urlencoded bodies keep every row and duplicate keys", () => {
		const request = makeRequest({
			method: "POST",
			body: {
				mode: "urlencoded",
				rows: [row("name", "Ada"), row("tag", "x"), row("tag", "y"), row("skip", "s", false), row("", "none")],
			},
		});
		expect(codeFor(request, "curl")).toContain("--data-urlencode 'name=Ada'");
		expect(codeFor(request, "curl")).toContain("--data-urlencode 'tag=x'");
		expect(codeFor(request, "curl")).toContain("--data-urlencode 'tag=y'");
		expect(codeFor(request, "curl")).not.toContain("skip");
		expect(codeFor(request, "curl")).toContain("--header 'Content-Type: application/x-www-form-urlencoded'");
		expect(codeFor(request, "javascript")).toContain('    ["tag", "x"],\n    ["tag", "y"],');
		expect(codeFor(request, "python")).toContain(
			'    data=[\n        ("name", "Ada"),\n        ("tag", "x"),\n        ("tag", "y"),\n    ],',
		);
	});

	test("node frames bodies with an explicit content length", () => {
		const jsonRequest = makeRequest({ method: "POST", body: { mode: "json", text: '{"a":1}' } });
		expect(codeFor(jsonRequest, "node")).toContain('"Content-Length": 7,');
		const formRequest = makeRequest({ method: "POST", body: { mode: "urlencoded", rows: [row("name", "Ada")] } });
		expect(codeFor(formRequest, "node")).toContain('"Content-Length": 8,');
		const textRequest = makeRequest({ method: "PUT", body: { mode: "text", text: "naïve", contentType: "text/plain" } });
		expect(codeFor(textRequest, "node")).toContain('"Content-Length": 6,');
	});

	test("an unknown body mode fails clearly", () => {
		const snippet = generateSnippet(makeRequest({ method: "POST", body: { mode: "multipart" } }), "curl");
		expect(snippet.ok).toBe(false);
		expect(snippet.errors[0].code).toBe("BODY_UNSUPPORTED");
	});
});

describe("authentication templates", () => {
	test("bearer tokens stay variable references in every format", () => {
		const request = makeRequest({ auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" } });
		for (const format of FORMATS) {
			const code = codeFor(request, format);
			expect(code).toContain("{{orders_token}}");
			expect(code).toContain("Bearer");
			expect(code).not.toContain("orders_token =");
		}
	});

	test("basic credentials keep both references", () => {
		const request = makeRequest({ auth: { mode: "basic", usernameTemplate: "{{orders_user}}", passwordTemplate: "{{orders_pass}}" } });
		expect(codeFor(request, "curl")).toContain("--user '{{orders_user}}:{{orders_pass}}'");
		expect(codeFor(request, "javascript")).toContain('btoa("{{orders_user}}:{{orders_pass}}")');
		expect(codeFor(request, "node")).toContain('Buffer.from("{{orders_user}}:{{orders_pass}}").toString("base64")');
		expect(codeFor(request, "python")).toContain('auth=("{{orders_user}}", "{{orders_pass}}")');
	});

	test("api key auth can live in a header or the query", () => {
		const headerRequest = makeRequest({
			auth: { mode: "apiKey", key: "X-Api-Key", valueTemplate: "{{demo_key}}", in: "header" },
		});
		expect(codeFor(headerRequest, "curl")).toContain("--header 'X-Api-Key: {{demo_key}}'");
		const queryRequest = makeRequest({ auth: { mode: "apiKey", key: "api_key", valueTemplate: "{{demo_key}}", in: "query" } });
		expect(codeFor(queryRequest, "curl")).toContain(`${target}?api_key={{demo_key}}`);
	});

	test("an api key that collides with an explicit header fails clearly", () => {
		const request = makeRequest({
			headers: [row("X-Api-Key", "explicit")],
			auth: { mode: "apiKey", key: "x-api-key", valueTemplate: "{{demo_key}}", in: "header" },
		});
		const snippet = generateSnippet(request, "curl");
		expect(snippet.ok).toBe(false);
		expect(snippet.errors[0].code).toBe("AUTH_CONFLICT");
	});

	test("inherit resolves from the collection auth without resolving variables", () => {
		const request = makeRequest({ auth: { mode: "inherit" } });
		const collectionAuth = { mode: "bearer", tokenTemplate: "{{collection_token}}" };
		expect(codeFor(request, "curl", { collectionAuth })).toContain("--header 'Authorization: Bearer {{collection_token}}'");
	});

	test("inherit without a collection fails clearly", () => {
		const snippet = generateSnippet(makeRequest({ auth: { mode: "inherit" } }), "curl");
		expect(snippet.ok).toBe(false);
		expect(snippet.errors[0].code).toBe("INHERIT_WITHOUT_COLLECTION");
	});

	test("an unknown auth mode fails clearly", () => {
		const snippet = generateSnippet(makeRequest({ auth: { mode: "oauth2" } }), "curl");
		expect(snippet.ok).toBe(false);
		expect(snippet.errors[0].code).toBe("AUTH_UNSUPPORTED");
	});

	test("send-only overrides attached to the request object are ignored", () => {
		const request = makeRequest({
			auth: { mode: "none" },
			authOverride: { mode: "basic", usernameTemplate: "send-only", passwordTemplate: "never-export" },
		});
		for (const format of FORMATS) {
			const code = codeFor(request, format);
			expect(code).not.toContain("send-only");
			expect(code).not.toContain("never-export");
			expect(code).not.toContain("Authorization");
		}
	});

	test("a literal draft credential is exported as typed without resolution", () => {
		const request = makeRequest({ auth: { mode: "bearer", tokenTemplate: "literal-token" } });
		expect(codeFor(request, "curl")).toContain("--header 'Authorization: Bearer literal-token'");
	});
});

describe("escaping", () => {
	test("shell quotes are escaped so the command stays one argument", () => {
		const request = makeRequest({ method: "POST", body: { mode: "text", text: "it's fine", contentType: "text/plain" } });
		expect(codeFor(request, "curl")).toContain(`--data-raw 'it'\\''s fine'`);
	});

	test("javascript and node escape quotes and newlines", () => {
		const request = makeRequest({
			method: "POST",
			body: { mode: "text", text: 'he said "hi"\nnaïve 😀', contentType: "text/plain" },
		});
		const code = codeFor(request, "javascript");
		expect(code).toContain('body: "he said \\"hi\\"\\nnaïve 😀",');
		expect(codeFor(request, "node")).toContain('request.write("he said \\"hi\\"\\nnaïve 😀");');
	});

	test("python escapes quotes and newlines while keeping unicode readable", () => {
		const request = makeRequest({
			method: "POST",
			body: { mode: "text", text: "he said 'hi'\nnaïve 😀", contentType: "text/plain" },
		});
		expect(codeFor(request, "python")).toContain("data=\"he said 'hi'\\nnaïve 😀\",");
	});

	test("unicode URLs and query values stay readable", () => {
		const request = makeRequest({ urlTemplate: `${target}?q=tempête`, query: [row("name", "naïve")] });
		const code = codeFor(request, "curl");
		expect(code).toContain("q=tempête");
		expect(code).toContain("name=na%C3%AFve");
	});
});

describe("imported cURL round trip", () => {
	const command = `curl -X PUT '${target}?tag=a&tag=b' -H 'X-Tag: one' -H 'Content-Type: application/json' -d '{"name":"Ada"}'`;

	test("re-exporting an imported command keeps method, query, headers, and body", () => {
		const parsed = parseCurl(command);
		expect(parsed.ok).toBe(true);
		const request = importedRequestDefinition(parsed.request);
		expect(requestDefinitionSchema.safeParse(request).success).toBe(true);
		const exported = codeFor(request, "curl");
		expect(exported).toContain("--request PUT");
		expect(exported).toContain(`'${target}?tag=a&tag=b'`);
		expect(exported).toContain("--header 'X-Tag: one'");
		expect(exported).toContain('--data-raw \'{"name":"Ada"}\'');
	});

	test("credentials imported with -u never reach an exported snippet", () => {
		const parsed = parseCurl(`curl -u 'ada:secret-pass' ${target}`);
		expect(parsed.ok).toBe(true);
		expect(parsed.authOverride).not.toBeNull();
		const request = importedRequestDefinition(parsed.request);
		for (const format of FORMATS) {
			const code = codeFor(request, format);
			expect(code).not.toContain("secret-pass");
			expect(code).not.toContain("ada:");
			expect(code).not.toContain("--user");
		}
	});
});

describe("clipboard copy", () => {
	test("hands the exact previewed code to the clipboard writer", async () => {
		let copied = null;
		const ok = await writeClipboard("curl --request GET", {
			writeText: async (text) => {
				copied = text;
			},
		});
		expect(ok).toBe(true);
		expect(copied).toBe("curl --request GET");
	});

	test("reports failure instead of claiming success", async () => {
		const ok = await writeClipboard("code", {
			writeText: async () => {
				throw new Error("denied");
			},
		});
		expect(ok).toBe(false);
	});

	test("reports failure when no clipboard writer exists", async () => {
		expect(await writeClipboard("code", null)).toBe(false);
	});
});
