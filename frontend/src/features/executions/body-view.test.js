import { describe, expect, test } from "bun:test";
import { bodyNotice, describeBody } from "./body-view.js";

const utf8 = (value, overrides = {}) => ({ encoding: "utf8", value, mediaType: "text/plain", truncated: false, ...overrides });

describe("body presentation", () => {
	test("presents base64 captures as binary text without formatting", () => {
		expect(describeBody({ encoding: "base64", value: "AAEC", mediaType: "application/octet-stream" })).toEqual({
			presentation: "binary",
			text: "AAEC",
		});
	});

	test("presents empty bodies distinctly", () => {
		expect(describeBody(utf8(""))).toEqual({ presentation: "empty", text: "" });
		expect(describeBody(null)).toEqual({ presentation: "empty", text: "" });
	});

	test("pretty prints JSON by media type and by sniffing untyped bodies", () => {
		const byMedia = describeBody(utf8('{"id":12345678901234567890}', { mediaType: "application/json; charset=utf-8" }));
		expect(byMedia.presentation).toBe("json");
		expect(byMedia.text).toContain("12345678901234567890");
		expect(describeBody(utf8('{"a":1}')).presentation).toBe("json");
	});

	test("does not let JSON sniffing override an explicit XML or HTML media type", () => {
		expect(describeBody(utf8('{"a":1}', { mediaType: "text/html" })).presentation).toBe("html");
		expect(describeBody(utf8('{"a":1}', { mediaType: "application/xml" })).presentation).toBe("raw");
	});

	test("falls back to raw source with a reason for malformed structured bodies", () => {
		const json = describeBody(utf8('{"a":', { mediaType: "application/json" }));
		expect(json.presentation).toBe("raw");
		expect(json.reason).toContain("not valid JSON");

		const xml = describeBody(utf8("<a><b></a>", { mediaType: "text/xml" }));
		expect(xml.presentation).toBe("raw");
		expect(xml.reason).toContain("not balanced");

		const html = describeBody(utf8("<p>hi</p><pre>x</pre>", { mediaType: "text/html" }));
		expect(html.presentation).toBe("raw");
		expect(html.reason).toContain("raw-text");
	});

	test("never pretty prints truncated or oversized bodies", () => {
		expect(describeBody(utf8('{"a":1}', { truncated: true }))).toEqual({ presentation: "raw", text: '{"a":1}' });
		const large = describeBody(utf8("x".repeat(256 * 1024 + 1)));
		expect(large.presentation).toBe("raw");
		expect(large.reason).toContain("larger than");
	});

	test("stays silent when an untyped body merely looks like JSON", () => {
		expect(describeBody(utf8("{not json"))).toEqual({ presentation: "raw", text: "{not json", reason: null });
	});
});

describe("body notices", () => {
	test("describes history truncation with kept and total sizes", () => {
		const notice = bodyNotice(
			{ encoding: "utf8", value: "x", truncated: true, omittedReason: "history_limit" },
			{ persistedBodyBytes: 262144, decodedBodyBytes: 1048576 },
		);
		expect(notice.tone).toBe("warning");
		expect(notice.message).toContain("History kept");
		expect(notice.message).toContain("256.0 KiB");
		expect(notice.message).toContain("1.0 MiB");
	});

	test("explains retention and redaction removals", () => {
		expect(bodyNotice({ encoding: "utf8", truncated: true, omittedReason: "retention" }).message).toContain("retention policy");
		expect(bodyNotice({ encoding: "base64", truncated: true, omittedReason: "sensitive" }).message).toContain("redacted secret");
	});

	test("explains binary bodies and stays quiet for plain text", () => {
		expect(bodyNotice({ encoding: "base64", value: "AA==", mediaType: "application/octet-stream", truncated: false }).tone).toBe(
			"info",
		);
		expect(bodyNotice(utf8("hello"))).toBeNull();
		expect(bodyNotice(null)).toBeNull();
	});
});
