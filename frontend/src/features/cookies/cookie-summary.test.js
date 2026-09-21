import { describe, expect, test } from "bun:test";
import { cookieBadges, cookieScope, expiryLabel } from "./cookie-summary.js";

describe("cookie summary", () => {
	test("shows the domain and path scope", () => {
		expect(cookieScope({ domain: "api.demo.test", path: "/app" })).toBe("api.demo.test/app");
	});

	test("labels session, host-only, secure, and http-only cookies", () => {
		expect(
			cookieBadges({ session: true, hostOnly: true, secure: false, httpOnly: true }),
		).toEqual(["Session", "Host only", "HttpOnly"]);
		expect(
			cookieBadges({ session: false, hostOnly: false, secure: true, httpOnly: false }),
		).toEqual(["Persistent", "Domain", "Secure"]);
	});

	test("formats expiry deterministically", () => {
		expect(expiryLabel({ session: true })).toBe("Session cookie");
		expect(expiryLabel({ session: false, expiresAt: "2026-09-22T06:30:00.000Z" })).toBe("Expires 2026-09-22 06:30 UTC");
		expect(expiryLabel({ session: false, expiresAt: "not-a-date" })).toBe("Expired");
	});
});
