import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DocsView } from "./DocsView.jsx";
import { DOCS_LIMITS } from "./docs-model.js";

let counter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const row = (key, value, enabled = true) => ({ id: nextId(), key, value, enabled });
const variable = (key, value) => ({ id: nextId(), key, kind: "plain", value, enabled: true });
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

const markup = (overrides = {}) => renderToStaticMarkup(<DocsView collection={collection(overrides)} onClose={() => {}} />);

describe("docs view: structure", () => {
	test("renders a labelled dialog with the collection name and revision", () => {
		const html = markup();
		expect(html).toContain('aria-labelledby="docs-title"');
		expect(html).toContain('<h2 id="docs-title">Orders API</h2>');
		expect(html).toContain("revision 3");
		expect(html).toContain("Generated from the saved collection");
		expect(html).toContain("Unsaved edits and send-only auth are never included");
	});

	test("renders a stable anchor per request and matching navigation", () => {
		const single = request();
		const html = markup({ requests: [single] });
		expect(html).toContain(`id="docs-${single.id}"`);
		expect(html).toContain(`href="#docs-${single.id}"`);
		expect(html).toContain('id="docs-overview"');
		expect(html).toContain('id="docs-variables"');
	});

	test("renders request sections, auth, and variables", () => {
		const html = markup({
			requests: [
				request({
					name: "Create order",
					method: "POST",
					query: [row("dry_run", "true")],
					headers: [row("Content-Type", "application/json")],
					body: { mode: "json", text: '{"customer":"Ada"}' },
				}),
			],
		});
		expect(html).toContain("Create order");
		expect(html).toContain("Auth");
		expect(html).toContain("Bearer token");
		expect(html).toContain("inherited from the collection");
		expect(html).toContain("Query parameters");
		expect(html).toContain("dry_run");
		expect(html).toContain("Content-Type");
		expect(html).toContain("Body");
		expect(html).toContain("application/json");
		expect(html).toContain("&quot;customer&quot;: &quot;Ada&quot;");
		expect(html).toContain("Variables");
		expect(html).toContain("Copy URL to clipboard");
		expect(html).toContain("Copy request to clipboard");
		expect(html).toContain("Copy Markdown to clipboard");
	});

	test("renders response examples with status and body", () => {
		const html = markup({
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
		expect(html).toContain("Response examples");
		expect(html).toContain("Paid order");
		expect(html).toContain("status 200");
		expect(html).toContain("Copy example body to clipboard");
	});

	test("shows an empty state for a collection without requests", () => {
		const html = markup({ requests: [] });
		expect(html).toContain("This collection has no saved requests yet");
		expect(html).not.toContain('class="docs-request"');
	});
});

describe("docs view: safety", () => {
	test("escapes XSS payloads from every saved field", () => {
		const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
		const html = markup({
			name: payload,
			description: payload,
			requests: [
				request({
					name: payload,
					urlTemplate: `http://127.0.0.1:8000/${payload}`,
					headers: [row(payload, payload)],
					body: { mode: "text", text: payload },
					examples: [{ name: payload, response: { status: 200, headers: [{ name: payload, value: payload }], body: payload } }],
				}),
			],
		});
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	test("never renders a credential literal or a variable value", () => {
		const html = markup({
			variables: [variable("api_version", "PLAIN-VALUE-SENTINEL"), secretRef("orders_token", "local_token")],
			requests: [request({ auth: { mode: "bearer", tokenTemplate: "Bearer hunter2-secret" } })],
		});
		expect(html).not.toContain("hunter2-secret");
		expect(html).not.toContain("PLAIN-VALUE-SENTINEL");
		expect(html).not.toContain("local_token");
		expect(html).toContain("\u2022\u2022\u2022");
		expect(html).toContain("Literal credential text is masked");
	});

	test("bounds a huge body in the rendered document", () => {
		const sentinel = "SENTINEL-BEYOND-LIMIT";
		const html = markup({
			requests: [request({ method: "POST", body: { mode: "text", text: "a".repeat(DOCS_LIMITS.bodyChars) + sentinel } })],
		});
		expect(html).not.toContain(sentinel);
		expect(html).toContain(`The body was shortened at ${DOCS_LIMITS.bodyChars} characters.`);
	});
});
