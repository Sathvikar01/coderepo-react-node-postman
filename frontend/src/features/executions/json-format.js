// JSON formatting and parsing for the response inspector.
//
// The pretty view must never change the meaning of the captured source, so this
// module re-emits the original tokens instead of JSON.parse/JSON.stringify
// round-tripping: big integers keep their exact digits, duplicate keys survive,
// and out-of-range values such as 1e400 are not turned into null. All scanning
// is iterative so deeply nested documents cannot overflow the call stack.

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const PUNCTUATION = new Set(["{", "}", "[", "]", ",", ":"]);

function readString(source, index) {
	let cursor = index + 1;
	while (cursor < source.length) {
		if (source[cursor] === "\\") {
			cursor += 2;
			continue;
		}
		if (source[cursor] === '"') return cursor + 1;
		cursor += 1;
	}
	return cursor;
}

function readNumber(source, index) {
	const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
	return index + (match ? match[0].length : 0);
}

function tokenize(source) {
	const tokens = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (WHITESPACE.has(character)) {
			index += 1;
			continue;
		}
		if (character === '"') {
			const end = readString(source, index);
			tokens.push({ type: "string", value: source.slice(index, end) });
			index = end;
			continue;
		}
		if (PUNCTUATION.has(character)) {
			tokens.push({ type: character, value: character });
			index += 1;
			continue;
		}
		if (character === "-" || (character >= "0" && character <= "9")) {
			const end = readNumber(source, index);
			tokens.push({ type: "number", value: source.slice(index, end) });
			index = end;
			continue;
		}
		const literal = ["true", "false", "null"].find((value) => source.startsWith(value, index));
		if (literal) {
			tokens.push({ type: "literal", value: literal });
			index += literal.length;
			continue;
		}
		index += 1;
	}
	return tokens;
}

function validate(source) {
	try {
		JSON.parse(source);
		return null;
	} catch (error) {
		return `This response is not valid JSON (${error.message}).`;
	}
}

export function formatJsonText(source, { maxDepth = 256 } = {}) {
	const invalid = validate(source);
	if (invalid) return { ok: false, reason: invalid };
	const tokens = tokenize(source);
	const lines = [];
	let indent = 0;
	let line = "";
	const flush = () => {
		lines.push(line);
		line = "";
	};
	for (let position = 0; position < tokens.length; position += 1) {
		const token = tokens[position];
		const previous = tokens[position - 1];
		const next = tokens[position + 1];
		if (token.type === "{" || token.type === "[") {
			if (indent >= maxDepth)
				return { ok: false, reason: `This document nests deeper than ${maxDepth} levels; Raw source is shown instead.` };
			line += token.type;
			if (next && (next.type === "}" || next.type === "]")) continue;
			indent += 1;
			flush();
			line = "  ".repeat(indent);
			continue;
		}
		if (token.type === "}" || token.type === "]") {
			if (previous && (previous.type === "{" || previous.type === "[")) {
				line += token.type;
				continue;
			}
			indent = Math.max(0, indent - 1);
			flush();
			line = `${"  ".repeat(indent)}${token.type}`;
			continue;
		}
		if (token.type === ",") {
			line += ",";
			flush();
			line = "  ".repeat(indent);
			continue;
		}
		if (token.type === ":") {
			line += ": ";
			continue;
		}
		line += token.value;
	}
	if (line) flush();
	return { ok: true, text: lines.join("\n") };
}

function parseValue(tokens, state, depth, maxDepth) {
	if (depth > maxDepth) {
		state.error = `This document nests deeper than ${maxDepth} levels; the interactive tree stops here.`;
		return null;
	}
	const token = tokens[state.index];
	if (!token) {
		state.error = "This response is not valid JSON.";
		return null;
	}
	state.index += 1;
	if (token.type === "{") {
		const value = {};
		if (tokens[state.index]?.type === "}") {
			state.index += 1;
			return value;
		}
		for (;;) {
			const key = tokens[state.index];
			if (!key || key.type !== "string") {
				state.error = "This response is not valid JSON.";
				return null;
			}
			state.index += 1;
			if (tokens[state.index]?.type !== ":") {
				state.error = "This response is not valid JSON.";
				return null;
			}
			state.index += 1;
			value[JSON.parse(key.value)] = parseValue(tokens, state, depth + 1, maxDepth);
			if (state.error) return null;
			const separator = tokens[state.index];
			if (separator?.type === ",") {
				state.index += 1;
				continue;
			}
			if (separator?.type === "}") {
				state.index += 1;
				return value;
			}
			state.error = "This response is not valid JSON.";
			return null;
		}
	}
	if (token.type === "[") {
		const value = [];
		if (tokens[state.index]?.type === "]") {
			state.index += 1;
			return value;
		}
		for (;;) {
			value.push(parseValue(tokens, state, depth + 1, maxDepth));
			if (state.error) return null;
			const separator = tokens[state.index];
			if (separator?.type === ",") {
				state.index += 1;
				continue;
			}
			if (separator?.type === "]") {
				state.index += 1;
				return value;
			}
			state.error = "This response is not valid JSON.";
			return null;
		}
	}
	if (token.type === "string") return JSON.parse(token.value);
	if (token.type === "number") return { __number: token.value };
	if (token.value === "true") return true;
	if (token.value === "false") return false;
	if (token.value === "null") return null;
	state.error = "This response is not valid JSON.";
	return null;
}

export function parseJsonDocument(source, { maxDepth = 256 } = {}) {
	const invalid = validate(source);
	if (invalid) return { ok: false, reason: invalid };
	const state = { index: 0, error: null };
	const value = parseValue(tokenize(source), state, 0, maxDepth);
	if (state.error) return { ok: false, reason: state.error };
	return { ok: true, value: value ?? null };
}
