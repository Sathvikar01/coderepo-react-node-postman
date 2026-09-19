import net from "node:net";

const IPV4_DENY = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

const IPV6_DENY = [
	["::", 128],
	["::1", 128],
	["100::", 64],
	["2001:2::", 48],
	["2001:10::", 28],
	["2001:db8::", 32],
	["2001::", 32],
	["2002::", 16],
	["3fff::", 20],
	["5f00::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
	["64:ff9b::", 96],
];

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

function expandIpv6(address) {
	let text = address;
	const zoneIndex = text.indexOf("%");
	if (zoneIndex !== -1) text = text.slice(0, zoneIndex);
	const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	if (mapped) return { mappedIpv4: mapped[1] };
	const compatible = text.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
	if (compatible) return { mappedIpv4: compatible[1] };
	const nat64Hex = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(text);
	if (nat64Hex) {
		const high = Number.parseInt(nat64Hex[1], 16);
		const low = Number.parseInt(nat64Hex[2], 16);
		return { mappedIpv4: `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}` };
	}
	const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(text);
	if (mappedHex) {
		const high = Number.parseInt(mappedHex[1], 16);
		const low = Number.parseInt(mappedHex[2], 16);
		return { mappedIpv4: `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}` };
	}
	const sixToFour = text.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
	if (sixToFour) {
		const high = Number.parseInt(sixToFour[1], 16);
		const low = Number.parseInt(sixToFour[2], 16);
		return { mappedIpv4: `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}` };
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
	if (groups.length !== 8) return null;
	const parsed = groups.map((group) => Number.parseInt(group || "0", 16));
	if (parsed.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
	return { groups: parsed };
}

export function classifyAddress(address) {
	const family = net.isIP(address);
	if (family === 4) return { family: 4, denied: IPV4_DENY.some((range) => inIpv4Range(address, range)), mappedIpv4: null };
	if (family !== 6) return { family: 0, denied: true, mappedIpv4: null };
	const expanded = expandIpv6(address);
	if (!expanded) return { family: 6, denied: true, mappedIpv4: null };
	if (expanded.mappedIpv4) {
		const mappedDenied = IPV4_DENY.some((range) => inIpv4Range(expanded.mappedIpv4, range));
		return { family: 6, denied: mappedDenied, mappedIpv4: expanded.mappedIpv4 };
	}
	const groups = expanded.groups;
	// IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) hex forms embed an IPv4 address.
	const zeroPrefix = groups.slice(0, 5).every((group) => group === 0);
	const nat64Prefix = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
	if ((zeroPrefix && groups[5] === 0xffff) || nat64Prefix) {
		const embedded = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
		const embeddedDenied = IPV4_DENY.some((range) => inIpv4Range(embedded, range));
		return { family: 6, denied: embeddedDenied, mappedIpv4: embedded };
	}
	const denied = IPV6_DENY.some(([base, bits]) => {
		const baseExpanded = expandIpv6(base);
		if (!baseExpanded?.groups) return false;
		const fullGroups = Math.floor(bits / 16);
		const remainder = bits % 16;
		for (let index = 0; index < fullGroups; index += 1) if (groups[index] !== baseExpanded.groups[index]) return false;
		if (remainder === 0) return true;
		const mask = (0xffff << (16 - remainder)) & 0xffff;
		return (groups[fullGroups] & mask) === (baseExpanded.groups[fullGroups] & mask);
	});
	return { family: 6, denied, mappedIpv4: null };
}

export const isDeniedAddress = (address) => classifyAddress(address).denied;
