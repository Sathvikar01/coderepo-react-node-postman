// Shared import boundary. Every import adapter (cURL today; Postman, OpenAPI,
// and Insomnia later) produces the normalized shape from curl-parser.js, and
// this module is the single place that turns it into a workspace draft tab.
//
// Importing is deliberately side-effect free beyond the tab: it never saves,
// never sends, and never touches other tabs.

import { createDraftTab } from "../workspace/workspace-reducer.js";

const DEFAULT_TIMEOUT_MS = 15000;

const withId = (row) => ({
	id: crypto.randomUUID(),
	key: String(row?.key ?? ""),
	value: String(row?.value ?? ""),
	enabled: row?.enabled !== false,
});

function normalizeBody(body) {
	if (body?.mode === "urlencoded") return { mode: "urlencoded", rows: (body.rows ?? []).map(withId) };
	if (body?.mode === "json") return { mode: "json", text: String(body.text ?? "") };
	if (body?.mode === "text") return { mode: "text", text: String(body.text ?? ""), contentType: body.contentType ?? "text/plain" };
	return { mode: "none" };
}

// Adapters that carry richer request semantics (reproduction capsules today,
// Postman/OpenAPI/Insomnia tomorrow) pass auth, scripts, and assertions in the
// normalized request. They are preserved verbatim so importing never changes
// what the request means. Adapters without them (cURL) keep the old defaults.
function normalizeAuth(auth) {
	if (!auth) return { mode: "none" };
	if (auth.mode === "inherit" || auth.mode === "none") return { mode: auth.mode };
	if (auth.mode === "bearer") return { mode: "bearer", tokenTemplate: String(auth.tokenTemplate ?? "") };
	if (auth.mode === "basic")
		return {
			mode: "basic",
			usernameTemplate: String(auth.usernameTemplate ?? ""),
			passwordTemplate: String(auth.passwordTemplate ?? ""),
		};
	if (auth.mode === "apiKey")
		return {
			mode: "apiKey",
			key: String(auth.key ?? ""),
			valueTemplate: String(auth.valueTemplate ?? ""),
			in: auth.in === "query" ? "query" : "header",
		};
	return { mode: "none" };
}

export function importedRequestDefinition(request) {
	return {
		schemaVersion: 1,
		id: crypto.randomUUID(),
		folderId: null,
		name: String(request?.name ?? "Imported request").slice(0, 80),
		method: request?.method ?? "GET",
		urlTemplate: String(request?.urlTemplate ?? ""),
		query: (request?.query ?? []).map(withId),
		headers: (request?.headers ?? []).map(withId),
		body: normalizeBody(request?.body),
		auth: normalizeAuth(request?.auth),
		scripts: {
			preRequest: String(request?.scripts?.preRequest ?? ""),
			test: String(request?.scripts?.test ?? ""),
		},
		assertions: Array.isArray(request?.assertions) ? structuredClone(request.assertions) : [],
		settings: { timeoutMs: request?.settings?.timeoutMs ?? DEFAULT_TIMEOUT_MS },
	};
}

export function buildImportedTab(parsed) {
	if (!parsed?.ok || !parsed.request) return null;
	const tab = {
		...createDraftTab({ request: importedRequestDefinition(parsed.request) }),
		dirty: true,
	};
	return { tab, authOverride: parsed.authOverride ?? null };
}
