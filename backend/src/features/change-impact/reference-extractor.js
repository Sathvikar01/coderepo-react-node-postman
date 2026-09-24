// Deterministic reference extraction for the change-impact engine.
//
// This module answers one narrow question: "which named variables does this
// stored request/script reference?" It never resolves values and never guesses.
// A reference that cannot be proven from a literal is reported as dynamic so the
// graph can mark it unknown instead of inventing an edge.

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const PLACEHOLDER_OPEN = /\{\{/g;
const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Reads: pm.variables.get("X"), pm.environment.get("X"), pm.collection.get("X")
// and the bare sandbox aliases variables/environment/collection.
const GET_CALL = /(?:pm\s*\.\s*)?(variables|environment|collection)\s*\.\s*get\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)?/g;
// Writes: pm.variables.set("X", ...) / pm.variables.unset("X")
const WRITE_CALL = /(?:pm\s*\.\s*)?variables\s*\.\s*(set|unset)\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)?/g;
// Whole-scope reads make every key a candidate, so they are inherently dynamic.
const TO_OBJECT_CALL = /(?:pm\s*\.\s*)?(variables|environment|collection)\s*\.\s*toObject\s*\(/g;

function literalArgument(doubleQuoted, singleQuoted, backtick) {
	if (doubleQuoted !== undefined) return { literal: true, value: doubleQuoted };
	if (singleQuoted !== undefined) return { literal: true, value: singleQuoted };
	if (backtick !== undefined) {
		// A template literal with interpolation is a computed name.
		if (backtick.includes("${")) return { literal: false, value: null };
		return { literal: true, value: backtick };
	}
	return { literal: false, value: null };
}

// `{{ name }}` placeholders are the only interpolation syntax the request
// compiler understands. Anything that opens `{{` without closing a valid
// identifier is malformed and reported so it is never treated as a resolved ref.
export function extractPlaceholders(text) {
	const value = typeof text === "string" ? text : "";
	const keys = [];
	const seen = new Set();
	PLACEHOLDER.lastIndex = 0;
	let match = PLACEHOLDER.exec(value);
	while (match !== null) {
		const key = match[1];
		if (!seen.has(key)) {
			seen.add(key);
			keys.push(key);
		}
		match = PLACEHOLDER.exec(value);
	}
	PLACEHOLDER_OPEN.lastIndex = 0;
	const opens = (value.match(PLACEHOLDER_OPEN) ?? []).length;
	return { keys, malformed: opens > keys.length };
}

function reset(...patterns) {
	for (const pattern of patterns) pattern.lastIndex = 0;
}

// Scan one script phase for literal reads and writes. Non-literal arguments are
// surfaced as dynamic counts, never as named edges.
export function scanScript(source) {
	const text = typeof source === "string" ? source : "";
	const reads = [];
	const writes = [];
	const dynamicReads = [];
	const dynamicWrites = [];
	const seenReads = new Set();
	const seenWrites = new Set();

	reset(GET_CALL, WRITE_CALL, TO_OBJECT_CALL);

	let match = GET_CALL.exec(text);
	while (match !== null) {
		const scope = match[1] === "variables" ? "merged" : match[1];
		const argument = literalArgument(match[2], match[3], match[4]);
		if (argument.literal && VARIABLE_KEY.test(argument.value)) {
			const signature = `${scope}:${argument.value}`;
			if (!seenReads.has(signature)) {
				seenReads.add(signature);
				reads.push({ key: argument.value, scope, source: "script" });
			}
		} else {
			dynamicReads.push({ scope });
		}
		match = GET_CALL.exec(text);
	}

	match = WRITE_CALL.exec(text);
	while (match !== null) {
		const op = match[1];
		const argument = literalArgument(match[2], match[3], match[4]);
		if (argument.literal && VARIABLE_KEY.test(argument.value)) {
			const signature = `${op}:${argument.value}`;
			if (!seenWrites.has(signature)) {
				seenWrites.add(signature);
				writes.push({ key: argument.value, op });
			}
		} else {
			dynamicWrites.push({ op });
		}
		match = WRITE_CALL.exec(text);
	}

	match = TO_OBJECT_CALL.exec(text);
	while (match !== null) {
		dynamicReads.push({ scope: match[1] === "variables" ? "merged" : match[1], wholeScope: true });
		match = TO_OBJECT_CALL.exec(text);
	}

	return { reads, writes, dynamicReads, dynamicWrites };
}

// The exact set of fields the request compiler interpolates, mirrored here so a
// reference the compiler would resolve is never missed.
export function collectRequestReferences(request) {
	const references = [];
	const malformed = [];
	const push = (field, key, rowId = null) => references.push({ field, key, rowId });

	const url = extractPlaceholders(request?.urlTemplate);
	if (url.malformed) malformed.push({ field: "url" });
	for (const key of url.keys) push("url", key);

	for (const row of request?.query ?? []) {
		const found = extractPlaceholders(row?.value);
		if (found.malformed) malformed.push({ field: "query", rowId: row?.id ?? null });
		for (const key of found.keys) push("query", key, row?.id ?? null);
	}

	for (const row of request?.headers ?? []) {
		const found = extractPlaceholders(row?.value);
		if (found.malformed) malformed.push({ field: "headers", rowId: row?.id ?? null });
		for (const key of found.keys) push("headers", key, row?.id ?? null);
	}

	const body = request?.body ?? { mode: "none" };
	if (body.mode === "json" || body.mode === "text") {
		const found = extractPlaceholders(body.text);
		if (found.malformed) malformed.push({ field: "body" });
		for (const key of found.keys) push("body", key);
	}
	if (body.mode === "urlencoded") {
		for (const row of body.rows ?? []) {
			const found = extractPlaceholders(row?.value);
			if (found.malformed) malformed.push({ field: "body.rows", rowId: row?.id ?? null });
			for (const key of found.keys) push("body.rows", key, row?.id ?? null);
		}
	}

	const auth = request?.auth ?? { mode: "none" };
	if (auth.mode === "bearer") {
		const found = extractPlaceholders(auth.tokenTemplate);
		if (found.malformed) malformed.push({ field: "auth.tokenTemplate" });
		for (const key of found.keys) push("auth.tokenTemplate", key);
	}
	if (auth.mode === "basic") {
		for (const field of ["usernameTemplate", "passwordTemplate"]) {
			const found = extractPlaceholders(auth[field]);
			if (found.malformed) malformed.push({ field: `auth.${field}` });
			for (const key of found.keys) push(`auth.${field}`, key);
		}
	}
	if (auth.mode === "apiKey") {
		const found = extractPlaceholders(auth.valueTemplate);
		if (found.malformed) malformed.push({ field: "auth.valueTemplate" });
		for (const key of found.keys) push("auth.valueTemplate", key);
	}

	return { references, malformed };
}

export { VARIABLE_KEY };
