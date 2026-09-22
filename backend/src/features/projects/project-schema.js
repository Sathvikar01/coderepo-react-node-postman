// TracerProjectV1 — the portable, versioned interchange representation of a
// Tracer project (collections, environments, saved examples).
//
// This format is an import/export boundary only. It is never Mongo's runtime
// storage format and it never carries execution state.
//
// Unknown-field policy. Every object accepts unknown keys. Unknown keys are
// carried verbatim through parse -> serialize so a newer producer's data
// survives an older reader, but they are never applied to the domain model:
// projectToDomain() rejects anything the workspace cannot represent instead of
// dropping it silently.
//
// Secret policy. Only definitions travel: secret references keep aliases and
// never values, credential templates must be variable references, and cookie
// jars, resolved secret values, and send-only overrides have no representation
// at all. Validation fails closed when a safe representation is impossible.
//
// Assertions. Phase 12 owns assertion semantics. This format carries them
// only inside a narrow versioned envelope (ASSERTIONS_CONTRACT) whose items
// stay opaque here and are validated against Phase 12's request assertion
// schema when a project is mapped onto the domain.

import { z } from "zod";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";
import { nameKey } from "../../shared/utils/names.js";
import { CREDENTIAL_REFERENCE, METHODS } from "../../shared/utils/schemas.js";
import { SENSITIVE_MATCH_HEADERS } from "../mocks/mock-matcher.js";

export const TRACER_PROJECT_KIND = "tracer.project";
export const TRACER_PROJECT_VERSION = 1;
export const ASSERTIONS_CONTRACT = "tracer.assertions/1";
export const PROJECT_JSON_MAX_BYTES = 8 * 1024 * 1024;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const limitedText = (limitBytes, label) =>
	z.string().refine((value) => utf8Bytes(value) <= limitBytes, `${label} are limited to ${limitBytes} bytes.`);

const idSchema = z.uuid();

const assertUniqueNames = (items, context, label) => {
	const seen = new Set();
	items.forEach((item, index) => {
		const key = nameKey(item.name);
		if (seen.has(key)) context.addIssue({ code: "custom", path: [index, "name"], message: `${label} names must be unique within a project.` });
		seen.add(key);
	});
};

const portableRowSchema = z
	.object({
		id: idSchema,
		key: limitedText(LIMITS.rowKeyBytes, "Row keys"),
		value: limitedText(LIMITS.rowValueBytes, "Row values"),
		enabled: z.boolean().default(true),
	})
	.passthrough();

const portableVariableSchema = z
	.object({
		id: idSchema,
		key: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.regex(VARIABLE_NAME, "Variable names start with a letter or underscore and contain letters, digits, or underscores."),
		kind: z.enum(["plain", "secretRef"]),
		value: limitedText(LIMITS.variableValueBytes, "Variable values").optional(),
		alias: z.string().trim().min(1).max(64).optional(),
		enabled: z.boolean().default(true),
	})
	.passthrough()
	.superRefine((variable, context) => {
		if (variable.kind === "plain" && variable.value === undefined)
			context.addIssue({ code: "custom", path: ["value"], message: "Plain variables require a value." });
		if (variable.kind === "secretRef") {
			if (!variable.alias) context.addIssue({ code: "custom", path: ["alias"], message: "Secret references require an alias." });
			if (variable.value !== undefined)
				context.addIssue({ code: "custom", path: ["value"], message: "Secret references store an alias and never a value." });
		}
	});

const portableVariableListSchema = z
	.array(portableVariableSchema)
	.max(LIMITS.variablesPerScope)
	.superRefine((variables, context) => {
		const seen = new Set();
		variables.forEach((variable, index) => {
			const key = variable.key.toLowerCase();
			if (seen.has(key)) context.addIssue({ code: "custom", path: [index, "key"], message: "Variable names must be unique within their scope." });
			seen.add(key);
		});
		if (utf8Bytes(JSON.stringify(variables)) > LIMITS.variableScopeBytes)
			context.addIssue({ code: "custom", message: "The variable scope is limited to 64 KiB." });
	});

const portableBodySchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("none") }).passthrough(),
	z.object({ mode: z.literal("json"), text: z.string() }).passthrough(),
	z
		.object({ mode: z.literal("text"), text: z.string(), contentType: z.string().trim().max(200).default("text/plain") })
		.passthrough(),
	z.object({ mode: z.literal("urlencoded"), rows: z.array(portableRowSchema).max(LIMITS.rowsPerList) }).passthrough(),
]);

const portableAuthSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("inherit") }).passthrough(),
	z.object({ mode: z.literal("none") }).passthrough(),
	z.object({ mode: z.literal("bearer"), tokenTemplate: z.string().max(8192) }).passthrough(),
	z.object({ mode: z.literal("basic"), usernameTemplate: z.string().max(8192), passwordTemplate: z.string().max(8192) }).passthrough(),
	z
		.object({
			mode: z.literal("apiKey"),
			key: z.string().trim().min(1).max(256),
			valueTemplate: z.string().max(8192),
			in: z.enum(["header", "query"]),
		})
		.passthrough(),
]);

const portableScriptsSchema = z
	.object({
		preRequest: limitedText(LIMITS.scriptSourceBytes, "Pre-request scripts").default(""),
		test: limitedText(LIMITS.scriptSourceBytes, "Test scripts").default(""),
	})
	.passthrough()
	.default({ preRequest: "", test: "" });

export const portableAssertionsSchema = z
	.object({
		contract: z.literal(ASSERTIONS_CONTRACT),
		items: z.array(z.unknown()).max(LIMITS.scriptTests),
	})
	.passthrough();

export const portableRequestSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: idSchema,
		folderId: z.union([idSchema, z.null()]).default(null),
		name: z.string().trim().min(1).max(LIMITS.name),
		method: z.enum(METHODS),
		urlTemplate: limitedText(LIMITS.urlBytes, "URL templates"),
		query: z.array(portableRowSchema).max(LIMITS.rowsPerList),
		headers: z.array(portableRowSchema).max(LIMITS.rowsPerList),
		body: portableBodySchema,
		auth: portableAuthSchema,
		scripts: portableScriptsSchema,
		settings: z.object({ timeoutMs: z.number().int().min(100).max(30000) }).passthrough(),
		assertions: portableAssertionsSchema.optional(),
	})
	.passthrough()
	.superRefine((request, context) => {
		if (["GET", "HEAD"].includes(request.method) && request.body.mode !== "none")
			context.addIssue({ code: "custom", path: ["body"], message: `${request.method} requests cannot include a body.` });
		if (request.auth.mode === "bearer" && !CREDENTIAL_REFERENCE.test(request.auth.tokenTemplate))
			context.addIssue({ code: "custom", path: ["auth", "tokenTemplate"], message: "Portable bearer credentials must use a variable reference." });
		if (
			request.auth.mode === "basic" &&
			(!CREDENTIAL_REFERENCE.test(request.auth.usernameTemplate) || !CREDENTIAL_REFERENCE.test(request.auth.passwordTemplate))
		)
			context.addIssue({ code: "custom", path: ["auth"], message: "Portable basic credentials must use variable references." });
		if (request.auth.mode === "apiKey" && !CREDENTIAL_REFERENCE.test(request.auth.valueTemplate))
			context.addIssue({ code: "custom", path: ["auth", "valueTemplate"], message: "Portable API-key credentials must use a variable reference." });
		if (utf8Bytes(JSON.stringify(request)) > LIMITS.requestJsonBytes)
			context.addIssue({ code: "custom", message: "A portable request is limited to 128 KiB." });
	});

const portableFolderSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(LIMITS.name) }).passthrough();

export const portableCollectionSchema = z
	.object({
		name: z.string().trim().min(1).max(LIMITS.name),
		description: z.string().max(LIMITS.description).default(""),
		variables: portableVariableListSchema,
		auth: portableAuthSchema,
		folders: z.array(portableFolderSchema).max(LIMITS.foldersPerCollection),
		requests: z.array(portableRequestSchema).max(LIMITS.requestsPerCollection),
	})
	.passthrough()
	.superRefine((collection, context) => {
		if (collection.auth.mode === "inherit")
			context.addIssue({ code: "custom", path: ["auth"], message: "Project collection authentication cannot inherit." });
		const folderIds = new Set();
		const folderNames = new Set();
		collection.folders.forEach((folder, index) => {
			if (folderIds.has(folder.id))
				context.addIssue({ code: "custom", path: ["folders", index, "id"], message: "Folder identifiers must be unique." });
			folderIds.add(folder.id);
			const key = nameKey(folder.name);
			if (folderNames.has(key))
				context.addIssue({ code: "custom", path: ["folders", index, "name"], message: "Folder names must be unique within a collection." });
			folderNames.add(key);
		});
		const requestIds = new Set();
		collection.requests.forEach((request, index) => {
			if (requestIds.has(request.id))
				context.addIssue({ code: "custom", path: ["requests", index, "id"], message: "Request identifiers must be unique." });
			requestIds.add(request.id);
			if (request.folderId && !folderIds.has(request.folderId))
				context.addIssue({ code: "custom", path: ["requests", index, "folderId"], message: "The folder does not exist in this collection." });
		});
	});

export const portableEnvironmentSchema = z
	.object({
		name: z.string().trim().min(1).max(LIMITS.name),
		variables: portableVariableListSchema,
	})
	.passthrough();

const portableExampleRuleSchema = z
	.object({ key: z.string().trim().min(1).max(256), value: z.string().max(8192).default("") })
	.passthrough();

const portableExampleMatchSchema = z
	.object({
		method: z.enum(METHODS),
		path: limitedText(2048, "Example match paths").default(""),
		query: z.array(portableExampleRuleSchema).max(LIMITS.rowsPerList).default([]),
		headers: z.array(portableExampleRuleSchema).max(LIMITS.rowsPerList).default([]),
	})
	.passthrough();

const portableExampleSourceSchema = z
	.object({
		type: z.enum(["response", "manual"]),
		requestId: z.uuid().nullable().default(null),
		requestName: z.string().trim().max(80).nullable().default(null),
	})
	.passthrough();

const portableExampleResponseSchema = z
	.object({
		status: z.number().int().min(100).max(599),
		statusText: z.string().max(120).default(""),
		contentType: z.string().max(200).default(""),
		headers: z
			.array(z.object({ name: z.string().trim().min(1).max(256), value: z.string().max(8192).default("") }).passthrough())
			.max(LIMITS.responseHeaderPairs)
			.default([]),
		body: z
			.object({
				encoding: z.enum(["utf8", "base64"]).default("utf8"),
				value: limitedText(LIMITS.historyBodyBytes, "Example bodies").default(""),
				mediaType: z.string().max(200).default(""),
				truncated: z.boolean().default(false),
				omittedReason: z.string().max(64).nullish().default(null),
			})
			.passthrough()
			.default({}),
	})
	.passthrough();

export const portableExampleSchema = z
	.object({
		name: z.string().trim().min(1).max(LIMITS.name),
		source: portableExampleSourceSchema,
		match: portableExampleMatchSchema,
		response: portableExampleResponseSchema,
	})
	.passthrough()
	.superRefine((example, context) => {
		example.match.headers.forEach((rule, index) => {
			if (SENSITIVE_MATCH_HEADERS.has(rule.key.toLowerCase()))
				context.addIssue({
					code: "custom",
					path: ["match", "headers", index, "key"],
					message: `"${rule.key}" cannot be a mock match rule because it carries credentials.`,
				});
		});
	});

export const tracerProjectSchema = z
	.object({
		schemaVersion: z.literal(TRACER_PROJECT_VERSION),
		kind: z.literal(TRACER_PROJECT_KIND),
		name: z.string().trim().min(1).max(LIMITS.name).optional(),
		description: z.string().max(LIMITS.description).default(""),
		collections: z.array(portableCollectionSchema).min(1).max(LIMITS.collectionsPerProfile),
		environments: z.array(portableEnvironmentSchema).max(LIMITS.environmentsPerProfile).default([]),
		examples: z.array(portableExampleSchema).max(LIMITS.examplesPerProfile).default([]),
	})
	.passthrough()
	.superRefine((project, context) => {
		assertUniqueNames(project.collections, context, "Collection");
		assertUniqueNames(project.environments, context, "Environment");
	});
