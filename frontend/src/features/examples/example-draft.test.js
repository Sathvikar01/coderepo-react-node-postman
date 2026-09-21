import { describe, expect, test } from "bun:test";
import {
	cleanMatch,
	cleanResponse,
	describeExample,
	exampleDraft,
	fromResponseInput,
	manualInput,
	responsePayloadFrom,
	selectableRequestRows,
	updateInput,
} from "./example-draft.js";

function resultFixture() {
	return {
		executionId: "exec-1",
		response: {
			status: 201,
			statusText: "Created",
			headers: [
				{ name: "Content-Type", value: "application/json; charset=utf-8" },
				{ name: "Set-Cookie", value: "a=1" },
				{ name: "Set-Cookie", value: "b=2" },
			],
			body: { encoding: "utf8", value: '{"ok":true}', mediaType: "application/json", truncated: false, omittedReason: null },
		},
	};
}

function requestFixture() {
	return {
		id: "req-1",
		name: "Create order",
		method: "POST",
		urlTemplate: "https://api.test/orders",
		query: [
			{ id: "q1", key: "page", value: "1", enabled: true },
			{ id: "q2", key: "skip", value: "x", enabled: false },
		],
		headers: [
			{ id: "h1", key: "X-Tenant", value: "acme", enabled: true },
			{ id: "h2", key: "Authorization", value: "Bearer {{token}}", enabled: true },
		],
	};
}

describe("example drafts", () => {
	test("copies a live response, keeping ordered headers and duplicates", () => {
		const payload = responsePayloadFrom(resultFixture());
		expect(payload).toMatchObject({ status: 201, statusText: "Created", contentType: "application/json" });
		expect(payload.headers).toEqual([
			{ name: "Content-Type", value: "application/json; charset=utf-8" },
			{ name: "Set-Cookie", value: "a=1" },
			{ name: "Set-Cookie", value: "b=2" },
		]);
		expect(payload.body).toMatchObject({ encoding: "utf8", value: '{"ok":true}' });
		expect(responsePayloadFrom({ outcome: "network_error" })).toBeNull();
	});

	test("keeps binary bodies base64 encoded", () => {
		const payload = responsePayloadFrom({
			response: { status: 200, headers: [], body: { encoding: "base64", value: "AAECAw==", mediaType: "application/octet-stream" } },
		});
		expect(payload.body).toMatchObject({ encoding: "base64", value: "AAECAw==" });
	});

	test("offers only enabled, non-sensitive request rows for match rules", () => {
		const rows = selectableRequestRows(requestFixture());
		expect(rows.query.map((row) => row.key)).toEqual(["page"]);
		expect(rows.headers.map((row) => row.key)).toEqual(["X-Tenant"]);
	});

	test("builds a from-response payload with the source reference and selection", () => {
		const input = fromResponseInput({
			name: "Orders",
			request: requestFixture(),
			result: resultFixture(),
			environmentId: "env-1",
			source: { collectionId: "c1" },
			selectQueryIds: ["q1"],
			selectHeaderIds: ["h1"],
		});
		expect(input).toMatchObject({
			mode: "from-response",
			name: "Orders",
			source: { executionId: "exec-1", requestId: "req-1", collectionId: "c1", requestName: "Create order" },
			environmentId: "env-1",
			selectQueryIds: ["q1"],
			selectHeaderIds: ["h1"],
		});
		expect(input.response.status).toBe(201);
		const withoutOptional = fromResponseInput({ name: "x", request: requestFixture(), result: resultFixture() });
		expect(withoutOptional.environmentId).toBeUndefined();
		expect(withoutOptional.source.collectionId).toBeUndefined();
	});

	test("cleans manual and update payloads without dropping duplicate response headers", () => {
		const draft = {
			method: "post",
			path: " /orders ",
			query: [
				{ key: " page ", value: "2" },
				{ key: "  ", value: "ignored" },
			],
			headers: [{ key: "X-Tenant", value: "acme" }],
		};
		const input = manualInput({
			name: "Manual",
			match: draft,
			response: {
				status: "204",
				statusText: "No Content",
				contentType: "text/plain",
				headers: [
					{ name: "X-A", value: "1" },
					{ name: "X-A", value: "2" },
					{ name: "  ", value: "ignored" },
				],
				body: { encoding: "utf8", value: "", mediaType: "" },
			},
		});
		expect(input.mode).toBe("manual");
		expect(input.match).toEqual({ method: "POST", path: "/orders", query: [{ key: "page", value: "2" }], headers: [{ key: "X-Tenant", value: "acme" }] });
		expect(input.response.status).toBe(204);
		expect(input.response.headers).toEqual([
			{ name: "X-A", value: "1" },
			{ name: "X-A", value: "2" },
		]);
		expect(updateInput({ name: "Edit", match: draft, response: cleanResponse({}) }).name).toBe("Edit");
		expect(cleanMatch(null).method).toBe("GET");
	});

	test("turns a saved example into an editable draft and back", () => {
		const draft = exampleDraft({
			name: "Orders",
			match: { method: "GET", path: "/orders", query: [{ key: "status", value: "paid" }], headers: [] },
			response: { status: 200, statusText: "OK", contentType: "application/json", headers: [{ name: "Content-Type", value: "application/json" }], body: { encoding: "utf8", value: "{}" } },
		});
		expect(draft.match.query[0]).toMatchObject({ key: "status", value: "paid", enabled: true });
		expect(draft.response.headers[0]).toMatchObject({ key: "Content-Type", value: "application/json", enabled: true });
		const rebuilt = updateInput({ name: draft.name, match: draft.match, response: draft.response });
		expect(rebuilt.match.query).toEqual([{ key: "status", value: "paid" }]);
		expect(rebuilt.response.headers).toEqual([{ name: "Content-Type", value: "application/json" }]);
		const empty = exampleDraft(null);
		expect(empty).toMatchObject({ name: "", match: { method: "GET", path: "/" } });
	});

	test("summarizes an example for the sidebar list", () => {
		const summary = describeExample({
			match: { method: "POST", path: "/orders", query: [{ key: "a", value: "1" }], headers: [{ key: "b", value: "2" }] },
			response: { status: 201, contentType: "application/json" },
			source: { type: "response" },
		});
		expect(summary).toEqual({ method: "POST", path: "/orders", status: 201, contentType: "application/json", rules: 2, source: "From a live response" });
	});
});
