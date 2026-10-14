import { afterEach, beforeAll, describe, expect, test } from "bun:test";

// The API client reads localStorage at module scope so a reload keeps its session.
// Bun has no DOM, so install a minimal in-memory storage before importing it. This
// keeps the client under test exactly as the browser loads it.
const store = new Map();
globalThis.localStorage = {
	getItem: (key) => (store.has(key) ? store.get(key) : null),
	setItem: (key, value) => store.set(key, String(value)),
	removeItem: (key) => store.delete(key),
	clear: () => store.clear(),
};

let client;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
	client = await import("./client.js");
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	client.clearSession();
});

const catchError = async (work) => {
	try {
		await work();
	} catch (error) {
		return error;
	}
	return null;
};

describe("request error shaping", () => {
	test("wraps a transport failure in an actionable message instead of leaking a browser TypeError", async () => {
		globalThis.fetch = async () => {
			throw new TypeError("Failed to fetch");
		};
		const caught = await catchError(() => client.request("/collections"));
		expect(caught).not.toBeNull();
		expect(caught.code).toBe("NETWORK_UNREACHABLE");
		expect(caught.status).toBe(0);
		expect(caught.message).toContain("could not reach its API");
		expect(caught.message).toContain("try again");
		expect(caught.message).not.toBe("Failed to fetch");
	});

	test("keeps the same error shape the UI already reads for server errors", async () => {
		globalThis.fetch = async () => {
			throw new TypeError("NetworkError");
		};
		const caught = await catchError(() => client.request("/environments"));
		expect(caught).toHaveProperty("code");
		expect(caught).toHaveProperty("details");
		expect(caught).toHaveProperty("status");
	});

	test("still surfaces a structured server error with its code and message", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "No such collection." } }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});
		const caught = await catchError(() => client.request("/collections/missing"));
		expect(caught.code).toBe("NOT_FOUND");
		expect(caught.message).toBe("No such collection.");
		expect(caught.status).toBe(404);
	});

	test("returns null for a 204 without parsing a body", async () => {
		globalThis.fetch = async () => new Response(null, { status: 204 });
		expect(await client.request("/collections/x")).toBeNull();
	});

	test("unwraps a successful data envelope", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ data: { id: "c1" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		expect(await client.request("/collections/c1")).toEqual({ id: "c1" });
	});

	test("rejects a non-JSON success rather than returning an undefined envelope", async () => {
		globalThis.fetch = async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
		const caught = await catchError(() => client.request("/collections"));
		expect(caught.message).toContain("invalid response");
	});
});

describe("session mutation origin", () => {
	const captureInit = () => {
		let init = null;
		globalThis.fetch = async (_url, options) => {
			init = options;
			return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
		};
		return () => init;
	};

	test("stamps a mutation so the session can recognise its own event echo", async () => {
		const init = captureInit();
		await client.request("/collections/c1", { method: "PUT", body: JSON.stringify({ name: "Orders" }) });
		expect(init().headers["x-tracer-origin"]).toBe(client.getClientOrigin());
	});

	test("distinguishes a delete from a create while keeping one session origin", async () => {
		const init = captureInit();
		await client.request("/collections/c1", { method: "DELETE" });
		const deleteOrigin = init().headers["x-tracer-origin"];
		await client.request("/collections", { method: "POST", body: JSON.stringify({ name: "New" }) });
		expect(init().headers["x-tracer-origin"]).toBe(deleteOrigin);
	});

	test("does not stamp a read, which causes no state change", async () => {
		const init = captureInit();
		await client.request("/collections");
		expect(init().headers["x-tracer-origin"]).toBeUndefined();
		expect(init().method ?? "GET").toBe("GET");
	});

	test("exposes a bounded, opaque origin value that is stable for the session", () => {
		const origin = client.getClientOrigin();
		expect(origin).toBe(client.getClientOrigin());
		expect(origin).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
	});
});
