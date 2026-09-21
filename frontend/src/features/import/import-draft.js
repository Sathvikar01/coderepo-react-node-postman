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
		auth: { mode: "none" },
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
