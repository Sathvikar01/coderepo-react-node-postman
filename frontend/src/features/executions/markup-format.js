const MAX_DEPTH = 64;
const MAX_BYTES = 256 * 1024;
const VOID_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

function indent(depth, value) {
	return "  ".repeat(Math.max(0, depth)) + value;
}

export function formatXml(source) {
	if (source.length > MAX_BYTES) return { ok: false, reason: "The document is larger than 256 KiB." };
	if (/<!doctype|<!entity/i.test(source))
		return { ok: false, reason: "Documents with a DTD or entity declaration are shown as source only." };

	const tokens = source.match(/<[^>]*>|[^<]+/g);
	if (!tokens) return { ok: false, reason: "No XML structure was found." };

	const lines = [];
	const stack = [];
	let depth = 0;

	for (const token of tokens) {
		if (token.startsWith("</")) {
			const closingName = (token.match(/^<\/\s*([^\s>]+)/) ?? [])[1];
			const expected = stack.pop();
			if (!closingName || !expected || closingName !== expected)
				return { ok: false, reason: "The XML tags are not balanced." };
			depth = Math.max(0, depth - 1);
			lines.push(indent(depth, token));
			continue;
		}

		if (token.startsWith("<?") || token.startsWith("<!")) {
			lines.push(indent(depth, token));
			continue;
		}

		if (token.startsWith("<")) {
			const name = (token.match(/^<\s*([^\s/>]+)/) ?? [])[1];
			if (!name) return { ok: false, reason: "The XML structure could not be parsed safely." };
			const selfClosing = /\/>$/.test(token);
			lines.push(indent(depth, token));
			if (!selfClosing) {
				stack.push(name);
				depth += 1;
				if (depth > MAX_DEPTH) return { ok: false, reason: "The document nests deeper than 64 levels." };
			}
			continue;
		}

		const text = token.trim();
		if (text) lines.push(indent(depth, text));
	}

	if (stack.length > 0) return { ok: false, reason: "The XML tags are not balanced." };
	return { ok: true, text: lines.join("\n") };
}

export function formatHtml(source) {
	if (source.length > MAX_BYTES) return { ok: false, reason: "The document is larger than 256 KiB." };
	if (/<\s*(script|style|textarea|title|pre)\b/i.test(source))
		return { ok: false, reason: "HTML with raw-text elements is shown as Raw source to preserve exact content." };

	const tokens = [];
	let index = 0;
	let depth = 0;

	while (index < source.length) {
		const next = source.indexOf("<", index);
		if (next === -1) {
			tokens.push({ type: "text", value: source.slice(index), depth });
			break;
		}
		if (next > index) tokens.push({ type: "text", value: source.slice(index, next), depth });

		if (source.startsWith("<!--", next)) {
			const end = source.indexOf("-->", next + 4);
			if (end === -1) return { ok: false, reason: "The HTML comment is not closed." };
			tokens.push({ type: "tag", value: source.slice(next, end + 3), depth });
			index = end + 3;
			continue;
		}

		let cursor = next + 1;
		let quote = null;
		while (cursor < source.length) {
			const character = source[cursor];
			if (quote) {
				if (character === quote) quote = null;
			} else if (character === '"' || character === "'") {
				quote = character;
			} else if (character === ">") {
				break;
			}
			cursor += 1;
		}
		if (cursor >= source.length) return { ok: false, reason: "The HTML tag is not closed." };

		const tag = source.slice(next, cursor + 1);
		const closing = /^<\//.test(tag);
		const name = (tag.match(/^<\/?\s*([A-Za-z0-9:-]+)/) ?? [])[1]?.toLowerCase() ?? "";
		const selfClosing = /\/>$/.test(tag) || VOID_ELEMENTS.has(name);

		if (closing) depth = Math.max(0, depth - 1);
		tokens.push({ type: "tag", value: tag, depth });
		if (!closing && !selfClosing && !/^<!/.test(tag)) {
			depth += 1;
			if (depth > MAX_DEPTH) return { ok: false, reason: "The document nests deeper than 64 levels." };
		}
		index = cursor + 1;
	}

	const lines = [];
	for (const token of tokens) {
		if (token.type === "text") {
			const text = token.value.trim();
			if (text) lines.push(indent(token.depth, text));
		} else {
			lines.push(indent(token.depth, token.value));
		}
	}
	return { ok: true, text: lines.join("\n") };
}
