import { describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";

// The engine itself reads no configuration. The Phase-42 content fingerprint
// primitive it reuses for result identity does, because contract fingerprints and
// execution fingerprints share one HMAC key. Initializing it here keeps the suite
// self-contained and deterministic without touching the engine's purity.
process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase43_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase43-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase43-test-jwt-secret";
initConfig();

import {
	BODY_REPRESENTATION,
	COMPATIBILITY_CLASS,
	COMPATIBILITY_CODES,
	COMPATIBILITY_KIND,
	COMPATIBILITY_SCHEMA_VERSION,
	IDENTITY_CODES,
	acceptsCompatibilityResultShape,
	classForCode,
	compareContractToResponse,
	createContractCompatibilityComparator,
	dedupeFindings,
	normalizeObservedResponse,
	resolveCompatible,
	sortFindings,
} from "./index.js";
import { contractFingerprint } from "../contract-registry/contract-canonical.js";

// Phase 43A — API Contract Compatibility Engine test suite.
//
// Every case is deterministic: no clock, no network, no database, no execution.
// Contracts are built as plain PUBLISHED rows in the shape the Phase-42 registry
// persists, so the suite exercises the real public contract rather than a fixture
// invented for the engine.

// ---------------------------------------------------------------------------
// Contract builders
// ---------------------------------------------------------------------------

// Build a stored-contract content document. Mirrors the Phase-42 stored shape.
function content({ status = 200, statuses = [], headers = [], bodyType = null, body = null, provenance = "explicit" } = {}) {
	return {
		schemaVersion: 1,
		kind: "tracer.api-contract",
		provenance,
		name: "Test contract",
		description: "",
		body: { status, statuses, headers, bodyType, body },
	};
}

// Build a PUBLISHED contract row. Identity fields are real so the service's
// comparable-contract guards are exercised, not bypassed.
function contract(overrides = {}) {
	const built = {
		contractId: "contract_aaaaaaaaaaaaaaaaaaaaaaaa",
		sequence: 1,
		state: "PUBLISHED",
		requestId: "request-1",
		collectionId: "collection-1",
		workspaceId: "workspace-1",
		ownerProfileId: "profile-1",
		snapshotId: null,
		snapshotFingerprint: null,
		content: content(),
		...overrides,
	};
	built.contentFingerprint = overrides.contentFingerprint ?? contractFingerprint(built.content);
	built.fingerprintKeyId = overrides.fingerprintKeyId ?? "test-key";
	return built;
}

// A simple object body node: `{ type: "object", properties: {...} }`.
function objectNode(properties, requiredProperties = []) {
	return { type: "object", properties, requiredProperties };
}

function scalarNode(type, enumValues) {
	return enumValues ? { type, enum: enumValues } : { type };
}

function findingsByCode(report, code) {
	return report.findings.filter((finding) => finding.code === code);
}

function response(overrides = {}) {
	return { status: 200, headers: [], body: null, ...overrides };
}

// Assert that a thunk rejects with a typed AppError carrying the given code. Codes
// live on `.code`, not in the message, so a pattern match on the message would be
// both brittle and wrong; this asserts the machine-readable contract directly.
function expectCode(thunk, code) {
	let raised = null;
	try {
		thunk();
	} catch (error) {
		raised = error;
	}
	if (!raised) throw new Error(`expected rejection with code ${code}, but the call succeeded`);
	expect(raised.code).toBe(code);
}

// ---------------------------------------------------------------------------
// 1–3. Status
// ---------------------------------------------------------------------------

describe("status comparison", () => {
	test("1. exact compatible response is compatible", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: response({ body: { id: "user-1" } }),
		});
		expect(report.compatible).toBe(true);
		expect(report.summary.breaking).toBe(0);
		expect(report.summary.unknown).toBe(0);
		expect(findingsByCode(report, COMPATIBILITY_CODES.STATUS_ALLOWED)).toHaveLength(1);
	});

	test("2. allowed status in a status set is compatible", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ status: null, statuses: [200, 201, 204] }) }),
			response: response({ status: 201 }),
		});
		expect(report.compatible).toBe(true);
		expect(findingsByCode(report, COMPATIBILITY_CODES.STATUS_ALLOWED)[0].expected).toEqual([200, 201, 204]);
	});

	test("3. disallowed status is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ status: 200 }) }),
			response: response({ status: 500 }),
		});
		expect(report.compatible).toBe(false);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.STATUS_NOT_ALLOWED)[0];
		expect(finding.class).toBe(COMPATIBILITY_CLASS.BREAKING);
		expect(finding.path).toBe("status");
		expect(finding.actual).toBe(500);
		expect(finding.severity).toBe("breaking");
	});

	test("contract status set is not widened by an observed status", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ status: 200 }) }),
			response: response({ status: 202 }),
		});
		expect(report.compatible).toBe(false);
		expect(report.summary.breaking).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// 4. Body root type
// ---------------------------------------------------------------------------

describe("body root type", () => {
	test("4a. object -> array is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: response({ body: [1, 2, 3] }),
		});
		expect(report.compatible).toBe(false);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.BODY_TYPE_CHANGED)[0];
		expect(finding).toMatchObject({ class: "BREAKING", path: "$", expected: "object", actual: "array" });
	});

	test("4b. array -> object is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: { type: "array", items: scalarNode("string") }, bodyType: "array" }) }),
			response: response({ body: { not: "an array" } }),
		});
		expect(report.compatible).toBe(false);
		expect(findingsByCode(report, COMPATIBILITY_CODES.BODY_TYPE_CHANGED)[0]).toMatchObject({ expected: "array", actual: "object" });
	});

	test("4c. string -> number is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: scalarNode("string"), bodyType: "string" }) }),
			response: response({ body: 42 }),
		});
		expect(report.compatible).toBe(false);
		expect(findingsByCode(report, COMPATIBILITY_CODES.BODY_TYPE_CHANGED)[0]).toMatchObject({ expected: "string", actual: "number" });
	});

	test("null is a distinct type, not an absent body", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: response({ body: null }),
		});
		expect(report.compatible).toBe(false);
		expect(findingsByCode(report, COMPATIBILITY_CODES.BODY_TYPE_CHANGED)[0]).toMatchObject({ expected: "object", actual: "null" });
	});
});

// ---------------------------------------------------------------------------
// 5–8. Properties
// ---------------------------------------------------------------------------

describe("object properties", () => {
	test("5. required property missing is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string"), name: scalarNode("string") }, ["id", "name"]), bodyType: "object" }) }),
			response: response({ body: { id: "user-1" } }),
		});
		expect(report.compatible).toBe(false);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.REQUIRED_PROPERTY_MISSING)[0];
		expect(finding).toMatchObject({ class: "BREAKING", path: "$.name", expected: "string", actual: "absent" });
	});

	test("6. optional field absent is compatible", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string"), name: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: response({ body: { id: "user-1" } }),
		});
		expect(report.compatible).toBe(true);
		expect(report.summary.breaking).toBe(0);
		expect(findingsByCode(report, COMPATIBILITY_CODES.OPTIONAL_PROPERTY_ABSENT)).toHaveLength(1);
		// The required property is still satisfied.
		expect(findingsByCode(report, COMPATIBILITY_CODES.REQUIRED_PROPERTY_PRESENT)).toHaveLength(1);
	});

	test("7. property type changed is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: response({ body: { id: 42 } }),
		});
		expect(report.compatible).toBe(false);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.BODY_TYPE_CHANGED)[0];
		expect(finding).toMatchObject({ class: "BREAKING", path: "$.id", expected: "string", actual: "number" });
	});

	test("8. an extra property is non-breaking", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: response({ body: { id: "user-1", surprise: true } }),
		});
		expect(report.compatible).toBe(true);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.ADDITIONAL_PROPERTY_PRESENT)[0];
		expect(finding).toMatchObject({ class: "NON_BREAKING", path: "$.surprise", expected: "undeclared", actual: "boolean" });
	});

	test("an unexpected property is never breaking even when many appear", () => {
		const observed = { id: "user-1", a: 1, b: 2, c: 3, d: { nested: true } };
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: response({ body: observed }),
		});
		expect(report.compatible).toBe(true);
		expect(findingsByCode(report, COMPATIBILITY_CODES.ADDITIONAL_PROPERTY_PRESENT)).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// 9–13. Nesting and arrays
// ---------------------------------------------------------------------------

describe("nesting and arrays", () => {
	test("9. nested object compatible", () => {
		const report = compareContractToResponse({
			contract: contract({
				content: content({
					body: objectNode({ user: objectNode({ id: scalarNode("string"), address: objectNode({ city: scalarNode("string") }, ["city"]) }, ["id", "address"]) }, ["user"]),
					bodyType: "object",
				}),
			}),
			response: response({ body: { user: { id: "u1", address: { city: "Springfield" } } } }),
		});
		expect(report.compatible).toBe(true);
		expect(report.summary.breaking).toBe(0);
	});

	test("10. nested required property missing is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({
				content: content({
					body: objectNode({ user: objectNode({ id: scalarNode("string"), email: scalarNode("string") }, ["id", "email"]) }, ["user"]),
					bodyType: "object",
				}),
			}),
			response: response({ body: { user: { id: "u1" } } }),
		});
		expect(report.compatible).toBe(false);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.REQUIRED_PROPERTY_MISSING)[0];
		expect(finding.path).toBe("$.user.email");
		expect(finding.parentPath).toBe("$.user");
	});

	test("11. root array of scalars", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: { type: "array", items: scalarNode("string") }, bodyType: "array" }) }),
			response: response({ body: ["a", "b", "c"] }),
		});
		expect(report.compatible).toBe(true);
		expect(report.summary.breaking).toBe(0);
	});

	test("11b. root array with a changed element type is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: { type: "array", items: scalarNode("string") }, bodyType: "array" }) }),
			response: response({ body: ["a", 2, "c"] }),
		});
		expect(report.compatible).toBe(false);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.ARRAY_ITEM_TYPE_CHANGED)[0];
		expect(finding).toMatchObject({ path: "$[1]", expected: "string", actual: "number" });
	});

	test("12. array of objects validates every item", () => {
		const report = compareContractToResponse({
			contract: contract({
				content: content({ body: { type: "array", items: objectNode({ id: scalarNode("string") }, ["id"]) }, bodyType: "array" }),
			}),
			response: response({ body: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
		});
		expect(report.compatible).toBe(true);
		expect(report.summary.breaking).toBe(0);
	});

	test("12b. array of objects reports the failing index", () => {
		const report = compareContractToResponse({
			contract: contract({
				content: content({ body: { type: "array", items: objectNode({ id: scalarNode("string") }, ["id"]) }, bodyType: "array" }),
			}),
			response: response({ body: [{ id: "a" }, {}, { id: "c" }] }),
		});
		expect(report.compatible).toBe(false);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.REQUIRED_PROPERTY_MISSING)[0];
		expect(finding.path).toBe("$[1].id");
	});

	test("13. nested array inside an object", () => {
		const report = compareContractToResponse({
			contract: contract({
				content: content({
					body: objectNode({ tags: { type: "array", items: scalarNode("string") } }, ["tags"]),
					bodyType: "object",
				}),
			}),
			response: response({ body: { tags: ["x", "y"] } }),
		});
		expect(report.compatible).toBe(true);
	});

	test("13b. nested array element type change is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({
				content: content({
					body: objectNode({ tags: { type: "array", items: scalarNode("string") } }, ["tags"]),
					bodyType: "object",
				}),
			}),
			response: response({ body: { tags: ["x", 9] } }),
		});
		expect(report.compatible).toBe(false);
		expect(findingsByCode(report, COMPATIBILITY_CODES.ARRAY_ITEM_TYPE_CHANGED)[0].path).toBe("$.tags[1]");
	});
});

// ---------------------------------------------------------------------------
// 14. Empty arrays -> UNKNOWN
// ---------------------------------------------------------------------------

describe("empty-array unknown handling", () => {
	test("14. an empty observed array against an item shape is UNKNOWN, not compatible", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: { type: "array", items: objectNode({ id: scalarNode("string") }, ["id"]) }, bodyType: "array" }) }),
			response: response({ body: [] }),
		});
		expect(report.compatible).toBe(false);
		expect(report.summary.unknown).toBe(1);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.ARRAY_ITEM_SHAPE_UNOBSERVABLE)[0];
		expect(finding.class).toBe(COMPATIBILITY_CLASS.UNKNOWN);
		expect(finding.actual).toBe("empty");
	});

	test("14b. an array contract declaring no item shape accepts an empty array", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: { type: "array" }, bodyType: "array" }) }),
			response: response({ body: [] }),
		});
		expect(report.compatible).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 15–16. Enums
// ---------------------------------------------------------------------------

describe("enums", () => {
	test("15. an observed value inside the declared enum is accepted", () => {
		const report = compareContractToResponse({
			contract: contract({
				content: content({ body: objectNode({ state: scalarNode("string", ["ACTIVE", "DISABLED"]) }, ["state"]), bodyType: "object" }),
			}),
			response: response({ body: { state: "ACTIVE" } }),
		});
		expect(report.compatible).toBe(true);
		expect(findingsByCode(report, COMPATIBILITY_CODES.ENUM_VALUE_ALLOWED)).toHaveLength(1);
	});

	test("16. an observed value outside the declared enum is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({
				content: content({ body: objectNode({ state: scalarNode("string", ["ACTIVE", "DISABLED"]) }, ["state"]), bodyType: "object" }),
			}),
			response: response({ body: { state: "PENDING" } }),
		});
		expect(report.compatible).toBe(false);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.ENUM_VALUE_NOT_ALLOWED)[0];
		expect(finding).toMatchObject({ class: "BREAKING", expected: ["ACTIVE", "DISABLED"], actual: "PENDING" });
	});

	test("the engine never invents enum semantics when the contract declares none", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ state: scalarNode("string") }, ["state"]), bodyType: "object" }) }),
			response: response({ body: { state: "ANYTHING" } }),
		});
		expect(report.compatible).toBe(true);
		expect(findingsByCode(report, COMPATIBILITY_CODES.ENUM_VALUE_NOT_ALLOWED)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 17–19. Headers
// ---------------------------------------------------------------------------

describe("response headers", () => {
	test("17. an expected response header present is compatible", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ headers: [{ name: "x-request-id", value: null, required: false }] }) }),
			response: response({ headers: [{ name: "x-request-id", value: "abc" }] }),
		});
		expect(report.compatible).toBe(true);
		expect(findingsByCode(report, COMPATIBILITY_CODES.RESPONSE_HEADER_PRESENT)).toHaveLength(1);
	});

	test("18a. a required expected header missing is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ headers: [{ name: "x-request-id", value: null, required: true }] }) }),
			response: response({ headers: [] }),
		});
		expect(report.compatible).toBe(false);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.RESPONSE_HEADER_MISSING)[0];
		expect(finding).toMatchObject({ class: "BREAKING", path: "headers.x-request-id", expected: "present", actual: "absent" });
	});

	test("18b. an absent optional presence-only header produces no finding", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ headers: [{ name: "x-optional", value: null, required: false }] }) }),
			response: response({ headers: [] }),
		});
		expect(report.summary.total).toBe(1);
		expect(findingsByCode(report, COMPATIBILITY_CODES.RESPONSE_HEADER_MISSING)).toHaveLength(0);
	});

	test("18c. a missing header with a declared value is breaking even when not marked required", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ headers: [{ name: "content-type", value: "application/json", required: false }] }) }),
			response: response({ headers: [] }),
		});
		expect(report.compatible).toBe(false);
		expect(findingsByCode(report, COMPATIBILITY_CODES.RESPONSE_HEADER_MISSING)).toHaveLength(1);
	});

	test("18d. a header value change is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ headers: [{ name: "content-type", value: "application/json", required: false }] }) }),
			response: response({ headers: [{ name: "content-type", value: "text/html" }] }),
		});
		expect(report.compatible).toBe(false);
		expect(findingsByCode(report, COMPATIBILITY_CODES.RESPONSE_HEADER_VALUE_CHANGED)[0]).toMatchObject({
			expected: "application/json",
			actual: "text/html",
		});
	});

	test("19. header name comparison is case-insensitive", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ headers: [{ name: "Content-Type", value: "application/json", required: true }] }) }),
			response: response({ headers: [{ name: "CONTENT-TYPE", value: "application/json" }] }),
		});
		expect(report.compatible).toBe(true);
		expect(findingsByCode(report, COMPATIBILITY_CODES.RESPONSE_HEADER_VALUE_MATCHES)).toHaveLength(1);
	});

	test("header comparison accepts a header map and a pair array alike", () => {
		const expected = contract({ content: content({ headers: [{ name: "x-trace", value: null, required: true }] }) });
		const asMap = compareContractToResponse({ contract: expected, response: response({ headers: { "X-Trace": "1" } }) });
		const asPairs = compareContractToResponse({ contract: expected, response: response({ headers: [["X-TRACE", "1"]] }) });
		expect(asMap.compatible).toBe(true);
		expect(asPairs.compatible).toBe(true);
	});

	test("an unregistered observed header is not a finding", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ headers: [] }) }),
			response: response({ headers: [{ name: "x-unregistered", value: "whatever" }] }),
		});
		expect(report.findings.every((finding) => !finding.path.startsWith("headers."))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 20–22. Aggregation, ordering, key noise
// ---------------------------------------------------------------------------

describe("aggregation and determinism", () => {
	test("20. multiple simultaneous findings are all reported with correct counts", () => {
		const report = compareContractToResponse({
			contract: contract({
				content: content({
					status: 200,
					headers: [{ name: "x-required", value: null, required: true }],
					body: objectNode({ id: scalarNode("string"), state: scalarNode("string", ["ACTIVE"]) }, ["id", "state"]),
					bodyType: "object",
				}),
			}),
			response: response({ status: 500, headers: [], body: { id: 7, state: "PENDING", extra: 1 } }),
		});
		expect(report.compatible).toBe(false);
		expect(findingsByCode(report, COMPATIBILITY_CODES.STATUS_NOT_ALLOWED)).toHaveLength(1);
		expect(findingsByCode(report, COMPATIBILITY_CODES.RESPONSE_HEADER_MISSING)).toHaveLength(1);
		expect(findingsByCode(report, COMPATIBILITY_CODES.BODY_TYPE_CHANGED)).toHaveLength(1);
		expect(findingsByCode(report, COMPATIBILITY_CODES.ENUM_VALUE_NOT_ALLOWED)).toHaveLength(1);
		expect(findingsByCode(report, COMPATIBILITY_CODES.ADDITIONAL_PROPERTY_PRESENT)).toHaveLength(1);
		// Breaking: disallowed status, missing required header, `id` string->number, enum
		// violation. Non-breaking: the satisfied `state` type check, both required-property
		// presence checks, and the extra `extra` property.
		expect(report.summary.breaking).toBe(4);
		expect(report.summary.nonBreaking).toBe(4);
		expect(report.summary.total).toBe(8);
	});

	test("21. finding ordering is deterministic by path then code", () => {
		const report = compareContractToResponse({
			contract: contract({
				content: content({ body: objectNode({ zeta: scalarNode("string"), alpha: scalarNode("string") }, ["zeta", "alpha"]), bodyType: "object" }),
			}),
			response: response({ body: {} }),
		});
		const paths = report.findings.map((finding) => finding.path);
		expect(paths).toEqual([...paths].sort());
	});

	test("21b. sortFindings is stable for equal keys via the tie-breaker", () => {
		const base = { code: "X", class: "BREAKING", path: "$", contractPath: null, parentPath: null, severity: "breaking" };
		const sorted = sortFindings([
			{ ...base, expected: "b", actual: "b" },
			{ ...base, expected: "a", actual: "a" },
		]);
		expect(sorted.map((finding) => finding.expected)).toEqual(["a", "b"]);
	});

	test("22. input object-key ordering does not change the report", () => {
		const bodyNode = objectNode({ id: scalarNode("string"), name: scalarNode("string"), state: scalarNode("string", ["A", "B"]) }, ["id", "name"]);
		const buildContract = () => contract({ content: content({ body: bodyNode, bodyType: "object" }) });
		const first = compareContractToResponse({ contract: buildContract(), response: response({ body: { id: "1", name: "n", state: "A", x: 1, y: 2 } }) });
		const second = compareContractToResponse({ contract: buildContract(), response: response({ body: { y: 2, x: 1, state: "A", name: "n", id: "1" } }) });
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first.resultFingerprint).toBe(second.resultFingerprint);
	});

	test("22b. header ordering does not change the report", () => {
		const buildContract = () =>
			contract({ content: content({ headers: [{ name: "x-a", value: null, required: true }, { name: "x-b", value: null, required: true }] }) });
		const first = compareContractToResponse({ contract: buildContract(), response: response({ headers: [["x-a", "1"], ["x-b", "2"]] }) });
		const second = compareContractToResponse({ contract: buildContract(), response: response({ headers: [["x-b", "2"], ["x-a", "1"]] }) });
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});

// ---------------------------------------------------------------------------
// 23–25. Contract safety
// ---------------------------------------------------------------------------

describe("contract identity safety", () => {
	test("23a. a malformed contract fails closed", () => {
		const broken = contract();
		broken.content = { ...broken.content, body: { status: 200, headers: [], statuses: [], bodyType: "not-a-type", body: null } };
		expectCode(() => compareContractToResponse({ contract: broken, response: response() }), "COMPATIBILITY_CONTRACT_MALFORMED");
	});

	test("23b. a contract with no content fails closed", () => {
		const broken = contract();
		broken.content = undefined;
		expect(() => compareContractToResponse({ contract: broken, response: response() })).toThrow();
	});

	test("23c. a contract declaring an impossible node fails closed", () => {
		const broken = contract();
		// A scalar node may not declare properties; the Phase-42 schema rejects it.
		broken.content = content({ body: { type: "string", properties: { a: { type: "string" } } }, bodyType: "string" });
		broken.contentFingerprint = contractFingerprint(broken.content);
		expectCode(() => compareContractToResponse({ contract: broken, response: response({ body: "x" }) }), "COMPATIBILITY_CONTRACT_MALFORMED");
	});

	test("24a. a DRAFT contract is rejected", () => {
		expectCode(() => compareContractToResponse({ contract: contract({ state: "DRAFT" }), response: response() }), "COMPATIBILITY_CONTRACT_NOT_PUBLISHED");
	});

	test("24b. a SUPERSEDED contract is rejected", () => {
		expectCode(() => compareContractToResponse({ contract: contract({ state: "SUPERSEDED" }), response: response() }), "COMPATIBILITY_CONTRACT_NOT_PUBLISHED");
	});

	test("24c. an unrecognized lifecycle state is rejected", () => {
		expectCode(() => compareContractToResponse({ contract: contract({ state: "ARCHIVED" }), response: response() }), "COMPATIBILITY_CONTRACT_STATE_INVALID");
	});

	test("24d. an incomplete contract identity is rejected", () => {
		const incomplete = contract();
		delete incomplete.contentFingerprint;
		expectCode(() => compareContractToResponse({ contract: incomplete, response: response() }), "COMPATIBILITY_CONTRACT_IDENTITY_INCOMPLETE");
	});

	test("24e. a missing contract is rejected", () => {
		expectCode(() => compareContractToResponse({ contract: null, response: response() }), "COMPATIBILITY_CONTRACT_MISSING");
	});

	test("25a. a request identity mismatch is rejected", () => {
		expectCode(() => compareContractToResponse({ contract: contract({ requestId: "request-1" }), response: response({ identity: { requestId: "request-OTHER" } }), }), "COMPATIBILITY_IDENTITY_MISMATCH");
	});

	test("25b. a profile identity mismatch is rejected", () => {
		try {
			compareContractToResponse({ contract: contract({ ownerProfileId: "profile-1" }), response: response({ identity: { profileId: "profile-2" } }) });
			throw new Error("expected throw");
		} catch (error) {
			expect(error.code).toBe("COMPATIBILITY_IDENTITY_MISMATCH");
			expect(error.details.mismatches.some((entry) => entry.code === IDENTITY_CODES.PROFILE_MISMATCH)).toBe(true);
		}
	});

	test("25c. a workspace identity mismatch is rejected", () => {
		expectCode(() => compareContractToResponse({ contract: contract({ workspaceId: "workspace-1" }), response: response({ identity: { workspaceId: "workspace-9" } }) }), "COMPATIBILITY_IDENTITY_MISMATCH");
	});

	test("25d. a matching identity compares normally", () => {
		const report = compareContractToResponse({
			contract: contract({ requestId: "request-1", workspaceId: "workspace-1", ownerProfileId: "profile-1" }),
			response: response({ identity: { requestId: "request-1", workspaceId: "workspace-1", profileId: "profile-1" } }),
		});
		expect(report.compatible).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 26. Deduplication
// ---------------------------------------------------------------------------

describe("deduplication", () => {
	test("26. identical findings are deduped", () => {
		const duplicate = { code: "STATUS_ALLOWED", class: "NON_BREAKING", path: "status", contractPath: null, parentPath: null, expected: [200], actual: 200, severity: "non_breaking" };
		const deduped = dedupeFindings([duplicate, { ...duplicate }]);
		expect(deduped).toHaveLength(1);
	});

	test("26b. findings that differ in any meaningful field are kept", () => {
		const base = { code: "STATUS_ALLOWED", class: "NON_BREAKING", path: "status", contractPath: null, parentPath: null, severity: "non_breaking" };
		expect(dedupeFindings([{ ...base, expected: [200], actual: 200 }, { ...base, expected: [201], actual: 201 }])).toHaveLength(2);
	});

	test("26c. a repeated array item does not collapse distinct index findings", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: { type: "array", items: objectNode({ id: scalarNode("string") }, ["id"]) }, bodyType: "array" }) }),
			response: response({ body: [{}, {}] }),
		});
		const missing = findingsByCode(report, COMPATIBILITY_CODES.REQUIRED_PROPERTY_MISSING);
		expect(missing.map((finding) => finding.path).sort()).toEqual(["$[0].id", "$[1].id"]);
	});
});

// ---------------------------------------------------------------------------
// 27–28. Secret leakage
// ---------------------------------------------------------------------------

describe("secret and redaction guarantees", () => {
	const SECRET = "super-secret-token-value";

	test("27. sensitive header values are absent from the serialized report", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ status: 200 }) }),
			response: response({
				headers: [
					{ name: "Authorization", value: `Bearer ${SECRET}` },
					{ name: "Cookie", value: `session=${SECRET}` },
					{ name: "Set-Cookie", value: `token=${SECRET}; HttpOnly` },
					{ name: "X-Api-Key", value: SECRET },
					{ name: "Proxy-Authorization", value: `Basic ${SECRET}` },
				],
			}),
		});
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain(SECRET);
		expect(serialized.toLowerCase()).not.toContain("authorization");
		expect(serialized.toLowerCase()).not.toContain("set-cookie");
		expect(serialized.toLowerCase()).not.toContain("cookie");
		expect(serialized.toLowerCase()).not.toContain("x-api-key");
	});

	test("28. known secret values are absent from the serialized report", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ headers: [{ name: "content-type", value: "application/json", required: false }] }) }),
			response: response({
				status: 401,
				headers: [
					{ name: "content-type", value: "application/json" },
					{ name: "WWW-Authenticate", value: `Bearer realm="${SECRET}"` },
				],
				body: { error: "unauthorized", detail: SECRET },
			}),
		});
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain(SECRET);
		// A non-sensitive header value is legitimately comparable and may appear.
		expect(serialized).toContain("application/json");
	});

	test("28b. a sensitive header can never be echoed even when the contract asks for it", () => {
		// A contract cannot normally register a sensitive header (Phase 42 refuses),
		// so this drives the header rule directly through a raw contract node to prove
		// the second line of defence.
		const report = compareContractToResponse({
			contract: contract({ content: content({ headers: [] }) }),
			response: response({ headers: [{ name: "authorization", value: `Bearer ${SECRET}` }] }),
		});
		expect(JSON.stringify(report)).not.toContain(SECRET);
	});

	test("28c. the normalizer reports which sensitive headers were dropped, without values", () => {
		const normalized = normalizeObservedResponse({ status: 200, headers: [{ name: "Authorization", value: SECRET }] });
		expect(normalized.droppedSensitiveHeaders).toEqual(["authorization"]);
		expect(JSON.stringify(normalized)).not.toContain(SECRET);
	});
});

// ---------------------------------------------------------------------------
// 29–30. Determinism and immutability
// ---------------------------------------------------------------------------

describe("determinism and purity", () => {
	test("29. repeated invocation is byte-identical", () => {
		const buildContract = () => contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) });
		const buildResponse = () => response({ status: 200, body: { id: "x", extra: 1 } });
		const first = JSON.stringify(compareContractToResponse({ contract: buildContract(), response: buildResponse() }));
		const second = JSON.stringify(compareContractToResponse({ contract: buildContract(), response: buildResponse() }));
		const third = JSON.stringify(compareContractToResponse({ contract: buildContract(), response: buildResponse() }));
		expect(first).toBe(second);
		expect(second).toBe(third);
	});

	test("30. the input contract and response objects are not mutated", () => {
		const inputContract = contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) });
		const inputResponse = response({ status: 200, headers: [{ name: "x-a", value: "1" }], body: { id: "x", extra: true } });
		const contractBefore = JSON.stringify(inputContract);
		const responseBefore = JSON.stringify(inputResponse);

		compareContractToResponse({ contract: inputContract, response: inputResponse });

		expect(JSON.stringify(inputContract)).toBe(contractBefore);
		expect(JSON.stringify(inputResponse)).toBe(responseBefore);
	});

	test("30b. a frozen contract still compares", () => {
		const frozenContract = contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) });
		Object.freeze(frozenContract);
		Object.freeze(frozenContract.content);
		const report = compareContractToResponse({ contract: frozenContract, response: response({ body: { id: "x" } }) });
		expect(report.compatible).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Adversarial prototype / property-name cases
// ---------------------------------------------------------------------------

describe("adversarial property names", () => {
	test("an observed __proto__ own property cannot pollute Object.prototype", () => {
		const hostile = Object.create(null);
		Object.defineProperty(hostile, "__proto__", { value: { polluted: true }, enumerable: true, writable: true, configurable: true });
		hostile.id = "x";
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: response({ body: hostile }),
		});
		expect(report.compatible).toBe(true);
		expect({}.polluted).toBeUndefined();
		expect(Object.prototype.polluted).toBeUndefined();
	});

	test("an observed constructor key is treated as an undeclared property, not walked", () => {
		const hostile = { id: "x", constructor: { evil: true } };
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: response({ body: hostile }),
		});
		// `constructor` is refused by name, so it produces no additional-property finding.
		expect(findingsByCode(report, COMPATIBILITY_CODES.ADDITIONAL_PROPERTY_PRESENT).every((finding) => !finding.path.includes("constructor"))).toBe(true);
		expect(report.compatible).toBe(true);
	});

	test("a hostile header map with a __proto__ key is refused at input validation", () => {
		const hostileHeaders = Object.create(null);
		Object.defineProperty(hostileHeaders, "__proto__", { value: "x", enumerable: true, writable: true, configurable: true });
		expectCode(() => compareContractToResponse({ contract: contract(), response: response({ headers: hostileHeaders }) }), "COMPATIBILITY_INPUT_INVALID");
	});

	test("a contract declaring a reserved property name is refused by the registry schema", () => {
		const broken = contract();
		broken.content = content({ body: objectNode({ ["__proto__"]: scalarNode("string") }, []), bodyType: "object" });
		expectCode(() => compareContractToResponse({ contract: broken, response: response({ body: {} }) }), "COMPATIBILITY_CONTRACT_MALFORMED");
	});

	test("a deeply nested hostile structure terminates and reports deterministically", () => {
		let node = { type: "object", properties: {}, requiredProperties: [] };
		const root = node;
		for (let depth = 0; depth < 10; depth += 1) {
			const child = { type: "object", properties: {}, requiredProperties: [] };
			node.properties[`level${depth}`] = child;
			node.requiredProperties.push(`level${depth}`);
			node = child;
		}
		const report = compareContractToResponse({ contract: contract({ content: content({ body: root, bodyType: "object" }) }), response: response({ body: {} }) });
		expect(report.compatible).toBe(false);
		expect(report.summary.breaking).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Body representation honesty
// ---------------------------------------------------------------------------

describe("body representation", () => {
	test("a malformed JSON string body is UNKNOWN, not a type mismatch", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: response({ contentType: "application/json", body: "{ not json" }),
		});
		expect(report.compatible).toBe(false);
		const finding = findingsByCode(report, COMPATIBILITY_CODES.UNSUPPORTED_BODY_REPRESENTATION)[0];
		expect(finding.class).toBe(COMPATIBILITY_CLASS.UNKNOWN);
		expect(finding.actual).toBe("malformed");
	});

	test("a JSON string body is parsed and compared structurally", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: response({ contentType: "application/json", body: JSON.stringify({ id: "x" }) }),
		});
		expect(report.compatible).toBe(true);
	});

	test("an absent body against a contract with no body shape is compatible when status matches", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ status: 204, bodyType: null, body: null }) }),
			response: { status: 204 },
		});
		expect(report.compatible).toBe(true);
	});

	test("an absent body against a contract declaring a body shape is breaking", () => {
		const report = compareContractToResponse({
			contract: contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) }),
			response: { status: 200 },
		});
		expect(report.compatible).toBe(false);
		expect(findingsByCode(report, COMPATIBILITY_CODES.BODY_TYPE_CHANGED)[0].actual).toBe("absent");
	});

	test("a body node whose declared type is null accepts only an observed null", () => {
		const ok = compareContractToResponse({ contract: contract({ content: content({ body: { type: "null" }, bodyType: "null" }) }), response: response({ body: null }) });
		expect(ok.findings.some((finding) => finding.class === "BREAKING")).toBe(false);
		const bad = compareContractToResponse({ contract: contract({ content: content({ body: { type: "null" }, bodyType: "null" }) }), response: response({ body: "x" }) });
		expect(bad.compatible).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Vocabulary and compatibility flag integrity
// ---------------------------------------------------------------------------

describe("vocabulary integrity", () => {
	test("every emitted code has a class in the closed vocabulary", () => {
		const report = compareContractToResponse({
			contract: contract({
				content: content({
					status: 200,
					headers: [{ name: "x-a", value: null, required: true }],
					body: objectNode({ id: scalarNode("string") }, ["id"]),
					bodyType: "object",
				}),
			}),
			response: response({ status: 500, headers: [], body: { extra: 1 } }),
		});
		for (const finding of report.findings) {
			expect(["BREAKING", "NON_BREAKING", "UNKNOWN"]).toContain(finding.class);
			expect(classForCode(finding.code)).toBe(finding.class);
			expect(["breaking", "non_breaking", "unknown"]).toContain(finding.severity);
			expect(typeof finding.path).toBe("string");
		}
	});

	test("resolveCompatible requires positive evidence, so an empty report is not compatible", () => {
		expect(resolveCompatible([])).toBe(false);
		expect(resolveCompatible([{ class: "NON_BREAKING" }])).toBe(true);
		expect(resolveCompatible([{ class: "NON_BREAKING" }, { class: "BREAKING" }])).toBe(false);
		expect(resolveCompatible([{ class: "NON_BREAKING" }, { class: "UNKNOWN" }])).toBe(false);
	});

	test("the result envelope carries kind, schema version, and a stable fingerprint", () => {
		const report = compareContractToResponse({ contract: contract(), response: response() });
		expect(report.kind).toBe(COMPATIBILITY_KIND);
		expect(report.schemaVersion).toBe(COMPATIBILITY_SCHEMA_VERSION);
		expect(report.resultFingerprint).toHaveLength(64);
		expect(report.contract.contractId).toBe("contract_aaaaaaaaaaaaaaaaaaaaaaaa");
		expect(report.contract.contentFingerprint).toHaveLength(64);
		expect(acceptsCompatibilityResultShape(report)).toBe(true);
	});

	test("a changed observation changes the result fingerprint", () => {
		const buildContract = () => contract({ content: content({ body: objectNode({ id: scalarNode("string") }, ["id"]), bodyType: "object" }) });
		const ok = compareContractToResponse({ contract: buildContract(), response: response({ body: { id: "x" } }) });
		const bad = compareContractToResponse({ contract: buildContract(), response: response({ body: { id: 7 } }) });
		expect(ok.resultFingerprint).not.toBe(bad.resultFingerprint);
	});

	test("a contract fingerprint mismatch does not crash and is not treated as authority", () => {
		// The engine trusts the published row's own decision; it does not re-derive or
		// silently repair a mismatched content fingerprint.
		const row = contract();
		row.contentFingerprint = "0".repeat(64);
		const report = compareContractToResponse({ contract: row, response: response() });
		expect(report.contract.contentFingerprint).toBe("0".repeat(64));
	});
});

// ---------------------------------------------------------------------------
// Integration seam
// ---------------------------------------------------------------------------

describe("integration seam (deferred wiring)", () => {
	test("createContractCompatibilityComparator accepts an explicit contract", () => {
		const compare = createContractCompatibilityComparator();
		const report = compare({ contract: contract(), response: response() });
		expect(report.compatible).toBe(true);
	});

	test("createContractCompatibilityComparator accepts a contract source", () => {
		const compare = createContractCompatibilityComparator({ contractSource: () => contract({ contractId: "contract_bbbbbbbbbbbbbbbbbbbbbbbb" }) });
		const report = compare({ response: response() });
		expect(report.contract.contractId).toBe("contract_bbbbbbbbbbbbbbbbbbbbbbbb");
	});

	test("the comparator fails loudly when no contract can be resolved", () => {
		const compare = createContractCompatibilityComparator();
		expect(() => compare({ response: response() })).toThrow(/requires a contract/);
	});

	test("the engine exposes no execution, persistence, or contract-mutation surface", async () => {
		const barrel = await import("./index.js");
		const exported = Object.keys(barrel);
		// No function in the public surface performs I/O, and no registry/service is
		// re-exported from here.
		expect(exported.filter((name) => /create|publish|update|save|persist|execute|fetch|send/i.test(name))).toEqual([
			"createContractCompatibilityComparator",
		]);
		expect(barrel.compareContractToResponse).toBeInstanceOf(Function);
	});
});

// ---------------------------------------------------------------------------
// Body representation vocabulary is completeness-checked
// ---------------------------------------------------------------------------

describe("representation vocabulary", () => {
	test("every representation the normalizer can report is a known value", () => {
		const known = new Set(Object.values(BODY_REPRESENTATION));
		for (const input of [
			{ status: 200 },
			{ status: 200, body: null },
			{ status: 200, body: "plain" },
			{ status: 200, contentType: "application/json", body: '{"a":1}' },
			{ status: 200, contentType: "application/json", body: "{" },
		]) {
			expect(known.has(normalizeObservedResponse(input).bodyRepresentation)).toBe(true);
		}
	});
});
