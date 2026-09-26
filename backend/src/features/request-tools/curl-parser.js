// cURL import adapter. Turns a pasted cURL command into the normalized import
// result consumed by import-draft.js:
//
//   { ok, request, authOverride, warnings, errors }
//
// `request` is a Tracer request draft without identifiers; import-draft.js
// assigns them. `authOverride` carries credentials supplied with -u/--user so
// the workspace can keep them send-only instead of persisting them.
//
// The parser never executes shell input. It fails closed on file access, shell
// substitution, and options whose HTTP effect it cannot represent.

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const DEFAULT_TIMEOUT_MS = 15000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30000;
const CURL_DEFAULT_CONTENT_TYPE = "application/x-www-form-urlencoded";
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]*\+)?json(?:$|;)/i;
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const MAX_CURL_INPUT_BYTES = 64 * 1024;

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

// Options that carry a value and change the request we import.
const VALUE_OPTIONS = new Map([
	["-X", "method"],
	["--request", "method"],
	["-H", "header"],
	["--header", "header"],
	["-d", "data"],
	["--data", "data"],
	["--data-ascii", "data"],
	["--data-binary", "dataBinary"],
	["--data-raw", "dataRaw"],
	["--json", "json"],
	["-u", "user"],
	["--user", "user"],
	["--oauth2-bearer", "oauthBearer"],
	["-A", "userAgent"],
	["--user-agent", "userAgent"],
	["-e", "referer"],
	["--referer", "referer"],
	["-b", "cookie"],
	["--cookie", "cookie"],
	["--url", "url"],
	["-m", "maxTime"],
	["--max-time", "maxTime"],
]);

// Options that carry a value but only affect curl itself.
const IGNORED_VALUE_OPTIONS = new Set([
	"--connect-timeout",
	"--keepalive-time",
	"--limit-rate",
	"--max-filesize",
	"--max-redirs",
	"--parallel-max",
	"--retry",
	"--retry-delay",
	"--retry-max-time",
	"--tls-max",
	"--ciphers",
	"--tls13-ciphers",
]);

// Flags that switch request behavior and are representable.
const BEHAVIOR_FLAGS = new Map([
	["-G", "get"],
	["--get", "get"],
	["-I", "head"],
	["--head", "head"],
	["--basic", "basic"],
]);

// Options that change the request. Tracer cannot represent them, so importing
// would silently send something different from what was pasted.
const UNSUPPORTED_OPTIONS = new Map([
	["--data-urlencode", "body"],
	["-F", "body"],
	["--form", "body"],
	["--form-string", "body"],
	["-T", "body"],
	["--upload-file", "body"],
	["--url-query", "query"],
	["-K", "file"],
	["--config", "file"],
	["--netrc", "file"],
	["-n", "file"],
	["--netrc-file", "file"],
	["-o", "file"],
	["--output", "file"],
	["-O", "file"],
	["--remote-name", "file"],
	["-D", "file"],
	["--dump-header", "file"],
	["-c", "file"],
	["--cookie-jar", "file"],
	["--hsts", "file"],
	["--libcurl", "file"],
	["--trace", "file"],
	["--trace-ascii", "file"],
	["--stderr", "file"],
	["--output-dir", "file"],
	["--create-dirs", "file"],
	["--remote-header-name", "file"],
	["--remote-time", "file"],
	["--random-file", "file"],
	["--egd-file", "file"],
	["-w", "output"],
	["--write-out", "output"],
	["--cert", "tls"],
	["-E", "tls"],
	["--key", "tls"],
	["--cacert", "tls"],
	["--capath", "tls"],
	["--cert-type", "tls"],
	["--key-type", "tls"],
	["--crlfile", "tls"],
	["--pinnedpubkey", "tls"],
	["--tlsuser", "tls"],
	["--tlspassword", "tls"],
	["--proxy-cert", "tls"],
	["--proxy", "network"],
	["-x", "network"],
	["--proxy-user", "network"],
	["--proxy-pass", "network"],
	["--preproxy", "network"],
	["--socks4", "network"],
	["--socks4a", "network"],
	["--socks5", "network"],
	["--socks5-hostname", "network"],
	["--resolve", "network"],
	["--connect-to", "network"],
	["--interface", "network"],
	["--unix-socket", "network"],
	["--dns-servers", "network"],
	["--dns-interface", "network"],
	["--doh-url", "network"],
	["--local-port", "network"],
	["--engine", "network"],
	["--digest", "auth"],
	["--ntlm", "auth"],
	["--negotiate", "auth"],
	["--anyauth", "auth"],
	["--next", "request"],
	["-:", "request"],
]);

const UNSUPPORTED_REASONS = {
	body: "uses a body format Tracer cannot represent",
	query: "adds query data Tracer cannot represent",
	file: "reads or writes local files",
	tls: "configures TLS outside Tracer's policy",
	network: "changes network routing, proxies, or sockets",
	auth: "requests an authentication scheme Tracer does not implement",
	output: "changes curl's own output",
	request: "runs more than one request",
};

// Flags with a dedicated warning because the difference is worth stating.
const EXPLAINED_FLAGS = new Map([
	["-k", "TLS verification cannot be disabled; the server certificate is always verified."],
	["--insecure", "TLS verification cannot be disabled; the server certificate is always verified."],
	["-L", "Tracer does not follow redirects; the response shows the first hop."],
	["--location", "Tracer does not follow redirects; the response shows the first hop."],
	["--location-trusted", "Tracer does not follow redirects; the response shows the first hop."],
	["--compressed", "Response compression is negotiated by the transport, not per request."],
]);

// Flags that only affect curl's presentation or transfer details. Ignoring
// them cannot change the imported HTTP request. The boolean marks value-taking
// options.
const IGNORED_FLAGS = new Map([
	["-s", false],
	["--silent", false],
	["-S", false],
	["--show-error", false],
	["-v", false],
	["--verbose", false],
	["-i", false],
	["--include", false],
	["-f", false],
	["--fail", false],
	["--fail-with-body", false],
	["-#", false],
	["--progress-bar", false],
	["--no-progress-meter", false],
	["-N", false],
	["--no-buffer", false],
	["-g", false],
	["--globoff", false],
	["--path-as-is", false],
	["--retry-all-errors", false],
	["--retry-connrefused", false],
	["--tcp-nodelay", false],
	["--no-keepalive", false],
	["--http1.0", false],
	["--http1.1", false],
	["--http2", false],
	["--http2-prior-knowledge", false],
	["--http3", false],
	["-0", false],
	["-4", false],
	["--ipv4", false],
	["-6", false],
	["--ipv6", false],
	["--tlsv1", false],
	["--tlsv1.0", false],
	["--tlsv1.1", false],
	["--tlsv1.2", false],
	["--tlsv1.3", false],
	["--ssl", false],
	["--ssl-reqd", false],
	["-Z", false],
	["--parallel", false],
	["--no-alpn", false],
	["--no-npn", false],
]);

const QUIET_FLAGS = new Set(["-s", "--silent", "-S", "--show-error", "-v", "--verbose", "-#", "--progress-bar", "--no-progress-meter"]);

const SHELL_OPERATOR_MESSAGE = {
	"|": "a pipe",
	";": "a second command",
	"<": "input redirection",
	">": "output redirection",
	"(": "a subshell",
	")": "a subshell",
	"&": "command separators",
};

function contentLength(value) {
	return new TextEncoder().encode(String(value ?? "")).length;
}

function readAnsiEscape(input, index) {
	const next = input[index + 1];
	if (next === undefined) return { text: "\\", index: index + 1 };
	const simple = {
		n: "\n",
		r: "\r",
		t: "\t",
		a: "\u0007",
		b: "\b",
		f: "\f",
		v: "\v",
		e: "\u001b",
		"\\": "\\",
		"'": "'",
		'"': '"',
	};
	if (Object.prototype.hasOwnProperty.call(simple, next)) return { text: simple[next], index: index + 2 };
	if (next === "x" || next === "u") {
		const width = next === "x" ? 2 : 4;
		const match = new RegExp(`^[0-9a-f]{1,${width}}`, "i").exec(input.slice(index + 2, index + 2 + width));
		if (match) return { text: String.fromCharCode(parseInt(match[0], 16)), index: index + 2 + match[0].length };
		return { text: next, index: index + 2 };
	}
	return { text: `\\${next}`, index: index + 2 };
}

function tokenize(input) {
	const tokens = [];
	let current = "";
	let started = false;
	let quote = null;
	let index = 0;
	const flush = () => {
		if (started) tokens.push(current);
		current = "";
		started = false;
	};
	const append = (text) => {
		current += text;
		started = true;
	};
	while (index < input.length) {
		const character = input[index];
		const next = input[index + 1];
		if (quote === "single") {
			if (character === "'") {
				quote = null;
				index += 1;
				continue;
			}
			append(character);
			index += 1;
			continue;
		}
		if (quote === "double") {
			if (character === '"') {
				quote = null;
				index += 1;
				continue;
			}
			if (character === "\\") {
				if (next === undefined) {
					index += 1;
					continue;
				}
				if (next === "\n") {
					index += 2;
					continue;
				}
				if (next === "\r" && input[index + 2] === "\n") {
					index += 3;
					continue;
				}
				if ('"\\$`'.includes(next)) {
					append(next);
					index += 2;
					continue;
				}
				append("\\");
				index += 1;
				continue;
			}
			if (character === "$" || character === "`") {
				return {
					error: {
						code: "SHELL_SUBSTITUTION",
						message: "The command contains shell substitution, which cannot be imported. Paste the literal value instead.",
					},
				};
			}
			append(character);
			index += 1;
			continue;
		}
		if (quote === "ansi") {
			if (character === "'") {
				quote = null;
				index += 1;
				continue;
			}
			if (character === "\\") {
				const escape = readAnsiEscape(input, index);
				append(escape.text);
				index = escape.index;
				continue;
			}
			append(character);
			index += 1;
			continue;
		}
		if (character === " " || character === "\t" || character === "\r" || character === "\n") {
			flush();
			index += 1;
			continue;
		}
		if (character === "\\") {
			if (next === undefined || next === "\n") {
				index += next === "\n" ? 2 : 1;
				continue;
			}
			if (next === "\r" && input[index + 2] === "\n") {
				index += 3;
				continue;
			}
			append(next);
			index += 2;
			continue;
		}
		if (character === "'") {
			quote = "single";
			started = true;
			index += 1;
			continue;
		}
		if (character === '"') {
			quote = "double";
			started = true;
			index += 1;
			continue;
		}
		if (character === "$") {
			if (next === "'") {
				quote = "ansi";
				started = true;
				index += 2;
				continue;
			}
			if (next === '"') {
				quote = "double";
				started = true;
				index += 2;
				continue;
			}
			if (next !== undefined && (/[A-Za-z0-9_]/.test(next) || next === "{" || next === "(")) {
				return {
					error: {
						code: "SHELL_SUBSTITUTION",
						message: "The command expands a shell variable, which cannot be imported. Paste the literal value instead.",
					},
				};
			}
			append(character);
			index += 1;
			continue;
		}
		if (character === "`") {
			if (next === undefined || next === "\n" || (next === "\r" && input[index + 2] === "\n")) {
				index += 1;
				continue;
			}
			return {
				error: {
					code: "SHELL_SUBSTITUTION",
					message: "The command contains a backtick command substitution, which cannot be imported.",
				},
			};
		}
		if (character === "^" && (next === undefined || next === "\n" || (next === "\r" && input[index + 2] === "\n"))) {
			index += 1;
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(SHELL_OPERATOR_MESSAGE, character)) {
			if (character === "&" && started && next !== undefined && !/[\s]/.test(next)) {
				append(character);
				index += 1;
				continue;
			}
			return {
				error: {
					code: "SHELL_OPERATOR",
					message: `The command contains ${SHELL_OPERATOR_MESSAGE[character]}. Paste a single cURL command without shell operators.`,
				},
			};
		}
		append(character);
		index += 1;
	}
	if (quote) {
		const label = quote === "single" ? "single-quoted" : quote === "double" ? "double-quoted" : "ANSI-C quoted";
		return {
			error: {
				code: "MALFORMED_QUOTING",
				message: `The command ends inside an unterminated ${label} string. Fix the quoting and try again.`,
			},
		};
	}
	flush();
	return { tokens };
}

function fail(error) {
	return { ok: false, request: null, authOverride: null, warnings: [], errors: [error] };
}

function splitHeader(raw) {
	const separator = raw.indexOf(":");
	if (separator === -1) {
		if (raw.endsWith(";")) return { key: raw.slice(0, -1).trim(), value: "" };
		return null;
	}
	return { key: raw.slice(0, separator).trim(), value: raw.slice(separator + 1).trim() };
}

function isValidJson(text) {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

function appendToUrl(url, data) {
	if (!data) return url;
	const hashIndex = url.indexOf("#");
	const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : url.slice(hashIndex);
	const separator = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
	return `${base}${separator}${data}${fragment}`;
}

function deriveName(url, method) {
	try {
		const parsed = new URL(url);
		const segments = parsed.pathname.split("/").filter(Boolean);
		const last = segments[segments.length - 1] ?? parsed.hostname;
		return decodeURIComponent(last).slice(0, 80) || `${method} request`;
	} catch {
		return "Imported request";
	}
}

export function parseCurl(text) {
	const warnings = [];
	const warn = (code, message, option = null) => {
		if (warnings.some((item) => item.code === code && item.option === option && item.message === message)) return;
		warnings.push({ code, message, option });
	};

	const source = String(text ?? "").trim();
	if (!source) return fail({ code: "NO_INPUT", message: "Paste a cURL command to import." });
	if (contentLength(source) > MAX_CURL_INPUT_BYTES)
		return fail({ code: "INPUT_TOO_LARGE", message: "The command is larger than 64 KiB. Paste a smaller command." });

	const lexed = tokenize(source);
	if (lexed.error) return fail(lexed.error);
	const words = lexed.tokens;
	if (words.length === 0) return fail({ code: "NO_INPUT", message: "Paste a cURL command to import." });

	let start = 0;
	while (start < words.length && (words[start] === "$" || words[start] === "sudo")) start += 1;
	const command = words[start] ?? "";
	const basename = command.replace(/\\/g, "/").split("/").pop().toLowerCase();
	if (!/^curl(\.exe)?$/.test(basename))
		return fail({
			code: "NOT_CURL",
			message: command ? `This import understands cURL commands; "${command}" is not one.` : "Paste a cURL command to import.",
		});

	const state = {
		method: null,
		headOnly: false,
		requestGet: false,
		urls: [],
		headers: [],
		data: "",
		jsonFlag: false,
		user: null,
		oauthBearer: null,
		maxTimeMs: null,
		ignored: new Set(),
	};

	for (let index = start + 1; index < words.length; index += 1) {
		const token = words[index];
		if (token === "--") {
			for (const positional of words.slice(index + 1)) state.urls.push(positional);
			break;
		}
		const options = [];
		if (token.startsWith("--")) {
			const separator = token.indexOf("=");
			options.push({
				name: separator === -1 ? token : token.slice(0, separator),
				inline: separator === -1 ? null : token.slice(separator + 1),
			});
		} else if (token.startsWith("-") && token.length > 1) {
			const letters = token.slice(1);
			for (let position = 0; position < letters.length; position += 1) {
				const name = `-${letters[position]}`;
				const attached = letters.slice(position + 1);
				options.push({ name, inline: attached === "" ? null : attached });
				if (VALUE_OPTIONS.has(name) || IGNORED_VALUE_OPTIONS.has(name) || UNSUPPORTED_OPTIONS.has(name)) break;
			}
		} else {
			state.urls.push(token);
			continue;
		}

		let missingValue = null;
		for (const option of options) {
			const resolvedValue = () => {
				if (option.inline !== null) return option.inline;
				index += 1;
				return words[index];
			};

			if (UNSUPPORTED_OPTIONS.has(option.name)) {
				const category = UNSUPPORTED_OPTIONS.get(option.name);
				return fail({
					code: "UNSUPPORTED_OPTION",
					option: option.name,
					message: `${option.name} ${UNSUPPORTED_REASONS[category]}. Remove the option or build the request manually.`,
				});
			}
			if (IGNORED_VALUE_OPTIONS.has(option.name) || IGNORED_FLAGS.has(option.name)) {
				const takesValue = IGNORED_VALUE_OPTIONS.has(option.name);
				if (takesValue && option.inline === null) index += 1;
				if (!QUIET_FLAGS.has(option.name)) state.ignored.add(option.name);
				continue;
			}
			if (BEHAVIOR_FLAGS.has(option.name)) {
				if (option.inline !== null)
					return fail({
						code: "INVALID_OPTION",
						option: option.name,
						message: `${option.name} does not take a value. Remove "${option.inline}".`,
					});
				const behavior = BEHAVIOR_FLAGS.get(option.name);
				if (behavior === "get") state.requestGet = true;
				if (behavior === "head") state.headOnly = true;
				continue;
			}
			if (EXPLAINED_FLAGS.has(option.name)) {
				warn("IGNORED_FLAG", EXPLAINED_FLAGS.get(option.name), option.name);
				continue;
			}
			if (!VALUE_OPTIONS.has(option.name)) {
				if (option.inline !== null)
					return fail({
						code: "INVALID_OPTION",
						option: option.name,
						message: `${option.name} does not take a value. Remove "${option.inline}".`,
					});
				return fail({
					code: "UNKNOWN_OPTION",
					option: option.name,
					message: `The option ${option.name} is not supported by cURL import. Remove it or build the request manually.`,
				});
			}

			const kind = VALUE_OPTIONS.get(option.name);
			const resolved = resolvedValue();
			if (resolved === undefined) {
				missingValue = option.name;
				break;
			}
			if (kind === "method") state.method = resolved.toUpperCase();
			else if (kind === "header") state.headers.push(resolved);
			else if (kind === "data" || kind === "dataBinary" || kind === "dataRaw" || kind === "json") {
				if (kind !== "dataRaw" && resolved.startsWith("@"))
					return fail({
						code: "FILE_READ",
						option: option.name,
						message: `${option.name} reads the file "${resolved}". File uploads are not supported; inline the content instead.`,
					});
				if (kind === "json") {
					state.jsonFlag = true;
					state.data += resolved;
				} else state.data += `${state.data ? "&" : ""}${resolved}`;
			} else if (kind === "user") state.user = resolved;
			else if (kind === "oauthBearer") state.oauthBearer = resolved;
			else if (kind === "userAgent") state.headers.push(`User-Agent: ${resolved}`);
			else if (kind === "referer") {
				if (resolved.startsWith(";")) warn("IGNORED_FLAG", "The automatic Referer option was ignored.", "-e");
				else state.headers.push(`Referer: ${resolved}`);
			} else if (kind === "cookie") {
				if (resolved.includes("=")) state.headers.push(`Cookie: ${resolved}`);
				else
					return fail({
						code: "FILE_READ",
						option: option.name,
						message: `${option.name} reads the cookie file "${resolved}". Cookie files are not supported; pass "name=value" instead.`,
					});
			} else if (kind === "url") state.urls.push(resolved);
			else if (kind === "maxTime") {
				const seconds = Number.parseFloat(resolved);
				if (!Number.isFinite(seconds) || seconds <= 0) {
					warn("INVALID_TIMEOUT", `--max-time "${resolved}" is not a positive number of seconds and was ignored.`, option.name);
				} else {
					const milliseconds = Math.round(seconds * 1000);
					const clamped = Math.min(Math.max(milliseconds, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
					if (clamped !== milliseconds)
						warn(
							"TIMEOUT_CLAMPED",
							`--max-time ${seconds}s is outside Tracer's 0.1s-30s window; the request timeout is ${clamped} ms.`,
							option.name,
						);
					state.maxTimeMs = clamped;
				}
			}
		}
		if (missingValue)
			return fail({
				code: "MISSING_VALUE",
				option: missingValue,
				message: `${missingValue} needs a value. The command ends before one is given.`,
			});
	}

	if (state.urls.length > 1)
		return fail({
			code: "MULTIPLE_URLS",
			message: "Tracer imports one request at a time. This command contains more than one URL.",
		});
	const url = state.urls[0];
	if (!url) return fail({ code: "NO_URL", message: "The command has no URL. Add one and try again." });

	if (state.headOnly && state.method && state.method !== "HEAD")
		return fail({
			code: "AMBIGUOUS_METHOD",
			message: `The command mixes --head with -X ${state.method}. Tracer cannot fetch headers with a different method; pick one.`,
		});

	const method = state.method ?? (state.headOnly ? "HEAD" : state.data && !state.requestGet ? "POST" : "GET");
	if (!METHODS.includes(method))
		return fail({
			code: "METHOD_INVALID",
			message: `Tracer supports ${METHODS.join(", ")}; this command asks for ${method}.`,
		});

	const headers = [];
	for (const raw of state.headers) {
		const header = splitHeader(raw);
		if (!header || !header.key)
			return fail({
				code: "MALFORMED_HEADER",
				message: `The header "${raw}" has no usable name. Use the form "Name: value" or "Name;" for an empty value.`,
			});
		headers.push(header);
	}

	const duplicateNames = new Set();
	const seenHeaderNames = new Set();
	for (const header of headers) {
		const lowered = header.key.toLowerCase();
		if (seenHeaderNames.has(lowered)) duplicateNames.add(header.key);
		seenHeaderNames.add(lowered);
	}
	if (duplicateNames.size > 0)
		warn(
			"DUPLICATE_HEADERS",
			`Duplicate header rows (${[...duplicateNames].join(", ")}) are kept as pasted. Tracer rejects duplicates on send.`,
		);
	for (const header of headers) {
		if (RESERVED_HEADERS.has(header.key.toLowerCase()))
			warn(
				"RESERVED_HEADER",
				`The header "${header.key}" is managed by the transport and cannot be set per request. Tracer rejects the send until it is removed.`,
			);
		else if (!HEADER_TOKEN.test(header.key))
			warn("INVALID_HEADER_NAME", `"${header.key}" is not a valid HTTP header name; Tracer rejects the send.`);
		if (/[\r\n]/.test(header.value))
			warn("INVALID_HEADER_VALUE", `The header "${header.key}" contains a line break; Tracer rejects the send.`);
	}

	const findHeader = (name) => headers.find((header) => header.key.toLowerCase() === name);
	const explicitContentType = findHeader("content-type");
	const explicitAuthorization = findHeader("authorization");
	if (state.user && explicitAuthorization) {
		warn("AUTH_CONFLICT", "The explicit Authorization header replaces the credentials from --user; Tracer sends the header as written.");
		state.user = null;
	}
	if (state.user && state.oauthBearer)
		return fail({ code: "AMBIGUOUS_AUTH", message: "The command mixes --user with --oauth2-bearer. Provide only one credential source." });
	if (state.oauthBearer) {
		if (explicitAuthorization || seenHeaderNames.has("authorization"))
			warn("AUTH_CONFLICT", "The explicit Authorization header was kept instead of --oauth2-bearer.");
		else headers.push({ key: "Authorization", value: `Bearer ${state.oauthBearer}` });
		state.oauthBearer = null;
	}

	let urlTemplate = url;
	let data = state.data;
	if (state.requestGet && data) {
		urlTemplate = appendToUrl(urlTemplate, data);
		data = "";
	}
	if (state.jsonFlag) {
		if (!explicitContentType) headers.push({ key: "Content-Type", value: "application/json" });
		if (!findHeader("accept")) headers.push({ key: "Accept", value: "application/json" });
	}

	if (data && (method === "GET" || method === "HEAD"))
		return fail({
			code: "METHOD_BODY_CONFLICT",
			message: `${method} requests cannot carry a body in Tracer. cURL would send one; use a different method or drop the data options.`,
		});

	const wantsJson = state.jsonFlag || JSON_CONTENT_TYPE.test(explicitContentType?.value ?? "");
	let body = { mode: "none" };
	if (data && wantsJson && isValidJson(data)) body = { mode: "json", text: data };
	else if (data) {
		body = {
			mode: "text",
			text: data,
			contentType: explicitContentType?.value ?? (state.jsonFlag ? "application/json" : CURL_DEFAULT_CONTENT_TYPE),
		};
		if (wantsJson) warn("BODY_NOT_JSON", "The body is not valid JSON, so it is imported as text with the same content type.");
	}

	for (const flag of state.ignored) warn("IGNORED_FLAG", `${flag} only affects curl itself and was ignored.`, flag);

	let authOverride = null;
	if (state.user) {
		const separator = state.user.indexOf(":");
		authOverride =
			separator === -1
				? { mode: "basic", usernameTemplate: state.user, passwordTemplate: "" }
				: {
						mode: "basic",
						usernameTemplate: state.user.slice(0, separator),
						passwordTemplate: state.user.slice(separator + 1),
					};
		if (separator === -1)
			warn("AUTH_PASSWORD_EMPTY", "curl would prompt for a password; the imported basic credentials have an empty password.");
	}

	return {
		ok: true,
		request: {
			schemaVersion: 1,
			folderId: null,
			name: deriveName(urlTemplate, method),
			method,
			urlTemplate,
			query: [],
			headers,
			body,
			auth: { mode: "none" },
			settings: { timeoutMs: state.maxTimeMs ?? DEFAULT_TIMEOUT_MS },
		},
		authOverride,
		warnings,
		errors: [],
	};
}
