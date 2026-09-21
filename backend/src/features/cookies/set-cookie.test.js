import { describe, expect, test } from "bun:test";
import {
	cookieHeaderFor,
	cookieMatches,
	defaultCookiePath,
	domainMatchesHost,
	isPublicSuffix,
	normalizeHost,
	orderCookies,
	parseSetCookie,
	pathMatches,
} from "./set-cookie.js";

const NOW = Date.UTC(2026, 8, 21, 6, 0, 0);

function parsed(header, options = {}) {
	const result = parseSetCookie(header, { host: "api.demo.test", path: "/app/items", now: NOW, ...options });
	if (!result.ok) throw new Error(`expected a parsed cookie, got ${result.reason}`);
	return result;
}

describe("set-cookie parsing", () => {
	test("parses name, value, and attributes", () => {
		const { ok, action, cookie } = parsed("sid=abc123; Path=/app; Domain=demo.test; Secure; HttpOnly; Max-Age=60");
		expect(ok).toBe(true);
		expect(action).toBe("store");
		expect(cookie).toMatchObject({
			name: "sid",
			value: "abc123",
			domain: "demo.test",
			hostOnly: false,
			path: "/app",
			secure: true,
			httpOnly: true,
		});
		expect(cookie.expiresAt.getTime()).toBe(NOW + 60_000);
	});

	test("defaults to a host-only cookie with the request default path", () => {
		const { cookie } = parsed("sid=abc123");
		expect(cookie).toMatchObject({ domain: "api.demo.test", hostOnly: true, path: "/app", expiresAt: null, secure: false });
	});

	test("strips a leading dot and trailing dot from Domain", () => {
		const { cookie } = parsed("sid=abc; Domain=.demo.test.");
		expect(cookie).toMatchObject({ domain: "demo.test", hostOnly: false });
	});

	test("a session cookie has no expiry", () => {
		const { action, cookie } = parsed("sid=abc; HttpOnly");
		expect(action).toBe("store");
		expect(cookie.expiresAt).toBeNull();
	});

	test("a past Expires deletes the cookie", () => {
		const { action, cookie } = parsed("sid=abc; Expires=Wed, 21 Oct 2015 07:28:00 GMT");
		expect(action).toBe("delete");
		expect(cookie.name).toBe("sid");
	});

	test("Max-Age=0 deletes and negative Max-Age deletes", () => {
		expect(parsed("sid=abc; Max-Age=0").action).toBe("delete");
		expect(parsed("sid=abc; Max-Age=-5").action).toBe("delete");
	});

	test("Max-Age takes precedence over Expires", () => {
		const { action, cookie } = parsed("sid=abc; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=120");
		expect(action).toBe("store");
		expect(cookie.expiresAt.getTime()).toBe(NOW + 120_000);
	});

	test("ignores SameSite, Partitioned, and unknown attributes", () => {
		const { action } = parsed("sid=abc; SameSite=None; Partitioned; Priority=High");
		expect(action).toBe("store");
	});

	test("parses each header of a multi-header response independently", () => {
		const headers = ["a=1; Path=/", "b=2; Path=/app; Secure"];
		const cookies = headers.map((header) => parsed(header).cookie);
		expect(cookies.map((cookie) => [cookie.name, cookie.value, cookie.path, cookie.secure])).toEqual([
			["a", "1", "/", false],
			["b", "2", "/app", true],
		]);
	});

	test("fails closed on malformed attributes", () => {
		const malformed = [
			"novalue",
			"=value; Path=/",
			"bad name=1",
			"$Version=1",
			"a b=1",
			"sid=1; Path=relative",
			"sid=1; Domain=",
			"sid=1; Domain=bad_domain",
			"sid=1; Domain=other.test",
			"sid=1; Domain=com",
			"sid=1; Domain=co.uk",
			"sid=1; Domain=localhost",
			"sid=1; Max-Age=soon",
			"sid=1; Max-Age=1.5",
			"sid=1; Expires=not-a-date",
			"sid=1; Secure=1",
			"sid=1; HttpOnly=yes",
			"sid=1; Path=; Secure",
		];
		for (const header of malformed) {
			const result = parseSetCookie(header, { host: "api.demo.test", path: "/app", now: NOW });
			expect(result.ok).toBe(false);
			expect(result.reason).toBeString();
		}
	});

	test("rejects a Domain attribute for an IP-literal host", () => {
		expect(parseSetCookie("sid=1; Domain=127.0.0.1", { host: "127.0.0.1", path: "/", now: NOW })).toMatchObject({
			ok: false,
			reason: "domain_ip_literal",
		});
		expect(parseSetCookie("sid=1", { host: "127.0.0.1", path: "/", now: NOW }).ok).toBe(true);
	});

	test("rejects oversized cookies and control characters", () => {
		const oversized = `sid=${"x".repeat(5000)}`;
		expect(parseSetCookie(oversized, { host: "demo.test", path: "/", now: NOW })).toMatchObject({ ok: false, reason: "size_limit" });
		expect(parseSetCookie("sid=a\u0001b", { host: "demo.test", path: "/", now: NOW })).toMatchObject({
			ok: false,
			reason: "control_characters",
		});
	});
});

describe("cookie matching", () => {
	const hostOnly = { name: "s", value: "1", domain: "demo.test", hostOnly: true, path: "/", secure: false, expiresAt: null };
	const domainCookie = { ...hostOnly, hostOnly: false };
	const secureCookie = { ...hostOnly, secure: true };

	test("host-only cookies match exactly one host", () => {
		expect(cookieMatches(hostOnly, { host: "demo.test", path: "/", secure: true, now: NOW })).toBe(true);
		expect(cookieMatches(hostOnly, { host: "sub.demo.test", path: "/", secure: true, now: NOW })).toBe(false);
		expect(cookieMatches(hostOnly, { host: "other.test", path: "/", secure: true, now: NOW })).toBe(false);
	});

	test("domain cookies match subdomains but not suffix lookalikes", () => {
		expect(cookieMatches(domainCookie, { host: "demo.test", path: "/", secure: true, now: NOW })).toBe(true);
		expect(cookieMatches(domainCookie, { host: "a.b.demo.test", path: "/", secure: true, now: NOW })).toBe(true);
		expect(cookieMatches(domainCookie, { host: "evildemo.test", path: "/", secure: true, now: NOW })).toBe(false);
		expect(cookieMatches(domainCookie, { host: "demo.test.evil", path: "/", secure: true, now: NOW })).toBe(false);
	});

	test("a Secure cookie is never sent over HTTP", () => {
		expect(cookieMatches(secureCookie, { host: "demo.test", path: "/", secure: true, now: NOW })).toBe(true);
		expect(cookieMatches(secureCookie, { host: "demo.test", path: "/", secure: false, now: NOW })).toBe(false);
	});

	test("an expired cookie is never sent", () => {
		const expired = { ...hostOnly, expiresAt: new Date(NOW - 1) };
		expect(cookieMatches(expired, { host: "demo.test", path: "/", secure: true, now: NOW })).toBe(false);
		expect(cookieMatches({ ...hostOnly, expiresAt: new Date(NOW + 1) }, { host: "demo.test", path: "/", secure: true, now: NOW })).toBe(
			true,
		);
	});

	test("path scoping respects directory boundaries", () => {
		expect(pathMatches("/app/items", "/app")).toBe(true);
		expect(pathMatches("/app", "/app")).toBe(true);
		expect(pathMatches("/app/items/1", "/app/items")).toBe(true);
		expect(pathMatches("/application", "/app")).toBe(false);
		expect(pathMatches("/app", "/app/")).toBe(false);
		expect(pathMatches("/other", "/app")).toBe(false);
	});

	test("default path follows the request directory", () => {
		expect(defaultCookiePath("/a/b/c")).toBe("/a/b");
		expect(defaultCookiePath("/a")).toBe("/");
		expect(defaultCookiePath("/")).toBe("/");
		expect(defaultCookiePath("nonsense")).toBe("/");
	});

	test("normalizes hosts", () => {
		expect(normalizeHost("[::1]")).toBe("::1");
		expect(normalizeHost("Demo.Test.")).toBe("demo.test");
		expect(domainMatchesHost("a.demo.test", "demo.test")).toBe(true);
		expect(isPublicSuffix("com")).toBe(true);
		expect(isPublicSuffix("co.uk")).toBe(true);
		expect(isPublicSuffix("example.test")).toBe(false);
	});
});

describe("cookie ordering and header assembly", () => {
	const base = { value: "v", domain: "demo.test", hostOnly: true, secure: false, expiresAt: null };
	const cookies = [
		{ ...base, name: "theme", path: "/", createdAt: new Date(NOW + 10) },
		{ ...base, name: "session", path: "/app", createdAt: new Date(NOW + 20) },
		{ ...base, name: "theme", path: "/app", createdAt: new Date(NOW + 30) },
		{ ...base, name: "aaa", path: "/app", createdAt: new Date(NOW + 5) },
	];

	test("orders by longest path, then creation time, then name", () => {
		expect(orderCookies(cookies).map((cookie) => `${cookie.name}:${cookie.path}`)).toEqual([
			"aaa:/app",
			"session:/app",
			"theme:/app",
			"theme:/",
		]);
	});

	test("duplicate names with different paths are both sent", () => {
		const scope = [
			{ ...base, name: "a", value: "root", path: "/", createdAt: new Date(NOW) },
			{ ...base, name: "a", value: "deep", path: "/app", createdAt: new Date(NOW + 1) },
		];
		const { value, matched } = cookieHeaderFor(scope, { host: "demo.test", path: "/app/items", secure: true, now: NOW });
		expect(value).toBe("a=deep; a=root");
		expect(matched).toHaveLength(2);
	});

	test("filters cookies that do not apply and reports values for redaction", () => {
		const mixed = [
			{ ...base, name: "keep", value: "one", path: "/" },
			{ ...base, name: "other-host", value: "two", domain: "elsewhere.test" },
			{ ...base, name: "outside-path", value: "three", path: "/admin" },
			{ ...base, name: "expired", value: "four", expiresAt: new Date(NOW - 5) },
		];
		const { value, matched, values } = cookieHeaderFor(mixed, { host: "demo.test", path: "/app", secure: true, now: NOW });
		expect(value).toBe("keep=one");
		expect(matched.map((cookie) => cookie.name)).toEqual(["keep"]);
		expect(values).toEqual(["one"]);
	});

	test("returns no header when nothing matches", () => {
		const { value, matched } = cookieHeaderFor([{ ...base, name: "x", domain: "elsewhere.test" }], {
			host: "demo.test",
			path: "/",
			secure: true,
			now: NOW,
		});
		expect(value).toBeNull();
		expect(matched).toEqual([]);
	});
});
