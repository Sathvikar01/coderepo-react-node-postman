import { describe, expect, test } from "bun:test";
import { createTargetPolicy, isAmbiguousNumericHost } from "./target-policy.js";
import { pinnedResolver } from "./address-resolver.js";

const policy = createTargetPolicy({ resolver: pinnedResolver([{ address: "93.184.216.34", family: 4 }]) });
const privateResolverPolicy = createTargetPolicy({ resolver: pinnedResolver([{ address: "10.0.0.5", family: 4 }]) });

describe("target policy", () => {
	test("permits an ordinary public hostname", async () => {
		const target = await policy.validate("https://example.com/orders?status=paid");
		expect(target).toMatchObject({
			scheme: "https",
			originalHostname: "example.com",
			port: 443,
			ip: "93.184.216.34",
			isIpLiteral: false,
		});
	});
	test("permits a public IP literal with an explicit port", async () => {
		const target = await policy.validate("http://93.184.216.34:8080/path");
		expect(target).toMatchObject({ port: 8080, isIpLiteral: true, ip: "93.184.216.34" });
	});
	test("rejects userinfo", async () => {
		await expect(policy.validate("http://user:pass@example.com/")).rejects.toMatchObject({ code: "URL_USERINFO" });
	});
	test("rejects fragments", async () => {
		await expect(policy.validate("http://example.com/#fragment")).rejects.toMatchObject({ code: "URL_FRAGMENT" });
	});
	test("rejects non-HTTP schemes", async () => {
		await expect(policy.validate("file:///etc/passwd")).rejects.toMatchObject({ code: "URL_SCHEME" });
	});
	test("rejects alternate numeric IPv4 spellings", async () => {
		expect(isAmbiguousNumericHost("2130706433")).toBe(true);
		expect(isAmbiguousNumericHost("0177.0.0.1")).toBe(true);
		expect(isAmbiguousNumericHost("0x7f000001")).toBe(true);
		await expect(policy.validate("http://2130706433/")).rejects.toMatchObject({ code: "URL_AMBIGUOUS_HOST" });
	});
	test("rejects loopback and metadata literals", async () => {
		for (const url of [
			"http://127.0.0.1/",
			"http://0.0.0.0/",
			"http://169.254.169.254/latest/meta-data",
			"http://[::1]/",
			"http://[::ffff:127.0.0.1]/",
			"http://[64:ff9b::7f00:1]/",
		]) {
			await expect(policy.validate(url)).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
		}
	});
	test("rejects a hostname resolving to a private address", async () => {
		await expect(privateResolverPolicy.validate("https://internal.example.com/")).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
	});
	test("rejects localhost names, single-label hostnames, and privately resolving lookalikes", async () => {
		for (const url of ["http://localhost/", "http://intranet/", "http://box.local/"]) {
			await expect(policy.validate(url)).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
		}
		await expect(privateResolverPolicy.validate("http://localhost.evil.example/")).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
		await expect(privateResolverPolicy.validate("https://wildcard.example.com/")).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
	});

	test("rejects unsafe authored spelling even after compiler normalization", async () => {
		await expect(
			policy.validate("http://127.0.0.1:8000/demo/v1/local/orders", {
				allowLocalDemo: true,
				authoredUrl: "http://2130706433:8000/demo/v1/local/orders",
			}),
		).rejects.toMatchObject({ code: "URL_AMBIGUOUS_HOST" });

		await expect(
			policy.validate("http://127.0.0.1:8000/demo/v1/local/orders", {
				allowLocalDemo: true,
				authoredUrl: "http://127.0.0.1:8000/demo/v1/local/../orders",
			}),
		).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
	});

	test("allows only the canonical demo target on loopback", async () => {
		const target = await policy.validate("http://127.0.0.1:8000/demo/v1/local/orders", { allowLocalDemo: true });
		expect(target).toMatchObject({ local: true, port: 8000, originalHostname: "127.0.0.1" });
		await expect(policy.validate("http://127.0.0.1:8000/api/v1/collections", { allowLocalDemo: true })).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
		});
		await expect(policy.validate("http://127.0.0.1:27017/", { allowLocalDemo: true })).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
		});
		await expect(
			policy.validate("http://127.0.0.1:8000/demo/v1/local/../api/v1/health", { allowLocalDemo: true }),
		).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
	});
});
