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

describe("target policy DNS adversaries", () => {
	test("fails closed when any answer in a mixed DNS reply is denied", async () => {
		const mixed = createTargetPolicy({
			resolver: pinnedResolver([
				{ address: "93.184.216.34", family: 4 },
				{ address: "10.0.0.5", family: 4 },
			]),
		});
		await expect(mixed.validate("https://mixed.example.com/")).rejects.toMatchObject({ code: "TARGET_BLOCKED", details: { address: "10.0.0.5" } });

		const deniedFirst = createTargetPolicy({
			resolver: pinnedResolver([
				{ address: "127.0.0.1", family: 4 },
				{ address: "93.184.216.34", family: 4 },
			]),
		});
		await expect(deniedFirst.validate("https://mixed.example.com/")).rejects.toMatchObject({ code: "TARGET_BLOCKED" });

		const v6Mixed = createTargetPolicy({
			resolver: pinnedResolver([
				{ address: "2606:4700:4700::1111", family: 6 },
				{ address: "fd00::1", family: 6 },
			]),
		});
		await expect(v6Mixed.validate("https://mixed.example.com/")).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
	});

	test("picks the first of several public answers and never consults DNS for literals", async () => {
		let calls = 0;
		const resolver = {
			async resolve() {
				calls += 1;
				return [
					{ address: "93.184.216.34", family: 4 },
					{ address: "1.1.1.1", family: 4 },
				];
			},
		};
		const multi = createTargetPolicy({ resolver });
		const target = await multi.validate("https://multi.example.com/");
		expect(calls).toBe(1);
		expect(target.ip).toBe("93.184.216.34");

		const literal = await multi.validate("http://93.184.216.34/");
		expect(calls).toBe(1);
		expect(literal.isIpLiteral).toBe(true);
	});

	test("rejects empty DNS answers", async () => {
		const empty = createTargetPolicy({ resolver: pinnedResolver([]) });
		await expect(empty.validate("https://empty.example.com/")).rejects.toMatchObject({ code: "TARGET_UNRESOLVED", statusCode: 502 });
	});

	test("rejects alternate numeric spellings that the URL parser would normalize", async () => {
		const spellings = ["http://2130706433/", "http://017700000001/", "http://0x7f000001/", "http://0177.0.0.1/"];
		for (const url of spellings) {
			await expect(policy.validate(url)).rejects.toMatchObject({ code: "URL_AMBIGUOUS_HOST" });
		}
		await expect(policy.validate("http://127.1/")).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
		await expect(policy.validate("http://0x7f.0.0.1/")).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
	});

	test("rejects encoded path separators and dot segments in the authored URL", async () => {
		for (const authored of [
			"https://example.com/a/%2e%2e/b",
			"https://example.com/a/%2f/b",
			"https://example.com/a/%5C/b",
			"https://example.com/a\\b",
		]) {
			await expect(policy.validate("https://example.com/", { authoredUrl: authored })).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
		}
	});
});
