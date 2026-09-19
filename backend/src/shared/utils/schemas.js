import { z } from "zod";
import { LIMITS, utf8Bytes } from "./limits.js";

export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
export const AUTH_MODES = ["inherit", "none", "bearer", "basic", "apiKey"];
const CREDENTIAL_REFERENCE = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/;

const idSchema = z.uuid("Provide a valid identifier.");
export const rowSchema = z
	.object({
		id: idSchema,
		key: z
			.string()
			.max(LIMITS.rowKeyBytes)
			.refine((value) => utf8Bytes(value) <= LIMITS.rowKeyBytes, "Row keys are limited to 256 bytes."),
		value: z.string().refine((value) => utf8Bytes(value) <= LIMITS.rowValueBytes, "Row values are limited to 8 KiB."),
		enabled: z.boolean().default(true),
	})
	.strict();

export const rowsSchema = z.array(rowSchema).max(LIMITS.rowsPerList, "A list may contain at most 100 rows.");

export const variableSchema = z
	.object({
		id: idSchema,
		key: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.regex(
				/^[A-Za-z_][A-Za-z0-9_]*$/,
				"Variable names start with a letter or underscore and contain letters, digits, or underscores.",
			),
		kind: z.enum(["plain", "secretRef"]),
		value: z
			.string()
			.refine((value) => utf8Bytes(value) <= LIMITS.variableValueBytes, "Variable values are limited to 8 KiB.")
			.optional(),
		alias: z.string().trim().min(1).max(64).optional(),
		enabled: z.boolean().default(true),
	})
	.strict()
	.superRefine((variable, context) => {
		if (variable.kind === "plain" && variable.value === undefined)
			context.addIssue({ code: "custom", path: ["value"], message: "Plain variables require a value." });
		if (variable.kind === "secretRef" && !variable.alias)
			context.addIssue({ code: "custom", path: ["alias"], message: "Secret references require an alias." });
	});

export const variablesSchema = z
	.array(variableSchema)
	.max(LIMITS.variablesPerScope, "A scope may contain at most 100 variables.")
	.superRefine((variables, context) => {
		const seen = new Set();
		variables.forEach((variable, index) => {
			const key = variable.key.toLowerCase();
			if (seen.has(key))
				context.addIssue({ code: "custom", path: [index, "key"], message: "Variable names must be unique within their scope." });
			seen.add(key);
		});
		if (utf8Bytes(JSON.stringify(variables)) > LIMITS.variableScopeBytes)
			context.addIssue({ code: "custom", message: "The variable scope is limited to 64 KiB." });
	});

export const authSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("inherit") }).strict(),
	z.object({ mode: z.literal("none") }).strict(),
	z.object({ mode: z.literal("bearer"), tokenTemplate: z.string().max(8192) }).strict(),
	z.object({ mode: z.literal("basic"), usernameTemplate: z.string().max(8192), passwordTemplate: z.string().max(8192) }).strict(),
	z
		.object({
			mode: z.literal("apiKey"),
			key: z.string().trim().min(1).max(256),
			valueTemplate: z.string().max(8192),
			in: z.enum(["header", "query"]),
		})
		.strict(),
]);

const bodySchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("none") }).strict(),
	z.object({ mode: z.literal("json"), text: z.string() }).strict(),
	z.object({ mode: z.literal("text"), text: z.string(), contentType: z.string().trim().max(200).default("text/plain") }).strict(),
	z.object({ mode: z.literal("urlencoded"), rows: rowsSchema }).strict(),
]);

export const requestDefinitionSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: idSchema,
		folderId: z.union([idSchema, z.null()]).default(null),
		name: z.string().trim().min(1).max(LIMITS.name),
		method: z.enum(METHODS),
		urlTemplate: z
			.string()
			.max(LIMITS.urlBytes)
			.refine((value) => utf8Bytes(value) <= LIMITS.urlBytes, "URL templates are limited to 8 KiB."),
		query: rowsSchema,
		headers: rowsSchema,
		body: bodySchema,
		auth: authSchema,
		settings: z.object({ timeoutMs: z.number().int().min(100).max(30000) }).strict(),
	})
	.strict()
	.superRefine((request, context) => {
		if (["GET", "HEAD"].includes(request.method) && request.body.mode !== "none") {
			context.addIssue({ code: "custom", path: ["body"], message: `${request.method} requests cannot include a body.` });
		}
		if (request.auth.mode === "bearer" && !CREDENTIAL_REFERENCE.test(request.auth.tokenTemplate))
			context.addIssue({ code: "custom", path: ["auth", "tokenTemplate"], message: "Saved bearer credentials must use a variable reference." });
		if (
			request.auth.mode === "basic" &&
			(!CREDENTIAL_REFERENCE.test(request.auth.usernameTemplate) || !CREDENTIAL_REFERENCE.test(request.auth.passwordTemplate))
		)
			context.addIssue({ code: "custom", path: ["auth"], message: "Saved basic credentials must use variable references." });
		if (request.auth.mode === "apiKey" && !CREDENTIAL_REFERENCE.test(request.auth.valueTemplate))
			context.addIssue({ code: "custom", path: ["auth", "valueTemplate"], message: "Saved API-key credentials must use a variable reference." });
		const seen = new Set();
		request.headers.forEach((row, index) => {
			if (!row.enabled) return;
			const key = row.key.trim().toLowerCase();
			if (!key) return;
			if (seen.has(key))
				context.addIssue({
					code: "custom",
					path: ["headers", index, "key"],
					message: "Enabled request headers must not duplicate each other.",
				});
			seen.add(key);
		});
		if (utf8Bytes(JSON.stringify(request)) > LIMITS.requestJsonBytes)
			context.addIssue({ code: "custom", message: "A saved request is limited to 128 KiB." });
	});

export const folderSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(LIMITS.name) }).strict();

export const collectionAggregateSchema = z
	.object({
		name: z.string().trim().min(1).max(LIMITS.name),
		description: z.string().max(LIMITS.description).default(""),
		variables: variablesSchema,
		auth: authSchema,
		folders: z.array(folderSchema).max(LIMITS.foldersPerCollection, "A collection may contain at most 20 folders."),
		requests: z.array(requestDefinitionSchema).max(LIMITS.requestsPerCollection, "A collection may contain at most 100 requests."),
	})
	.strict()
	.superRefine((collection, context) => {
		if (collection.auth.mode === "inherit")
			context.addIssue({ code: "custom", path: ["auth"], message: "Collection authentication cannot inherit." });
		const folderIds = new Set();
		const folderNames = new Set();
		collection.folders.forEach((folder, index) => {
			if (folderIds.has(folder.id))
				context.addIssue({ code: "custom", path: ["folders", index, "id"], message: "Folder identifiers must be unique." });
			folderIds.add(folder.id);
			const normalizedName = folder.name.trim().toLocaleLowerCase();
			if (folderNames.has(normalizedName))
				context.addIssue({ code: "custom", path: ["folders", index, "name"], message: "Folder names must be unique within a collection." });
			folderNames.add(normalizedName);
		});
		const requestIds = new Set();
		collection.requests.forEach((request, index) => {
			if (requestIds.has(request.id))
				context.addIssue({ code: "custom", path: ["requests", index, "id"], message: "Request identifiers must be unique." });
			requestIds.add(request.id);
			if (request.folderId && !folderIds.has(request.folderId))
				context.addIssue({
					code: "custom",
					path: ["requests", index, "folderId"],
					message: "The folder does not exist in this collection.",
				});
		});
	});
