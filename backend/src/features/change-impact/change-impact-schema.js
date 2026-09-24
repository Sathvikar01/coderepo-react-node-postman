import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import {
	assertionNode,
	collectionAuthNode,
	collectionNode,
	collectionVariableNode,
	environmentNode,
	environmentVariableNode,
	folderNode,
	requestAuthNode,
	requestHeaderNode,
	requestNode,
	requestVariableNode,
	sharedHeaderNode,
} from "./node-ids.js";

// Input validation for the change-impact engine.
//
// The engine is fail-closed: stored data that does not match the declared shape is
// rejected with a structured AppError instead of being coerced. Unknown persistence
// metadata (_id, revision, timestamps, nameKey) is stripped by zod so real Mongo
// documents can be passed without a separate projection step, but every field the
// graph depends on is type-checked.

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const variableSchema = z
	.object({
		id: z.string().min(1),
		key: z.string().regex(KEY, "Variable keys start with a letter or underscore."),
		kind: z.enum(["plain", "secretRef"]),
		value: z.string().optional(),
		alias: z.string().optional(),
		enabled: z.boolean().optional(),
	})
	.superRefine((variable, context) => {
		if (variable.kind === "plain" && variable.value === undefined)
			context.addIssue({ code: "custom", path: ["value"], message: "Plain variables require a value." });
		if (variable.kind === "secretRef") {
			if (!variable.alias) context.addIssue({ code: "custom", path: ["alias"], message: "Secret references require an alias." });
			if (variable.value !== undefined)
				context.addIssue({ code: "custom", path: ["value"], message: "Secret references must not store a value." });
		}
	});

const rowSchema = z.object({
	id: z.string().min(1),
	key: z.string(),
	value: z.string(),
	enabled: z.boolean().optional(),
});

const authSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("inherit") }),
	z.object({ mode: z.literal("none") }),
	z.object({ mode: z.literal("bearer"), tokenTemplate: z.string() }),
	z.object({ mode: z.literal("basic"), usernameTemplate: z.string(), passwordTemplate: z.string() }),
	z.object({ mode: z.literal("apiKey"), key: z.string(), valueTemplate: z.string(), in: z.enum(["header", "query"]) }),
]);

const bodySchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("none") }),
	z.object({ mode: z.literal("json"), text: z.string() }),
	z.object({ mode: z.literal("text"), text: z.string(), contentType: z.string().optional() }),
	z.object({ mode: z.literal("urlencoded"), rows: z.array(rowSchema) }),
]);

const scriptsSchema = z.object({
	preRequest: z.string().optional(),
	test: z.string().optional(),
});

const assertionSchema = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	target: z.enum(["status", "header", "body", "json"]).optional(),
	path: z.string().optional(),
});

const requestSchema = z
	.object({
		id: z.string().min(1),
		folderId: z.string().min(1).nullable().optional(),
		name: z.string().optional(),
		method: z.string().optional(),
		urlTemplate: z.string(),
		query: z.array(rowSchema).optional(),
		headers: z.array(rowSchema).optional(),
		body: bodySchema.optional(),
		auth: authSchema.optional(),
		scripts: scriptsSchema.optional(),
		assertions: z.array(assertionSchema).optional(),
		settings: z.object({ timeoutMs: z.number().optional() }).optional(),
	})
	.superRefine((request, context) => {
		const seen = new Set();
		(request.headers ?? []).forEach((row, index) => {
			if (row.enabled === false) return;
			const key = row.key.trim().toLowerCase();
			if (!key) return;
			if (seen.has(key))
				context.addIssue({ code: "custom", path: ["headers", index, "key"], message: "Enabled headers must be unique per request." });
			seen.add(key);
		});
		const ids = new Set();
		(request.assertions ?? []).forEach((assertion, index) => {
			if (ids.has(assertion.id))
				context.addIssue({ code: "custom", path: ["assertions", index, "id"], message: "Assertion identifiers must be unique." });
			ids.add(assertion.id);
		});
	});

const folderSchema = z.object({ id: z.string().min(1), name: z.string().optional() });

function uniqueKeys(items, path, context) {
	const seen = new Set();
	(items ?? []).forEach((item, index) => {
		const key = item.key.toLowerCase();
		if (seen.has(key))
			context.addIssue({ code: "custom", path: [path, index, "key"], message: "Variable keys must be unique within a scope." });
		seen.add(key);
	});
}

const collectionSchema = z
	.object({
		id: z.string().min(1),
		ownerProfileId: z.string().optional(),
		name: z.string().optional(),
		variables: z.array(variableSchema).optional(),
		auth: authSchema.optional(),
		folders: z.array(folderSchema).optional(),
		requests: z.array(requestSchema).optional(),
	})
	.superRefine((collection, context) => {
		uniqueKeys(collection.variables, "variables", context);
		const folderIds = new Set();
		(collection.folders ?? []).forEach((folder, index) => {
			if (folderIds.has(folder.id))
				context.addIssue({ code: "custom", path: ["folders", index, "id"], message: "Folder identifiers must be unique." });
			folderIds.add(folder.id);
		});
		const requestIds = new Set();
		(collection.requests ?? []).forEach((request, index) => {
			if (requestIds.has(request.id))
				context.addIssue({ code: "custom", path: ["requests", index, "id"], message: "Request identifiers must be unique." });
			requestIds.add(request.id);
			if (request.folderId && !folderIds.has(request.folderId))
				context.addIssue({ code: "custom", path: ["requests", index, "folderId"], message: "The folder does not exist in this collection." });
		});
	});

const environmentSchema = z
	.object({
		id: z.string().min(1),
		ownerProfileId: z.string().optional(),
		name: z.string().optional(),
		variables: z.array(variableSchema).optional(),
	})
	.superRefine((environment, context) => uniqueKeys(environment.variables, "variables", context));

export const workspaceSchema = z
	.object({
		ownerProfileId: z.string().optional(),
		environmentId: z.string().min(1).nullable().optional(),
		collections: z.array(collectionSchema),
		environments: z.array(environmentSchema).optional(),
	})
	.superRefine((workspace, context) => {
		const collectionIds = new Set();
		workspace.collections.forEach((collection, index) => {
			if (collectionIds.has(collection.id))
				context.addIssue({ code: "custom", path: ["collections", index, "id"], message: "Collection identifiers must be unique." });
			collectionIds.add(collection.id);
		});
		const environmentIds = new Set();
		(workspace.environments ?? []).forEach((environment, index) => {
			if (environmentIds.has(environment.id))
				context.addIssue({ code: "custom", path: ["environments", index, "id"], message: "Environment identifiers must be unique." });
			environmentIds.add(environment.id);
		});
		if (workspace.environmentId && !environmentIds.has(workspace.environmentId))
			context.addIssue({ code: "custom", path: ["environmentId"], message: "The selected environment is not part of this workspace." });
		const profileIds = new Set();
		if (workspace.ownerProfileId) profileIds.add(workspace.ownerProfileId);
		for (const entity of [...workspace.collections, ...(workspace.environments ?? [])]) if (entity.ownerProfileId) profileIds.add(entity.ownerProfileId);
		if (profileIds.size > 1)
			context.addIssue({ code: "custom", path: ["ownerProfileId"], message: "A workspace must belong to a single profile." });
	});

const changeTargetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("environment"), environmentId: z.string().min(1) }),
	z.object({ kind: z.literal("environmentVariable"), environmentId: z.string().min(1), key: z.string().min(1) }),
	z.object({ kind: z.literal("collection"), collectionId: z.string().min(1) }),
	z.object({ kind: z.literal("collectionVariable"), collectionId: z.string().min(1), key: z.string().min(1) }),
	z.object({ kind: z.literal("folder"), collectionId: z.string().min(1), folderId: z.string().min(1) }),
	z.object({ kind: z.literal("request"), collectionId: z.string().min(1), requestId: z.string().min(1) }),
	z.object({ kind: z.literal("requestVariable"), collectionId: z.string().min(1), requestId: z.string().min(1), key: z.string().min(1) }),
	z.object({ kind: z.literal("auth"), scope: z.enum(["collection", "request"]), collectionId: z.string().min(1), requestId: z.string().min(1).optional() }),
	z.object({
		kind: z.literal("header"),
		scope: z.enum(["shared", "request"]),
		name: z.string().min(1),
		collectionId: z.string().min(1).optional(),
		requestId: z.string().min(1).optional(),
	}),
]);

export const changeSchema = z
	.object({
		operation: z.enum(["changed", "removed"]),
		target: changeTargetSchema,
	})
	.superRefine((change, context) => {
		const target = change.target;
		if (target.kind === "auth" && target.scope === "request" && !target.requestId)
			context.addIssue({ code: "custom", path: ["target", "requestId"], message: "Request-scoped auth changes need a request id." });
		if (target.kind === "header" && target.scope === "request") {
			if (!target.collectionId) context.addIssue({ code: "custom", path: ["target", "collectionId"], message: "Request header changes need a collection id." });
			if (!target.requestId) context.addIssue({ code: "custom", path: ["target", "requestId"], message: "Request header changes need a request id." });
		}
	});

function toDetails(error) {
	return (error.issues ?? []).map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

export function parseWorkspace(input) {
	const result = workspaceSchema.safeParse(input);
	if (!result.success) throw new AppError(422, "CHANGE_IMPACT_SOURCE_INVALID", "The workspace data is malformed.", { issues: toDetails(result.error) });
	return result.data;
}

export function parseChange(input) {
	const result = changeSchema.safeParse(input);
	if (!result.success) throw new AppError(422, "CHANGE_IMPACT_CHANGE_INVALID", "The proposed change is malformed.", { issues: toDetails(result.error) });
	return result.data;
}

// Canonical, stable form of a change used in the result envelope and in the root
// node id. Header names are lowercased so a change matches regardless of casing.
export function canonicalChange(change) {
	const target = change.target;
	if (target.kind === "header") return { operation: change.operation, target: { ...target, name: target.name.toLowerCase() } };
	return { operation: change.operation, target: { ...target } };
}

export function rootNodeIdOf(change) {
	const target = change.target;
	switch (target.kind) {
		case "environment":
			return environmentNode(target.environmentId);
		case "environmentVariable":
			return environmentVariableNode(target.environmentId, target.key);
		case "collection":
			return collectionNode(target.collectionId);
		case "collectionVariable":
			return collectionVariableNode(target.collectionId, target.key);
		case "folder":
			return folderNode(target.collectionId, target.folderId);
		case "request":
			return requestNode(target.collectionId, target.requestId);
		case "requestVariable":
			return requestVariableNode(target.collectionId, target.requestId, target.key);
		case "auth":
			return target.scope === "collection" ? collectionAuthNode(target.collectionId) : requestAuthNode(target.collectionId, target.requestId);
		case "header":
			return target.scope === "shared"
				? sharedHeaderNode(target.name.toLowerCase())
				: requestHeaderNode(target.collectionId, target.requestId, target.name.toLowerCase());
		default:
			return null;
	}
}

const CATEGORY_BY_TARGET = {
	environment: "environment",
	environmentVariable: "variable",
	collection: "collection-config",
	collectionVariable: "variable",
	folder: "folder",
	request: "request",
	requestVariable: "variable",
	auth: "auth",
	header: "header",
};

export function categoryOf(change) {
	return CATEGORY_BY_TARGET[change.target.kind] ?? "unknown";
}
