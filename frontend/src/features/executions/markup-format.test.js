import { describe, expect, test } from "bun:test";
import { formatHtml, formatXml } from "./markup-format.js";

describe("xml formatting", () => {
	test("preserves quoted attribute values containing >", () => {
		expect(formatXml('<span title="a > b">x</span>')).toEqual({ ok: true, text: '<span title="a > b">\n  x\n</span>' });
	});

	test("preserves comments and CDATA containing >", () => {
		expect(formatXml("<!-- keep > this --><a>x</a>").text).toBe("<!-- keep > this -->\n<a>\n  x\n</a>");
		expect(formatXml("<root><![CDATA[a > b]]></root>").text).toBe("<root>\n  <![CDATA[a > b]]>\n</root>");
	});

	test("keeps indentation-only whitespace without treating it as content", () => {
		const source = "<root>\n  <a>1</a>\n  <b>2</b>\n</root>";
		expect(formatXml(source)).toEqual({ ok: true, text: "<root>\n  <a>\n    1\n  </a>\n  <b>\n    2\n  </b>\n</root>" });
	});

	test("formats prologs, self-closing tags, and text containing >", () => {
		expect(formatXml('<?xml version="1.0"?><a><b/></a>')).toEqual({
			ok: true,
			text: '<?xml version="1.0"?>\n<a>\n  <b/>\n</a>',
		});
		expect(formatXml("<a>1 > 0</a>")).toEqual({ ok: true, text: "<a>\n  1 > 0\n</a>" });
	});

	test("falls back to raw for mixed content, malformed markup, and entities", () => {
		const sources = [
			"<a>hello <b>x</b> world</a>",
			"<a>text<b/></a>",
			"<a><b></a>",
			"<a>1 < 2</a>",
			"<root><![CDATA[unterminated</root>",
			"<!-- unterminated <a/>",
			"<!DOCTYPE x><a/>",
			"</a>",
			"",
		];
		for (const source of sources) expect(formatXml(source).ok).toBe(false);
	});

	test("falls back for oversized documents", () => {
		expect(formatXml(`<a>${"x".repeat(256 * 1024)}</a>`).ok).toBe(false);
	});
});

describe("html formatting", () => {
	test("keeps quoted attribute values containing >", () => {
		expect(formatHtml('<span title="a > b">x</span>').text).toBe('<span title="a > b">\n  x\n</span>');
	});

	test("keeps comments and entities intact", () => {
		expect(formatHtml("<!-- a > b --><p>a &amp; b &lt; c</p>")).toEqual({
			ok: true,
			text: "<!-- a > b -->\n<p>\n  a &amp; b &lt; c\n</p>",
		});
	});

	test("falls back for raw-text elements so their content is never rewritten", () => {
		const sources = [
			"<p>hi</p><script>if (a<b) {}</script>",
			"<pre>  exact\n  text</pre>",
			"<style>a{color:red}</style>",
			"<textarea> keep </textarea>",
			"<title>t</title>",
		];
		for (const source of sources) {
			const result = formatHtml(source);
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("raw-text");
		}
	});

	test("falls back for unterminated tags and oversized documents", () => {
		expect(formatHtml("<div><p").ok).toBe(false);
		expect(formatHtml("<!-- open").ok).toBe(false);
		expect(formatHtml(`<div>${"x".repeat(256 * 1024)}</div>`).ok).toBe(false);
	});
});
