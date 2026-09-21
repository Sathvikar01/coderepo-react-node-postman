import { describe, expect, test } from "bun:test";
import { createCookieService } from "./cookie.service.js";

const NOW = Date.UTC(2026, 8, 21, 6, 0, 0);

function fakeRepository() {
	const rows = new Map();
	let sequence = 0;
	const keyOf = (owner, cookie) => `${owner}|${cookie.name}|${cookie.domain}|${cookie.path}`;
	const isLive = (row, sessionId, now) =>
		row.expiresAt !== null && row.expiresAt !== undefined
			? new Date(row.expiresAt).getTime() > now
			: row.sessionId === sessionId;
	return {
		rows,
		async purgeDead(owner, sessionId, now) {
			for (const [key, row] of rows) {
				if (row.ownerProfileId === owner && !isLive(row, sessionId, now)) rows.delete(key);
			}
		},
		async list(owner, sessionId, now) {
			return [...rows.values()]
				.filter((row) => row.ownerProfileId === owner && isLive(row, sessionId, now))
				.map((row) => structuredClone(row));
		},
		async count(owner, sessionId, now) {
			return (await this.list(owner, sessionId, now)).length;
		},
		async upsert(entry) {
			const cookie = structuredClone(entry);
			const key = keyOf(entry.ownerProfileId, entry);
			const existing = rows.get(key);
			const stored = {
				...cookie,
				_id: existing?._id ?? `id-${(sequence += 1)}`,
				createdAt: existing?.createdAt ?? new Date(NOW + sequence),
				updatedAt: new Date(NOW + sequence),
			};
			rows.set(key, stored);
			return structuredClone(stored);
		},
		async deleteByKey(owner, { name, domain, path }) {
			return { deletedCount: rows.delete(keyOf(owner, { name, domain, path })) ? 1 : 0 };
		},
		async deleteById(owner, id) {
			for (const [key, row] of rows) {
				if (row.ownerProfileId === owner && row._id === id) {
					rows.delete(key);
					return structuredClone(row);
				}
			}
			return null;
		},
		async clear(owner) {
			let deletedCount = 0;
			for (const [key, row] of rows) {
				if (row.ownerProfileId === owner) {
					rows.delete(key);
					deletedCount += 1;
				}
			}
			return { deletedCount };
		},
	};
}

function makeJar({ sessionId = "session-a", limit = 200, clock = { value: NOW } } = {}) {
	const repository = fakeRepository();
	const service = createCookieService({
		repository,
		sessionId,
		limit,
		now: () => clock.value,
		isStoreReady: () => true,
	});
	return { repository, service, clock };
}

const setCookie = (value) => ({ name: "Set-Cookie", value });

describe("cookie service", () => {
	test("stores a response cookie and sends it to the next matching request", async () => {
		const { service } = makeJar();
		await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/login",
			responseHeaders: [setCookie("sid=abc123; Path=/")],
		});
		const applied = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/profile", headers: [] });
		expect(applied.headers).toEqual([{ name: "Cookie", value: "sid=abc123" }]);
		expect(applied.secretValues).toEqual(["abc123"]);
	});

	test("stores every Set-Cookie header from one response", async () => {
		const { service } = makeJar();
		await service.storeResponseCookies({
			profileId: "p1",
			url: "https://api.demo.test/login",
			responseHeaders: [setCookie("sid=1; Path=/"), setCookie("theme=dark; Path=/app; Secure")],
		});
		const root = await service.applyToRequest({ profileId: "p1", url: "https://api.demo.test/x", headers: [] });
		expect(root.headers.at(-1).value).toBe("sid=1");
		const app = await service.applyToRequest({ profileId: "p1", url: "https://api.demo.test/app/settings", headers: [] });
		expect(app.headers.at(-1).value).toBe("theme=dark; sid=1");
	});

	test("replaces a cookie with the same name, domain, and path", async () => {
		const { service } = makeJar();
		const store = (value) =>
			service.storeResponseCookies({ profileId: "p1", url: "http://api.demo.test/", responseHeaders: [setCookie(`sid=${value}; Path=/`)] });
		await store("one");
		await store("two");
		const listed = await service.list("p1");
		expect(listed.cookies).toHaveLength(1);
		expect(listed.cookies[0].value).toBe("two");
	});

	test("duplicate names with different paths are both sent, longest path first", async () => {
		const { service } = makeJar();
		await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/",
			responseHeaders: [setCookie("token=root; Path=/"), setCookie("token=deep; Path=/app")],
		});
		const applied = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/app/items", headers: [] });
		expect(applied.headers.at(-1).value).toBe("token=deep; token=root");
		const rootOnly = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/other", headers: [] });
		expect(rootOnly.headers.at(-1).value).toBe("token=root");
	});

	test("Max-Age=0 deletes an existing cookie", async () => {
		const { service } = makeJar();
		await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/",
			responseHeaders: [setCookie("sid=abc; Path=/")],
		});
		const stored = await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/logout",
			responseHeaders: [setCookie("sid=; Path=/; Max-Age=0")],
		});
		expect(stored.stored).toBe(1);
		const applied = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/", headers: [] });
		expect(applied.headers).toEqual([]);
	});

	test("an already expired cookie is not sent and is purged", async () => {
		const { service, clock } = makeJar();
		await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/",
			responseHeaders: [setCookie("sid=abc; Path=/; Max-Age=60")],
		});
		clock.value = NOW + 61_000;
		const applied = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/", headers: [] });
		expect(applied.headers).toEqual([]);
		const listed = await service.list("p1");
		expect(listed.cookies).toEqual([]);
	});

	test("host-only cookies stay on one host while domain cookies reach subdomains", async () => {
		const { service } = makeJar();
		await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/",
			responseHeaders: [setCookie("hostonly=1; Path=/"), setCookie("shared=1; Path=/; Domain=demo.test")],
		});
		const same = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/", headers: [] });
		expect(same.headers.at(-1).value).toBe("hostonly=1; shared=1");
		const sub = await service.applyToRequest({ profileId: "p1", url: "http://cdn.demo.test/", headers: [] });
		expect(sub.headers.at(-1).value).toBe("shared=1");
		const unrelated = await service.applyToRequest({ profileId: "p1", url: "http://demo.test.evil/", headers: [] });
		expect(unrelated.headers).toEqual([]);
	});

	test("a Secure cookie is not sent over HTTP", async () => {
		const { service } = makeJar();
		await service.storeResponseCookies({
			profileId: "p1",
			url: "https://api.demo.test/",
			responseHeaders: [setCookie("sid=abc; Path=/; Secure")],
		});
		const insecure = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/", headers: [] });
		expect(insecure.headers).toEqual([]);
		const secure = await service.applyToRequest({ profileId: "p1", url: "https://api.demo.test/", headers: [] });
		expect(secure.headers).toEqual([{ name: "Cookie", value: "sid=abc" }]);
	});

	test("path scoping never sends a cookie outside its path", async () => {
		const { service } = makeJar();
		await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/admin/panel",
			responseHeaders: [setCookie("scope=admin; Path=/admin")],
		});
		const inside = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/admin/settings", headers: [] });
		expect(inside.headers).toHaveLength(1);
		const boundary = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/administrator", headers: [] });
		expect(boundary.headers).toEqual([]);
		const outside = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/profile", headers: [] });
		expect(outside.headers).toEqual([]);
	});

	test("an explicit Cookie header wins over the jar and warns", async () => {
		const { service } = makeJar();
		await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/",
			responseHeaders: [setCookie("sid=abc; Path=/")],
		});
		const manual = [{ name: "Cookie", value: "manual=1" }];
		const applied = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/", headers: manual });
		expect(applied.headers).toBe(manual);
		expect(applied.warnings.map((entry) => entry.code)).toEqual(["COOKIE_HEADER_EXPLICIT"]);
	});

	test("an explicit Cookie header that matches nothing stays quiet", async () => {
		const { service } = makeJar();
		const applied = await service.applyToRequest({
			profileId: "p1",
			url: "http://api.demo.test/",
			headers: [{ name: "Cookie", value: "manual=1" }],
		});
		expect(applied.headers).toHaveLength(1);
		expect(applied.warnings).toEqual([]);
	});

	test("profiles never share cookies", async () => {
		const { service } = makeJar();
		await service.storeResponseCookies({
			profileId: "a",
			url: "http://api.demo.test/",
			responseHeaders: [setCookie("sid=profile-a; Path=/")],
		});
		const other = await service.applyToRequest({ profileId: "b", url: "http://api.demo.test/", headers: [] });
		expect(other.headers).toEqual([]);
		const mine = await service.applyToRequest({ profileId: "a", url: "http://api.demo.test/", headers: [] });
		expect(mine.headers).toEqual([{ name: "Cookie", value: "sid=profile-a" }]);
		await service.clear("b");
		expect((await service.list("a")).cookies).toHaveLength(1);
	});

	test("session cookies end with the session while persistent cookies survive a restart", async () => {
		const repository = fakeRepository();
		const clock = { value: NOW };
		const first = createCookieService({ repository, sessionId: "session-a", now: () => clock.value, isStoreReady: () => true });
		await first.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/",
			responseHeaders: [setCookie("session=1; Path=/"), setCookie("persistent=2; Path=/; Max-Age=3600")],
		});
		const restarted = createCookieService({ repository, sessionId: "session-b", now: () => clock.value, isStoreReady: () => true });
		const applied = await restarted.applyToRequest({ profileId: "p1", url: "http://api.demo.test/", headers: [] });
		expect(applied.headers).toEqual([{ name: "Cookie", value: "persistent=2" }]);
		expect((await restarted.list("p1")).cookies.map((cookie) => [cookie.name, cookie.session])).toEqual([["persistent", false]]);
	});

	test("malformed response cookies are rejected with a warning and no value leak", async () => {
		const { service } = makeJar();
		const result = await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/",
			responseHeaders: [setCookie("bad name=secret-value; Path=/"), setCookie("sid=ok; Path=/")],
		});
		expect(result.stored).toBe(1);
		expect(result.warnings.map((entry) => entry.code)).toEqual(["COOKIE_REJECTED"]);
		expect(JSON.stringify(result.warnings)).not.toContain("secret-value");
		expect((await service.list("p1")).cookies.map((cookie) => cookie.name)).toEqual(["sid"]);
	});

	test("a full jar refuses new cookies with a warning", async () => {
		const { service } = makeJar({ limit: 1 });
		const result = await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/",
			responseHeaders: [setCookie("a=1; Path=/"), setCookie("b=2; Path=/")],
		});
		expect(result.stored).toBe(1);
		expect(result.warnings.map((entry) => entry.code)).toEqual(["COOKIE_LIMIT"]);
	});

	test("an unavailable store degrades to warnings instead of failing a send", async () => {
		const repository = fakeRepository();
		const service = createCookieService({ repository, sessionId: "s", now: () => NOW, isStoreReady: () => false });
		const applied = await service.applyToRequest({ profileId: "p1", url: "http://api.demo.test/", headers: [] });
		expect(applied.warnings.map((entry) => entry.code)).toEqual(["COOKIE_JAR_UNAVAILABLE"]);
		const stored = await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/",
			responseHeaders: [setCookie("sid=1; Path=/")],
		});
		expect(stored.stored).toBe(0);
		expect(stored.warnings.map((entry) => entry.code)).toEqual(["COOKIE_JAR_UNAVAILABLE"]);
	});

	test("lists, removes one cookie, and clears the jar", async () => {
		const { service } = makeJar();
		await service.storeResponseCookies({
			profileId: "p1",
			url: "http://api.demo.test/",
			responseHeaders: [setCookie("a=1; Path=/"), setCookie("b=2; Path=/app")],
		});
		const listed = await service.list("p1");
		expect(listed.cookies.map((cookie) => cookie.name).sort()).toEqual(["a", "b"]);
		await service.remove("p1", listed.cookies[0].id);
		expect((await service.list("p1")).cookies.map((cookie) => cookie.name)).toEqual(["b"]);
		let missingError = null;
		try {
			await service.remove("p1", "000000000000000000000000");
		} catch (error) {
			missingError = error;
		}
		expect(missingError).toMatchObject({ statusCode: 404, code: "COOKIE_NOT_FOUND" });
		await service.clear("p1");
		expect((await service.list("p1")).cookies).toEqual([]);
	});
});
