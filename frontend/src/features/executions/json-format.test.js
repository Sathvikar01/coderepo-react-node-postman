import { describe, expect, test } from "bun:test";
import { formatJsonText, parseJsonDocument } from "./json-format.js";

describe("json pretty formatting", () => {
	test("pretty prints nested documents with two-space indentation", () => {
		const result = formatJsonText('{"a":1,"b":[1,2],"c":{"d":null,"e":true},"f":[],"g":{}}');
		expect(result).toEqual({
			ok: true,
			text: [
				"{",
				'  "a": 1,',
				'  "b": [',
				"    1,",
				"    2",
				"  ],",
				'  "c": {',
				'    "d": null,',
				'    "e": true',
				"  },",
				'  "f": [],',
				'  "g": {}',
				"}",
			].join("\n"),
		});
	});

	test("preserves number literals that JSON.parse would round or null out", () => {
		const result = formatJsonText('{"id":12345678901234567890,"big":1e400,"neg":-0}');
		expect(result.ok).toBe(true);
		expect(result.text).toContain("12345678901234567890");
		expect(result.text).toContain("1e400");
		expect(result.text).toContain("-0");
		expect(result.text).not.toContain("null");
	});

	test("preserves duplicate keys and escape sequences from the source", () => {
		const result = formatJsonText('{"a":1,"a":2,"s":"a\\u0041\\n"}');
		expect(result.ok).toBe(true);
		expect(result.text).toContain('"a": 1');
		expect(result.text).toContain('"a": 2');
		expect(result.text).toContain('"a\\u0041\\n"');
	});

	test("refuses invalid JSON with a reason", () => {
		const result = formatJsonText('{"a":');
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("not valid JSON");
	});

	test("refuses documents that nest deeper than the budget instead of exploding", () => {
		const result = formatJsonText("[".repeat(300) + "1" + "]".repeat(300));
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("nests deeper");
	});

	test("formats deep documents below the budget without recursion", () => {
		const depth = 200;
		const result = formatJsonText("[".repeat(depth) + "1" + "]".repeat(depth));
		expect(result.ok).toBe(true);
		expect(result.text.split("\n")).toHaveLength(depth * 2 + 1);
		expect(result.text).toContain("1");
	});
});

describe("json document parsing", () => {
	test("wraps numbers so exact literals survive into the tree", () => {
		const result = parseJsonDocument('{"a":12345678901234567890,"b":1.5e-9,"c":"x","d":true,"e":null}');
		expect(result.ok).toBe(true);
		expect(result.value.a).toEqual({ __number: "12345678901234567890" });
		expect(result.value.b).toEqual({ __number: "1.5e-9" });
		expect(result.value.c).toBe("x");
		expect(result.value.d).toBe(true);
		expect(result.value.e).toBeNull();
	});

	test("rejects invalid JSON and excessive nesting", () => {
		expect(parseJsonDocument("{nope}").ok).toBe(false);
		const deep = parseJsonDocument("[".repeat(300) + "1" + "]".repeat(300));
		expect(deep.ok).toBe(false);
		expect(deep.reason).toContain("nests deeper");
	});
});
