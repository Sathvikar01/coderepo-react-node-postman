import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";
import { cookieRepository } from "./cookie.repository.js";
import { cookieHeaderFor, parseSetCookie } from "./set-cookie.js";

const SESSION_ID = randomUUID();

function parseUrl(url) {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

function warning(code, message) {
	return { code, message };
}

export function createCookieService({
	repository = cookieRepository,
	sessionId = SESSION_ID,
	now = () => Date.now(),
	limit = LIMITS.cookiesPerProfile,
	isStoreReady = () => mongoose.connection.readyState === 1,
} = {}) {
	function ensureStoreReady() {
		if (!isStoreReady()) throw new Error("The cookie store is not connected.");
	}

	async function liveCookies(profileId) {
		ensureStoreReady();
		const timestamp = now();
		await repository.purgeDead(profileId, sessionId, timestamp);
		return repository.list(profileId, sessionId, timestamp);
	}

	// Adds the profile jar's matching cookies to a compiled request. Never throws:
	// a missing cookie store must not stop a send, so it degrades to a warning.
	async function applyToRequest({ profileId, url, headers }) {
		const parsed = parseUrl(url);
		if (!parsed) return { headers, warnings: [], secretValues: [] };
		try {
			const cookies = await liveCookies(profileId);
			const options = {
				host: parsed.hostname,
				path: parsed.pathname || "/",
				secure: parsed.protocol === "https:",
				now: now(),
			};
			const { value, matched, values } = cookieHeaderFor(cookies, options);
			const explicit = headers.find((header) => header.name.toLowerCase() === "cookie");
			if (explicit) {
				return {
					headers,
					warnings: matched.length
						? [
								warning(
									"COOKIE_HEADER_EXPLICIT",
									"This request defines its own Cookie header, so the profile cookie jar was not applied.",
								),
							]
						: [],
					secretValues: [],
				};
			}
			if (!value) return { headers, warnings: [], secretValues: [] };
			if (utf8Bytes(value) > LIMITS.cookieHeaderBytes) {
				return {
					headers,
					warnings: [
						warning("COOKIE_HEADER_LIMIT", "The stored cookies exceed the 8 KiB Cookie header budget; no jar cookies were sent."),
					],
					secretValues: [],
				};
			}
			return {
				headers: [...headers, { name: "Cookie", value }],
				warnings: [],
				secretValues: values,
			};
		} catch {
			return {
				headers,
				warnings: [warning("COOKIE_JAR_UNAVAILABLE", "The profile cookie jar could not be read; this request was sent without stored cookies.")],
				secretValues: [],
			};
		}
	}

	// Stores every Set-Cookie on the response, including redirects, because this
	// client never follows redirects automatically. Failures become warnings.
	async function storeResponseCookies({ profileId, url, responseHeaders }) {
		const parsed = parseUrl(url);
		if (!parsed) return { stored: 0, warnings: [] };
		const headers = (responseHeaders ?? []).filter((header) => header.name.toLowerCase() === "set-cookie");
		if (headers.length === 0) return { stored: 0, warnings: [] };
		const timestamp = now();
		const warnings = [];
		let stored = 0;
		let current = 0;
		try {
			ensureStoreReady();
			current = await repository.count(profileId, sessionId, timestamp);
		} catch {
			return {
				stored: 0,
				warnings: [warning("COOKIE_JAR_UNAVAILABLE", "The profile cookie jar could not be updated; the response cookies were not stored.")],
			};
		}
		for (const header of headers) {
			try {
				const result = parseSetCookie(header.value, { host: parsed.hostname, path: parsed.pathname || "/", now: timestamp });
				if (!result.ok) {
					warnings.push(warning("COOKIE_REJECTED", `A response cookie was rejected: ${result.reason}.`));
					continue;
				}
				const { cookie, action } = result;
				if (action === "delete") {
					await repository.deleteByKey(profileId, cookie);
					stored += 1;
					continue;
				}
				if (current >= limit) {
					warnings.push(warning("COOKIE_LIMIT", `The profile cookie jar is full (${limit}); a response cookie was not stored.`));
					continue;
				}
				await repository.upsert({
					...cookie,
					ownerProfileId: profileId,
					expiresAt: cookie.expiresAt,
					sessionId: cookie.expiresAt ? null : sessionId,
				});
				current += 1;
				stored += 1;
			} catch {
				warnings.push(
					warning("COOKIE_JAR_UNAVAILABLE", "The profile cookie jar could not be updated; some response cookies were not stored."),
				);
				break;
			}
		}
		return { stored, warnings };
	}

	async function list(profileId) {
		const cookies = await liveCookies(profileId);
		return {
			sessionId,
			cookies: cookies.map((cookie) => ({
				id: String(cookie._id),
				name: cookie.name,
				value: cookie.value,
				domain: cookie.domain,
				hostOnly: cookie.hostOnly,
				path: cookie.path,
				secure: cookie.secure,
				httpOnly: cookie.httpOnly,
				session: !cookie.expiresAt,
				expiresAt: cookie.expiresAt ?? null,
				updatedAt: cookie.updatedAt ?? null,
			})),
		};
	}

	async function remove(profileId, cookieId) {
		const removed = await repository.deleteById(profileId, cookieId);
		if (!removed) throw new AppError(404, "COOKIE_NOT_FOUND", "The requested cookie does not exist in this profile jar.");
		return { id: String(removed._id) };
	}

	async function clear(profileId) {
		const result = await repository.clear(profileId);
		return { removed: result?.deletedCount ?? 0 };
	}

	return { applyToRequest, storeResponseCookies, list, remove, clear };
}

export const cookieService = createCookieService();
