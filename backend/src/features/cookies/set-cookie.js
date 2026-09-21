import net from "node:net";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

// RFC 6265 does not list public suffixes; browsers consult the Public Suffix List.
// This is a bounded denylist of common single- and multi-label public suffixes so a
// Domain attribute cannot attach a cookie to an entire registry-controlled zone.
const PUBLIC_SUFFIXES = new Set([
	"com",
	"net",
	"org",
	"edu",
	"gov",
	"mil",
	"int",
	"io",
	"co",
	"dev",
	"app",
	"ai",
	"info",
	"biz",
	"me",
	"tv",
	"xyz",
	"uk",
	"us",
	"de",
	"fr",
	"jp",
	"cn",
	"in",
	"au",
	"ca",
	"br",
	"ru",
	"nl",
	"it",
	"es",
	"se",
	"no",
	"fi",
	"ch",
	"at",
	"be",
	"pl",
	"co.uk",
	"org.uk",
	"ac.uk",
	"gov.uk",
	"com.au",
	"net.au",
	"org.au",
	"co.jp",
	"or.jp",
	"ne.jp",
	"com.br",
	"com.cn",
	"github.io",
	"pages.dev",
	"vercel.app",
	"netlify.app",
	"herokuapp.com",
	"azurewebsites.net",
	"cloudfront.net",
	"amazonaws.com",
	"firebaseapp.com",
	"web.app",
	"onrender.com",
	"fly.dev",
	"workers.dev",
	"blogspot.com",
	"wordpress.com",
]);

export function normalizeHost(host) {
	let value = String(host ?? "").trim().toLowerCase();
	if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
	if (value.endsWith(".") && value.length > 1) value = value.slice(0, -1);
	return value;
}

export function isIpLiteral(host) {
	return net.isIP(normalizeHost(host)) !== 0;
}

function epoch(value) {
	if (value === null || value === undefined) return null;
	const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isFinite(millis) ? millis : null;
}

export function defaultCookiePath(pathname) {
	const value = String(pathname ?? "");
	if (!value.startsWith("/")) return "/";
	const lastSlash = value.lastIndexOf("/");
	return lastSlash <= 0 ? "/" : value.slice(0, lastSlash);
}

export function domainMatchesHost(host, domain) {
	const normalizedHost = normalizeHost(host);
	const normalizedDomain = normalizeHost(domain);
	return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

export function pathMatches(requestPath, cookiePath) {
	const target = String(requestPath ?? "/");
	const scope = String(cookiePath ?? "/");
	if (target === scope) return true;
	if (!target.startsWith(scope)) return false;
	return scope.endsWith("/") || target[scope.length] === "/";
}

export function isPublicSuffix(domain) {
	const value = normalizeHost(domain);
	if (!value.includes(".")) return true;
	return PUBLIC_SUFFIXES.has(value);
}

export function cookieMatches(cookie, { host, path, secure, now = Date.now() }) {
	const expiresAt = epoch(cookie.expiresAt);
	if (expiresAt !== null && expiresAt <= now) return false;
	if (cookie.secure && !secure) return false;
	if (!domainMatchesHost(host, cookie.domain)) return false;
	if (cookie.hostOnly && normalizeHost(host) !== normalizeHost(cookie.domain)) return false;
	return pathMatches(path, cookie.path);
}

// RFC 6265 5.4: longer paths first, then earlier creation time; name keeps ordering
// deterministic when two cookies were created within the same millisecond.
export function orderCookies(cookies) {
	return [...cookies].sort(
		(left, right) =>
			String(right.path ?? "/").length - String(left.path ?? "/").length ||
			(epoch(left.createdAt) ?? 0) - (epoch(right.createdAt) ?? 0) ||
			String(left.name).localeCompare(String(right.name)),
	);
}

export function cookieHeaderFor(cookies, options) {
	const matched = orderCookies(cookies.filter((cookie) => cookieMatches(cookie, options)));
	if (matched.length === 0) return { value: null, matched, values: [] };
	return {
		value: matched.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
		matched,
		values: matched.map((cookie) => cookie.value).filter(Boolean),
	};
}

function reject(reason) {
	return { ok: false, reason };
}

// Parses one Set-Cookie header value. Malformed attribute values fail closed: the
// cookie is rejected instead of stored with a guessed domain, path, or expiry.
export function parseSetCookie(headerValue, { host, path, now = Date.now() } = {}) {
	const requestHost = normalizeHost(host);
	const raw = String(headerValue ?? "");
	if (CONTROL.test(raw)) return reject("control_characters");
	const segments = raw.split(";");
	const first = segments.shift() ?? "";
	const separator = first.indexOf("=");
	if (separator <= 0) return reject("name_invalid");
	const name = first.slice(0, separator).trim();
	const value = first.slice(separator + 1).trim();
	if (!TOKEN.test(name) || name.startsWith("$")) return reject("name_invalid");
	if (utf8Bytes(name) + utf8Bytes(value) > LIMITS.cookieBytes) return reject("size_limit");
	if (value.includes("\r") || value.includes("\n")) return reject("value_invalid");

	let domain = null;
	let hostOnly = true;
	let cookiePath = null;
	let secure = false;
	let httpOnly = false;
	let expiresAt = null;
	let hasExpiry = false;
	let maxAgeSeconds = null;

	for (const segment of segments) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		const index = trimmed.indexOf("=");
		const attribute = (index === -1 ? trimmed : trimmed.slice(0, index)).trim().toLowerCase();
		const attributeValue = index === -1 ? null : trimmed.slice(index + 1).trim();
		if (attribute === "domain") {
			if (!attributeValue) return reject("domain_invalid");
			const candidate = attributeValue.toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
			if (!HOSTNAME.test(candidate)) return reject("domain_invalid");
			if (isIpLiteral(requestHost)) return reject("domain_ip_literal");
			if (!domainMatchesHost(requestHost, candidate)) return reject("domain_mismatch");
			if (isPublicSuffix(candidate)) return reject("public_suffix");
			domain = candidate;
			hostOnly = false;
		} else if (attribute === "path") {
			if (!attributeValue || !attributeValue.startsWith("/") || utf8Bytes(attributeValue) > LIMITS.cookiePathBytes)
				return reject("path_invalid");
			cookiePath = attributeValue;
		} else if (attribute === "max-age") {
			if (!attributeValue || !/^-?\d+$/.test(attributeValue)) return reject("max_age_invalid");
			const seconds = Number(attributeValue);
			if (!Number.isSafeInteger(seconds)) return reject("max_age_invalid");
			maxAgeSeconds = seconds;
		} else if (attribute === "expires") {
			if (!attributeValue) return reject("expires_invalid");
			const parsed = Date.parse(attributeValue);
			if (Number.isNaN(parsed)) return reject("expires_invalid");
			expiresAt = parsed;
			hasExpiry = true;
		} else if (attribute === "secure") {
			if (attributeValue !== null) return reject("secure_invalid");
			secure = true;
		} else if (attribute === "httponly") {
			if (attributeValue !== null) return reject("httponly_invalid");
			httpOnly = true;
		} else if (!attribute) {
			return reject("attribute_invalid");
		}
		// samesite, partitioned, and unknown attributes are ignored per RFC 6265.
	}

	if (maxAgeSeconds !== null) {
		expiresAt = now + maxAgeSeconds * 1000;
		hasExpiry = true;
	}
	if (hasExpiry && !Number.isFinite(expiresAt)) return reject("expires_invalid");

	const cookie = {
		name,
		value,
		domain: domain ?? requestHost,
		hostOnly,
		path: cookiePath ?? defaultCookiePath(path),
		secure,
		httpOnly,
		expiresAt: hasExpiry ? new Date(expiresAt) : null,
	};
	if (hasExpiry && expiresAt <= now) return { ok: true, action: "delete", cookie };
	return { ok: true, action: "store", cookie };
}
