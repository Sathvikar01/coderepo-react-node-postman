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
const RAW_TEXT_ELEMENTS = /<\s*(script|style|textarea|title|pre|xmp|plaintext|listing|noembed)\b/i;

function indent(depth, value) {
	return "  ".repeat(Math.max(0, depth)) + value;
}

// XML is scanned with quote, comment, and CDATA awareness so a formatted view can
// never corrupt attribute values or character data. Anything that cannot be
// reformatted without changing the document (mixed content, entities, unbalanced
// tags) is rejected and the caller keeps the Raw source.
function scanXml(source) {
	const tokens = [];
	let index = 0;
	let text = "";
	const flushText = () => {
		if (text) {
			tokens.push({ type: "text", value: text });
			text = "";
		}
	};
	while (index < source.length) {
		const next = source.indexOf("<", index);
		if (next === -1) {
			text += source.slice(index);
			break;
		}
		if (next > index) text += source.slice(index, next);
		if (source.startsWith("<!--", next)) {
			const end = source.indexOf("-->", next + 4);
			if (end === -1) return { ok: false, reason: "The XML comment is not closed." };
			flushText();
			tokens.push({ type: "markup", value: source.slice(next, end + 3) });
			index = end + 3;
			continue;
		}
		if (source.startsWith("<![CDATA[", next)) {
			const end = source.indexOf("]]>", next + 9);
			if (end === -1) return { ok: false, reason: "The CDATA section is not closed." };
			flushText();
			tokens.push({ type: "cdata", value: source.slice(next, end + 3) });
			index = end + 3;
			continue;
		}
		if (source.startsWith("<?", next)) {
			const end = source.indexOf("?>", next + 2);
			if (end === -1) return { ok: false, reason: "The XML declaration is not closed." };
			flushText();
			tokens.push({ type: "markup", value: source.slice(next, end + 2) });
			index = end + 2;
			continue;
		}
		if (source.startsWith("<!", next))
			return { ok: false, reason: "Documents with declarations or entities are shown as source only." };
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
		if (cursor >= source.length) return { ok: false, reason: "An XML tag is not closed." };
		const tag = source.slice(next, cursor + 1);
		const closing = /^<\//.test(tag);
		const name = (tag.match(/^<\/?\s*([A-Za-z_:][\w.:-]*)/) ?? [])[1];
		if (!name) return { ok: false, reason: "The XML structure could not be parsed safely." };
		flushText();
		tokens.push({ type: "tag", name, closing, selfClosing: closing || /\/\s*>$/.test(tag), value: tag });
		index = cursor + 1;
	}
	flushText();
	return { ok: true, tokens };
}

export function formatXml(source) {
	if (source.length > MAX_BYTES) return { ok: false, reason: "The document is larger than 256 KiB." };

	const scanned = scanXml(source);
	if (!scanned.ok) return scanned;
	if (scanned.tokens.length === 0) return { ok: false, reason: "No XML structure was found." };

	const mixedContent = { ok: false, reason: "Mixed content is shown as source only to preserve exact whitespace." };
	const lines = [];
	const stack = [];

	for (const token of scanned.tokens) {
		if (token.type === "markup") {
			lines.push(indent(stack.length, token.value));
			continue;
		}
		if (token.type === "tag") {
			if (token.closing) {
				const frame = stack.pop();
				if (!frame || frame.name !== token.name) return { ok: false, reason: "The XML tags are not balanced." };
				if (frame.hadText && frame.hadChild) return mixedContent;
				lines.push(indent(stack.length, token.value));
				continue;
			}
			const parent = stack.at(-1);
			if (parent?.hadText) return mixedContent;
			if (parent) parent.hadChild = true;
			lines.push(indent(stack.length, token.value));
			if (!token.selfClosing) {
				if (stack.length >= MAX_DEPTH) return { ok: false, reason: "The document nests deeper than 64 levels." };
				stack.push({ name: token.name, hadText: false, hadChild: false });
			}
			continue;
		}
		if (token.type === "text") {
			const trimmed = token.value.trim();
			if (!trimmed) continue;
			const frame = stack.at(-1);
			if (!frame) return { ok: false, reason: "Text outside the root element is shown as source only." };
			if (frame.hadChild) return mixedContent;
			frame.hadText = true;
			lines.push(indent(stack.length, trimmed));
			continue;
		}
		const frame = stack.at(-1);
		if (!frame) return { ok: false, reason: "The XML structure could not be parsed safely." };
		if (frame.hadChild) return mixedContent;
		frame.hadText = true;
		lines.push(indent(stack.length, token.value));
	}

	if (stack.length > 0) return { ok: false, reason: "The XML tags are not balanced." };
	return { ok: true, text: lines.join("\n") };
}

export function formatHtml(source) {
	if (source.length > MAX_BYTES) return { ok: false, reason: "The document is larger than 256 KiB." };
	if (RAW_TEXT_ELEMENTS.test(source))
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
