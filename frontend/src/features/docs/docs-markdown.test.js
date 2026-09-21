import { describe, expect, test } from "bun:test";
import { buildCollectionDocs } from "./docs-model.js";
import { collectionDocsFileName, collectionDocsToMarkdown, requestDocsToMarkdown } from "./docs-markdown.js";

let counter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const row = (key, value, enabled = true) => ({ id: nextId(), key, value, enabled });
const variable = (key, value, enabled = true) => ({ id: nextId(), key, kind: "plain", value, enabled });
const secretRef = (key, alias) => ({ id: nextId(), key, kind: "secretRef", alias, enabled: true });

function request(overrides = {}) {
	return {
		schemaVersion: 1,
		id: nextId(),
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
		...overrides,
	};
}

const render = (overrides = {}) => collectionDocsToMarkdown(buildCollectionDocs(collection(overrides)));

describe("docs markdown: document shape", () => {
	test("is deterministic and ends with a single newline", () => {
		const first = render();
		expect(render()).toBe(first);
		expect(first.endsWith("\n")).toBe(true);
		expect(first.endsWith("\n\n")).toBe(false);
	});

	test("writes a title, description, and revision metadata", () => {
		const markdown = render();
		expect(markdown).toContain("# Orders API");
		expect(markdown).toContain("Order management endpoints for the local demo target.");
		expect(markdown).toContain("_Saved revision 3 \u00b7 1 request_");
	});

	test("lists declared variables with sources and never their values", () => {
		const markdown = collectionDocsToMarkdown(
			buildCollectionDocs(
				collection({
					variables: [variable("api_version", "PLAIN-VALUE-SENTINEL"), secretRef("orders_token", "local_token")],
					requests: [request({ query: [row("v", "{{api_version}}")] })],
				}),
			),
		);
		expect(markdown).toContain("## Variables");
		expect(markdown).toContain("| {{api_version}} | Collection variable | enabled | 1 request |");
		expect(markdown).toContain("| {{orders_token}} | Server secret (value never shown) | enabled | 1 request |");
		expect(markdown).toContain("_Values are never included in generated documentation._");
		expect(markdown).not.toContain("PLAIN-VALUE-SENTINEL");
		expect(markdown).not.toContain("local_token");
	});

	test("says so plainly when a collection has no saved requests", () => {
		expect(render({ requests: [] })).toContain("_This collection has no saved requests._");
	});
});

describe("docs markdown: requests", () => {
	test("includes method, URL, query rows, headers, and body", () => {
		const markdown = render({
			requests: [
				request({
					name: "Create order",
					method: "POST",
					query: [row("dry_run", "true"), row("tag", "a"), row("tag", "b")],
					headers: [row("Content-Type", "application/json")],
					body: { mode: "json", text: '{"customer":"Ada"}' },
				}),
			],
		});
		expect(markdown).toContain("### POST {{base_url}}/orders");
		expect(markdown).toContain("_Create order_");
		expect(markdown).toContain("**Query parameters**");
		expect(markdown).toContain("| tag | a | yes |");
		expect(markdown).toContain("| tag | b | yes |");
		expect(markdown).toContain("| Content-Type | application/json | yes |");
		expect(markdown).toContain("**Body (_application/json_)**");
		expect(markdown).toContain('```json\n{\n  "customer": "Ada"\n}\n```');
	});

	test("keeps a malformed JSON body as raw text with a notice", () => {
		const markdown = render({ requests: [request({ method: "POST", body: { mode: "json", text: '{"broken":' } })] });
		expect(markdown).toContain('{"broken":');
		expect(markdown).toContain("> This body is shown as Raw text because it cannot be formatted safely as JSON.");
	});

	test("renders every body line unchanged, including blank lines and backticks", () => {
		const text = 'first\n\n\n{"fence":"```"}\nlast';
		const markdown = render({ requests: [request({ method: "POST", body: { mode: "text", text } })] });
		expect(markdown).toContain(text);
		expect(markdown).toContain("````text");
	});

	test("describes auth through references and masks literal credential text", () => {
		const markdown = render({ requests: [request({ auth: { mode: "bearer", tokenTemplate: "{{user}}:hunter2-secret" } })] });
		expect(markdown).toContain("**Auth:** Bearer token");
		expect(markdown).toContain("| Token | {{user}}\u2022\u2022\u2022 |");
		expect(markdown).not.toContain("hunter2-secret");
	});

	test("marks inherited auth as inherited", () => {
		expect(render()).toContain("**Auth:** Bearer token (inherited from the collection)");
	});

	test("lists request variables with their resolved scope labels", () => {
		const markdown = render({ requests: [request({ urlTemplate: "{{base_url}}/orders/{{order_id}}" })] });
		expect(markdown).toContain("- `{{base_url}}` \u00b7 Environment variable (resolved at send time)");
		expect(markdown).toContain("- `{{order_id}}` \u00b7 Environment variable (resolved at send time)");
		expect(markdown).toContain("- `{{orders_token}}` \u00b7 Server secret (value never shown)");
	});

	test("includes response examples when the saved request has them", () => {
		const markdown = render({
			requests: [
				request({
					examples: [
						{
							name: "Paid order",
							response: {
								status: 200,
								headers: [{ name: "Content-Type", value: "application/json" }],
								body: '{"id":"ord_1"}',
							},
						},
					],
				}),
			],
		});
		expect(markdown).toContain("**Response examples**");
		expect(markdown).toContain("*Paid order \u00b7 200*");
		expect(markdown).toContain("| Content-Type | application/json |");
		expect(markdown).toContain('{"id":"ord_1"}');
	});
});

// Code fences are literal in CommonMark, and the fenced text is exported verbatim so a
// body can be copied out unchanged. Markup safety is therefore asserted on everything
// outside fences: no raw tag may survive there.
function stripFences(markdown) {
	const kept = [];
	let fenced = false;
	for (const line of markdown.split("\n")) {
		if (/^`{3,}/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (!fenced) kept.push(line);
	}
	return kept.join("\n");
}

describe("docs markdown: escaping and safety", () => {
	test("escapes markup from names, headers, and bodies", () => {
		const payload = '<script>alert("xss")</script>';
		const markdown = render({
			name: payload,
			description: payload,
			requests: [
				request({
					name: payload,
					headers: [row("X-Payload", `${payload}|next-line`)],
					body: { mode: "text", text: payload },
					examples: [{ name: payload, response: { status: 200, body: payload } }],
				}),
			],
		});
		const prose = stripFences(markdown);
		expect(prose).not.toContain("<script>");
		expect(prose).not.toContain("<img");
		expect(prose).toContain("&lt;script&gt;");
		expect(prose).toContain('| X-Payload | &lt;script&gt;alert("xss")&lt;/script&gt;\\|next-line |');
		expect(markdown).toContain(`\`\`\`text\n${payload}\n\`\`\``);
	});

	test("keeps table rows intact when a value carries pipes or newlines", () => {
		const markdown = render({ requests: [request({ query: [row("a|b", "one\ntwo")] })] });
		expect(markdown).toContain("| a\\|b | one two | yes |");
		expect(markdown).not.toContain("| a | b |");
	});

	test("never emits an HTML tag for a request heading or field label", () => {
		const markdown = render({ requests: [request({ name: "<h1>owned</h1>" })] });
		expect(markdown).not.toContain("<h1>");
		expect(markdown).toContain("_&lt;h1&gt;owned&lt;/h1&gt;_");
	});
});

describe("docs markdown: filenames and single requests", () => {
	test("derives a safe download name", () => {
		expect(collectionDocsFileName("Orders API")).toBe("orders-api-docs.md");
		expect(collectionDocsFileName("Orders API (local)")).toBe("orders-api-local-docs.md");
		expect(collectionDocsFileName("../../etc/passwd")).toBe("etc-passwd-docs.md");
		expect(collectionDocsFileName("  ")).toBe("collection-docs.md");
		expect(collectionDocsFileName(undefined)).toBe("collection-docs.md");
		expect(collectionDocsFileName("a/b\\c:d*e?f")).toBe("a-b-c-d-e-f-docs.md");
	});

	test("renders a single request section that stands alone", () => {
		const model = buildCollectionDocs(collection({ requests: [request({ name: "Get order" })] }));
		const markdown = requestDocsToMarkdown(model.requests[0]);
		expect(markdown.startsWith("### GET {{base_url}}/orders")).toBe(true);
		expect(markdown).toContain("_Get order_");
		expect(markdown).toContain("**Auth:**");
		expect(markdown).not.toContain("# Orders API");
	});
});
