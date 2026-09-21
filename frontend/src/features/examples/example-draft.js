export const EXAMPLE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export const SENSITIVE_MATCH_HEADERS = ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"];

export function isSensitiveHeader(name) {
	return SENSITIVE_MATCH_HEADERS.includes(String(name ?? "").trim().toLowerCase());
}

export function contentTypeOf(headers = []) {
	return headers.find((header) => String(header.name ?? "").toLowerCase() === "content-type")?.value?.split(";")[0]?.trim() ?? "";
}

export function responsePayloadFrom(result) {
	const response = result?.response;
	if (!response) return null;
	return {
		status: response.status,
		statusText: response.statusText ?? "",
		contentType: contentTypeOf(response.headers ?? []),
		headers: (response.headers ?? []).map((header) => ({ name: header.name, value: header.value })),
		body: {
			encoding: response.body?.encoding === "base64" ? "base64" : "utf8",
			value: response.body?.value ?? "",
			mediaType: response.body?.mediaType ?? "",
			truncated: Boolean(response.body?.truncated),
			omittedReason: response.body?.omittedReason ?? null,
		},
	};
}

export function selectableRequestRows(request) {
	const pick = (rows) =>
		(rows ?? [])
			.filter((row) => row.enabled !== false && String(row.key ?? "").trim() !== "")
			.map((row) => ({ id: row.id, key: row.key, value: row.value ?? "" }));
	return { query: pick(request?.query), headers: pick(request?.headers).filter((row) => !isSensitiveHeader(row.key)) };
}

export function fromResponseInput({ name, request, result, environmentId, source, selectQueryIds, selectHeaderIds }) {
	return {
		mode: "from-response",
		name,
		source: {
			executionId: result.executionId,
			...(request?.id ? { requestId: request.id } : {}),
			...(source?.collectionId ? { collectionId: source.collectionId } : {}),
			...(request?.name ? { requestName: request.name } : {}),
		},
		request,
		...(environmentId ? { environmentId } : {}),
		...(Array.isArray(selectQueryIds) ? { selectQueryIds } : {}),
		...(Array.isArray(selectHeaderIds) ? { selectHeaderIds } : {}),
		response: responsePayloadFrom(result),
	};
}

export function manualInput({ name, match, response }) {
	return { mode: "manual", name, match: cleanMatch(match), response: cleanResponse(response) };
}

export function updateInput({ name, match, response }) {
	return { name, match: cleanMatch(match), response: cleanResponse(response) };
}

export function cleanMatch(match) {
	const cleanRows = (rows) =>
		(rows ?? [])
			.filter((row) => String(row.key ?? "").trim() !== "")
			.map((row) => ({ key: String(row.key).trim(), value: String(row.value ?? "") }));
	return {
		method: String(match?.method ?? "GET").toUpperCase(),
		path: String(match?.path ?? "").trim(),
		query: cleanRows(match?.query),
		headers: cleanRows(match?.headers),
	};
}

export function cleanResponse(response) {
	const nameOf = (header) => String(header.name ?? header.key ?? "").trim();
	return {
		status: Number(response?.status ?? 200),
		statusText: String(response?.statusText ?? ""),
		contentType: String(response?.contentType ?? ""),
		headers: (response?.headers ?? [])
			.filter((header) => nameOf(header) !== "")
			.map((header) => ({ name: nameOf(header), value: String(header.value ?? "") })),
		body: {
			encoding: response?.body?.encoding === "base64" ? "base64" : "utf8",
			value: String(response?.body?.value ?? ""),
			mediaType: String(response?.body?.mediaType ?? ""),
			truncated: Boolean(response?.body?.truncated),
			omittedReason: response?.body?.omittedReason ?? null,
		},
	};
}

export function emptyMatch() {
	return { method: "GET", path: "/", query: [], headers: [] };
}

export function emptyResponse() {
	return { status: 200, statusText: "OK", contentType: "text/plain", headers: [], body: { encoding: "utf8", value: "", mediaType: "text/plain" } };
}

export function exampleDraft(example) {
	if (!example) return { name: "", match: emptyMatch(), response: emptyResponse() };
	return {
		name: example.name ?? "",
		match: {
			method: example.match?.method ?? "GET",
			path: example.match?.path ?? "/",
			query: (example.match?.query ?? []).map((row) => ({ id: crypto.randomUUID(), key: row.key, value: row.value ?? "", enabled: true })),
			headers: (example.match?.headers ?? []).map((row) => ({ id: crypto.randomUUID(), key: row.key, value: row.value ?? "", enabled: true })),
		},
		response: {
			status: example.response?.status ?? 200,
			statusText: example.response?.statusText ?? "",
			contentType: example.response?.contentType ?? "",
			headers: (example.response?.headers ?? []).map((header) => ({
				id: crypto.randomUUID(),
				key: header.name,
				value: header.value ?? "",
				enabled: true,
			})),
			body: {
				encoding: example.response?.body?.encoding === "base64" ? "base64" : "utf8",
				value: example.response?.body?.value ?? "",
				mediaType: example.response?.body?.mediaType ?? "",
				truncated: Boolean(example.response?.body?.truncated),
				omittedReason: example.response?.body?.omittedReason ?? null,
			},
		},
	};
}

export function ruleRowsFromDraft(rows) {
	return (rows ?? []).map((row) => ({ key: row.key, value: row.value }));
}

export function headerRowsFromDraft(rows) {
	return (rows ?? []).map((row) => ({ name: row.key, value: row.value }));
}

export function describeExample(example) {
	const rules = (example?.match?.query?.length ?? 0) + (example?.match?.headers?.length ?? 0);
	return {
		method: example?.match?.method ?? "",
		path: example?.match?.path || "/",
		status: example?.response?.status ?? 0,
		contentType: example?.response?.contentType || "—",
		rules,
		source: example?.source?.type === "response" ? "From a live response" : "Manual",
	};
}
