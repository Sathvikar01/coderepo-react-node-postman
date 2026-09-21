// Generated API documentation model.
//
// A documentation projection is a pure function of a saved collection aggregate.
// Nothing here reads environment state, tab drafts, send-only auth overrides, or
// the network, so the same saved collection always produces the same document.
//
// Safety contract:
// - Variable *values* are never copied into the model, plain or secret. Only names,
//   declarations, and references are projected.
// - Credential templates are reduced to the variable references they contain; every
//   literal character is replaced by a mask, so an accidentally hardcoded credential
//   cannot be published by the docs view.
// - Text is bounded before it reaches the DOM or an export, and text is treated as
//   text: the model never emits markup.

import { formatJsonText } from "../executions/json-format.js";

export const DOCS_LIMITS = {
	bodyChars: 8192,
	exampleBodyChars: 4096,
	templateChars: 512,
	valueChars: 2048,
	renderedRequests: 300,
	examplesPerRequest: 20,
	headersPerExample: 40,
	usedByNames: 10,
};

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const MASK = "\u2022\u2022\u2022";

export const AUTH_LABELS = {
	none: "No authentication",
	bearer: "Bearer token",
	basic: "Basic auth",
	apiKey: "API key",
};

export const VARIABLE_SCOPES = {
	collection: "Collection variable",
	secret: "Server secret (value never shown)",
	environment: "Environment variable (resolved at send time)",
	disabled: "Declared but disabled",
};

function text(value) {
	return typeof value === "string" ? value : "";
}

function bounded(value, limit) {
	const source = text(value);
	if (source.length <= limit) return { text: source, truncated: false };
	let cut = limit;
	if (cut > 0 && source.charCodeAt(cut - 1) >= 0xd800 && source.charCodeAt(cut - 1) <= 0xdbff) cut -= 1;
	return { text: source.slice(0, cut), truncated: true };
}

export function referencedVariables(value) {
	const names = [];
	for (const match of text(value).matchAll(PLACEHOLDER)) {
		if (!names.includes(match[1])) names.push(match[1]);
	}
	return names;
}

// Only variable references survive. Literal runs become a fixed mask so a template
// such as {{user}}:hunter2 can never publish the literal half.
export function maskTemplate(value, limit = DOCS_LIMITS.templateChars) {
	const source = text(value);
	let output = "";
	let cursor = 0;
	for (const match of source.matchAll(PLACEHOLDER)) {
		if (match.index > cursor) output += MASK;
		output += match[0];
		cursor = match.index + match[0].length;
	}
	if (cursor < source.length) output += MASK;
	const trimmed = output || (source ? MASK : "");
	const result = bounded(trimmed, limit);
	return { text: result.text, truncated: result.truncated, references: referencedVariables(source), masked: result.text.includes(MASK) };
}

function projectRows(rows, { limit = DOCS_LIMITS.valueChars } = {}) {
	if (!Array.isArray(rows)) return [];
	const projected = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const key = bounded(row.key, DOCS_LIMITS.valueChars);
		const value = bounded(row.value, limit);
		projected.push({
			id: typeof row.id === "string" ? row.id : `row-${projected.length}`,
			key: key.text,
			value: value.text,
			enabled: row.enabled !== false,
			truncated: key.truncated || value.truncated,
		});
	}
	return projected;
}

function projectBody(body) {
	const mode = body?.mode ?? "none";
	if (mode === "none") return { mode: "none", rows: [], format: "none", text: "", notices: [] };
	if (mode === "urlencoded") {
		const rows = projectRows(body.rows);
		const notices = rows.some((row) => row.truncated) ? ["Some form fields were shortened for this view."] : [];
		return { mode, rows, format: "urlencoded", text: "", notices };
	}
	const source = text(body.text);
	const size = bounded(source, DOCS_LIMITS.bodyChars);
	if (!source.trim()) return { mode, rows: [], format: mode === "json" ? "json" : "text", text: "", notices: [] };
	if (mode === "json") {
		if (size.truncated) {
			return {
				mode,
				rows: [],
				format: "json",
				text: size.text,
				notices: [
					`The body is larger than ${DOCS_LIMITS.bodyChars} characters; the original text is shown instead of a formatted copy.`,
				],
			};
		}
		const formatted = formatJsonText(size.text);
		if (formatted.ok) return { mode, rows: [], format: "json", text: formatted.text, notices: [] };
		return {
			mode,
			rows: [],
			format: "json",
			text: size.text,
			notices: ["This body is shown as Raw text because it cannot be formatted safely as JSON."],
		};
	}
	return {
		mode,
		rows: [],
		format: "text",
		text: size.text,
		contentType: bounded(body.contentType ?? "text/plain", 200).text,
		notices: size.truncated ? [`The body was shortened at ${DOCS_LIMITS.bodyChars} characters.`] : [],
	};
}

function projectExamples(examples) {
	if (!Array.isArray(examples)) return [];
	const projected = [];
	for (const entry of examples) {
		if (projected.length >= DOCS_LIMITS.examplesPerRequest) break;
		if (!entry || typeof entry !== "object") continue;
		const response = entry.response && typeof entry.response === "object" ? entry.response : entry;
		const headers = Array.isArray(response.headers) ? response.headers.slice(0, DOCS_LIMITS.headersPerExample) : [];
		const projectedHeaders = [];
		for (const header of headers) {
			if (!header || typeof header !== "object") continue;
			projectedHeaders.push({ name: bounded(header.name, 256).text, value: bounded(header.value, DOCS_LIMITS.valueChars).text });
		}
		const contentType = projectedHeaders.find((header) => header.name.toLowerCase() === "content-type")?.value ?? "";
		const rawBody =
			typeof response.body === "string" ? response.body : response.body == null ? "" : JSON.stringify(response.body, null, 2);
		const body = bounded(rawBody, DOCS_LIMITS.exampleBodyChars);
		const name = bounded(entry.name ?? entry.label ?? "", 120).text.trim();
		projected.push({
			id: typeof entry.id === "string" ? entry.id : `example-${projected.length}`,
			name: name || `Example ${projected.length + 1}`,
			status: Number.isInteger(response.status) ? response.status : null,
			contentType,
			headers: projectedHeaders,
			body: body.text,
			bodyTruncated: body.truncated,
		});
	}
	return projected;
}

function projectAuth(requestAuth, collectionAuth, scopeOf) {
	const request = requestAuth && typeof requestAuth === "object" ? requestAuth : { mode: "inherit" };
	const inherited = request.mode === "inherit" || !request.mode;
	const effective = inherited ? (collectionAuth?.mode && collectionAuth.mode !== "inherit" ? collectionAuth : { mode: "none" }) : request;
	const mode = effective.mode ?? "none";
	if (mode === "none") return { mode: "none", label: AUTH_LABELS.none, inherited, fields: [], references: [] };

	const references = [];
	const track = (field) => {
		for (const name of field.references) if (!references.includes(name)) references.push(name);
	};
	if (mode === "bearer") {
		const token = maskTemplate(effective.tokenTemplate);
		track(token);
		return { mode, label: AUTH_LABELS.bearer, inherited, fields: [{ label: "Token", ...token }], references };
	}
	if (mode === "basic") {
		const username = maskTemplate(effective.usernameTemplate);
		const password = maskTemplate(effective.passwordTemplate);
		track(username);
		track(password);
		return {
			mode,
			label: AUTH_LABELS.basic,
			inherited,
			fields: [
				{ label: "Username", ...username },
				{ label: "Password", ...password },
			],
			references,
		};
	}
	if (mode === "apiKey") {
		const value = maskTemplate(effective.valueTemplate);
		track(value);
		return {
			mode,
			label: `${AUTH_LABELS.apiKey} (${effective.in === "query" ? "query string" : "header"})`,
			inherited,
			fields: [
				{
					label: effective.in === "query" ? "Query name" : "Header name",
					text: bounded(effective.key, 256).text,
					references: [],
					truncated: false,
					masked: false,
				},
				{ label: "Value", ...value },
			],
			references,
		};
	}
	return { mode: "none", label: AUTH_LABELS.none, inherited, fields: [], references };
}

function projectRequest(request, { collection, scopeOf, group, index }) {
	const query = projectRows(request.query);
	const headers = projectRows(request.headers);
	const body = projectBody(request.body);
	const auth = projectAuth(request.auth, collection.auth, scopeOf);
	const url = bounded(request.urlTemplate, DOCS_LIMITS.valueChars);
	const examples = projectExamples(request.examples);
	const references = [];
	const addReferences = (names) => {
		for (const name of names) if (!references.includes(name)) references.push(name);
	};
	addReferences(referencedVariables(request.urlTemplate));
	for (const row of query) if (row.enabled) addReferences(referencedVariables(row.value));
	for (const row of headers) if (row.enabled) addReferences(referencedVariables(row.value));
	if (body.mode === "json" || body.mode === "text") addReferences(referencedVariables(body.text));
	for (const row of body.rows) if (row.enabled) addReferences(referencedVariables(row.value));
	addReferences(auth.references);

	const description = bounded(request.description, 1000).text;
	const fallbackId = `request-${index}`;
	const id = typeof request.id === "string" && request.id ? request.id : fallbackId;
	return {
		id,
		anchor: `docs-${id}`,
		name: bounded(request.name, 120).text.trim() || "Untitled request",
		method: typeof request.method === "string" && request.method ? request.method.toUpperCase() : "GET",
		url: url.text,
		urlTruncated: url.truncated,
		description,
		query,
		headers,
		body,
		auth,
		examples,
		group,
		variables: references.map((name) => ({ name, ...scopeOf(name) })),
	};
}

function scopeFactory(collection) {
	const declared = new Map();
	for (const variable of Array.isArray(collection.variables) ? collection.variables : []) {
		if (variable && typeof variable.key === "string" && !declared.has(variable.key))
			declared.set(variable.key, {
				kind: variable.kind === "secretRef" ? "secretRef" : "plain",
				enabled: variable.enabled !== false,
			});
	}
	return (name) => {
		const found = declared.get(name);
		if (!found) return { scope: "environment", label: VARIABLE_SCOPES.environment };
		if (!found.enabled) return { scope: "disabled", label: VARIABLE_SCOPES.disabled };
		if (found.kind === "secretRef") return { scope: "secret", label: VARIABLE_SCOPES.secret };
		return { scope: "collection", label: VARIABLE_SCOPES.collection };
	};
}

function projectVariables(collection, requests) {
	const rows = [];
	const seen = new Set();
	const push = (variable, declared) => {
		const key = bounded(variable?.key, 64).text.trim();
		if (!key || seen.has(key)) return;
		seen.add(key);
		const usedBy = requests.filter((request) => request.variables.some((entry) => entry.name === key)).map((request) => request.name);
		rows.push({
			key,
			declared,
			scope: variable.kind === "secretRef" ? "secret" : "plain",
			enabled: variable.enabled !== false,
			label: !declared
				? VARIABLE_SCOPES.environment
				: variable.enabled === false
					? VARIABLE_SCOPES.disabled
					: variable.kind === "secretRef"
						? VARIABLE_SCOPES.secret
						: VARIABLE_SCOPES.collection,
			usedBy: usedBy.slice(0, DOCS_LIMITS.usedByNames),
			usedByCount: usedBy.length,
		});
	};
	for (const variable of Array.isArray(collection.variables) ? collection.variables : []) push(variable, true);
	for (const request of requests) {
		for (const entry of request.variables) {
			if (entry.scope === "environment" && !seen.has(entry.name)) push({ key: entry.name, kind: "plain", enabled: true }, false);
		}
	}
	return rows;
}

// Missing or partial aggregates are tolerated: a half-loaded collection produces an
// empty document instead of throwing, so the docs view never breaks the workspace.
export function buildCollectionDocs(collection) {
	const source = collection && typeof collection === "object" ? collection : {};
	const folders = (Array.isArray(source.folders) ? source.folders : []).filter((folder) => folder && typeof folder.id === "string");
	const folderById = new Map(folders.map((folder) => [folder.id, bounded(folder.name, 120).text.trim() || "Untitled folder"]));
	const scopeOf = scopeFactory(source);
	const root = { id: null, name: "Requests" };
	const rawRequests = Array.isArray(source.requests) ? source.requests.filter((request) => request && typeof request === "object") : [];
	const ordered = rawRequests.map((request, index) => {
		const folderId = typeof request.folderId === "string" ? request.folderId : null;
		const group = folderById.has(folderId) ? { id: folderId, name: folderById.get(folderId) } : root;
		return { request, index, group };
	});
	ordered.sort((left, right) => {
		if (left.group.id === right.group.id) return left.index - right.index;
		if (left.group.id === null) return 1;
		if (right.group.id === null) return -1;
		return folders.findIndex((folder) => folder.id === left.group.id) - folders.findIndex((folder) => folder.id === right.group.id);
	});
	const requests = ordered
		.slice(0, DOCS_LIMITS.renderedRequests)
		.map((entry, index) => projectRequest(entry.request, { collection: source, scopeOf, group: entry.group, index }));

	return {
		id: typeof source._id === "string" ? source._id : String(source._id ?? ""),
		name: bounded(source.name, 120).text.trim() || "Untitled collection",
		description: bounded(source.description, 1000).text,
		revision: Number.isInteger(source.revision) ? source.revision : null,
		updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
		variables: projectVariables(source, requests),
		requests,
		requestCount: rawRequests.length,
		overflow: Math.max(rawRequests.length - requests.length, 0),
	};
}
