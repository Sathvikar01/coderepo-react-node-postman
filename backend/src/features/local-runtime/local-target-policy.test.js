import { describe, expect, test } from "bun:test";
import { pinnedResolver } from "../executions/address-resolver.js";
import { createTargetPolicy } from "../executions/target-policy.js";

const localhostResolver = pinnedResolver([{ address: "127.0.0.1", family: 4 }]);
const lanResolver = pinnedResolver([{ address: "192.168.1.20", family: 4 }]);
const policy = createTargetPolicy({ resolver: lanResolver });
const localhostPolicy = createTargetPolicy({ resolver: localhostResolver });
const settings = (hosts, enabled = true) => ({ enabled, hosts });

describe("local runtime target opt-in", () => {
	test("localhost is blocked while Local Runtime is disabled", async () => {
		for (const raw of ["http://localhost:3000/", "http://127.0.0.1/", "http://[::1]/"]) {
			await expect(localhostPolicy.validate(raw, { localRuntime: settings(["localhost", "127.0.0.1", "::1"], false) })).rejects.toMatchObject({
				code: "TARGET_BLOCKED",
			});
		}
	});

	test("localhost is blocked when Local Runtime is on but the host was not approved", async () => {
		await expect(localhostPolicy.validate("http://localhost:3000/", { localRuntime: settings(["dev.lan"]) })).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
		});
	});

	test("an approved localhost resolves to a pinned loopback address", async () => {
		const target = await localhostPolicy.validate("http://localhost:3000/health", {
			localRuntime: settings(["localhost"]),
		});
		expect(target).toMatchObject({
			scheme: "http",
			originalHostname: "localhost",
			authority: "localhost:3000",
			port: 3000,
			ip: "127.0.0.1",
			family: 4,
			isIpLiteral: false,
			local: true,
		});
	});

	test("approved IPv4 and IPv6 literals stay literals", async () => {
		const v4 = await localhostPolicy.validate("http://127.0.0.1:8080/api", { localRuntime: settings(["127.0.0.1"]) });
		expect(v4).toMatchObject({ ip: "127.0.0.1", isIpLiteral: true, local: true, port: 8080 });
		const v6Policy = createTargetPolicy({ resolver: pinnedResolver([]) });
		const v6 = await v6Policy.validate("http://[::1]:8080/api", { localRuntime: settings(["::1"]) });
		expect(v6).toMatchObject({ ip: "::1", isIpLiteral: true, family: 6, local: true, authority: "[::1]:8080" });
	});

	test("an unapproved private IP literal stays blocked", async () => {
		await expect(policy.validate("http://10.0.0.5/", { localRuntime: settings(["localhost"]) })).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
		});
	});

	test("an approved LAN hostname resolves and pins a private address", async () => {
		const target = await policy.validate("http://dev.lan:9000/status", { localRuntime: settings(["dev.lan"]) });
		expect(target).toMatchObject({ originalHostname: "dev.lan", ip: "192.168.1.20", local: true, isIpLiteral: false });
	});

	test("an approved hostname that resolves to a public address is blocked", async () => {
		const publicResolver = createTargetPolicy({ resolver: pinnedResolver([{ address: "93.184.216.34", family: 4 }]) });
		await expect(publicResolver.validate("http://dev.lan/", { localRuntime: settings(["dev.lan"]) })).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
		});
	});
});

describe("local runtime DNS rebinding defenses", () => {
	test("mixed private and public answers are rejected", async () => {
		const mixed = createTargetPolicy({
			resolver: pinnedResolver([
				{ address: "192.168.1.20", family: 4 },
				{ address: "93.184.216.34", family: 4 },
			]),
		});
		await expect(mixed.validate("http://dev.lan/", { localRuntime: settings(["dev.lan"]) })).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
			details: { address: "93.184.216.34" },
		});
	});

	test("mixed IPv4 and IPv6 answers must all be local", async () => {
		const mixed = createTargetPolicy({
			resolver: pinnedResolver([
				{ address: "::1", family: 6 },
				{ address: "2001:db8::5", family: 6 },
			]),
		});
		await expect(mixed.validate("http://dev.lan/", { localRuntime: settings(["dev.lan"]) })).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
		});
	});

	test("validation resolves exactly once and pins the approved address", async () => {
		const calls = [];
		const flipping = createTargetPolicy({
			resolver: {
				async resolve(hostname) {
					calls.push(hostname);
					if (calls.length === 1) return [{ address: "192.168.1.20", family: 4 }];
					return [{ address: "93.184.216.34", family: 4 }];
				},
			},
		});
		const target = await flipping.validate("http://dev.lan/", { localRuntime: settings(["dev.lan"]) });
		expect(calls).toEqual(["dev.lan"]);
		expect(target.ip).toBe("192.168.1.20");
		expect(target.local).toBe(true);
	});

	test("a mapped private IPv6 answer is rejected", async () => {
		const mapped = createTargetPolicy({ resolver: pinnedResolver([{ address: "::ffff:192.168.1.5", family: 6 }]) });
		await expect(mapped.validate("http://dev.lan/", { localRuntime: settings(["dev.lan"]) })).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
		});
	});

	test("link-local IPv6 answers are rejected", async () => {
		const linkLocal = createTargetPolicy({ resolver: pinnedResolver([{ address: "fe80::1", family: 6 }]) });
		await expect(linkLocal.validate("http://dev.lan/", { localRuntime: settings(["dev.lan"]) })).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
		});
	});
});

describe("local runtime metadata defenses", () => {
	test("metadata addresses are blocked even when they appear in the approved list", async () => {
		for (const entry of ["169.254.169.254", "100.100.100.200", "192.0.0.192", "fd00:ec2::254"]) {
			const metadataPolicy = createTargetPolicy({ resolver: pinnedResolver([]) });
			const raw = entry.includes(":") ? `http://[${entry}]/` : `http://${entry}/`;
			await expect(metadataPolicy.validate(raw, { localRuntime: settings([entry]) })).rejects.toMatchObject({
				code: "TARGET_BLOCKED",
			});
		}
	});

	test("metadata hostnames are blocked even when approved", async () => {
		const metadataResolver = pinnedResolver([{ address: "169.254.169.254", family: 4 }]);
		const metadataPolicy = createTargetPolicy({ resolver: metadataResolver });
		await expect(
			metadataPolicy.validate("http://metadata.google.internal/", { localRuntime: settings(["metadata.google.internal"]) }),
		).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
	});
});

describe("local runtime preserves the normal URL rules", () => {
	test("a subdomain of an approved localhost is not covered by the approval", async () => {
		await expect(localhostPolicy.validate("http://dev.localhost/", { localRuntime: settings(["localhost"]) })).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
		});
	});

	test("ambiguous numeric hosts, userinfo, fragments, and bad ports stay rejected", async () => {
		const hosts = ["localhost"];
		await expect(localhostPolicy.validate("http://2130706433/", { localRuntime: settings(hosts) })).rejects.toMatchObject({
			code: "URL_AMBIGUOUS_HOST",
		});
		await expect(localhostPolicy.validate("http://user:pass@localhost/", { localRuntime: settings(hosts) })).rejects.toMatchObject({
			code: "URL_USERINFO",
		});
		await expect(localhostPolicy.validate("http://localhost/#frag", { localRuntime: settings(hosts) })).rejects.toMatchObject({
			code: "URL_FRAGMENT",
		});
		await expect(localhostPolicy.validate("ftp://localhost/file", { localRuntime: settings(hosts) })).rejects.toMatchObject({
			code: "URL_SCHEME",
		});
		await expect(localhostPolicy.validate("http://localhost/a/../b", { localRuntime: settings(hosts) })).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
		});
	});

	test("the frozen demo exception is unchanged and still marked local", async () => {
		const demo = await localhostPolicy.validate("http://127.0.0.1:8000/demo/v1/echo", { allowLocalDemo: true });
		expect(demo).toMatchObject({ local: true, ip: "127.0.0.1", port: 8000 });
		await expect(localhostPolicy.validate("http://127.0.0.1:8000/demo/v1/echo")).rejects.toMatchObject({
			code: "TARGET_BLOCKED",
		});
	});
});
