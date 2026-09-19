import { describe, expect, test } from "bun:test";
import { persistenceFrom, terminalResult } from "./execution.service.js";

const baseRecord = {
	executionId: "exec-1",
	outcome: "response",
	effectCertainty: "may_have_reached_target",
	response: { status: 200 },
	error: null,
	persistence: { state: "saved" },
	startedAt: new Date("2026-09-19T10:00:00.000Z"),
	finishedAt: new Date("2026-09-19T10:00:01.000Z"),
	request: {
		schemaVersion: 1,
		id: "r1",
		name: "List orders",
		method: "GET",
		urlTemplate: "http://127.0.0.1:8000/demo/v1/{{dataset}}/orders",
	},
	snapshot: { displayUrl: "http://127.0.0.1:8000/demo/v1/local/orders", effectiveAuth: { mode: "none" } },
	compileTrace: [{ field: "url", variable: "dataset", scope: "environment" }],
	warnings: [{ code: "DECODED_LIMIT" }],
	visible: true,
};

describe("terminal result contract", () => {
	test("carries trace, warnings, request snapshot and history id for status and cancel responses", () => {
		const result = terminalResult(baseRecord);

		expect(result.compileTrace).toEqual(baseRecord.compileTrace);
		expect(result.warnings).toEqual(baseRecord.warnings);
		expect(result.request).toEqual(baseRecord.request);
		expect(result.historyId).toBe("exec-1");
	});

	test("defaults trace and warnings to empty arrays for records written before the trace contract", () => {
		const legacy = { ...baseRecord, compileTrace: undefined, warnings: undefined };
		const result = terminalResult(legacy);

		expect(result.compileTrace).toEqual([]);
		expect(result.warnings).toEqual([]);
	});
});

describe("persistence acknowledgment contract", () => {
	test("saved only when finalization returned the terminal record", () => {
		expect(persistenceFrom(baseRecord)).toEqual({ state: "saved" });
	});

	test("unknown when finalization could not be confirmed", () => {
		const state = persistenceFrom(null);

		expect(state.state).toBe("unknown");
		expect(state.warning).toBeTruthy();
	});
});
