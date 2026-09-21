// Normalized export model. One module decides which parts of a Tracer request
// can be represented as portable code; the snippet renderers only format it.
//
// Export reads the request definition and never resolves variables. `{{name}}`
// placeholders travel to the snippet exactly as typed, so variable references
// stay references and resolved secret values can never leak into code.
//
// Send-only auth overrides live in separate workspace state and are
// deliberately not part of this boundary: `authOverride` is not read here.

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const BODY_MODES = new Set(["none", "json", "text", "urlencoded"]);
const AUTH_MODES = new Set(["inherit", "none", "bearer", "basic", "apiKey"]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Mirrors MANAGED_TRANSPORT_HEADERS in
// backend/src/features/executions/request-compiler.js.
const RESERVED_HEADERS = new Set([
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

const URLENCODED_TYPE = "application/x-www-form-urlencoded";

function existingQueryNames(url) {
	const names = new Set();
	const start = url.indexOf("?");
	if (start === -1) return names;
	const hash = url.indexOf("#");
	const query = url.slice(start + 1, hash === -1 ? undefined : hash);
	for (const [name] of new URLSearchParams(query)) names.add(name.toLowerCase());
	return names;
}

// Appends enabled rows after any query the URL already carries, preserving row
// order and duplicate keys. Placeholders keep their braces instead of becoming
// percent-encoded, so `{{token}}` stays legible in the snippet.
function appendQuery(url, pairs) {
	if (pairs.length === 0) return url;
	const hash = url.indexOf("#");
	const base = hash === -1 ? url : url.slice(0, hash);
	const fragment = hash === -1 ? "" : url.slice(hash);
	const encoded = pairs
		.map(([key, value]) => {
			const search = new URLSearchParams();
			search.append(key, value);
			return search.toString().replaceAll("%7B%7B", "{{").replaceAll("%7D%7D", "}}");
		})
		.join("&");
	const glue = base.includes("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?";
	return `${base}${glue}${encoded}${fragment}`;
}

function resolveAuth(rawAuth, collectionAuth, fail) {
	const auth = rawAuth ?? { mode: "none" };
	if (!AUTH_MODES.has(auth.mode)) {
		fail("AUTH_UNSUPPORTED", `Tracer cannot generate code for the auth mode "${auth.mode ?? "(missing)"}".`);
		return { mode: "none" };
	}
	if (auth.mode !== "inherit") return auth;
	if (!collectionAuth) {
		fail("INHERIT_WITHOUT_COLLECTION", "This request inherits authentication but is not attached to a collection.");
		return { mode: "none" };
	}
	if (!AUTH_MODES.has(collectionAuth.mode) || collectionAuth.mode === "inherit") {
		fail("INHERIT_INVALID", "Collection authentication cannot itself inherit.");
		return { mode: "none" };
	}
	return collectionAuth;
}

// Expands auth into headers and query pairs exactly like the executor does.
// Basic auth stays separate because every language encodes it differently.
function expandAuth(auth, headers, queryPairs, urlNames, fail) {
	const hasHeader = (name) => headers.some((header) => header.name.toLowerCase() === name);
	if (auth.mode === "bearer") {
		if (hasHeader("authorization")) {
			fail("AUTH_CONFLICT", 'The header "Authorization" is defined more than once.');
			return null;
		}
		headers.push({ name: "Authorization", value: `Bearer ${String(auth.tokenTemplate ?? "")}` });
		return null;
	}
	if (auth.mode === "basic") {
		if (hasHeader("authorization")) {
			fail("AUTH_CONFLICT", 'The header "Authorization" is defined more than once.');
			return null;
		}
		return { username: String(auth.usernameTemplate ?? ""), password: String(auth.passwordTemplate ?? "") };
	}
	if (auth.mode === "apiKey") {
		const key = String(auth.key ?? "").trim();
		if (!key) {
			fail("AUTH_INVALID", "API-key authentication needs a header or query name.");
			return null;
		}
		const value = String(auth.valueTemplate ?? "");
		if (auth.in === "header") {
			if (hasHeader(key.toLowerCase())) {
				fail("AUTH_CONFLICT", `The generated API key header "${key}" conflicts with an explicit header.`);
				return null;
			}
			headers.push({ name: key, value });
			return null;
		}
		if (auth.in === "query") {
			const collides = urlNames.has(key.toLowerCase()) || queryPairs.some(([name]) => name.toLowerCase() === key.toLowerCase());
			if (collides) {
				fail("AUTH_CONFLICT", `The generated API key query "${key}" conflicts with an explicit query field.`);
				return null;
			}
			queryPairs.push([key, value]);
			return null;
		}
		fail("AUTH_UNSUPPORTED", `Tracer cannot generate code for an API key in "${auth.in ?? "(missing)"}".`);
		return null;
	}
	return null;
}

function normalizeBody(body) {
	if (body.mode === "none") return { kind: "none" };
	if (body.mode === "json") return { kind: "raw", text: String(body.text ?? "") };
	if (body.mode === "text") return { kind: "raw", text: String(body.text ?? "") };
	return {
		kind: "urlencoded",
		pairs: (body.rows ?? [])
			.filter((row) => row?.enabled !== false && String(row?.key ?? "").trim())
			.map((row) => [String(row.key).trim(), String(row.value ?? "")]),
	};
}

export function buildExportModel(request, { collectionAuth = null } = {}) {
	const errors = [];
	const warnings = [];
	const fail = (code, message) => errors.push({ code, message });

	if (!request || typeof request !== "object") {
		fail("REQUEST_INVALID", "Open a request before generating code.");
		return { ok: false, model: null, errors, warnings };
	}

	const method = String(request.method ?? "");
	if (!METHODS.has(method)) fail("METHOD_UNSUPPORTED", `Tracer cannot generate code for the method "${method || "(missing)"}".`);

	const url = String(request.urlTemplate ?? "").trim();
	if (!url) fail("URL_MISSING", "Add a URL before generating code.");

	const body = request.body ?? { mode: "none" };
	if (!BODY_MODES.has(body?.mode))
		fail("BODY_UNSUPPORTED", `Tracer cannot generate code for the body mode "${body?.mode ?? "(missing)"}".`);
	if (["GET", "HEAD"].includes(method) && body?.mode !== "none")
		fail("GET_BODY_UNSUPPORTED", `${method} requests cannot include a body.`);

	const headers = [];
	const headerCounts = new Map();
	for (const row of request.headers ?? []) {
		if (row?.enabled === false) continue;
		const name = String(row?.key ?? "").trim();
		const value = String(row?.value ?? "");
		if (!name) {
			fail("HEADER_INVALID", "An enabled header row has no name. Add one or turn the row off.");
			continue;
		}
		if (!TOKEN.test(name)) {
			fail("HEADER_INVALID", `"${name}" is not a valid HTTP header name.`);
			continue;
		}
		if (RESERVED_HEADERS.has(name.toLowerCase())) {
			fail("HEADER_RESERVED", `The header "${name}" is managed by the transport and cannot be set per request.`);
			continue;
		}
		if (/[\r\n]/.test(value)) {
			fail("HEADER_INVALID", `The header "${name}" contains a line break.`);
			continue;
		}
		headers.push({ name, value });
		headerCounts.set(name.toLowerCase(), (headerCounts.get(name.toLowerCase()) ?? 0) + 1);
	}
	if ([...headerCounts.values()].some((count) => count > 1))
		warnings.push({
			code: "DUPLICATE_HEADERS",
			message: "Duplicate enabled headers are preserved in the snippet; Tracer's executor rejects duplicates on send.",
		});

	const queryPairs = [];
	for (const row of request.query ?? []) {
		if (row?.enabled === false) continue;
		const name = String(row?.key ?? "").trim();
		if (!name) continue;
		queryPairs.push([name, String(row?.value ?? "")]);
	}

	const auth = resolveAuth(request.auth, collectionAuth, fail);

	const normalizedBody = BODY_MODES.has(body?.mode) ? normalizeBody(body) : { kind: "none" };
	if (normalizedBody.kind !== "none" && !headers.some((header) => header.name.toLowerCase() === "content-type")) {
		const contentType =
			body.mode === "json"
				? "application/json"
				: body.mode === "text"
					? String(body.contentType ?? "").trim() || "text/plain"
					: URLENCODED_TYPE;
		headers.push({ name: "Content-Type", value: contentType });
	}

	const basicAuth = expandAuth(auth, headers, queryPairs, existingQueryNames(url), fail);

	return {
		ok: errors.length === 0,
		model: {
			method,
			url: appendQuery(url, queryPairs),
			headers,
			body: normalizedBody,
			basicAuth,
		},
		errors,
		warnings,
	};
}
