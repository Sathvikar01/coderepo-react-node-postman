import { describe, expect, test } from "bun:test";
import { classifyAddress, isDeniedAddress } from "./address-policy.js";

describe("address policy", () => {
	const denied = [
		"127.0.0.1",
		"0.0.0.0",
		"169.254.169.254",
		"10.1.2.3",
		"172.16.5.4",
		"192.168.1.1",
		"100.64.0.1",
		"198.18.0.1",
		"224.0.0.1",
		"255.255.255.255",
		"::1",
		"::",
		"fd00:ec2::254",
		"fe80::1",
		"ff02::1",
		"::ffff:127.0.0.1",
		"64:ff9b::7f00:1",
		"2002:7f00:1::",
		"2001:db8::1",
	];
	const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:0808:0808::"];
	for (const address of denied) {
		test(`denies ${address}`, () => expect(isDeniedAddress(address)).toBe(true));
	}
	for (const address of allowed) {
		test(`permits ${address}`, () => expect(isDeniedAddress(address)).toBe(false));
	}
	test("classifies a mapped IPv4 literal", () => {
		expect(classifyAddress("::ffff:10.0.0.1")).toMatchObject({ family: 6, denied: true, mappedIpv4: "10.0.0.1" });
	});
	test("unknown input is treated as denied", () => {
		expect(isDeniedAddress("not-an-address")).toBe(true);
	});
});
