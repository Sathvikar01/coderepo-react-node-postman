import net from "node:net";
import { AppError } from "../../shared/errors/app-error.js";

// Local Runtime is a separate, explicit, profile-scoped opt-in. It never
// widens the default target policy: it only classifies the addresses that the
// approved-host list is allowed to dial, and the cloud metadata blocklist
// always wins over any range match.
const IPV4_LOCAL = [
	["127.0.0.0", 8],
	["10.0.0.0", 8],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
];

const METADATA_IPV4 = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "192.0.0.192"]);
const METADATA_IPV6 = new Set(["fd00:ec2::254"]);

export const METADATA_HOSTNAMES = new Set([
	"metadata.google.internal",
	"metadata.goog",
	"metadata.tencentyun.com",
]);

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function ipv4ToNumber(address) {
	const parts = address.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
	return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function inIpv4Range(address, [base, bits]) {
	const value = ipv4ToNumber(address);
	const baseValue = ipv4ToNumber(base);
	if (value === null || baseValue === null) return false;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (value & mask) >>> 0 === (baseValue & mask) >>> 0;
}

// WHATWG URL canonicalizes IPv6 literals (lowercase, compressed, embedded IPv4
// rewritten as hex), which makes range and blocklist comparison reliable.
function canonicalIpv6(address) {
	try {
		return new URL(`http://[${address}]/`).hostname.slice(1, -1);
	} catch {
		return null;
	}
}

function ipv6ToBigInt(address) {
	const canonical = canonicalIpv6(address);
	if (!canonical) return null;
	const [head, tail = ""] = canonical.split("::");
	const headGroups = head ? head.split(":") : [];
	const tailGroups = tail ? tail.split(":") : [];
	const fill = 8 - headGroups.length - tailGroups.length;
	if (fill < 0) return null;
	const groups = [...headGroups, ...Array(fill).fill("0"), ...tailGroups];
	let value = 0n;
	for (const group of groups) {
		const parsed = Number.parseInt(group || "0", 16);
		if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) return null;
		value = (value << 16n) | BigInt(parsed);
	}
	return value;
}

export function isMetadataAddress(address) {
	if (net.isIPv4(address)) return METADATA_IPV4.has(address);
	if (net.isIPv6(address)) {
		const canonical = canonicalIpv6(address);
		return canonical !== null && METADATA_IPV6.has(canonical);
	}
	return false;
}

export function isMetadataHostname(hostname) {
	return METADATA_HOSTNAMES.has(String(hostname ?? "").toLowerCase().replace(/\.$/, ""));
}

export function classifyLocalAddress(address) {
	if (net.isIPv4(address)) {
		const metadata = METADATA_IPV4.has(address);
		const permitted = !metadata && IPV4_LOCAL.some((range) => inIpv4Range(address, range));
		return { family: 4, permitted, metadata };
	}
	if (net.isIPv6(address)) {
		const canonical = canonicalIpv6(address);
		if (!canonical) return { family: 6, permitted: false, metadata: false };
		const metadata = METADATA_IPV6.has(canonical);
		const value = ipv6ToBigInt(canonical);
		if (value === null) return { family: 6, permitted: false, metadata };
		const loopback = value === 1n;
		const uniqueLocal = value >> 121n === 0x7en;
		return { family: 6, permitted: !metadata && (loopback || uniqueLocal), metadata };
	}
	return { family: 0, permitted: false, metadata: false };
}

// Returns the normalized host to store, or throws for anything that is not an
// exact loopback/private target. Wildcards, CIDR ranges, ports, and URLs are
// never approved.
export function normalizeLocalHost(raw) {
	const value = String(raw ?? "").trim().toLowerCase();
	const fail = (code, message) => {
		throw new AppError(400, code, message);
	};
	if (!value) fail("LOCAL_HOST_INVALID", "Enter a hostname or IP address to approve.");
	if (value.length > 253) fail("LOCAL_HOST_INVALID", "Approved hosts must be 253 characters or fewer.");
	let host = value;
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (/[\s/*@?#]/.test(host) || host.includes("://") || host.includes("\\"))
		fail(
			"LOCAL_HOST_INVALID",
			"Approve one exact host. Wildcards, CIDR ranges, ports, and URLs are not allowed.",
		);
	if (host.endsWith(".")) host = host.slice(0, -1);
	if (isMetadataHostname(host)) fail("LOCAL_HOST_METADATA", "Cloud metadata endpoints can never be approved.");
	if (net.isIP(host)) {
		const classification = classifyLocalAddress(host);
		if (classification.metadata) fail("LOCAL_HOST_METADATA", "Cloud metadata endpoints can never be approved.");
		if (!classification.permitted) fail("LOCAL_HOST_INVALID", "Only loopback and private LAN addresses can be approved.");
		return host;
	}
	if (host === "localhost") return host;
	if (!HOSTNAME.test(host))
		fail("LOCAL_HOST_INVALID", "Use a dotted hostname (for example dev.lan) or an IP address.");
	return host;
}
