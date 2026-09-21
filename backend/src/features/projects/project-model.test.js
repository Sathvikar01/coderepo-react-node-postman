import { describe, expect, test } from "bun:test";
import { ASSERTIONS_CONTRACT, TRACER_PROJECT_KIND, TRACER_PROJECT_VERSION, tracerProjectSchema } from "./project-schema.js";
import { parseProject, projectFingerprint, serializeProject } from "./project-serialize.js";

const REQUEST_1 = "11111111-1111-4111-8111-111111111111";
const REQUEST_2 = "22222222-2222-4222-8222-222222222222";
const FOLDER_1 = "33333333-3333-4333-8333-333333333333";
const ROW_1 = "44444444-4444-4444-8444-444444444441";
const ROW_2 = "44444444-4444-4444-8444-444444444442";
const ROW_3 = "44444444-4444-4444-8444-444444444443";
const ROW_4 = "44444444-4444-4444-8444-444444444444";
const ROW_5 = "44444444-4444-4444-8444-444444444445";
const VAR_1 = "55555555-5555-4555-8555-555555555551";
const VAR_2 = "55555555-5555-4555-8555-555555555552";
const VAR_3 = "55555555-5555-4555-8555-555555555553";

const requestId = (n) => `${String(n).padStart(8, "0")}-1111-4111-8111-${String(n).padStart(12, "0")}`;

function portableRequest(overrides = {}) {
	return {
		schemaVersion: 1,
		id: REQUEST_1,
		folderId: null,
		name: "List orders",
		method: "GET",
		urlTemplate: "https://api.test/orders",
		query: [{ id: ROW_1, key: "status", value: "paid", enabled: true }],
		headers: [{ id: ROW_2, key: "Accept", value: "application/json", enabled: true }],
		body: { mode: "none" },
		auth: { mode: "none" },
		scripts: { preRequest: "", test: "" },
		settings: { timeoutMs: 15000 },
		...overrides,
	};
}

function portableProject(overrides = {}) {
	return {
		schemaVersion: TRACER_PROJECT_VERSION,
		kind: TRACER_PROJECT_KIND,
		name: "Orders",
		description: "",
		collections: [
			{
				name: "Orders API",
				description: "Order management",
				variables: [{ id: VAR_1, key: "baseUrl", kind: "plain", value: "https://api.test", enabled: true }],
				auth: { mode: "none" },
				folders: [{ id: FOLDER_1, name: "Read" }],
				requests: [portableRequest({ folderId: FOLDER_1 })],
			},
		],
		environments: [],
		examples: [],
		...overrides,
	};
}

function caught(operation) {
	try {
		operation();
	} catch (error) {
		return error;
	}
	throw new Error("expected the operation to throw");
}

describe("canonical serialization", () => {
	test("emits object keys in lexicographic order at every level", () => {
		const parsed = JSON.parse(serializeProject(portableProject()));
		expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
		expect(Object.keys(parsed.collections[0])).toEqual([...Object.keys(parsed.collections[0])].sort());
		expect(Object.keys(parsed.collections[0].requests[0])).toEqual([...Object.keys(parsed.collections[0].requests[0])].sort());
		expect(Object.keys(parsed.collections[0].variables[0])).toEqual([...Object.keys(parsed.collections[0].variables[0])].sort());
		expect(Object.keys(parsed.collections[0].requests[0].auth)).toEqual([...Object.keys(parsed.collections[0].requests[0].auth)].sort());
	});

	test("is identical for the same logical project regardless of key insertion order", () => {
		const ordered = portableProject();
		const shuffled = {
			kind: TRACER_PROJECT_KIND,
			environments: [],
			examples: [],
			collections: [
				{
					requests: [portableRequest({ folderId: FOLDER_1 })],
					folders: [{ name: "Read", id: FOLDER_1 }],
					auth: { mode: "none" },
					variables: [{ value: "https://api.test", id: VAR_1, enabled: true, kind: "plain", key: "baseUrl" }],
					description: "Order management",
					name: "Orders API",
				},
			],
			description: "",
			name: "Orders",
			schemaVersion: TRACER_PROJECT_VERSION,
		};
		expect(serializeProject(shuffled)).toBe(serializeProject(ordered));
		expect(projectFingerprint(shuffled)).toBe(projectFingerprint(ordered));
	});

	test("repeated serialization is deterministic and array order is preserved", () => {
		const project = portableProject({
			collections: [
				{
					...portableProject().collections[0],
					requests: [portableRequest({ id: REQUEST_2, name: "Second" }), portableRequest({ id: REQUEST_1 })],
				},
			],
		});
		const first = serializeProject(project);
		expect(serializeProject(project)).toBe(first);
		const parsed = parseProject(first);
		const order = parsed.collections[0].requests.map((request) => request.name);
		expect(order).toEqual(["Second", "List orders"]);
		expect(serializeProject(parsed)).toBe(first);
	});

	test("fingerprint is sha256 hex, stable, and content sensitive", () => {
		const project = portableProject();
		const fingerprint = projectFingerprint(project);
		expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(projectFingerprint(parseProject(serializeProject(project)))).toBe(fingerprint);
		const changed = portableProject({
			collections: [{ ...portableProject().collections[0], description: "Changed" }],
		});
		expect(projectFingerprint(changed)).not.toBe(fingerprint);
	});
});

describe("schema validation", () => {
	test("rejects unsupported versions before schema validation", () => {
		const text = JSON.stringify({ ...portableProject(), schemaVersion: 2 });
		const error = caught(() => parseProject(text));
		expect(error.code).toBe("PROJECT_VERSION_UNSUPPORTED");
		expect(error.statusCode).toBe(422);
	});

	test("rejects malformed files", () => {
		expect(caught(() => parseProject("not json")).code).toBe("PROJECT_MALFORMED");
		expect(caught(() => parseProject("[]")).code).toBe("PROJECT_MALFORMED");
		expect(caught(() => parseProject("null")).code).toBe("PROJECT_MALFORMED");
		expect(caught(() => parseProject(42)).code).toBe("PROJECT_MALFORMED");
	});

	test("rejects structurally invalid projects", () => {
		const base = portableProject();
		expect(caught(() => parseProject(JSON.stringify({ ...base, kind: "postman.collection" }))).code).toBe("PROJECT_INVALID");
		expect(caught(() => parseProject(JSON.stringify({ ...base, collections: [] }))).code).toBe("PROJECT_INVALID");
		expect(
			caught(() =>
				parseProject(
					JSON.stringify({
						...base,
						collections: [{ ...base.collections[0], requests: [portableRequest({ method: "FETCH" })] }],
					}),
				),
			).code,
		).toBe("PROJECT_INVALID");
	});

	test("rejects unsafe or inconsistent definitions", () => {
		const base = portableProject();
		const collection = (requests) => ({ ...base.collections[0], requests });

		expect(
			caught(() =>
				parseProject(JSON.stringify({ ...base, collections: [collection([portableRequest({ method: "GET", body: { mode: "json", text: "{}" } })])] })),
			).code,
		).toBe("PROJECT_INVALID");
		expect(
			caught(() =>
				parseProject(
					JSON.stringify({
						...base,
						collections: [collection([portableRequest({ auth: { mode: "bearer", tokenTemplate: "sk-live-literal" } })])],
					}),
				),
			).code,
		).toBe("PROJECT_INVALID");
		expect(
			caught(() =>
				parseProject(
					JSON.stringify({
						...base,
						collections: [
							{
								...base.collections[0],
								variables: [{ id: VAR_1, key: "token", kind: "secretRef", value: "leaked", alias: "a", enabled: true }],
							},
						],
					}),
				),
			).code,
		).toBe("PROJECT_INVALID");
		expect(
			caught(() =>
				parseProject(
					JSON.stringify({
						...base,
						collections: [
							{ ...base.collections[0], variables: [{ id: VAR_1, key: "token", kind: "secretRef", enabled: true }] },
						],
					}),
				),
			).code,
		).toBe("PROJECT_INVALID");
		expect(
			caught(() => parseProject(JSON.stringify({ ...base, collections: [base.collections[0], base.collections[0]] }))).code,
		).toBe("PROJECT_INVALID");
		expect(
			caught(() =>
				parseProject(
					JSON.stringify({
						...base,
						collections: [
							{
								...base.collections[0],
								requests: [portableRequest(), portableRequest({ name: "Duplicate id" })],
							},
						],
					}),
				),
			).code,
		).toBe("PROJECT_INVALID");
		expect(
			caught(() =>
				parseProject(
					JSON.stringify({
						...base,
						collections: [{ ...base.collections[0], requests: [portableRequest({ folderId: "99999999-9999-4999-8999-999999999999" })] }],
					}),
				),
			).code,
		).toBe("PROJECT_INVALID");
	});
});

describe("unknown-field policy", () => {
	test("preserves unknown keys through parse and re-serialization", () => {
		const text = JSON.stringify({
			...portableProject({
				collections: [
					{
						...portableProject().collections[0],
						futureCollectionKey: { note: "keep me" },
						requests: [
							portableRequest({
								futureRequestKey: [1, 2, 3],
							}),
						],
						variables: [{ id: VAR_2, key: "local", kind: "plain", value: "x", enabled: true, futureVariableKey: true }],
					},
				],
			}),
			futureProjectKey: "v1.1 data",
		});
		const parsed = parseProject(text);
		expect(parsed.futureProjectKey).toBe("v1.1 data");
		expect(parsed.collections[0].futureCollectionKey).toEqual({ note: "keep me" });
		expect(parsed.collections[0].requests[0].futureRequestKey).toEqual([1, 2, 3]);
		expect(parsed.collections[0].variables[0].futureVariableKey).toBe(true);

		const reserialized = parseProject(serializeProject(parsed));
		expect(reserialized.futureProjectKey).toBe("v1.1 data");
		expect(reserialized.collections[0].requests[0].futureRequestKey).toEqual([1, 2, 3]);
		expect(serializeProject(reserialized)).toBe(serializeProject(parsed));
	});
});

describe("unicode and size bounds", () => {
	test("round-trips unicode identifiers and values", () => {
		const project = portableProject({
			name: "依頼 🚀",
			collections: [
				{
					...portableProject().collections[0],
					name: "Ordres — café ☕",
					description: "e\u0301 combining, 日本語, emoji 🛰️",
					requests: [portableRequest({ name: "こんにちは 🌏", urlTemplate: "https://api.test/日本語/🚀" })],
				},
			],
		});
		const parsed = parseProject(serializeProject(project));
		expect(parsed.name).toBe("依頼 🚀");
		expect(parsed.collections[0].requests[0].urlTemplate).toBe("https://api.test/日本語/🚀");
	});

	test("enforces byte-based value limits instead of code-unit limits", () => {
		const variable = (value) => ({
			id: VAR_3,
			key: "token",
			kind: "plain",
			value,
			enabled: true,
		});
		const withVariable = (value) =>
			portableProject({
				collections: [{ ...portableProject().collections[0], variables: [variable(value)] }],
			});
		expect(typeof serializeProject(withVariable("é".repeat(4096)))).toBe("string");
		const error = caught(() => serializeProject(withVariable("é".repeat(4096) + "a")));
		expect(error.code).toBe("PROJECT_INVALID");
		expect(error.details.issues[0].path).toBe("collections.0.variables.0.value");
	});

	test("rejects projects above the portable byte ceiling", () => {
		const requests = Array.from({ length: 100 }, (_, index) =>
			portableRequest({
				id: requestId(index + 1),
				name: `Request ${index + 1}`,
				method: "POST",
				body: { mode: "json", text: "a".repeat(100_000) },
			}),
		);
		const project = portableProject({ collections: [{ ...portableProject().collections[0], requests }] });
		const error = caught(() => serializeProject(project));
		expect(error.code).toBe("PROJECT_LIMIT");
		expect(error.statusCode).toBe(413);
		const oversized = `{"schemaVersion":1,"kind":"tracer.project","collections":[${" ".repeat(9 * 1024 * 1024)}]}`;
		expect(caught(() => parseProject(oversized)).code).toBe("PROJECT_LIMIT");
	});

	test("accepts the assertions envelope contract and rejects anything else", () => {
		const withAssertions = portableProject({
			collections: [
				{
					...portableProject().collections[0],
					requests: [
						portableRequest({
							assertions: { contract: ASSERTIONS_CONTRACT, items: [{ id: "a1", kind: "status", expected: 200 }] },
						}),
					],
				},
			],
		});
		const parsed = parseProject(serializeProject(withAssertions));
		expect(parsed.collections[0].requests[0].assertions.items).toEqual([{ id: "a1", kind: "status", expected: 200 }]);
		expect(
			caught(() =>
				serializeProject(
					portableProject({
						collections: [
							{
								...portableProject().collections[0],
								requests: [portableRequest({ assertions: { contract: "other/2", items: [] } })],
							},
						],
					}),
				),
			).code,
		).toBe("PROJECT_INVALID");
	});

	test("preserves duplicate header and query keys in order without merging", () => {
		const duplicated = portableProject({
			collections: [
				{
					...portableProject().collections[0],
					requests: [
						portableRequest({
							headers: [
								{ id: ROW_1, key: "Accept", value: "application/json", enabled: true },
								{ id: ROW_2, key: "Accept", value: "text/plain", enabled: true },
								{ id: ROW_3, key: "accept", value: "application/xml", enabled: true },
							],
							query: [
								{ id: ROW_4, key: "tag", value: "one", enabled: true },
								{ id: ROW_5, key: "tag", value: "two", enabled: true },
							],
						}),
					],
				},
			],
		});
		const parsed = parseProject(serializeProject(duplicated));
		const request = parsed.collections[0].requests[0];
		expect(request.headers.map((row) => [row.key, row.value])).toEqual([
			["Accept", "application/json"],
			["Accept", "text/plain"],
			["accept", "application/xml"],
		]);
		expect(request.query.map((row) => [row.key, row.value])).toEqual([
			["tag", "one"],
			["tag", "two"],
		]);
	});

	test("validates the whole project object, not just the serialized path", () => {
		expect(tracerProjectSchema.safeParse(portableProject()).success).toBe(true);
		expect(tracerProjectSchema.safeParse(portableProject({ schemaVersion: 2 })).success).toBe(false);
	});
});
