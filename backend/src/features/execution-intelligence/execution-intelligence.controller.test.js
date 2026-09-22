import { describe, expect, test } from "bun:test";
import { parseCapsuleExportInput, parseCapsuleImportInput, parseComparisonInput } from "./execution-intelligence.controller.js";

const BASE = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = "22222222-2222-4222-8222-222222222222";

describe("execution intelligence request contracts", () => {
	test("accepts exactly two different execution identifiers", () => {
		expect(parseComparisonInput({ baseExecutionId: BASE, candidateExecutionId: CANDIDATE })).toEqual({
			baseExecutionId: BASE,
			candidateExecutionId: CANDIDATE,
		});
	});

	test("rejects invalid, repeated, and extra comparison input", () => {
		expect(() => parseComparisonInput({ baseExecutionId: "bad", candidateExecutionId: CANDIDATE })).toThrow();
		expect(() => parseComparisonInput({ baseExecutionId: BASE, candidateExecutionId: BASE })).toThrow();
		expect(() => parseComparisonInput({ baseExecutionId: BASE, candidateExecutionId: CANDIDATE, receipt: {} })).toThrow();
	});

	test("validates capsule export and import payloads strictly", () => {
		expect(parseCapsuleExportInput({ executionId: BASE })).toEqual({ executionId: BASE, includeResponseBody: false });
		expect(parseCapsuleExportInput({ executionId: BASE, includeResponseBody: true })).toEqual({
			executionId: BASE,
			includeResponseBody: true,
		});
		expect(parseCapsuleImportInput({ text: "{}" })).toEqual({ text: "{}" });
		expect(() => parseCapsuleExportInput({ executionId: BASE, extra: true })).toThrow();
		expect(() => parseCapsuleImportInput({ text: "", extra: true })).toThrow();
	});
});
