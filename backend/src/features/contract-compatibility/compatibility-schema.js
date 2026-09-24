import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { SUSPECT_PROPERTY_NAMES } from "./response-normalization.js";

// Phase 43A — API Contract Compatibility Engine.
//
// Vocabulary and fail-closed input contracts for the comparison engine. This
// module is the only place that knows the accepted input shape, and it is the only
// place that defines the closed vocabulary the engine may emit.
//
// The engine answers exactly one question:
//
//   "Does this supplied API response remain compatible with this published Tracer
//    contract?"
//
// It compares supplied data and nothing else: no HTTP, no contract writes, no
// auto-capture, no runner, no verification decision, no UI.

export const COMPATIBILITY_KIND = "tracer.contract-compatibility";
export const COMPATIBILITY_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Compatibility classes
// ---------------------------------------------------------------------------
//
// A deliberately small, closed vocabulary. There is no numeric score and no
// interpolation: a finding is breaking, non-breaking, or unknown, and each class
// has exactly one meaning.
//
//   BREAKING       the observed response contradicts the published contract in a
//                  way that would break a consumer relying on it.
//   NON_BREAKING   the observed response satisfies the contract; nothing a
//                  consumer relies on has changed.
//   UNKNOWN        the contract does not, or the supplied data cannot, establish
//                  compatibility. Uncertainty is never reported as compatibility.
export const COMPATIBILITY_CLASSES = ["BREAKING", "NON_BREAKING", "UNKNOWN"];

export const COMPATIBILITY_CLASS = Object.freeze({
	BREAKING: "BREAKING",
	NON_BREAKING: "NON_BREAKING",
	UNKNOWN: "UNKNOWN",
});

// ---------------------------------------------------------------------------
// Finding codes
// ---------------------------------------------------------------------------
//
// Codes are the engine's public contract; a caller branches on them. Every code
// maps to exactly one compatibility class, which is enforced below so a rule
// cannot emit a code with an inconsistent class.
export const COMPATIBILITY_CODES = Object.freeze({
	// Status
	STATUS_NOT_ALLOWED: "STATUS_NOT_ALLOWED",
	STATUS_ALLOWED: "STATUS_ALLOWED",

	// Body root / node type
	BODY_TYPE_CHANGED: "BODY_TYPE_CHANGED",
	BODY_TYPE_MATCHES: "BODY_TYPE_MATCHES",
	UNSUPPORTED_BODY_REPRESENTATION: "UNSUPPORTED_BODY_REPRESENTATION",

	// Object properties
	REQUIRED_PROPERTY_MISSING: "REQUIRED_PROPERTY_MISSING",
	REQUIRED_PROPERTY_PRESENT: "REQUIRED_PROPERTY_PRESENT",
	OPTIONAL_PROPERTY_ABSENT: "OPTIONAL_PROPERTY_ABSENT",
	PROPERTY_TYPE_CHANGED: "PROPERTY_TYPE_CHANGED",
	PROPERTY_TYPE_MATCHES: "PROPERTY_TYPE_MATCHES",
	ADDITIONAL_PROPERTY_PRESENT: "ADDITIONAL_PROPERTY_PRESENT",

	// Arrays
	ARRAY_ITEM_TYPE_CHANGED: "ARRAY_ITEM_TYPE_CHANGED",
	ARRAY_ITEM_SHAPE_UNOBSERVABLE: "ARRAY_ITEM_SHAPE_UNOBSERVABLE",

	// Enums
	ENUM_VALUE_NOT_ALLOWED: "ENUM_VALUE_NOT_ALLOWED",
	ENUM_VALUE_ALLOWED: "ENUM_VALUE_ALLOWED",

	// Headers
	RESPONSE_HEADER_MISSING: "RESPONSE_HEADER_MISSING",
	RESPONSE_HEADER_PRESENT: "RESPONSE_HEADER_PRESENT",
	RESPONSE_HEADER_VALUE_CHANGED: "RESPONSE_HEADER_VALUE_CHANGED",
	RESPONSE_HEADER_VALUE_MATCHES: "RESPONSE_HEADER_VALUE_MATCHES",
});

export const COMPATIBILITY_CODE_VALUES = Object.freeze(Object.values(COMPATIBILITY_CODES));

// The single authority mapping a code to its class. A rule names a code; the class
// follows from this table, so "unknown is not compatibility" and "extra property is
// non-breaking" are properties of the vocabulary rather than of a call site.
export const CODE_CLASSES = Object.freeze({
	[COMPATIBILITY_CODES.STATUS_NOT_ALLOWED]: COMPATIBILITY_CLASS.BREAKING,
	[COMPATIBILITY_CODES.STATUS_ALLOWED]: COMPATIBILITY_CLASS.NON_BREAKING,

	[COMPATIBILITY_CODES.BODY_TYPE_CHANGED]: COMPATIBILITY_CLASS.BREAKING,
	[COMPATIBILITY_CODES.BODY_TYPE_MATCHES]: COMPATIBILITY_CLASS.NON_BREAKING,
	[COMPATIBILITY_CODES.UNSUPPORTED_BODY_REPRESENTATION]: COMPATIBILITY_CLASS.UNKNOWN,

	[COMPATIBILITY_CODES.REQUIRED_PROPERTY_MISSING]: COMPATIBILITY_CLASS.BREAKING,
	[COMPATIBILITY_CODES.REQUIRED_PROPERTY_PRESENT]: COMPATIBILITY_CLASS.NON_BREAKING,
	[COMPATIBILITY_CODES.OPTIONAL_PROPERTY_ABSENT]: COMPATIBILITY_CLASS.NON_BREAKING,
	[COMPATIBILITY_CODES.PROPERTY_TYPE_CHANGED]: COMPATIBILITY_CLASS.BREAKING,
	[COMPATIBILITY_CODES.PROPERTY_TYPE_MATCHES]: COMPATIBILITY_CLASS.NON_BREAKING,
	// An unexpected extra property is normally harmless: consumers read the fields
	// they know about. Phase 42 has no closed-object vocabulary, so this is always
	// NON_BREAKING and closed-object semantics are never invented here.
	[COMPATIBILITY_CODES.ADDITIONAL_PROPERTY_PRESENT]: COMPATIBILITY_CLASS.NON_BREAKING,

	[COMPATIBILITY_CODES.ARRAY_ITEM_TYPE_CHANGED]: COMPATIBILITY_CLASS.BREAKING,
	// An empty observed array against a contract that describes an item shape means
	// the item shape could not be observed. That is uncertainty, not compatibility.
	[COMPATIBILITY_CODES.ARRAY_ITEM_SHAPE_UNOBSERVABLE]: COMPATIBILITY_CLASS.UNKNOWN,

	[COMPATIBILITY_CODES.ENUM_VALUE_NOT_ALLOWED]: COMPATIBILITY_CLASS.BREAKING,
	[COMPATIBILITY_CODES.ENUM_VALUE_ALLOWED]: COMPATIBILITY_CLASS.NON_BREAKING,

	[COMPATIBILITY_CODES.RESPONSE_HEADER_MISSING]: COMPATIBILITY_CLASS.BREAKING,
	[COMPATIBILITY_CODES.RESPONSE_HEADER_PRESENT]: COMPATIBILITY_CLASS.NON_BREAKING,
	[COMPATIBILITY_CODES.RESPONSE_HEADER_VALUE_CHANGED]: COMPATIBILITY_CLASS.BREAKING,
	[COMPATIBILITY_CODES.RESPONSE_HEADER_VALUE_MATCHES]: COMPATIBILITY_CLASS.NON_BREAKING,
});

export function classForCode(code) {
	return CODE_CLASSES[code] ?? null;
}

// ---------------------------------------------------------------------------
// Contract lifecycle states valid for comparison
// ---------------------------------------------------------------------------
//
// Comparison reads an expectation. A DRAFT is an unfinished authoring state and a
// SUPERSEDED row is history, so neither is a valid authority to compare against.
// Only a PUBLISHED contract may be compared.
export const COMPARABLE_CONTRACT_STATES = ["PUBLISHED"];

// ---------------------------------------------------------------------------
// Supplied observed response
// ---------------------------------------------------------------------------
//
// The caller hands in an already-obtained response. There is no fetching here.
// `body` may be a decoded value or a string; `rawBody` is an optional unparsed
// string used only when `body` is absent. `headers` accepts the several shapes a
// captured response commonly arrives in (array of pairs, array of objects, object
// map, Headers-like getter).
//
// Sensitive header names are dropped by normalization before any finding is built,
// so a credential-bearing header can never reach result construction.

const headerPair = z.union([
	z.object({ name: z.string().min(1), value: z.string() }).strict(),
	z.object({ key: z.string().min(1), value: z.string() }).strict(),
	z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).length(2),
	z.tuple([z.string(), z.string()]),
	z.string().min(1),
]);

const observedResponseSchema = z
	.object({
		// HTTP status observed. Required: without it no status comparison is possible.
		status: z.number().int().min(100).max(599),
		headers: z.union([z.array(headerPair), z.record(z.string(), z.any())]).optional(),
		// Decoded body. `undefined` means "not supplied"; an explicit `null` is a real
		// observed JSON null, which is a different claim.
		body: z.any().optional(),
		rawBody: z.union([z.string(), z.null()]).optional(),
		contentType: z.string().max(512).nullish(),
		// Identity the caller attaches to the sample. Used only to contradict a
		// contract; never to loosen one.
		identity: z
			.object({
				requestId: z.string().min(1).max(128).nullish(),
				workspaceId: z.string().min(1).max(128).nullish(),
				collectionId: z.string().min(1).max(128).nullish(),
				profileId: z.string().min(1).max(128).nullish(),
				snapshotId: z.string().min(1).max(128).nullish(),
				snapshotFingerprint: z.string().min(1).max(128).nullish(),
				executionId: z.string().min(1).max(128).nullish(),
				label: z.string().max(200).nullish(),
			})
			.strict()
			.optional(),
	})
	.strict();

// ---------------------------------------------------------------------------
// Parsers — fail closed
// ---------------------------------------------------------------------------

function fail(code, message, details) {
	return new AppError(400, code, message, details);
}

function parseWith(schema, value, code, message) {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
		throw fail(code, message, { issues });
	}
	return parsed.data;
}

// Reject prototype-mutating and otherwise pathological property names in a raw
// header map before zod sees them.
//
// zod's `record` writes entries by assignment, so an own `__proto__` key rewires
// the target's prototype instead of creating a property. Phase 42A found and fixed
// this on the contract side; the same class of bug applies to any caller-supplied
// header map, so it is refused here too rather than silently dropped.
//
// The guard must look at the *nested* header map, not only the top-level response
// object: the reserved key lives one level down. A top-level-only check silently
// misses it, which is exactly the fail-open failure this guard exists to prevent.
function assertNoReservedHeaderKeys(value) {
	if (!value || typeof value !== "object") return value;

	const inspect = (candidate, location) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
		for (const name of Object.getOwnPropertyNames(candidate)) {
			if (SUSPECT_PROPERTY_NAMES.has(name.toLowerCase()))
				throw fail("COMPATIBILITY_INPUT_INVALID", `Header name "${name}" is reserved and cannot be used (${location}).`);
		}
	};

	// A map-style header collection is an object; an array of pairs is inspected per
	// row so a pair object cannot smuggle a reserved key either.
	const headers = value.headers;
	if (Array.isArray(headers)) {
		for (const row of headers) if (row && typeof row === "object" && !Array.isArray(row)) inspect(row, "headers");
	} else {
		inspect(headers, "headers");
	}

	return value;
}

const guardedObservedResponseSchema = z.preprocess(assertNoReservedHeaderKeys, observedResponseSchema);

export function parseObservedResponse(value) {
	return parseWith(guardedObservedResponseSchema, value, "COMPATIBILITY_INPUT_INVALID", "The supplied observed response is not valid.");
}

export function parseCompatibilityInput(value) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw fail("COMPATIBILITY_INPUT_INVALID", "A compatibility input object is required.");
	if (!("contract" in value)) throw fail("COMPATIBILITY_INPUT_INVALID", "A published contract is required.");
	if (!("response" in value)) throw fail("COMPATIBILITY_INPUT_INVALID", "A supplied observed response is required.");
	return value;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------
//
// Defined with zod so the engine validates its own output before returning it: a
// malformed result is a bug, not data. `findingSchema` is exported so later phases
// can assert the shape without importing the builder.

export const findingSchema = z
	.object({
		code: z.enum(COMPATIBILITY_CODE_VALUES),
		// Compatibility class, derived from the code table above.
		class: z.enum(COMPATIBILITY_CLASSES),
		// JSON-pointer-ish location in the observed response, e.g. `$.user.id` or `$[0].id`.
		path: z.string(),
		// Contract-side location, when the finding concerns a named contract node.
		contractPath: z.string().nullable(),
		// Parent locating context (the enclosing object/array path), when meaningful.
		parentPath: z.string().nullable(),
		// Machine-readable expectation and observation. Never freeform prose, and never
		// a header value that could carry a credential.
		expected: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.any())]),
		actual: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.any())]),
		severity: z.enum(["breaking", "non_breaking", "unknown"]),
	})
	.strict();

export const compatibilityResultSchema = z
	.object({
		schemaVersion: z.literal(COMPATIBILITY_SCHEMA_VERSION),
		kind: z.literal(COMPATIBILITY_KIND),
		// Bytes-stable identity of this comparison, independent of calling order.
		resultFingerprint: z.string().min(1),
		contract: z
			.object({
				contractId: z.string().min(1),
				sequence: z.number().int().min(1),
				state: z.string().min(1),
				contentFingerprint: z.string().min(1),
				fingerprintKeyId: z.string().min(1),
				requestId: z.string().min(1),
				profileId: z.string().nullable(),
			})
			.strict(),
		observed: z
			.object({
				status: z.number().int(),
				executionId: z.string().nullable(),
				label: z.string().nullable(),
			})
			.strict(),
		compatible: z.boolean(),
		// `compatible` is true only when there is at least one NON_BREAKING check and no
		// BREAKING or UNKNOWN finding.
		findings: z.array(findingSchema),
		summary: z
			.object({
				total: z.number().int().min(0),
				breaking: z.number().int().min(0),
				nonBreaking: z.number().int().min(0),
				unknown: z.number().int().min(0),
				statusChecked: z.number().int().min(0),
				headersChecked: z.number().int().min(0),
				bodyStructureChecked: z.number().int().min(0),
			})
			.strict(),
	})
	.strict();

export function assertCompatibilityResult(result) {
	return parseWith(compatibilityResultSchema, result, "COMPATIBILITY_RESULT_INVALID", "The compatibility result is not valid.");
}
