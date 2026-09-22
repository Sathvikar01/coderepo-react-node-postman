import { describe, expect, test } from "bun:test";
import { LIMITS } from "./limits.js";
import { assertionSchema, collectionAggregateSchema, requestDefinitionSchema } from "./schemas.js";

const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
const id2 = "1f8fad5b-d9cb-469f-a165-70867728950e";

const request = (auth = { mode: "none" }) => ({
	schemaVersion: 1,
	id,
	folderId: null,
	name: "Probe",
	method: "GET",
	urlTemplate: "https://example.com",
	query: [],
	headers: [],
	body: { mode: "none" },
	auth,
	settings: { timeoutMs: 15000 },
});

describe("saved request auth contract", () => {
	test("rejects literal saved bearer credentials", () => {
		expect(() => requestDefinitionSchema.parse(request({ mode: "bearer", tokenTemplate: "literal-secret" }))).toThrow();
		expect(
			requestDefinitionSchema.parse(request({ mode: "bearer", tokenTemplate: "{{token}}" })).auth.tokenTemplate,
		).toBe("{{token}}");
	});
});

describe("saved request assertions contract", () => {
	const assertion = (overrides = {}) => ({ id, name: "check", target: "status", operator: "equals", expected: "200", ...overrides });

	test("defaults to no assertions and accepts valid definitions", () => {
		expect(requestDefinitionSchema.parse(request()).assertions).toEqual([]);
		const parsed = requestDefinitionSchema.parse({
			...request(),
			assertions: [
				assertion(),
				assertion({ id: id2, name: "range", operator: "range", expected: "", min: 200, max: 299 }),
				assertion({ id: id2, name: "header", target: "header", operator: "exists", path: "content-type" }),
				assertion({ id: id2, name: "json", target: "json", operator: "equals", path: "items[0].sku", valueType: "number", expected: "3" }),
			],
		});
		expect(parsed.assertions).toHaveLength(4);
	});

	test("rejects unsupported combinations and non-numeric numerics", () => {
		expect(() => assertionSchema.parse(assertion({ operator: "range" }))).toThrow();
		expect(() => assertionSchema.parse(assertion({ expected: "ok" }))).toThrow();
		expect(() => assertionSchema.parse(assertion({ target: "status", path: "code" }))).toThrow();
		expect(() =>
			assertionSchema.parse(assertion({ target: "json", operator: "equals", path: "count", valueType: "number", expected: "three" })),
		).toThrow();
		expect(() => assertionSchema.parse(assertion({ target: "json", operator: "equals", path: "" }))).toThrow();
	});

	test("caps assertions per request", () => {
		const many = Array.from({ length: LIMITS.assertionsPerRequest + 1 }, () => assertion());
		expect(() => requestDefinitionSchema.parse({ ...request(), assertions: many })).toThrow();
	});
});

describe("collection aggregate contract", () => {
	test("rejects inherited collection auth and normalized duplicate folder names", () => {
		const base = { name: "Collection", description: "", variables: [], requests: [] };
		expect(() =>
			collectionAggregateSchema.parse({ ...base, auth: { mode: "inherit" }, folders: [] }),
		).toThrow();
		expect(() =>
			collectionAggregateSchema.parse({
				...base,
				auth: { mode: "none" },
				folders: [
					{ id, name: "Read" },
					{ id: id2, name: " read " },
				],
			}),
		).toThrow();
	});
});
