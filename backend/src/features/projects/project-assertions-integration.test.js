import { describe, expect, test } from "bun:test";
import { ASSERTIONS_CONTRACT } from "./project-schema.js";
import { projectFromDomain } from "./project-export.js";
import { projectToDomain } from "./project-import.js";
import { parseProject, serializeProject } from "./project-serialize.js";

const REQUEST_1 = "11111111-1111-4111-8111-111111111111";
const REQUEST_2 = "11111111-1111-4111-8111-111111111112";
const ROW_1 = "44444444-4444-4444-8444-444444444441";

const definition = (n, name, target, operator, extra = {}) => ({
	id: `aaaaaaaa-1111-4111-8111-aaaaaaaaaaa${n}`,
	name,
	enabled: true,
	target,
	operator,
	path: "",
	expected: "",
	valueType: "string",
	min: null,
	max: null,
	...extra,
});

const ALL_TYPES = [
	definition(1, "status equals", "status", "equals", { expected: "200" }),
	definition(2, "status range", "status", "range", { min: 200, max: 299 }),
	definition(3, "header exists", "header", "exists", { path: "content-type" }),
	definition(4, "header equals", "header", "equals", { path: "content-type", expected: "application/json" }),
	definition(5, "header contains", "header", "contains", { path: "content-type", expected: "json" }),
	definition(6, "body equals", "body", "equals", { expected: "orders" }),
	definition(7, "body contains", "body", "contains", { expected: "orders" }),
	definition(8, "json exists", "json", "exists", { path: "orders" }),
	definition(9, "json equals", "json", "equals", { path: "count", valueType: "number", expected: "42" }),
];

function requestDoc(id, overrides = {}) {
	return {
		schemaVersion: 1,
		id,
		folderId: null,
		name: `Request ${id.slice(-1)}`,
		method: "GET",
		urlTemplate: "https://api.test/things",
		query: [],
		headers: [{ id: ROW_1, key: "Accept", value: "application/json", enabled: true }],
		body: { mode: "none" },
		auth: { mode: "none" },
		scripts: { preRequest: "", test: "" },
		settings: { timeoutMs: 15000 },
		...overrides,
	};
}

function collectionDoc(assertionsByRequest = {}) {
	return {
		name: "Things API",
		description: "",
		variables: [],
		auth: { mode: "none" },
		folders: [],
		requests: [requestDoc(REQUEST_1, assertionsByRequest[REQUEST_1] ? { assertions: assertionsByRequest[REQUEST_1] } : {}),
			requestDoc(REQUEST_2)],
	};
}

const portableBase = (assertions) =>
	parseProject(serializeProject(projectFromDomain({ collections: [collectionDoc({ [REQUEST_1]: assertions })] })));

function caught(operation) {
	try {
		operation();
	} catch (error) {
		return error;
	}
	throw new Error("expected the operation to throw");
}

describe("Phase 12 assertions through TracerProjectV1", () => {
	test("round-trips every assertion type with ids, names, and order intact", () => {
		const exported = projectFromDomain({ collections: [collectionDoc({ [REQUEST_1]: ALL_TYPES })] });
		expect(exported.collections[0].requests[0].id).toBe(REQUEST_1);
		expect(exported.collections[0].requests[0].assertions).toEqual({ contract: ASSERTIONS_CONTRACT, items: ALL_TYPES });
		expect(exported.collections[0].requests[0].assertions.items.map((item) => item.id)).toEqual(ALL_TYPES.map((item) => item.id));
		expect(exported.collections[0].requests[0].assertions.items.map((item) => item.name)).toEqual(ALL_TYPES.map((item) => item.name));

		const applied = projectToDomain(parseProject(serializeProject(exported)));
		expect(applied.collections[0].requests[0].id).toBe(REQUEST_1);
		expect(applied.collections[0].requests[0].assertions).toEqual(ALL_TYPES);
		expect(applied.collections[0].requests[0].assertions.map((item) => item.id)).toEqual(ALL_TYPES.map((item) => item.id));
		expect(applied.collections[0].requests[1].assertions).toEqual([]);
	});

	test("re-export after import produces an identical portable project", () => {
		const exported = projectFromDomain({ collections: [collectionDoc({ [REQUEST_1]: ALL_TYPES })] });
		const applied = projectToDomain(serializeProject(exported));
		const reexported = projectFromDomain({ collections: applied.collections, environments: applied.environments, examples: applied.examples });
		expect(serializeProject(reexported)).toBe(serializeProject(exported));
	});

	test("rejects a malformed assertion envelope on import", () => {
		const missingItems = portableBase([ALL_TYPES[0]]);
		delete missingItems.collections[0].requests[0].assertions.items;
		expect(caught(() => projectToDomain(missingItems)).code).toBe("PROJECT_INVALID");

		const missingContract = portableBase([ALL_TYPES[0]]);
		delete missingContract.collections[0].requests[0].assertions.contract;
		expect(caught(() => projectToDomain(missingContract)).code).toBe("PROJECT_INVALID");

		const nonObject = portableBase([ALL_TYPES[0]]);
		nonObject.collections[0].requests[0].assertions = ASSERTIONS_CONTRACT;
		expect(caught(() => projectToDomain(nonObject)).code).toBe("PROJECT_INVALID");

		const nonArrayItems = portableBase([ALL_TYPES[0]]);
		nonArrayItems.collections[0].requests[0].assertions.items = "not-an-array";
		expect(caught(() => projectToDomain(nonArrayItems)).code).toBe("PROJECT_INVALID");
	});

	test("rejects an unknown assertion type on both export and import", () => {
		const unknown = { ...ALL_TYPES[0], target: "cookie", operator: "exists" };
		expect(caught(() => projectFromDomain({ collections: [collectionDoc({ [REQUEST_1]: [unknown] })] })).code).toBe("PROJECT_DOMAIN_INVALID");

		const portable = portableBase([ALL_TYPES[0]]);
		portable.collections[0].requests[0].assertions = { contract: ASSERTIONS_CONTRACT, items: [unknown] };
		expect(caught(() => projectToDomain(portable)).code).toBe("PROJECT_DOMAIN_INVALID");
	});

	test("rejects an assertion with a missing target on both export and import", () => {
		const { target, ...withoutTarget } = ALL_TYPES[0];
		expect(caught(() => projectFromDomain({ collections: [collectionDoc({ [REQUEST_1]: [withoutTarget] })] })).code).toBe("PROJECT_DOMAIN_INVALID");

		const portable = portableBase([ALL_TYPES[0]]);
		portable.collections[0].requests[0].assertions = { contract: ASSERTIONS_CONTRACT, items: [withoutTarget] };
		expect(caught(() => projectToDomain(portable)).code).toBe("PROJECT_DOMAIN_INVALID");
	});

	test("rejects an unsupported envelope version", () => {
		const portable = portableBase([ALL_TYPES[0]]);
		portable.collections[0].requests[0].assertions = { contract: "tracer.assertions/9", items: [] };
		expect(caught(() => projectToDomain(portable)).code).toBe("PROJECT_INVALID");
		expect(
			caught(() =>
				serializeProject({
					...portableBase([ALL_TYPES[0]]),
					collections: [
						{
							...portableBase([ALL_TYPES[0]]).collections[0],
							requests: [
								{ ...portableBase([ALL_TYPES[0]]).collections[0].requests[0], assertions: { contract: "tracer.assertions/9", items: [] } },
							],
						},
					],
				}),
			).code,
		).toBe("PROJECT_INVALID");
	});

	test("never exports historical results as editable assertion definitions", () => {
		const historicalResults = [
			{
				name: "status is 200",
				status: "passed",
				assertionId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1",
				expected: "200",
				actual: "200",
			},
		];
		expect(caught(() => projectFromDomain({ collections: [collectionDoc({ [REQUEST_1]: historicalResults })] })).code).toBe(
			"PROJECT_DOMAIN_INVALID",
		);

		const exported = projectFromDomain({ collections: [collectionDoc()] });
		expect(exported.collections[0].requests[0].assertions).toBeUndefined();
		expect(serializeProject(exported)).not.toContain("tracer.assertions/1");
	});
});
