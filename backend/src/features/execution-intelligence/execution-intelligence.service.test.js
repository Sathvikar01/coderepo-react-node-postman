import { describe, expect, test } from "bun:test";
import { createExecutionIntelligenceService } from "./execution-intelligence.service.js";
import { parseReproCapsule } from "./repro-capsule.js";

const PROFILE_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PROFILE_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const EXECUTION_A = "11111111-1111-4111-8111-111111111111";
const EXECUTION_B = "22222222-2222-4222-8222-222222222222";

function receipt(executionId, status = 200) {
	return {
		schemaVersion: 1,
		kind: "tracer.execution-receipt",
		executionId,
		request: { authoredFingerprint: "same", compiledFingerprint: "same", auth: { mode: "none", source: "request", referenceKeys: [] } },
		source: {},
		policy: { decision: "allowed" },
		target: { hostname: "api.test", address: "203.0.113.1" },
		transport: { durationMs: 10 },
		response: { binary: false, truncated: false, bodyFingerprint: "same", contract: { status, headers: [], bodyShape: [] } },
		outcome: "response",
	};
}

function service(records) {
	return createExecutionIntelligenceService({
		history: {
			async get(profileId, executionId) {
				return records.get(`${profileId}:${executionId}`) ?? null;
			},
		},
	});
}

function recordWithRequest(executionId) {
	return {
		executionId,
		outcome: "response",
		effectCertainty: "may_have_reached_target",
		request: {
			schemaVersion: 1,
			id: "33333333-3333-4333-8333-333333333333",
			folderId: null,
			name: "List orders",
			method: "GET",
			urlTemplate: "https://api.test/orders",
			query: [],
			headers: [],
			body: { mode: "none" },
			auth: { mode: "none" },
			scripts: { preRequest: "", test: "" },
			assertions: [],
			settings: { timeoutMs: 15000 },
		},
		snapshot: { scriptResults: null },
		response: { status: 200, headers: [], body: { encoding: "utf8", value: "{}", mediaType: "application/json", truncated: false } },
		receipt: receipt(executionId, 200),
	};
}

function caught(promise) {
	return promise.then(
		() => null,
		(error) => error,
	);
}

describe("execution intelligence service", () => {
	test("returns only the owning profile's execution receipt", async () => {
		const records = new Map([[`${PROFILE_A}:${EXECUTION_A}`, { executionId: EXECUTION_A, receipt: receipt(EXECUTION_A) }]]);
		const intelligence = service(records);

		expect(await intelligence.getReceipt(PROFILE_A, EXECUTION_A)).toEqual(receipt(EXECUTION_A));
		expect((await caught(intelligence.getReceipt(PROFILE_B, EXECUTION_A))).code).toBe("HISTORY_NOT_FOUND");
	});

	test("fails clearly for an old history record without a receipt", async () => {
		const records = new Map([[`${PROFILE_A}:${EXECUTION_A}`, { executionId: EXECUTION_A, receipt: null }]]);

		const error = await caught(service(records).getReceipt(PROFILE_A, EXECUTION_A));
		expect(error.statusCode).toBe(409);
		expect(error.code).toBe("RECEIPT_UNAVAILABLE");
	});

	test("compares two owned receipts without accepting caller-provided evidence", async () => {
		const records = new Map([
			[`${PROFILE_A}:${EXECUTION_A}`, { executionId: EXECUTION_A, receipt: receipt(EXECUTION_A, 200) }],
			[`${PROFILE_A}:${EXECUTION_B}`, { executionId: EXECUTION_B, receipt: receipt(EXECUTION_B, 500) }],
		]);

		const result = await service(records).compare(PROFILE_A, EXECUTION_A, EXECUTION_B);
		expect(result.baseExecutionId).toBe(EXECUTION_A);
		expect(result.candidateExecutionId).toBe(EXECUTION_B);
		expect(result.contract).toEqual({
			breaking: true,
			changes: [{ kind: "status_changed", path: "status", before: 200, after: 500, severity: "breaking" }],
		});
	});

	test("exports and imports a capsule as an unsent dirty draft without persistence", async () => {
		const records = new Map([[`${PROFILE_A}:${EXECUTION_A}`, recordWithRequest(EXECUTION_A)]]);
		const intelligence = service(records);

		const exported = await intelligence.exportCapsule(PROFILE_A, EXECUTION_A, { includeResponseBody: false });
		expect(exported.filename).toBe("list-orders.repro.json");
		expect(parseReproCapsule(exported.text).request.name).toBe("List orders");

		const imported = intelligence.importCapsule(exported.text);
		expect(imported).toMatchObject({
			dirty: true,
			autoSend: false,
			autoSave: false,
			draft: { name: "List orders", method: "GET" },
		});
		expect(imported.warnings).toContain("Review and provide every required input before sending this draft.");
	});
});
