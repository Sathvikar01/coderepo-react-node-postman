import { describe, expect, test } from "bun:test";
import { approvedHostForUrl, hostPayload, validateHostInput } from "./local-runtime.js";

describe("approved host input", () => {
	test("normalizes hostnames, IPv4, and IPv6 entries", () => {
		expect(validateHostInput("  Dev.LAN. ", [])).toEqual({ ok: true, host: "dev.lan" });
		expect(validateHostInput("127.0.0.1", [])).toEqual({ ok: true, host: "127.0.0.1" });
		expect(validateHostInput("::1", [])).toEqual({ ok: true, host: "::1" });
		expect(validateHostInput("[fd00::1]", [])).toEqual({ ok: true, host: "fd00::1" });
		expect(validateHostInput("localhost", [])).toEqual({ ok: true, host: "localhost" });
	});

	test("rejects wildcards, ranges, URLs, ports, duplicates, and symbols", () => {
		for (const entry of ["", "   ", "*", "*.lan", "10.0.0.0/8", "http://localhost:3000", "dev.lan:8080", "a b.lan", "dev.lan\\x"]) {
			expect(validateHostInput(entry, []).ok).toBe(false);
		}
		expect(validateHostInput("dev.lan", ["dev.lan"])).toEqual({
			ok: false,
			error: "dev.lan is already on the approved list.",
		});
	});
});

describe("approved host payload", () => {
	test("sends only host names back to the API", () => {
		const targets = [
			{ id: "server-id-1", host: "127.0.0.1", addedAt: "2026-01-01T00:00:00.000Z" },
			{ id: "server-id-2", host: "::1", addedAt: "2026-01-01T00:00:00.000Z" },
		];
		expect(hostPayload(targets)).toEqual([{ host: "127.0.0.1" }, { host: "::1" }]);
		expect(hostPayload()).toEqual([]);
	});
});

describe("pre-send local host warning", () => {	test("detects an approved literal host in a URL template", () => {
		expect(approvedHostForUrl("http://dev.lan:9000/status", ["dev.lan"])).toBe("dev.lan");
		expect(approvedHostForUrl("http://[::1]:9000/status", ["::1"])).toBe("::1");
		expect(approvedHostForUrl("http://localhost/health", ["localhost"])).toBe("localhost");
	});

	test("stays quiet for unapproved hosts, variable templates, and invalid URLs", () => {
		expect(approvedHostForUrl("http://example.com/", ["dev.lan"])).toBeNull();
		expect(approvedHostForUrl("http://{{host}}/status", ["dev.lan"])).toBeNull();
		expect(approvedHostForUrl("not a url", ["dev.lan"])).toBeNull();
		expect(approvedHostForUrl("", ["dev.lan"])).toBeNull();
		expect(approvedHostForUrl("http://dev.lan/", [])).toBeNull();
	});
});
