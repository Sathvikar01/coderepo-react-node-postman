import { describe, expect, test } from "bun:test";
import { resolveRedirectUrl } from "./redirect.js";

describe("redirect resolution", () => {
	test("resolves relative and protocol-relative locations against the executed URL", () => {
		expect(resolveRedirectUrl("/next?q=1", "http://demo.local:8000/api/v1/items")).toEqual({
			ok: true,
			url: "http://demo.local:8000/next?q=1",
		});
		expect(resolveRedirectUrl("//other.test/x", "https://demo.local/a/b")).toEqual({ ok: true, url: "https://other.test/x" });
		expect(resolveRedirectUrl("item/2", "http://demo.local/api/v1/items/1")).toEqual({
			ok: true,
			url: "http://demo.local/api/v1/items/item/2",
		});
	});

	test("keeps absolute http(s) locations", () => {
		expect(resolveRedirectUrl("https://example.test/next", "http://demo.local/")).toEqual({
			ok: true,
			url: "https://example.test/next",
		});
	});

	test("refuses non-HTTP(S) and malformed locations", () => {
		expect(resolveRedirectUrl("javascript:alert(1)", "http://demo.local/")).toEqual({ ok: false, reason: "scheme" });
		expect(resolveRedirectUrl("file:///etc/passwd", "http://demo.local/")).toEqual({ ok: false, reason: "scheme" });
		expect(resolveRedirectUrl("http://", "http://demo.local/")).toEqual({ ok: false, reason: "invalid" });
		expect(resolveRedirectUrl("/next", "not a url")).toEqual({ ok: false, reason: "invalid" });
		expect(resolveRedirectUrl("", "http://demo.local/")).toEqual({ ok: false, reason: "missing" });
		expect(resolveRedirectUrl(undefined, "http://demo.local/")).toEqual({ ok: false, reason: "missing" });
	});
});
