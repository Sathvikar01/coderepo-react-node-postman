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
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "pre"]);

export function formatXml(source) {
	if (source.length > MAX_BYTES) return { ok: false, reason: "The document is larger than 256 KiB." };
	if (/<!doctype|<!entity/i.test(source))
		return { ok: false, reason: "Documents with a DTD or entity declaration are shown as source only." };
	const tokens = source.match(/<[^>]*>|[^<]+/g);
	if (!tokens) return { ok: false, reason: "No XML structure was found." };
	const lines = [];
	let depth = 0;
	for (const token of tokens) {
		if (token.startsWith("</")) {
			depth = Math.max(0, depth - 1);
			if (depth > MAX_DEPTH) return { ok: false, reason: "The document nests deeper than 64 levels." };
			lines.push(`${"  ".repeat(depth)}${token}`);
			continue;
		}
		if (token.startsWith("<?")) {
			lines.push(`${"  ".repeat(depth)}${token}`);
			continue;
		}
		if (token.startsWith("<!")) {
			lines.push(`${"  ".repeat(depth)}${token}`);
			continue;
		}
		if (token.startsWith("<")) {
			const selfClosing = /\/>$/.test(token) || VOID_ELEMENTS.has((token.match(/^<\s*([^\s/>]+)/) ?? [])[1]?.toLowerCase());
			lines.push(`${"  ".repeat(depth)}${token}`);
			if (!selfClosing) {
				depth += 1;
				if (depth > MAX_DEPTH) return { ok: false, reason: "The document nests deeper than 64 levels." };
			}
			continue;
		}
		const text = token.trim();
		if (text) lines.push(`${"  ".repeat(depth)}${text}`);
	}
	return { ok: true, text: lines.join("\n") };
}

export function formatHtml(source) {
	if (source.length > MAX_BYTES) return { ok: false, reason: "The document is larger than 256 KiB." };
	const tokens = [];
	let index = 0;
	let depth = 0;
	while (index < source.length) {
		const next = source.indexOf("<", index);
		if (next === -1) {
			tokens.push({ type: "text", value: source.slice(index) });
			break;
		}
		if (next > index) tokens.push({ type: "text", value: source.slice(index, next) });
		if (source.startsWith("<!--", next)) {
			const end = source.indexOf("-->", next + 4);
			const stop = end === -1 ? source.length : end + 3;
			tokens.push({ type: "comment", value: source.slice(next, stop) });
			index = stop;
			continue;
		}
		let cursor = next + 1;
		let quote = null;
		while (cursor < source.length) {
			const character = source[cursor];
			if (quote) {
				if (character === quote) quote = null;
			} else if (character === '"' || character === "'") quote = character;
			else if (character === ">") break;
			cursor += 1;
		}
		tokens.push({ type: "tag", value: source.slice(next, Math.min(cursor + 1, source.length)) });
		index = cursor + 1;
		const tag = tokens[tokens.length - 1].value;
		if (/^<!/.test(tag)) continue;
		const closing = /^<\//.test(tag);
		const name = (tag.match(/^<\/?\s*([A-Za-z0-9:-]+)/) ?? [])[1]?.toLowerCase() ?? "";
		const selfClosing = /\/>$/.test(tag) || VOID_ELEMENTS.has(name);
		if (closing) depth = Math.max(0, depth - 1);
		tokens[tokens.length - 1].depth = depth;
		if (!closing && !selfClosing) depth += 1;
		if (depth > MAX_DEPTH) return { ok: false, reason: "The document nests deeper than 64 levels." };
	}
	const lines = [];
	for (const token of tokens) {
		if (token.type === "text") {
			const text = token.value.trim();
			if (text) lines.push(`${"  ".repeat(depth)}${text}`);
			continue;
		}
		const pad = "  ".repeat(Math.max(0, token.depth ?? 0));
		lines.push(`${pad}${token.value}`);
	}
	return { ok: true, text: lines.join("\n") };
}
