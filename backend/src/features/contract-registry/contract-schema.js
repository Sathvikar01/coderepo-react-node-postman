import { z } from "zod";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";
import { SENSITIVE_MATCH_HEADERS } from "../mocks/mock-matcher.js";

// Phase 42A — API Contract Registry schema.
//
// Bounded, explicit vocabulary for "for this request/workspace version, this is
// the response behavior we expect". This is deliberately not JSON Schema and not
// OpenAPI: a contract describes an observable response shape, nothing more.
//
// Two rules shape the whole file:
//
//   1. Everything is bounded. Depth, property count, enum size, header count, and
//      total size all have a hard ceiling, so a caller cannot persist a
//      pathological document.
//   2. Nothing sensitive enters. Header names are filtered against the same
//      credential header set the mock matcher already uses, and control or
//      credential-shaped strings are refused outright.

export const CONTRACT_SCHEMA_VERSION = 1;
export const CONTRACT_KIND = "tracer.api-contract";

export const CONTRACT_STATES = ["DRAFT", "PUBLISHED", "SUPERSEDED"];

export const CONTRACT_STATE = Object.freeze({
	DRAFT: "DRAFT",
	PUBLISHED: "PUBLISHED",
	SUPERSEDED: "SUPERSEDED",
});

// Provenance of a contract. `explicit` means a caller supplied the structure;
// `inferred` means it was derived from an already-captured response payload. The
// distinction is stored so a consumer can weigh the two differently.
export const CONTRACT_PROVENANCE = ["explicit", "inferred"];

// Observable scalar/structural types a contract node may declare. This is the
// entire type vocabulary — no unions, no allOf/anyOf, no $ref.
export const CONTRACT_VALUE_TYPES = ["object", "array", "string", "number", "boolean", "null"];

// Bounds. Kept in this module (not shared/limits.js) because they are specific to
// contracts and Phase 42A must not touch shared files.
export const CONTRACT_LIMITS = Object.freeze({
	maxDepth: 12,
	maxProperties: 500,
	maxPropertiesPerObject: 200,
	maxEnumValues: 32,
	maxStatusCodes: 32,
	maxHeaders: 50,
	maxJsonBytes: 128 * 1024,
	maxNameBytes: 200,
	maxPropertyNameBytes: 256,
	maxHeaderValueBytes: 512,
	maxRequestBodyBytes: 8 * 1024,
});

// Status codes a contract may expect. 100–599 is the HTTP range; anything else is
// a caller bug, not a contract.
const statusCode = z.number().int().min(100).max(599);

// A string that could carry a credential. Rejected rather than redacted, because a
// contract is authored deliberately and a secret in it is a mistake, not data.
const CREDENTIAL_SHAPED = [
	/\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\./,
	/\b(sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_\-]{12,}/,
];

function isCredentialShaped(value) {
	return CREDENTIAL_SHAPED.some((pattern) => pattern.test(value));
}

function byteLimit(maxBytes, label) {
	return z.string().refine((value) => utf8Bytes(value) <= maxBytes, `${label} is limited to ${Math.floor(maxBytes / 1024)} KiB.`);
}

// A property name. Empty, control characters, and credential-shaped text are all
// refused so a pathological key cannot smuggle either a control sequence or a
// secret into persistence. Prototype-mutating keys are refused too: a contract is
// untrusted input, and `__proto__` as an own key can rewire prototypes in any
// consumer that deep-merges the parsed value.
const FORBIDDEN_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

// Refuse reserved keys anywhere in a raw type node *before* zod sees it.
//
// This guard exists because zod's `record` parsing writes entries by assignment,
// and assigning an own `__proto__` key rewires the target's prototype instead of
// creating a property. Without this check a contract declaring `__proto__` would
// parse “successfully” with the property silently dropped, so the stored contract
// and its fingerprint would disagree with what the caller submitted. Failing closed
// on the raw input is the only way to make that impossible.
function assertNoReservedKeys(value) {
	if (!value || typeof value !== "object") return value;
	if (value.properties && typeof value.properties === "object") {
		for (const name of Object.getOwnPropertyNames(value.properties)) {
			if (FORBIDDEN_PROPERTY_NAMES.has(name.toLowerCase()))
				throw new AppError(400, "CONTRACT_INVALID", `Property name "${name}" is reserved and cannot be used in a contract.`);
		}
	}
	return value;
}

const propertyName = z
	.string()
	.min(1)
	.refine((value) => utf8Bytes(value) <= CONTRACT_LIMITS.maxPropertyNameBytes, "Property names are limited to 256 bytes.")
	.refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Property names cannot contain control characters.")
	.refine((value) => !isCredentialShaped(value), "Property names cannot contain credential-shaped text.")
	.refine((value) => !FORBIDDEN_PROPERTY_NAMES.has(value.toLowerCase()), "Property names cannot use reserved object keys.");

const enumValue = z
	.union([z.string(), z.number(), z.boolean(), z.null()])
	.refine((value) => !(typeof value === "string" && isCredentialShaped(value)), "Enum values cannot contain credential-shaped text.");

const headerName = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => !/[\r\n]/.test(value), "Header names cannot contain line breaks.")
	.refine((value) => !isCredentialShaped(value), "Header names cannot contain credential-shaped text.");

// Sensitive headers are refused by policy before anything is persisted.
export const CONTRACT_SENSITIVE_HEADERS = new Set([...SENSITIVE_MATCH_HEADERS].map((name) => name.toLowerCase()));

export function isSensitiveHeader(name) {
	return CONTRACT_SENSITIVE_HEADERS.has(String(name ?? "").trim().toLowerCase());
}

const expectedHeaderSchema = z
	.object({
		name: headerName,
		// A header is asserted by presence, and optionally by an expected value. The
		// value is bounded and credential-shaped values are refused.
		value: byteLimit(CONTRACT_LIMITS.maxHeaderValueBytes, "Expected header values").nullable().default(null),
		required: z.boolean().default(false),
	})
	.strict()
	.superRefine((header, context) => {
		if (isSensitiveHeader(header.name))
			context.addIssue({
				code: "custom",
				path: ["name"],
				message: `"${header.name}" cannot appear in a contract because it carries credentials.`,
			});
		if (header.value !== null && isCredentialShaped(header.value))
			context.addIssue({ code: "custom", path: ["value"], message: "Expected header values cannot contain credential-shaped text." });
	});

// ---------------------------------------------------------------------------
// Recursive type node
// ---------------------------------------------------------------------------
//
// Depth is enforced structurally as well as at parse time: `typeNodeAt(depth)`
// builds a schema whose children are built one level deeper, and the deepest level
// refuses to nest further. That makes an over-deep document a parse failure rather
// than something that has to be walked afterwards.

function typeNodeAt(depth) {
	const baseFields = {
		// `type` is the observable type of this node.
		type: z.enum(CONTRACT_VALUE_TYPES),
		// Optional enumeration of allowed scalar values. Only meaningful for scalars.
		enum: z
			.array(enumValue)
			.max(CONTRACT_LIMITS.maxEnumValues, `Enums may declare at most ${CONTRACT_LIMITS.maxEnumValues} values.`)
			.optional(),
		// Whether the node must be present. Contracts authored literally can assert
		// requiredness; inference never sets it from a single sample.
		required: z.boolean().optional(),
		// Free-text note, bounded and secret-screened.
		note: byteLimit(CONTRACT_LIMITS.maxNameBytes, "Notes").refine((value) => !isCredentialShaped(value), "Notes cannot contain credential-shaped text.").optional(),
	};

	if (depth >= CONTRACT_LIMITS.maxDepth) {
		// Deepest permitted level: no children allowed.
		return z
			.object(baseFields)
			.strict()
			.superRefine((node, context) => {
				if (node.type === "object" || node.type === "array")
					context.addIssue({
						code: "custom",
						path: ["type"],
						message: `Contracts may nest at most ${CONTRACT_LIMITS.maxDepth} levels deep.`,
					});
				if (node.enum && !["string", "number", "boolean", "null"].includes(node.type))
					context.addIssue({ code: "custom", path: ["enum"], message: "Only scalar nodes may declare an enum." });
			});
	}

	const child = typeNodeAt(depth + 1);
	return z.preprocess(
		assertNoReservedKeys,
		z
			.object({
				...baseFields,
				// Object children, keyed by property name. Bounded per object.
				properties: z
					.record(propertyName, child)
					.refine((value) => Object.keys(value).length <= CONTRACT_LIMITS.maxPropertiesPerObject, `An object may declare at most ${CONTRACT_LIMITS.maxPropertiesPerObject} properties.`)
					.optional(),
				// Names that must be present. Never populated by inference.
				requiredProperties: z
					.array(propertyName)
					.max(CONTRACT_LIMITS.maxPropertiesPerObject, `An object may require at most ${CONTRACT_LIMITS.maxPropertiesPerObject} properties.`)
					.optional(),
				// Element shape for arrays. Arrays are described by one element shape, never
				// a union of shapes.
				items: child.optional(),
			})
			.strict()
			.superRefine((node, context) => {
				const issue = (path, message) => context.addIssue({ code: "custom", path, message });
				if (node.enum && !["string", "number", "boolean", "null"].includes(node.type))
					issue(["enum"], "Only scalar nodes may declare an enum.");
				if (node.type === "object") {
					if (node.items) issue(["items"], "Only array nodes may declare an element shape.");
				} else if (node.type === "array") {
					if (node.properties) issue(["properties"], "Only object nodes may declare properties.");
					if (node.requiredProperties) issue(["requiredProperties"], "Only object nodes may declare required properties.");
				} else {
					if (node.properties) issue(["properties"], "Only object nodes may declare properties.");
					if (node.requiredProperties) issue(["requiredProperties"], "Only object nodes may declare required properties.");
					if (node.items) issue(["items"], "Only array nodes may declare an element shape.");
					if (node.required) issue(["required"], "Only object properties carry a required flag.");
				}
				// Every required name must exist in the property map.
				for (const name of node.requiredProperties ?? []) {
					if (!Object.prototype.hasOwnProperty.call(node.properties ?? {}, name))
						issue(["requiredProperties"], `Required property "${name}" is not declared in properties.`);
				}
			}),
	);
}

export const contractTypeNodeSchema = typeNodeAt(0);

// ---------------------------------------------------------------------------
// Contract body
// ---------------------------------------------------------------------------

export const contractBodySchema = z
	.object({
		// An expected status, or an allowed set. Exactly one of the two forms.
		status: statusCode.nullable().default(null),
		statuses: z
			.array(statusCode)
			.max(CONTRACT_LIMITS.maxStatusCodes, `A contract may allow at most ${CONTRACT_LIMITS.maxStatusCodes} status codes.`)
			.default([]),
		// Expected response headers, bounded and screened.
		headers: z.array(expectedHeaderSchema).max(CONTRACT_LIMITS.maxHeaders, `A contract may declare at most ${CONTRACT_LIMITS.maxHeaders} headers.`).default([]),
		// The expected response body shape. A contract may describe no body at all.
		bodyType: z.enum(CONTRACT_VALUE_TYPES).nullable().default(null),
		body: contractTypeNodeSchema.nullable().default(null),
	})
	.strict()
	.superRefine((body, context) => {
		const issue = (path, message) => context.addIssue({ code: "custom", path, message });
		if (body.status !== null && body.statuses.length > 0)
			issue(["statuses"], "Declare either a single expected status or an allowed set, not both.");
		if (body.status === null && body.statuses.length === 0)
			issue(["status"], "Declare an expected status or an allowed status set.");
		if (new Set(body.statuses).size !== body.statuses.length) issue(["statuses"], "Allowed status codes must be unique.");
		if (body.body === null && body.bodyType !== null) issue(["bodyType"], "A body type requires a body shape.");
		if (body.body !== null && body.bodyType !== null && body.body.type !== body.bodyType)
			issue(["bodyType"], "The declared body type must match the body shape type.");
		const seen = new Set();
		body.headers.forEach((header, index) => {
			const key = header.name.trim().toLowerCase();
			if (seen.has(key)) issue(["headers", index, "name"], "Expected headers must not duplicate each other.");
			seen.add(key);
		});
		if (utf8Bytes(JSON.stringify(body)) > CONTRACT_LIMITS.maxJsonBytes)
			issue([], "A contract body is limited to 128 KiB.");
	});

// ---------------------------------------------------------------------------
// Identity and envelope
// ---------------------------------------------------------------------------

const objectIdLike = z
	.string()
	.min(1)
	.refine((value) => /^[a-fA-F0-9]{24}$/.test(value) || /^[A-Za-z0-9._:-]{1,128}$/.test(value), "Provide a valid identifier.");

export const contractIdentitySchema = z
	.object({
		ownerProfileId: objectIdLike,
		collectionId: objectIdLike.nullable().default(null),
		workspaceId: objectIdLike.nullable().default(null),
		requestId: z.string().min(1).max(128),
		// Optional binding to a workspace version. A contract may exist before a
		// snapshot is taken, so both fields are optional but are stored when known.
		snapshotId: objectIdLike.nullable().default(null),
		snapshotFingerprint: z
			.string()
			.min(1)
			.max(128)
			.refine((value) => !isCredentialShaped(value), "Snapshot fingerprints cannot contain credential-shaped text.")
			.nullable()
			.default(null),
	})
	.strict();

export const contractDraftInputSchema = z
	.object({
		contractId: z.string().min(1).max(128).nullish(),
		collectionId: objectIdLike.nullish(),
		workspaceId: objectIdLike.nullish(),
		requestId: z.string().min(1).max(128),
		snapshotId: objectIdLike.nullish(),
		snapshotFingerprint: z.string().min(1).max(128).nullish(),
		name: z.string().trim().min(1).max(CONTRACT_LIMITS.maxNameBytes),
		description: z
			.string()
			.max(LIMITS.description)
			.refine((value) => !isCredentialShaped(value), "Descriptions cannot contain credential-shaped text.")
			.default(""),
		provenance: z.enum(CONTRACT_PROVENANCE).default("explicit"),
		body: contractBodySchema,
	})
	.strict();

export const contractUpdateInputSchema = contractDraftInputSchema.partial({ requestId: true, name: true, body: true }).strict();

// ---------------------------------------------------------------------------
// Parsers — fail closed
// ---------------------------------------------------------------------------

import { AppError } from "../../shared/errors/app-error.js";

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

export function parseContractDraftInput(value) {
	return parseWith(contractDraftInputSchema, value, "CONTRACT_INVALID", "The contract definition is not valid.");
}

export function parseContractUpdateInput(value) {
	return parseWith(contractUpdateInputSchema, value, "CONTRACT_INVALID", "The contract update is not valid.");
}

export function parseContractBody(value) {
	return parseWith(contractBodySchema, value, "CONTRACT_INVALID", "The contract body is not valid.");
}

export function parseContractIdentity(value) {
	return parseWith(contractIdentitySchema, value, "CONTRACT_IDENTITY_INVALID", "The contract identity is not valid.");
}

// A live-document shape used when validating stored contract content. Same
// vocabulary as the write path, so a stored contract can never drift from it.
export const storedContractSchema = z
	.object({
		schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
		kind: z.literal(CONTRACT_KIND),
		provenance: z.enum(CONTRACT_PROVENANCE),
		name: z.string().min(1).max(CONTRACT_LIMITS.maxNameBytes),
		description: z.string().max(LIMITS.description),
		body: contractBodySchema,
	})
	.strict();

export function parseStoredContract(value) {
	return parseWith(storedContractSchema, value, "CONTRACT_CONTENT_INVALID", "Stored contract content is not valid.");
}
