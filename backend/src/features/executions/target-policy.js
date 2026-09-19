import { AppError } from "../../shared/errors/app-error.js";
import { classifyAddress } from "./address-policy.js";
import { dnsResolver } from "./address-resolver.js";

export const POLICY_VERSION = "1.0";
const DEMO_HOST = "127.0.0.1";
const DEMO_PORT = 8000;
const DEMO_PATH = /^\/demo\/v1\/[A-Za-z0-9_\-/]*$/;

const AUTHORITY = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)(?:([^/?#]*))?/;

function rawAuthority(raw) {
	const match = AUTHORITY.exec(raw.trim());
	return match?.[2] ?? "";
}

function rawHostOf(raw) {
	const authority = rawAuthority(raw);
	if (!authority) return "";
	const withoutUser = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
	if (withoutUser.startsWith("[")) {
		const closing = withoutUser.indexOf("]");
		return closing === -1 ? withoutUser : withoutUser.slice(0, closing + 1);
	}
	const colon = withoutUser.indexOf(":");
	return colon === -1 ? withoutUser : withoutUser.slice(0, colon);
}

export function isAmbiguousNumericHost(host) {
	if (!host) return false;
	if (/^\[.*\]$/.test(host)) return false;
	const bare = host;
	if (/^\d+$/.test(bare)) return true;
	if (/^0[xX][0-9a-fA-F]+$/.test(bare)) return true;
	if (/^0[0-7]+(\.0[0-7]+)*$/.test(bare)) return true;
	if (/^\d+(\.\d+){1,3}$/.test(bare)) return bare.split(".").some((part) => part.length > 1 && part.startsWith("0"));
	return false;
}

function isRejectedHostname(hostname) {
	const lower = hostname.toLowerCase();
	if (!lower.includes(".")) return true;
	if (lower === "localhost" || lower.endsWith(".localhost")) return true;
	if (lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".home.arpa")) return true;
	return false;
}

export function createTargetPolicy({ resolver = dnsResolver } = {}) {
	return {
		async validate(rawUrl, { allowLocalDemo = false } = {}) {
			const raw = String(rawUrl ?? "").trim();
			if (!raw) throw new AppError(400, "URL_INVALID", "Provide an absolute HTTP or HTTPS URL.");
			const rawHost = rawHostOf(raw);
			const rawPath = raw.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, "").split(/[?#]/)[0] ?? "";
			if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(rawPath))
				throw new AppError(400, "TARGET_BLOCKED", "Dot segments and encoded path separators are not permitted.");
			if (raw.includes("@")) throw new AppError(400, "URL_USERINFO", "URLs cannot contain user information.");
			if (isAmbiguousNumericHost(rawHost))
				throw new AppError(400, "URL_AMBIGUOUS_HOST", "Provide the host as a dotted-decimal address or a DNS name.");
			if (rawHost.includes("%")) throw new AppError(400, "URL_INVALID", "Zone identifiers are not supported.");

			let url;
			try {
				url = new URL(raw);
			} catch {
				throw new AppError(400, "URL_INVALID", "Provide an absolute HTTP or HTTPS URL.");
			}
			if (url.username || url.password) throw new AppError(400, "URL_USERINFO", "URLs cannot contain user information.");
			if (url.hash) throw new AppError(400, "URL_FRAGMENT", "URLs cannot contain fragments.");
			if (!["http:", "https:"].includes(url.protocol))
				throw new AppError(400, "URL_SCHEME", "Only HTTP and HTTPS targets are supported.");
			if (!url.hostname) throw new AppError(400, "URL_INVALID", "Provide an absolute HTTP or HTTPS URL.");

			const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
			if (!Number.isInteger(port) || port < 1 || port > 65535)
				throw new AppError(400, "URL_PORT", "Provide an explicit port between 1 and 65535.");

			const hostname = url.hostname.replace(/^\[|\]$/g, "");
			const literal = classifyAddress(hostname);
			const isIpLiteral = literal.family !== 0;

			if (
				isIpLiteral &&
				allowLocalDemo &&
				hostname === DEMO_HOST &&
				port === DEMO_PORT &&
				url.protocol === "http:" &&
				isDemoPath(url.pathname)
			) {
				return {
					scheme: url.protocol.slice(0, -1),
					originalHostname: hostname,
					authority: url.host,
					port,
					pathAndQuery: `${url.pathname}${url.search}`,
					ip: hostname,
					family: 4,
					isIpLiteral: true,
					policyVersion: POLICY_VERSION,
					local: true,
				};
			}

			if (!isIpLiteral && isRejectedHostname(hostname)) throw new AppError(400, "TARGET_BLOCKED", "This hostname is not permitted.");

			const candidates = isIpLiteral ? [{ address: hostname, family: literal.family }] : await resolver.resolve(hostname);
			const unique = new Map();
			for (const candidate of candidates ?? []) {
				if (!candidate?.address) continue;
				unique.set(candidate.address, candidate);
			}
			if (unique.size === 0) throw new AppError(502, "TARGET_UNRESOLVED", "The target hostname could not be resolved.");
			for (const candidate of unique.values()) {
				const classification = classifyAddress(candidate.address);
				if (classification.family === 0 || classification.denied) {
					throw new AppError(400, "TARGET_BLOCKED", "The target resolves to an address that is not permitted.", {
						address: candidate.address,
					});
				}
			}
			const chosen = [...unique.values()][0];
			return {
				scheme: url.protocol.slice(0, -1),
				originalHostname: hostname,
				authority: url.host,
				port,
				pathAndQuery: `${url.pathname}${url.search}`,
				ip: chosen.address,
				family: chosen.family === 6 ? 6 : 4,
				isIpLiteral,
				policyVersion: POLICY_VERSION,
				local: false,
			};
		},
	};
}

export function isDemoPath(pathname) {
	if (!DEMO_PATH.test(pathname)) return false;
	const segments = pathname.split("/");
	return !segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\") || segment.includes("%"));
}
