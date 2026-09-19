import { describe, expect, test } from "bun:test";
import { collectionAggregateSchema, requestDefinitionSchema } from "./schemas.js";

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
