import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { createOperationRegistry } from "../executions/active-registry.js";
import { createExecutionService } from "../executions/execution.service.js";
import { createCookieService } from "./cookie.service.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_cookie_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "cookie-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "cookie-test-jwt-secret";

beforeAll(() => {
	initConfig();
});

function fakeHistory() {
	const records = new Map();
	const keyOf = (profileId, executionId) => `${profileId}:${executionId}`;
	return {
		records,
		async get(profileId, executionId) {
			const record = records.get(keyOf(profileId, executionId));
			return record ? structuredClone(record) : null;
		},
		async admit(entry) {
			records.set(keyOf(entry.ownerProfileId, entry.executionId), structuredClone(entry));
			return structuredClone(entry);
		},
		async finalize(profileId, executionId, update) {
			const key = keyOf(profileId, executionId);
			const record = records.get(key);
			if (!record || record.status !== "running") return null;
			const next = { ...record, ...update, status: "terminal" };
			for (const [path, value] of Object.entries(update)) {
				if (!path.includes(".")) continue;
				delete next[path];
				const [head, ...rest] = path.split(".");
				next[head] = { ...(next[head] ?? {}) };
				let cursor = next[head];
				while (rest.length > 1) {
					const segment = rest.shift();
					cursor[segment] = { ...(cursor[segment] ?? {}) };
					cursor = cursor[segment];
				}
				cursor[rest[0]] = value;
			}
			records.set(key, next);
			return structuredClone(next);
		},
		async reconcileStale() {
			return null;
		},
	};
}

function fakeCookieRepository() {
	const rows = new Map();
	let sequence = 0;
	const keyOf = (owner, cookie) => `${owner}|${cookie.name}|${cookie.domain}|${cookie.path}`;
	const isLive = (row, sessionId, now) =>
		row.expiresAt !== null && row.expiresAt !== undefined ? new Date(row.expiresAt).getTime() > now : row.sessionId === sessionId;
	const list = (owner, sessionId, now) =>
		[...rows.values()].filter((row) => row.ownerProfileId === owner && isLive(row, sessionId, now));
	return {
		async purgeDead(owner, sessionId, now) {
			for (const [key, row] of rows) if (row.ownerProfileId === owner && !isLive(row, sessionId, now)) rows.delete(key);
		},
		async list(owner, sessionId, now) {
			return list(owner, sessionId, now).map((row) => structuredClone(row));
		},
		async count(owner, sessionId, now) {
			return list(owner, sessionId, now).length;
		},
		async upsert(entry) {
			const key = keyOf(entry.ownerProfileId, entry);
			const existing = rows.get(key);
			const stored = {
				...structuredClone(entry),
				_id: existing?._id ?? `id-${(sequence += 1)}`,
				createdAt: existing?.createdAt ?? new Date(sequence),
				updatedAt: new Date(sequence),
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

function target(url) {
	const parsed = new URL(url);
	return {
		scheme: parsed.protocol.slice(0, -1),
		originalHostname: parsed.hostname,
		authority: parsed.hostname,
		port: parsed.protocol === "https:" ? 443 : 80,
		pathAndQuery: `${parsed.pathname}${parsed.search}`,
		ip: "93.184.216.34",
		family: 4,
		isIpLiteral: false,
		policyVersion: "1.0",
		local: false,
	};
}

function response({ status = 200, headers = [], body = "", contentType = "application/json" }) {
	return {
		state: {
			status,
			statusText: status === 302 ? "Found" : "OK",
			httpVersion: "1.1",
			headers: [{ name: "Content-Type", value: contentType }, { name: "Content-Length", value: String(Buffer.byteLength(body)) }, ...headers],
		},
		encoded: Buffer.from(body),
		encodedBytes: Buffer.byteLength(body),
		truncated: false,
		omittedReason: null,
		bytesSent: 0,
		timing: { totalMs: 3, firstByteMs: 1 },
		ok: true,
	};
}

function draft(url, overrides = {}) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name: "Cookie probe",
		method: "GET",
		urlTemplate: url,
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		settings: { timeoutMs: 5000 },
		...overrides,
	};
}

function harness({ repository = fakeCookieRepository(), sessionId = "session-a", transport } = {}) {
	const history = fakeHistory();
	const calls = { transport: [] };
	const cookies = createCookieService({ repository, sessionId, isStoreReady: () => true });
	const service = createExecutionService({
		registry: createOperationRegistry(),
		history,
		cookies,
		transport: async (input) => {
			calls.transport.push(input);
			input.onDispatch?.();
			return transport(input);
		},
		policy: {
			async validate(url) {
				return target(url);
			},
		},
	});
	return { service, history, calls, cookies };
}

let sequence = 0;
const sendInput = (url, overrides = {}) => ({
	executionId: randomUUID(),
	tabId: `tab-${(sequence += 1)}`,
	draftVersion: 1,
	request: draft(url, overrides),
	context: {},
});

const cookieHeaderOf = (input) => input.headers.find((header) => header.name.toLowerCase() === "cookie")?.value ?? null;

describe("cookie jar through the execution pipeline", () => {
	test("Set-Cookie from one response reaches the next request", async () => {
		const { service, calls } = harness({
			transport: (input) =>
				input.target.pathAndQuery === "/login"
					? response({ headers: [{ name: "Set-Cookie", value: "sid=abc123; Path=/" }] })
					: response({ body: '{"ok":true}' }),
		});
		const profileId = `profile-${randomUUID()}`;
		await service.send(profileId, sendInput("http://demo.test/login"));
		expect(cookieHeaderOf(calls.transport[0])).toBeNull();
		await service.send(profileId, sendInput("http://demo.test/profile"));
		expect(cookieHeaderOf(calls.transport[1])).toBe("sid=abc123");
	});

	test("multiple Set-Cookie headers are stored and ordered by path", async () => {
		const { service, calls } = harness({
			transport: (input) =>
				input.target.pathAndQuery === "/login"
					? response({
							headers: [
								{ name: "Set-Cookie", value: "token=root; Path=/" },
								{ name: "Set-Cookie", value: "token=deep; Path=/deep" },
							],
						})
					: response({ body: "{}" }),
		});
		const profileId = `profile-${randomUUID()}`;
		await service.send(profileId, sendInput("http://demo.test/login"));
		await service.send(profileId, sendInput("http://demo.test/deep/items"));
		expect(cookieHeaderOf(calls.transport[1])).toBe("token=deep; token=root");
	});

	test("redirect cookies are stored without following the redirect", async () => {
		const { service, calls } = harness({
			transport: (input) =>
				input.target.pathAndQuery === "/start"
					? response({
							status: 302,
							headers: [
								{ name: "Location", value: "http://demo.test/next" },
								{ name: "Set-Cookie", value: "hop=1; Path=/" },
							],
						})
					: response({ body: "{}" }),
		});
		const profileId = `profile-${randomUUID()}`;
		const first = await service.send(profileId, sendInput("http://demo.test/start"));
		expect(first.response.status).toBe(302);
		expect(calls.transport).toHaveLength(1);
		await service.send(profileId, sendInput("http://demo.test/next"));
		expect(calls.transport).toHaveLength(2);
		expect(cookieHeaderOf(calls.transport[1])).toBe("hop=1");
	});

	test("an explicit Cookie header wins over the jar", async () => {
		const { service, calls } = harness({
			transport: (input) =>
				input.target.pathAndQuery === "/login"
					? response({ headers: [{ name: "Set-Cookie", value: "sid=abc; Path=/" }] })
					: response({ body: "{}" }),
		});
		const profileId = `profile-${randomUUID()}`;
		await service.send(profileId, sendInput("http://demo.test/login"));
		const result = await service.send(
			profileId,
			sendInput("http://demo.test/profile", {
				headers: [{ id: randomUUID(), key: "Cookie", value: "manual=1", enabled: true }],
			}),
		);
		expect(cookieHeaderOf(calls.transport[1])).toBe("manual=1");
		expect(result.warnings.map((entry) => entry.code)).toContain("COOKIE_HEADER_EXPLICIT");
	});

	test("profiles never share a jar", async () => {
		const { service, calls } = harness({
			transport: (input) =>
				input.target.pathAndQuery === "/login"
					? response({ headers: [{ name: "Set-Cookie", value: "sid=alpha; Path=/" }] })
					: response({ body: "{}" }),
		});
		const profileA = `profile-${randomUUID()}`;
		const profileB = `profile-${randomUUID()}`;
		await service.send(profileA, sendInput("http://demo.test/login"));
		await service.send(profileB, sendInput("http://demo.test/other"));
		expect(cookieHeaderOf(calls.transport[1])).toBeNull();
		await service.send(profileA, sendInput("http://demo.test/other"));
		expect(cookieHeaderOf(calls.transport[2])).toBe("sid=alpha");
	});

	test("a Secure cookie is not sent over HTTP", async () => {
		const { service, calls } = harness({
			transport: (input) =>
				input.target.pathAndQuery === "/login"
					? response({ headers: [{ name: "Set-Cookie", value: "sid=abc; Path=/; Secure" }] })
					: response({ body: "{}" }),
		});
		const profileId = `profile-${randomUUID()}`;
		await service.send(profileId, sendInput("https://demo.test/login"));
		await service.send(profileId, sendInput("http://demo.test/profile"));
		expect(cookieHeaderOf(calls.transport[1])).toBeNull();
		await service.send(profileId, sendInput("https://demo.test/profile"));
		expect(cookieHeaderOf(calls.transport[2])).toBe("sid=abc");
	});

	test("expiry deletes a jar cookie", async () => {
		const { service, calls } = harness({
			transport: (input) =>
				input.target.pathAndQuery === "/login"
					? response({ headers: [{ name: "Set-Cookie", value: "sid=abc; Path=/" }] })
					: input.target.pathAndQuery === "/logout"
						? response({ headers: [{ name: "Set-Cookie", value: "sid=; Path=/; Max-Age=0" }] })
						: response({ body: "{}" }),
		});
		const profileId = `profile-${randomUUID()}`;
		await service.send(profileId, sendInput("http://demo.test/login"));
		await service.send(profileId, sendInput("http://demo.test/logout"));
		await service.send(profileId, sendInput("http://demo.test/profile"));
		expect(cookieHeaderOf(calls.transport[2])).toBeNull();
	});

	test("session cookies die on restart while persistent cookies survive", async () => {
		const repository = fakeCookieRepository();
		const first = harness({ repository, sessionId: "session-a", transport: () => response({ headers: [
			{ name: "Set-Cookie", value: "session=1; Path=/" },
			{ name: "Set-Cookie", value: "persistent=2; Path=/; Max-Age=3600" },
		] }) });
		const profileId = `profile-${randomUUID()}`;
		await first.service.send(profileId, sendInput("http://demo.test/login"));

		const second = harness({ repository, sessionId: "session-b", transport: () => response({ body: "{}" }) });
		await second.service.send(profileId, sendInput("http://demo.test/profile"));
		expect(cookieHeaderOf(second.calls.transport[0])).toBe("persistent=2");
	});

	test("stored cookie values are redacted from the recorded response", async () => {
		const { service, history } = harness({
			transport: (input) =>
				input.target.pathAndQuery === "/login"
					? response({ headers: [{ name: "Set-Cookie", value: "sid=super-secret-value; Path=/" }] })
					: response({ body: '{"echo":"super-secret-value"}' }),
		});
		const profileId = `profile-${randomUUID()}`;
		await service.send(profileId, sendInput("http://demo.test/login"));
		const result = await service.send(profileId, sendInput("http://demo.test/profile"));
		expect(result.response.body.value).toBe('{"echo":"[REDACTED]"}');
		const stored = [...history.records.values()].at(-1);
		expect(stored.snapshot.requestHeaders).toContain("Cookie");
		expect(JSON.stringify(stored)).not.toContain("super-secret-value");
	});

	test("malformed response cookies warn without failing the send", async () => {
		const { service } = harness({
			transport: () =>
				response({ headers: [{ name: "Set-Cookie", value: "bad name=value; Path=/" }], body: "{}" }),
		});
		const result = await service.send(`profile-${randomUUID()}`, sendInput("http://demo.test/login"));
		expect(result.outcome).toBe("response");
		expect(result.warnings.map((entry) => entry.code)).toContain("COOKIE_REJECTED");
	});

	test("jar failures warn without failing the send", async () => {
		const { service, calls } = harness({ transport: () => response({ body: "{}" }) });
		const broken = createExecutionService({
			registry: createOperationRegistry(),
			history: fakeHistory(),
			cookies: {
				applyToRequest: async ({ headers }) => ({ headers, warnings: [{ code: "COOKIE_JAR_UNAVAILABLE", message: "down" }] }),
				storeResponseCookies: async () => ({ stored: 0, warnings: [{ code: "COOKIE_JAR_UNAVAILABLE", message: "down" }] }),
			},
			transport: async (input) => {
				calls.transport.push(input);
				input.onDispatch?.();
				return response({ body: "{}" });
			},
			policy: { async validate(url) { return target(url); } },
		});
		const result = await broken.send(`profile-${randomUUID()}`, sendInput("http://demo.test/profile"));
		expect(result.outcome).toBe("response");
		expect(result.warnings.filter((entry) => entry.code === "COOKIE_JAR_UNAVAILABLE")).toHaveLength(2);
	});
});
