import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { LIMITS } from "../../shared/utils/limits.js";
import {
	assertionsDefinitionOf,
	evaluateAssertions,
	executionFailurePredicate,
	normalizeAssertion,
	resolveJsonPath,
} from "./assertions.js";

function view(overrides = {}) {
	return {
		status: 200,
		statusText: "OK",
		headers: [
			{ name: "Content-Type", value: "application/json" },
			{ name: "X-Tag", value: "alpha" },
		],
		body: '{"ok":true,"count":3,"name":"tracer","flag":false,"empty":null}',
		binary: false,
		truncated: false,
		...overrides,
	};
}

function assertion(overrides = {}) {
	return normalizeAssertion({
		id: randomUUID(),
		name: "check",
		enabled: true,
		target: "status",
		operator: "equals",
		path: "",
		expected: "200",
		valueType: "string",
		min: null,
		max: null,
		...overrides,
	});
}

const evaluate = (overrides, response = view()) => evaluateAssertions([assertion(overrides)], response)[0];

describe("status assertions", () => {
	test("matches equality and reports expected vs actual", () => {
		expect(evaluate({ target: "status", operator: "equals", expected: "200" })).toMatchObject({ status: "passed", expected: "200", actual: "200" });
		expect(evaluate({ target: "status", operator: "equals", expected: "201" })).toMatchObject({
			status: "failed",
			expected: "201",
			actual: "200",
		});
	});

	test("matches inclusive ranges", () => {
		expect(evaluate({ target: "status", operator: "range", expected: "", min: 200, max: 299 }).status).toBe("passed");
		expect(evaluate({ target: "status", operator: "range", expected: "", min: 300, max: 399 })).toMatchObject({
			status: "failed",
			expected: "300-399",
			actual: "200",
		});
	});

	test("errors when equality has no numeric expected value", () => {
		expect(evaluate({ target: "status", operator: "equals", expected: "ok" }).status).toBe("error");
	});
});

describe("header assertions", () => {
	test("handles present, missing, equal, and duplicate headers", () => {
		expect(evaluate({ target: "header", operator: "exists", path: "content-type" }).status).toBe("passed");
		expect(evaluate({ target: "header", operator: "exists", path: "X-Absent" })).toMatchObject({ status: "failed", actual: "<missing>" });
		expect(evaluate({ target: "header", operator: "equals", path: "x-tag", expected: "alpha" }).status).toBe("passed");
		const duplicate = view({ headers: [{ name: "X-Tag", value: "alpha" }, { name: "X-Tag", value: "beta" }] });
		expect(evaluate({ target: "header", operator: "equals", path: "x-tag", expected: "beta" }, duplicate)).toMatchObject({
			status: "passed",
			actual: "alpha, beta",
		});
		expect(evaluate({ target: "header", operator: "contains", path: "x-tag", expected: "bet" }, duplicate).status).toBe("passed");
		expect(evaluate({ target: "header", operator: "equals", path: "x-tag", expected: "gamma" }, duplicate).status).toBe("failed");
	});

	test("errors when the header name is missing", () => {
		expect(evaluate({ target: "header", operator: "exists", path: "   " }).status).toBe("error");
	});
});

describe("body assertions", () => {
	test("compares text with equality and containment", () => {
		expect(evaluate({ target: "body", operator: "contains", expected: '"ok":true' }).status).toBe("passed");
		expect(evaluate({ target: "body", operator: "equals", expected: '{"ok":true,"count":3,"name":"tracer","flag":false,"empty":null}' }).status).toBe("passed");
		expect(evaluate({ target: "body", operator: "equals", expected: "nope" }).status).toBe("failed");
	});

	test("errors for binary bodies but compares empty bodies as text", () => {
		expect(evaluate({ target: "body", operator: "equals", expected: "" }, view({ body: null, binary: false })).status).toBe("passed");
		expect(evaluate({ target: "body", operator: "equals", expected: "" }, view({ body: null, binary: true })).status).toBe("error");
	});
});

describe("json assertions", () => {
	test("matches typed scalars and bounded paths", () => {
		expect(evaluate({ target: "json", operator: "equals", path: "name", valueType: "string", expected: "tracer" }).status).toBe("passed");
		expect(evaluate({ target: "json", operator: "equals", path: "count", valueType: "number", expected: "3" }).status).toBe("passed");
		expect(evaluate({ target: "json", operator: "equals", path: "count", valueType: "number", expected: "4" })).toMatchObject({
			status: "failed",
			expected: "4",
			actual: "3",
		});
		expect(evaluate({ target: "json", operator: "equals", path: "flag", valueType: "boolean", expected: "false" }).status).toBe("passed");
		expect(evaluate({ target: "json", operator: "equals", path: "empty", valueType: "null", expected: "" }).status).toBe("passed");
		expect(evaluate({ target: "json", operator: "equals", path: "ok", valueType: "string", expected: "true" }).status).toBe("failed");
	});

	test("reports missing paths as failures and malformed bodies as errors", () => {
		expect(evaluate({ target: "json", operator: "exists", path: "nested.value" })).toMatchObject({ status: "failed", actual: "<missing>" });
		expect(evaluate({ target: "json", operator: "equals", path: "nested.value", valueType: "number", expected: "1" })).toMatchObject({
			status: "failed",
			actual: "<missing>",
		});
		expect(evaluate({ target: "json", operator: "exists", path: "ok" }, view({ body: "not json" })).status).toBe("error");
		expect(evaluate({ target: "json", operator: "exists", path: "ok" }, view({ body: "" })).status).toBe("error");
		expect(evaluate({ target: "json", operator: "exists", path: "ok" }, view({ body: null, binary: true })).status).toBe("error");
	});

	test("resolves array indices", () => {
		const payload = view({ body: '{"items":[{"sku":"a"},{"sku":"b"}]}' });
		expect(evaluate({ target: "json", operator: "equals", path: "items[1].sku", valueType: "string", expected: "b" }, payload).status).toBe("passed");
		expect(resolveJsonPath(JSON.parse(payload.body), "$.items[0].sku")).toEqual({ found: true, value: "a" });
		expect(resolveJsonPath({ a: 1 }, "a[9]")).toEqual({ found: false, value: undefined });
		expect(resolveJsonPath({ a: 1 }, "$")).toEqual({ found: true, value: { a: 1 } });
	});
});

describe("assertion results", () => {
	test("keeps order, isolation, and a deterministic failure predicate", () => {
		const definitions = [
			assertion({ name: "status ok", target: "status", operator: "equals", expected: "200" }),
			assertion({ name: "missing header", target: "header", operator: "exists", path: "X-Absent" }),
			assertion({ name: "bad json", target: "json", operator: "exists", path: "ok" }),
		];
		const records = evaluateAssertions(definitions, view({ body: "not json" }));
		expect(records.map((record) => record.name)).toEqual(["status ok", "missing header", "bad json"]);
		expect(records.map((record) => record.status)).toEqual(["passed", "failed", "error"]);
		const predicate = executionFailurePredicate({ tests: records });
		expect(predicate.failed).toBe(true);
		expect(predicate.failures.map((failure) => failure.status)).toEqual(["failed", "error"]);
		expect(executionFailurePredicate({ tests: [records[0]] })).toEqual({ failed: false, failures: [] });
	});

	test("errors on unknown targets and caps the number of assertions", () => {
		expect(evaluateAssertions([normalizeAssertion({ target: "magic", operator: "equals" })], view())[0].status).toBe("error");
		const many = Array.from({ length: LIMITS.assertionsPerRequest + 5 }, (_, index) =>
			assertion({ name: `check ${index}`, target: "status", operator: "equals", expected: "200" }),
		);
		expect(evaluateAssertions(many, view())).toHaveLength(LIMITS.assertionsPerRequest);
	});

	test("only returns enabled definitions from a request", () => {
		const request = {
			assertions: [
				{ id: randomUUID(), name: "on", enabled: true, target: "status", operator: "equals", expected: "200" },
				{ id: randomUUID(), name: "off", enabled: false, target: "status", operator: "equals", expected: "500" },
			],
		};
		expect(assertionsDefinitionOf(request).map((definition) => definition.name)).toEqual(["on"]);
		expect(assertionsDefinitionOf({})).toEqual([]);
	});
});
