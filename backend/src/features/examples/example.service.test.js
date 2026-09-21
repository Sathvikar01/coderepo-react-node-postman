import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { describe, expect, test } from "bun:test";
import { nameKey } from "../../shared/utils/names.js";
import { createExampleService } from "./example.service.js";

function requestDoc(overrides = {}) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name: "List orders",
		method: "GET",
		urlTemplate: "https://api.test/orders?inline=1",
		query: [{ id: "q1", key: "status", value: "paid", enabled: true }],
		headers: [{ id: "h1", key: "X-Tenant", value: "acme", enabled: true }],
		body: { mode: "none" },
		auth: { mode: "none" },
		settings: { timeoutMs: 15000 },
		...overrides,
	};
}

function responsePayload(overrides = {}) {
	return {
		status: 200,
		statusText: "OK",
		contentType: "",
		headers: [
			{ name: "Content-Type", value: "application/json" },
			{ name: "Set-Cookie", value: "a=1" },
			{ name: "Set-Cookie", value: "b=2" },
		],
		body: { encoding: "utf8", value: '{"orders":[]}', mediaType: "application/json" },
		...overrides,
	};
}

function createHarness({ receipt = null, seed = [] } = {}) {
	const store = new Map();
	let sequence = 0;
	for (const document of seed) store.set(String(document._id), structuredClone(document));
	const calls = { create: 0, replaceById: 0, removeById: 0, count: 0, findByNameKey: 0, historyGet: 0 };
	const repository = {
		calls,
		list: (profileId) => [...store.values()].filter((item) => String(item.ownerProfileId) === String(profileId)),
		async count(profileId) {
			calls.count += 1;
			return [...store.values()].filter((item) => String(item.ownerProfileId) === String(profileId)).length;
		},
		findById: (id, profileId) => {
			const item = store.get(String(id));
			return item && String(item.ownerProfileId) === String(profileId) ? structuredClone(item) : null;
		},
		async findByNameKey(value, profileId, excludedId) {
			calls.findByNameKey += 1;
			return (
				[...store.values()].find(
					(item) =>
						String(item.ownerProfileId) === String(profileId) &&
						item.nameKey === value &&
						(excludedId === undefined || String(item._id) !== String(excludedId)),
				) ?? null
			);
		},
		async create(input) {
			calls.create += 1;
			sequence += 1;
			const created = {
				...structuredClone(input),
				_id: new mongoose.Types.ObjectId().toString(),
				createdAt: new Date(),
				updatedAt: new Date(),
			};
			store.set(String(created._id), created);
			return structuredClone(created);
		},
		async replaceById(id, profileId, update) {
			calls.replaceById += 1;
			const item = store.get(String(id));
			if (!item || String(item.ownerProfileId) !== String(profileId)) return null;
			const updated = { ...item, ...structuredClone(update), updatedAt: new Date() };
			store.set(String(id), updated);
			return structuredClone(updated);
		},
		async removeById(id, profileId) {
			calls.removeById += 1;
			const item = store.get(String(id));
			if (!item || String(item.ownerProfileId) !== String(profileId)) return null;
			store.delete(String(id));
			return structuredClone(item);
		},
	};
	const history = {
		async get(profileId, executionId) {
			calls.historyGet += 1;
			if (receipt) return structuredClone(receipt);
			return executionId === "missing" ? null : { executionId, response: { status: 200 } };
		},
	};
	const environments = { findById: async () => null };
	return { service: createExampleService({ repository, history, environments }), store, calls, history };
}

const executionId = () => randomUUID();

describe("example service", () => {
	test("saves an example from a live response without touching the history receipt", async () => {
		const receipt = {
			executionId: executionId(),
			response: { status: 200 },
			snapshot: { executedUrl: "https://api.test/orders" },
		};
		const frozen = structuredClone(receipt);
		const harness = createHarness({ receipt });
		const created = await harness.service.createFromResponse("profile-a", {
			mode: "from-response",
			name: "Orders example",
			source: { executionId: receipt.executionId, requestName: "List orders" },
			request: requestDoc(),
			response: responsePayload(),
		});
		expect(created.match).toEqual({
			method: "GET",
			path: "/orders",
			query: [{ key: "status", value: "paid" }],
			headers: [{ key: "X-Tenant", value: "acme" }],
		});
		expect(created.response.headers.map((header) => `${header.name}:${header.value}`)).toEqual([
			"Content-Type:application/json",
			"Set-Cookie:a=1",
			"Set-Cookie:b=2",
		]);
		expect(created.response.contentType).toBe("application/json");
		expect(created.source).toMatchObject({ type: "response", executionId: receipt.executionId, requestName: "List orders" });
		expect(harness.calls.historyGet).toBe(1);
		expect(receipt).toEqual(frozen);
	});

	test("derives rules only from the selected query parameters and headers", async () => {
		const harness = createHarness();
		const created = await harness.service.createFromResponse("profile-a", {
			mode: "from-response",
			name: "Selected only",
			source: { executionId: executionId() },
			request: requestDoc({
				query: [
					{ id: "q1", key: "status", value: "paid", enabled: true },
					{ id: "q2", key: "page", value: "2", enabled: true },
				],
				headers: [
					{ id: "h1", key: "X-Tenant", value: "acme", enabled: true },
					{ id: "h2", key: "X-Trace", value: "abc", enabled: true },
				],
			}),
			selectQueryIds: ["q2"],
			selectHeaderIds: ["h1"],
			response: responsePayload(),
		});
		expect(created.match.query).toEqual([{ key: "page", value: "2" }]);
		expect(created.match.headers).toEqual([{ key: "X-Tenant", value: "acme" }]);
	});

	test("rejects a missing source execution", async () => {
		const harness = createHarness();
		let caught = null;
		try {
			await harness.service.createFromResponse("profile-a", {
				mode: "from-response",
				name: "Gone",
				source: { executionId: "missing" },
				request: requestDoc(),
				response: responsePayload(),
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ statusCode: 404, code: "EXAMPLE_SOURCE_NOT_FOUND" });
		expect(harness.calls.create).toBe(0);
	});

	test("saves a manual example with json, text, empty, and binary bodies", async () => {
		const harness = createHarness();
		const manual = (overrides) => ({
			mode: "manual",
			name: overrides.name,
			match: { method: "POST", path: "/orders", query: [], headers: [] },
			response: responsePayload({ headers: [], contentType: "", body: overrides.body }),
		});
		const json = await harness.service.createManual("profile-a", manual({ name: "json", body: { encoding: "utf8", value: '{"a":1}', mediaType: "application/json" } }));
		const text = await harness.service.createManual("profile-a", manual({ name: "text", body: { encoding: "utf8", value: "hello", mediaType: "text/plain" } }));
		const empty = await harness.service.createManual("profile-a", manual({ name: "empty", body: { encoding: "utf8", value: "", mediaType: "" } }));
		const binary = await harness.service.createManual(
			"profile-a",
			manual({ name: "binary", body: { encoding: "base64", value: "AAECAw==", mediaType: "application/octet-stream" } }),
		);
		expect(json.response.body).toMatchObject({ encoding: "utf8", value: '{"a":1}', mediaType: "application/json" });
		expect(text.response.body.value).toBe("hello");
		expect(empty.response.body.value).toBe("");
		expect(binary.response.body).toMatchObject({ encoding: "base64", value: "AAECAw==" });
		expect(json.response.contentType).toBe("application/json");
	});

	test("keeps every response header in order, including duplicates", async () => {
		const harness = createHarness();
		const created = await harness.service.createManual("profile-a", {
			mode: "manual",
			name: "duplicates",
			match: { method: "GET", path: "/dup", query: [], headers: [] },
			response: responsePayload({
				headers: [
					{ name: "X-Order", value: "1" },
					{ name: "X-Order", value: "2" },
					{ name: "X-Order", value: "3" },
				],
			}),
		});
		expect(created.response.headers).toEqual([
			{ name: "X-Order", value: "1" },
			{ name: "X-Order", value: "2" },
			{ name: "X-Order", value: "3" },
		]);
	});

	test("refuses credential headers as mock match rules", async () => {
		const harness = createHarness();
		let caught = null;
		try {
			await harness.service.createManual("profile-a", {
				mode: "manual",
				name: "unsafe",
				match: { method: "GET", path: "/orders", query: [], headers: [{ key: "Authorization", value: "Bearer x" }] },
				response: responsePayload(),
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ statusCode: 400, code: "EXAMPLE_MATCH_SENSITIVE" });
		expect(harness.calls.create).toBe(0);
	});

	test("rejects duplicate names and invalid base64 bodies", async () => {
		const harness = createHarness();
		const input = {
			mode: "manual",
			name: "duplicate",
			match: { method: "GET", path: "/orders", query: [], headers: [] },
			response: responsePayload(),
		};
		await harness.service.createManual("profile-a", input);
		let duplicate = null;
		try {
			await harness.service.createManual("profile-a", input);
		} catch (error) {
			duplicate = error;
		}
		expect(duplicate).toMatchObject({ statusCode: 409, code: "EXAMPLE_NAME_CONFLICT" });
		let invalid = null;
		try {
			await harness.service.createManual("profile-a", {
				mode: "manual",
				name: "bad base64",
				match: { method: "GET", path: "/orders", query: [], headers: [] },
				response: responsePayload({ body: { encoding: "base64", value: "not base64!", mediaType: "" } }),
			});
		} catch (error) {
			invalid = error;
		}
		expect(invalid).toMatchObject({ statusCode: 400, code: "EXAMPLE_BODY_INVALID" });
	});

	test("caps saved response bodies, truncates live ones, and rejects oversize manual bodies", async () => {
		const harness = createHarness();
		const bigUtf8 = `{"data":"${"x".repeat(300 * 1024)}"}`;
		const manual = await harness.service
			.createManual("profile-a", {
				mode: "manual",
				name: "oversize manual",
				match: { method: "GET", path: "/big", query: [], headers: [] },
				response: responsePayload({ body: { encoding: "utf8", value: bigUtf8, mediaType: "application/json" } }),
			})
			.catch((error) => error);
		expect(manual).toMatchObject({ statusCode: 413, code: "EXAMPLE_BODY_LIMIT" });
		const fromResponse = await harness.service.createFromResponse("profile-a", {
			mode: "from-response",
			name: "live big",
			source: { executionId: executionId() },
			request: requestDoc(),
			response: responsePayload({ body: { encoding: "utf8", value: bigUtf8, mediaType: "application/json" } }),
		});
		expect(fromResponse.response.body.truncated).toBe(true);
		expect(fromResponse.response.body.omittedReason).toBe("example_limit");
		expect(Buffer.byteLength(fromResponse.response.body.value, "utf8")).toBeLessThanOrEqual(256 * 1024);
	});

	test("scopes every read and write to the owning profile", async () => {
		const harness = createHarness();
		const created = await harness.service.createManual("profile-a", {
			mode: "manual",
			name: "scoped",
			match: { method: "GET", path: "/orders", query: [], headers: [] },
			response: responsePayload(),
		});
		expect(await harness.service.get("profile-a", created._id)).toMatchObject({ name: "scoped" });
		let caught = null;
		try {
			await harness.service.get("profile-b", created._id);
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ statusCode: 404, code: "EXAMPLE_NOT_FOUND" });
		caught = null;
		try {
			await harness.service.remove("profile-b", created._id);
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ statusCode: 404, code: "EXAMPLE_NOT_FOUND" });
		expect(await harness.service.list("profile-b")).toHaveLength(0);
	});

	test("edits an example while keeping its source reference, then deletes it", async () => {
		const harness = createHarness();
		const created = await harness.service.createManual("profile-a", {
			mode: "manual",
			name: "before",
			match: { method: "GET", path: "/before", query: [], headers: [] },
			response: responsePayload(),
		});
		const updated = await harness.service.replace("profile-a", created._id, {
			name: "after",
			match: { method: "POST", path: "/after", query: [{ key: "page", value: "1" }], headers: [] },
			response: responsePayload({ status: 201, statusText: "Created" }),
		});
		expect(updated).toMatchObject({ name: "after", nameKey: nameKey("after"), source: { type: "manual" } });
		expect(updated.match).toEqual({ method: "POST", path: "/after", query: [{ key: "page", value: "1" }], headers: [] });
		expect(updated.response.status).toBe(201);
		await harness.service.remove("profile-a", created._id);
		expect(await harness.service.list("profile-a")).toHaveLength(0);
	});
});
