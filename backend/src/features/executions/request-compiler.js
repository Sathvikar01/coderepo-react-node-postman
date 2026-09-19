import { AppError } from "../../shared/errors/app-error.js";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const MANAGED_TRANSPORT_HEADERS = new Set([
	"host",
	"content-length",
	"connection",
	"transfer-encoding",
	"upgrade",
	"accept-encoding",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function variableMap(collection, environment, secrets = new Map()) {
	const map = new Map();
	for (const variable of collection?.variables ?? []) {
		if (variable.enabled !== false) {
			if (variable.kind === "plain") map.set(variable.key, { value: variable.value ?? "", scope: "collection" });
			else if (variable.kind === "secretRef" && secrets.has(variable.key))
				map.set(variable.key, { value: secrets.get(variable.key), scope: "collection-secret" });
		}
	}
	for (const variable of environment?.variables ?? []) {
		if (variable.enabled !== false) {
			if (variable.kind === "plain") map.set(variable.key, { value: variable.value ?? "", scope: "environment" });
			else if (variable.kind === "secretRef" && secrets.has(variable.key))
				map.set(variable.key, { value: secrets.get(variable.key), scope: "environment-secret" });
		}
	}
	return map;
}

function interpolate(template, map, field, trace, missing) {
	const value = String(template ?? "");
	if (!value.includes("{{")) return value;
	const output = value.replace(PLACEHOLDER, (match, name) => {
		const entry = map.get(name);
		if (!entry) {
			missing.add(name);
			missing.fields.add(field);
			return match;
		}
		trace.push({ field, variable: name, scope: entry.scope });
		return entry.value;
	});
	return output;
}

function ensureHeaderSafety(name, value) {
	const trimmed = name.trim();
	if (!trimmed || !TOKEN.test(trimmed)) throw new AppError(400, "HEADER_INVALID", "Header names must be valid HTTP tokens.");
	if (/[\r\n]/.test(String(value ?? ""))) throw new AppError(400, "HEADER_INVALID", "Header values cannot contain line breaks.");
}

function addHeader(headers, seen, name, value, { generated = false } = {}) {
	ensureHeaderSafety(name, value);
	const lower = name.toLowerCase();
	if (MANAGED_TRANSPORT_HEADERS.has(lower))
		throw new AppError(400, "HEADER_RESERVED", `The header "${name}" is managed by the transport.`);
	if (seen.has(lower))
		throw new AppError(400, generated ? "AUTH_CONFLICT" : "HEADER_INVALID", `The header "${name}" is defined more than once.`);
	seen.add(lower);
	headers.push({ name, value });
}

function mergeQuery(url, rows, missing, trace) {
	const pairs = [];
	url.searchParams.forEach((value, key) => pairs.push([key, value]));
	for (const row of rows) {
		if (!row.enabled) continue;
		const name = String(row.key ?? "");
		const value = interpolate(row.value, row._map, "query.value", trace, missing);
		if (!name.trim()) continue;
		pairs.push([name, value]);
	}
	return pairs;
}

function encodeQuery(pairs) {
	const search = new URLSearchParams();
	for (const [key, value] of pairs) search.append(key, value);
	return search.toString();
}

function buildBody(body, map, missing, trace) {
	if (body.mode === "none") return { bytes: null, contentType: null };
	if (body.mode === "json") {
		const text = interpolate(body.text, map, "body.text", trace, missing);
		return { bytes: Buffer.from(text, "utf8"), contentType: "application/json", jsonText: text };
	}
	if (body.mode === "text") {
		const text = interpolate(body.text, map, "body.text", trace, missing);
		return { bytes: Buffer.from(text, "utf8"), contentType: body.contentType || "text/plain" };
	}
	const search = new URLSearchParams();
	for (const row of body.rows) {
		if (!row.enabled) continue;
		const name = String(row.key ?? "");
		const value = interpolate(row.value, map, "body.rows.value", trace, missing);
		if (!name.trim()) continue;
		search.append(name, value);
	}
	const text = search.toString();
	return { bytes: Buffer.from(text, "utf8"), contentType: "application/x-www-form-urlencoded" };
}

function effectiveAuth(request, collection) {
	if (request.auth?.mode === "inherit") {
		if (!collection)
			throw new AppError(
				400,
				"INHERIT_WITHOUT_COLLECTION",
				"This request inherits authentication but is not attached to a collection.",
			);
		if (collection.auth?.mode === "inherit")
			throw new AppError(400, "INHERIT_INVALID", "Collection authentication cannot itself inherit.");
		return { auth: collection.auth ?? { mode: "none" }, source: "collection" };
	}
	return { auth: request.auth ?? { mode: "none" }, source: "request" };
}

export function compileRequest({ request, collection, environment, authOverride, secrets = new Map() }) {
	const map = variableMap(collection, environment, secrets);
	const missing = Object.assign(new Set(), { fields: new Set() });
	const trace = [];
	const warnings = [];
	const redaction = { values: [], headerNames: new Set(), queryKeys: new Set() };

	const forRow = (rows) => rows.map((row) => ({ ...row, _map: map }));
	const urlTemplate = interpolate(request.urlTemplate, map, "url", trace, missing);
	let url;
	try {
		url = new URL(urlTemplate);
	} catch {
		if (missing.size > 0)
			throw new AppError(400, "VARIABLE_UNKNOWN", `Unknown variable${missing.size > 1 ? "s" : ""}: ${[...missing].join(", ")}.`, {
				variables: [...missing],
				fields: [...missing.fields],
			});
		throw new AppError(400, "URL_INVALID", "Provide an absolute HTTP or HTTPS URL.");
	}
	const rows = forRow(request.query ?? []);
	const pairs = mergeQuery(url, rows, missing, trace);
	const headerRows = forRow(request.headers ?? []);
	const body = buildBody(request.body, map, missing, trace);
	const { auth, source } = authOverride ? { auth: authOverride, source: "override" } : effectiveAuth(request, collection);
	const resolvedAuth = auth ?? { mode: "none" };
	const headers = [];
	const headerNames = new Set();
	for (const row of headerRows) {
		if (!row.enabled) continue;
		const name = String(row.key ?? "").trim();
		const value = interpolate(row.value, map, "headers.value", trace, missing);
		addHeader(headers, headerNames, name, value);
	}
	if (body.contentType && !headerNames.has("content-type") && body.bytes)
		addHeader(headers, headerNames, "Content-Type", body.contentType, { generated: true });
	if (resolvedAuth.mode === "bearer") {
		const token = interpolate(resolvedAuth.tokenTemplate, map, "auth.tokenTemplate", trace, missing);
		addHeader(headers, headerNames, "Authorization", `Bearer ${token}`, { generated: true });
		redaction.headerNames.add("authorization");
		redaction.values.push(token);
	} else if (resolvedAuth.mode === "basic") {
		const username = interpolate(resolvedAuth.usernameTemplate, map, "auth.usernameTemplate", trace, missing);
		const password = interpolate(resolvedAuth.passwordTemplate, map, "auth.passwordTemplate", trace, missing);
		const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
		addHeader(headers, headerNames, "Authorization", `Basic ${encoded}`, { generated: true });
		redaction.headerNames.add("authorization");
		redaction.values.push(encoded, `${username}:${password}`, encodeURIComponent(`${username}:${password}`), password);
	} else if (resolvedAuth.mode === "apiKey") {
		const key = resolvedAuth.key.trim();
		const value = interpolate(resolvedAuth.valueTemplate, map, "auth.valueTemplate", trace, missing);
		if (resolvedAuth.in === "header") {
			addHeader(headers, headerNames, key, value, { generated: true });
			redaction.headerNames.add(key.toLowerCase());
		} else {
			if (pairs.some(([name]) => name.toLowerCase() === key.toLowerCase()))
				throw new AppError(400, "AUTH_CONFLICT", `The generated API key query "${key}" conflicts with an explicit query field.`);
			pairs.push([key, value]);
			redaction.queryKeys.add(key.toLowerCase());
		}
		redaction.values.push(value);
	}

	if (missing.size > 0) {
		throw new AppError(400, "VARIABLE_UNKNOWN", `Unknown variable${missing.size > 1 ? "s" : ""}: ${[...missing].join(", ")}.`, {
			variables: [...missing],
			fields: [...missing.fields],
		});
	}

	const query = encodeQuery(pairs);
	url.search = query ? `?${query}` : "";
	const finalUrl = url.toString();
	if (utf8Bytes(urlTemplate) > LIMITS.urlBytes)
		throw new AppError(413, "URL_TOO_LARGE", "The URL template exceeds 8 KiB.", {
			limit: LIMITS.urlBytes,
			actual: utf8Bytes(urlTemplate),
			unit: "bytes",
			scope: "url-template",
		});
	if (utf8Bytes(finalUrl) > LIMITS.urlBytes)
		throw new AppError(413, "URL_TOO_LARGE", "The encoded URL exceeds 8 KiB.", {
			limit: LIMITS.urlBytes,
			actual: utf8Bytes(finalUrl),
			unit: "bytes",
			scope: "url-encoded",
		});
	if (utf8Bytes(query) > LIMITS.queryBytes)
		throw new AppError(413, "QUERY_TOO_LARGE", "The encoded query exceeds 4 KiB.", {
			limit: LIMITS.queryBytes,
			actual: utf8Bytes(query),
			unit: "bytes",
			scope: "query",
		});
	const headerBytes = headers.reduce((total, header) => total + utf8Bytes(header.name) + utf8Bytes(header.value) + 4, 0);
	if (headerBytes > LIMITS.requestHeaderBytes)
		throw new AppError(413, "HEADER_LIMIT", "Request headers exceed 16 KiB.", {
			limit: LIMITS.requestHeaderBytes,
			actual: headerBytes,
			unit: "bytes",
			scope: "request-headers",
		});
	if (body.bytes && body.bytes.length > LIMITS.requestBodyBytes)
		throw new AppError(413, "BODY_TOO_LARGE", "The request body exceeds 64 KiB.", {
			limit: LIMITS.requestBodyBytes,
			actual: body.bytes.length,
			unit: "bytes",
			scope: "request-body",
		});

	if (request.body?.mode === "json" && body.bytes) {
		try {
			JSON.parse(body.jsonText);
		} catch {
			throw new AppError(400, "BODY_JSON_INVALID", "The JSON body is not valid after variable interpolation.");
		}
	}

	return {
		method: request.method,
		authoredUrl: urlTemplate,
		url: finalUrl,
		headers,
		body: body.bytes,
		authMode: resolvedAuth.mode,
		authSource: source,
		authTemplate: resolvedAuth,
		redaction: {
			values: [...new Set(redaction.values.filter(Boolean))],
			headerNames: [...redaction.headerNames],
			queryKeys: [...redaction.queryKeys],
		},
		trace,
		warnings,
		timeoutMs: request.settings?.timeoutMs ?? 15000,
		displayUrl: finalUrl,
	};
}

export function redactUrl(url, redaction) {
	try {
		const parsed = new URL(url);
		for (const key of redaction.queryKeys) {
			for (const name of [...parsed.searchParams.keys()]) {
				if (name.toLowerCase() === key) parsed.searchParams.set(name, "[REDACTED]");
			}
		}
		let output = parsed.toString();
		for (const secret of redaction.values ?? []) {
			if (!secret || secret.length < 3) continue;
			for (const candidate of [secret, encodeURIComponent(secret)]) {
				if (candidate) output = output.split(candidate).join("[REDACTED]");
			}
		}
		return output;
	} catch {
		return url;
	}
}
