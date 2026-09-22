import { describe, expect, test } from "bun:test";
import {
	ASSERTION_LIMIT,
	ASSERTION_OPERATORS,
	assertionsOf,
	describeAssertion,
	enabledAssertionCount,
	newAssertion,
	operatorDefaults,
	targetDefaults,
} from "./assertions.js";

describe("assertion helpers", () => {
	test("builds target-appropriate defaults", () => {
		expect(newAssertion()).toMatchObject({ target: "status", operator: "equals", expected: "200" });
		expect(newAssertion("header")).toMatchObject({ target: "header", operator: "exists", path: "" });
		expect(newAssertion("json")).toMatchObject({ target: "json", operator: "exists", path: "data.id" });
		expect(targetDefaults("body")).toMatchObject({ operator: "contains", path: "" });
		expect(ASSERTION_OPERATORS.header.map((option) => option.value)).toContain("contains");
	});

	test("resets dependent fields on target change and seeds range bounds", () => {
		expect(targetDefaults("status")).toMatchObject({ expected: "200", path: "" });
		expect(operatorDefaults({ target: "status", operator: "range", min: null, max: null })).toEqual({ min: 200, max: 299 });
		expect(operatorDefaults({ target: "status", operator: "range", min: 100, max: 199 })).toEqual({});
		expect(operatorDefaults({ target: "json", operator: "equals" })).toEqual({});
	});

	test("reads request assertions and counts enabled rows", () => {
		const request = { assertions: [{ enabled: true }, { enabled: false }, {}] };
		expect(assertionsOf(request)).toHaveLength(3);
		expect(assertionsOf(undefined)).toEqual([]);
		expect(enabledAssertionCount(request)).toBe(2);
		expect(ASSERTION_LIMIT).toBe(50);
	});

	test("describes each assertion shape for summaries", () => {
		expect(describeAssertion({ target: "status", operator: "equals", expected: "200" })).toBe("status equals 200");
		expect(describeAssertion({ target: "status", operator: "range", min: 200, max: 299 })).toBe("status in 200-299");
		expect(describeAssertion({ target: "header", operator: "exists", path: "Content-Type" })).toBe("header Content-Type exists");
		expect(describeAssertion({ target: "header", operator: "equals", path: "X-Tag", expected: "beta" })).toBe('header X-Tag equals "beta"');
		expect(describeAssertion({ target: "body", operator: "contains", expected: "ok" })).toBe('body contains "ok"');
		expect(describeAssertion({ target: "json", operator: "equals", path: "count", valueType: "number", expected: "3" })).toBe(
			"json count equals 3 (number)",
		);
		expect(describeAssertion({ target: "json", operator: "equals", path: "empty", valueType: "null" })).toBe("json empty is null");
		expect(describeAssertion(null)).toBe("Assertion");
	});
});
