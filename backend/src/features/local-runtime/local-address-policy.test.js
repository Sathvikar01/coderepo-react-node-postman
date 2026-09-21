import { describe, expect, test } from "bun:test";
import {
	classifyLocalAddress,
	isMetadataAddress,
	isMetadataHostname,
	normalizeLocalHost,
} from "./local-address-policy.js";

describe("local address classification", () => {
	test("permits loopback and RFC1918/ULA ranges", () => {
		for (const address of ["127.0.0.1", "127.8.8.8", "10.0.0.5", "172.16.4.4", "172.31.255.254", "192.168.1.20"]) {
			expect(classifyLocalAddress(address)).toMatchObject({ family: 4, permitted: true, metadata: false });
		}
		for (const address of ["::1", "fd00::1", "fd12:3456::1", "fc00::abcd"]) {
			expect(classifyLocalAddress(address)).toMatchObject({ family: 6, permitted: true, metadata: false });
		}
	});

	test("rejects public, link-local, CGNAT, and transition addresses", () => {
		for (const address of [
			"93.184.216.34",
			"8.8.8.8",
			"169.254.1.1",
			"100.64.0.1",
			"172.32.0.1",
			"192.169.0.1",
			"224.0.0.1",
			"0.0.0.0",
			"fe80::1",
			"2001:db8::1",
			"::ffff:192.168.1.5",
			"64:ff9b::c0a8:105",
			"2002:c0a8:105::1",
		]) {
			expect(classifyLocalAddress(address).permitted).toBe(false);
		}
	});

	test("flags metadata endpoints even when they sit inside a permitted range", () => {
		expect(isMetadataAddress("169.254.169.254")).toBe(true);
		expect(isMetadataAddress("100.100.100.200")).toBe(true);
		expect(isMetadataAddress("192.0.0.192")).toBe(true);
		expect(isMetadataAddress("fd00:ec2::254")).toBe(true);
		expect(isMetadataAddress("fd00:ec2:0:0:0:0:0:254")).toBe(true);
		expect(isMetadataAddress("10.0.0.5")).toBe(false);
		// fd00:ec2::254 is inside fc00::/7, so the blocklist is what stops it.
		expect(classifyLocalAddress("fd00:ec2::254")).toMatchObject({ family: 6, permitted: false, metadata: true });
	});

	test("recognizes metadata hostnames with or without a trailing dot", () => {
		expect(isMetadataHostname("metadata.google.internal")).toBe(true);
		expect(isMetadataHostname("METADATA.GOOGLE.INTERNAL.")).toBe(true);
		expect(isMetadataHostname("metadata.example.lan")).toBe(false);
	});
});

describe("approved host normalization", () => {
	const expectCode = (entry, code) => {
		try {
			normalizeLocalHost(entry);
		} catch (error) {
			expect(error.code).toBe(code);
			return;
		}
		throw new Error(`Expected ${JSON.stringify(entry)} to be rejected with ${code}`);
	};

	test("accepts loopback, private addresses, localhost, and dotted hostnames", () => {
		expect(normalizeLocalHost(" 127.0.0.1 ")).toBe("127.0.0.1");
		expect(normalizeLocalHost("LOCALHOST")).toBe("localhost");
		expect(normalizeLocalHost("::1")).toBe("::1");
		expect(normalizeLocalHost("[::1]")).toBe("::1");
		expect(normalizeLocalHost("Dev.LAN.")).toBe("dev.lan");
		expect(normalizeLocalHost("192.168.1.20")).toBe("192.168.1.20");
	});

	test("rejects wildcards, ranges, URLs, ports, and single-label names", () => {
		const entries = ["*", "*.lan", "10.0.0.0/8", "http://localhost:3000", "dev.lan:8080", "intranet", "", "   ", "a b.lan", "localhost\\x"];
		for (const entry of entries) expectCode(entry, "LOCAL_HOST_INVALID");
	});

	test("rejects public and link-local addresses and metadata entries", () => {
		for (const entry of ["93.184.216.34", "8.8.8.8", "169.254.1.1", "fe80::1", "::ffff:192.168.1.5"]) {
			expectCode(entry, "LOCAL_HOST_INVALID");
		}
		expectCode("169.254.169.254", "LOCAL_HOST_METADATA");
		expectCode("metadata.google.internal", "LOCAL_HOST_METADATA");
		expectCode("fd00:ec2::254", "LOCAL_HOST_METADATA");
	});
});
