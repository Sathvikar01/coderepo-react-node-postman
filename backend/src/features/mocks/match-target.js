import { compileRequest } from "../executions/request-compiler.js";
import { SENSITIVE_MATCH_HEADERS } from "./mock-matcher.js";

function authoredPath(urlTemplate) {
	const value = String(urlTemplate ?? "").trim();
	if (!value) return "";
	try {
		return new URL(value).pathname;
	} catch {
		// Baseline URLs such as {{baseUrl}}/orders cannot be parsed until they are compiled.
	}
	const withoutQuery = value.split(/[?#]/)[0];
	if (withoutQuery.startsWith("/")) return withoutQuery;
	return withoutQuery.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, "") || "/";
}

function enabledRows(rows = []) {
	return rows.filter((row) => row?.enabled !== false && String(row?.key ?? "").trim() !== "");
}

function firstByKey(rows, keyOf) {
	const index = new Map();
	for (const row of rows) {
		const key = keyOf(row);
		if (!index.has(key)) index.set(key, row.value);
	}
	return index;
}

export function matchTargetFromRequest({ request, environment }) {
	const authored = {
		method: String(request?.method ?? "").toUpperCase(),
		path: authoredPath(request?.urlTemplate),
		query: enabledRows(request?.query).map((row) => ({ key: String(row.key), value: String(row.value ?? "") })),
		headers: enabledRows(request?.headers).map((row) => ({ key: String(row.key), value: String(row.value ?? "") })),
	};
	let compiled;
	try {
		compiled = compileRequest({
			request,
			environment: environment ?? null,
			authOverride: { mode: "none" },
			secrets: new Map(),
		});
	} catch {
		return authored;
	}
	try {
		const url = new URL(compiled.url);
		return {
			method: compiled.method,
			path: url.pathname,
			query: [...url.searchParams.entries()].map(([key, value]) => ({ key, value })),
			headers: (compiled.headers ?? []).map((header) => ({ key: header.name, value: header.value })),
		};
	} catch {
		return authored;
	}
}

export function matchRulesFromRequest({ request, environment, selectQueryIds, selectHeaderIds }) {
	const target = matchTargetFromRequest({ request, environment });
	const queryIndex = firstByKey(target.query, (row) => row.key);
	const headerIndex = firstByKey(target.headers, (row) => row.key.toLowerCase());
	const select = (rows, ids) => {
		const chosen = enabledRows(rows);
		if (!Array.isArray(ids)) return chosen;
		const allowed = new Set(ids);
		return chosen.filter((row) => allowed.has(row.id));
	};
	return {
		method: target.method,
		path: target.path,
		query: select(request?.query, selectQueryIds).map((row) => ({
			key: String(row.key),
			value: queryIndex.get(String(row.key)) ?? String(row.value ?? ""),
		})),
		headers: select(request?.headers, selectHeaderIds)
			.filter((row) => !SENSITIVE_MATCH_HEADERS.has(String(row.key).toLowerCase()))
			.map((row) => ({
				key: String(row.key),
				value: headerIndex.get(String(row.key).toLowerCase()) ?? String(row.value ?? ""),
			})),
	};
}
