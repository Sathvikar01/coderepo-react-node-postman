import { describe, expect, test } from "bun:test";
import { requestToolsService } from "./request-tools.service.js";

const row = (id, key, value) => ({ id, key, value, enabled: true });

describe("request tools service", () => {
	test("re-parses raw cURL on the backend", () => {
		const result = requestToolsService.parseCurl("curl -X POST https://example.test/orders -H 'Content-Type: application/json' -d '{\"id\":1}'");
		expect(result.ok).toBe(true);
		expect(result.request.method).toBe("POST");
		expect(result.request.urlTemplate).toBe("https://example.test/orders");
		expect(result.request.body).toEqual({ mode: "json", text: "{\"id\":1}" });
	});

	test("generates code from the server-owned normalized export model", () => {
		const request = {
			schemaVersion: 1,
			id: "00000000-0000-4000-8000-000000000001",
			folderId: null,
			name: "List orders",
			method: "GET",
			urlTemplate: "https://example.test/orders",
			query: [row("00000000-0000-4000-8000-000000000002", "limit", "10")],
			headers: [],
			body: { mode: "none" },
			auth: { mode: "none" },
			scripts: { preRequest: "", test: "" },
			assertions: [],
			settings: { timeoutMs: 15000 },
		};
		const result = requestToolsService.generateSnippet(request, "curl");
		expect(result.ok).toBe(true);
		expect(result.code).toContain("curl --request GET");
		expect(result.code).toContain("limit=10");
	});
});
