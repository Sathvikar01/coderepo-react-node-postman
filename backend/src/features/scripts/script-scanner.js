const FORBIDDEN_IDENTIFIERS = new Set([
	"require",
	"exports",
	"module",
	"process",
	"global",
	"globalThis",
	"import",
	"export",
	"eval",
	"Function",
	"WebAssembly",
	"setTimeout",
	"setInterval",
	"setImmediate",
	"clearTimeout",
	"clearInterval",
	"clearImmediate",
	"queueMicrotask",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"fetch",
	"XMLHttpRequest",
	"WebSocket",
	"EventSource",
	"Worker",
	"SharedWorker",
	"MessageChannel",
	"BroadcastChannel",
	"Promise",
	"async",
	"await",
	"constructor",
	"prototype",
	"__proto__",
	"Buffer",
	"Bun",
	"Deno",
	"window",
	"document",
	"self",
	"navigator",
	"importScripts",
	"SharedArrayBuffer",
	"Atomics",
]);

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

function lineOf(source, index) {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor += 1) {
		if (source[cursor] === "\n") line += 1;
	}
	return line;
}

function skipQuoted(source, start, quote) {
	let cursor = start + 1;
	while (cursor < source.length) {
		const character = source[cursor];
		if (character === "\\") {
			cursor += 2;
			continue;
		}
		if (character === quote) return cursor + 1;
		cursor += 1;
	}
	return source.length;
}

export function scanForbiddenTokens(source) {
	const text = String(source ?? "");
	let cursor = 0;
	while (cursor < text.length) {
		const character = text[cursor];
		if (character === '"' || character === "'") {
			cursor = skipQuoted(text, cursor, character);
			continue;
		}
		if (character === "/" && text[cursor + 1] === "/") {
			const newline = text.indexOf("\n", cursor);
			cursor = newline === -1 ? text.length : newline + 1;
			continue;
		}
		if (character === "/" && text[cursor + 1] === "*") {
			const closing = text.indexOf("*/", cursor + 2);
			cursor = closing === -1 ? text.length : closing + 2;
			continue;
		}
		if (IDENTIFIER_START.test(character)) {
			let end = cursor + 1;
			while (end < text.length && IDENTIFIER_PART.test(text[end])) end += 1;
			const word = text.slice(cursor, end);
			if (FORBIDDEN_IDENTIFIERS.has(word)) return { token: word, index: cursor, line: lineOf(text, cursor) };
			cursor = end;
			continue;
		}
		cursor += 1;
	}
	return null;
}

export { FORBIDDEN_IDENTIFIERS };
