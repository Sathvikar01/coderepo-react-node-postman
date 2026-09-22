import { describe, expect, test } from "bun:test";
import { compareReceipts } from "./run-comparison.js";

function receipt(overrides = {}) {
	const base = {
		schemaVersion: 1,
		kind: "tracer.execution-receipt",
		executionId: "11111111-1111-4111-8111-111111111111",
		outcome: "response",
		effectCertainty: "may_have_reached_target",
		request: {
			method: "GET",
			displayUrl: "https://api.example.test/orders",
			executedUrl: "https://api.example.test/orders",
			authoredFingerprint: "authored-a",
			compiledFingerprint: "compiled-a",
			headerNames: ["accept"],
			queryKeys: ["page"],
			body: { mode: "none", sizeBytes: 0, fingerprint: null },
			auth: { mode: "bearer", source: "request", referenceKeys: ["token"] },
			variableSources: [{ field: "url", key: "base_url", scope: "environment" }],
		},
		source: {
			type: "collection",
			collectionId: "aaaaaaaaaaaaaaaaaaaaaaaa",
			collectionRevision: 2,
			requestId: "22222222-2222-4222-8222-222222222222",
			environmentId: "bbbbbbbbbbbbbbbbbbbbbbbb",
			environmentRevision: 4,
		},
		policy: { decision: "allowed", version: "1.0", local: false },
		target: { scheme: "https", hostname: "api.example.test", port: 443, address: "203.0.113.10", family: 4 },
		redirects: [],
		transport: { httpVersion: "1.1", durationMs: 50, firstByteMs: 20, receivedBodyBytes: 100, capturedBodyBytes: 100 },
		response: {
			bodyFingerprint: "body-a",
			truncated: false,
			binary: false,
			contract: {
				status: 200,
				headers: [
					{ name: "content-type", count: 1 },
					{ name: "x-request-id", count: 2 },
				],
				bodyShape: [
					{ path: "$", type: "object" },
					{ path: "$.items", type: "array" },
					{ path: "$.items[]", type: "object" },
					{ path: "$.items[].id", type: "number" },
					{ path: "$.meta", type: "object" },
				],
			},
		},
		error: null,
		tests: { counts: { passed: 1, failed: 0, error: 0 }, failureFingerprint: "tests-a" },
		warnings: [],
	};
	return {
		...base,
		...overrides,
		request: { ...base.request, ...(overrides.request ?? {}) },
		source: { ...base.source, ...(overrides.source ?? {}) },
		policy: { ...base.policy, ...(overrides.policy ?? {}) },
		target: overrides.target === null ? null : { ...base.target, ...(overrides.target ?? {}) },
		transport: overrides.transport === null ? null : { ...base.transport, ...(overrides.transport ?? {}) },
		response:
			overrides.response === null
				? null
				: {
						...base.response,
						...(overrides.response ?? {}),
						contract: { ...base.response.contract, ...(overrides.response?.contract ?? {}) },
					},
	};
}

describe("RunComparisonV1", () => {
	test("returns no divergence for equivalent receipts", () => {
		const comparison = compareReceipts(receipt(), receipt({ executionId: "33333333-3333-4333-8333-333333333333" }));

		expect(comparison).toMatchObject({
			schemaVersion: 1,
			kind: "tracer.run-comparison",
			firstDivergence: null,
			changes: [],
			contract: { breaking: false, changes: [] },
		});
	});

	test("orders causal evidence and identifies the first meaningful divergence", () => {
		const candidate = receipt({
			executionId: "33333333-3333-4333-8333-333333333333",
			source: { collectionRevision: 3, environmentRevision: 5 },
			request: {
				authoredFingerprint: "authored-b",
				compiledFingerprint: "compiled-b",
				auth: { mode: "apiKey", source: "collection", referenceKeys: ["api_key"] },
			},
			target: { address: "203.0.113.11" },
			transport: { durationMs: 90 },
		});

		const comparison = compareReceipts(receipt(), candidate);
		expect(comparison.firstDivergence).toEqual({
			category: "source",
			path: "source.collectionRevision",
			message: "The collection revision changed from 2 to 3.",
		});
		expect(comparison.changes.map((change) => `${change.category}:${change.path}`)).toEqual([
			"source:source.collectionRevision",
			"source:source.environmentRevision",
			"request:request.authoredFingerprint",
			"auth:request.auth",
			"request:request.compiledFingerprint",
			"target:target.address",
			"transport:transport.durationMs",
		]);
	});

	test("reports lightweight breaking contract changes and duplicate header counts", () => {
		const candidate = receipt({
			executionId: "33333333-3333-4333-8333-333333333333",
			response: {
				bodyFingerprint: "body-b",
				contract: {
					status: 500,
					headers: [
						{ name: "content-type", count: 1 },
						{ name: "x-request-id", count: 1 },
						{ name: "x-new", count: 1 },
					],
					bodyShape: [
						{ path: "$", type: "object" },
						{ path: "$.items", type: "array" },
						{ path: "$.items[]", type: "object" },
						{ path: "$.items[].id", type: "string" },
						{ path: "$.extra", type: "boolean" },
					],
				},
			},
		});

		const comparison = compareReceipts(receipt(), candidate);
		expect(comparison.contract.breaking).toBe(true);
		expect(comparison.contract.changes).toEqual([
			{ kind: "status_changed", path: "status", before: 200, after: 500, severity: "breaking" },
			{ kind: "header_count_decreased", path: "headers.x-request-id", before: 2, after: 1, severity: "breaking" },
			{ kind: "header_added", path: "headers.x-new", before: 0, after: 1, severity: "additive" },
			{ kind: "body_path_added", path: "$.extra", before: null, after: "boolean", severity: "additive" },
			{ kind: "body_type_changed", path: "$.items[].id", before: "number", after: "string", severity: "breaking" },
			{ kind: "body_path_removed", path: "$.meta", before: "object", after: null, severity: "breaking" },
		]);
	});

	test("does not invent structured diffs for binary or truncated bodies", () => {
		const comparison = compareReceipts(
			receipt(),
			receipt({
				executionId: "33333333-3333-4333-8333-333333333333",
				response: { binary: true, truncated: true, contract: { bodyShape: [] } },
			}),
		);

		expect(comparison.contract.changes.filter((change) => change.path.startsWith("$."))).toEqual([]);
		expect(comparison.changes).toContainEqual(
			expect.objectContaining({ category: "response", path: "response.representation", severity: "warning" }),
		);
	});
});
