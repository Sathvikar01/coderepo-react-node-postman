import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../../app.js";
import { getConfig, initConfig } from "../../shared/config/index.js";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { WorkspaceAccount } from "../auth/workspace-account.model.js";
import { Example } from "./example.model.js";
import { ExecutionHistory } from "../history/history.model.js";
import { fingerprintKeyId, fingerprintOf } from "../history/fingerprint.js";
import { Profile } from "../profiles/profile.model.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase19_routes_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase19-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase19-test-jwt-secret";
initConfig();

const ready = await connectTestDatabase();
if (ready) await Promise.all([Example.init(), Profile.init(), WorkspaceAccount.init(), ExecutionHistory.init()]);

const TEST_TIMEOUT_MS = 20000;
const mtest = (name, fn) => test(name, fn, TEST_TIMEOUT_MS);

let server = null;
let baseUrl = "";
let account = null;
let profileA = null;
let profileB = null;
let tokenA = "";
let tokenB = "";

function signToken(profileId) {
	const config = getConfig();
	return jwt.sign(
		{ sub: String(account._id), type: "profile", profileId: String(profileId) },
		config.jwtSecret,
		{ expiresIn: config.jwtExpiresIn, issuer: config.jwtIssuer, audience: config.jwtAudience },
	);
}

async function api(path, { method = "GET", token = tokenA, body } = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			...(body ? { "Content-Type": "application/json" } : {}),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await response.text();
	const payload = text ? JSON.parse(text) : null;
	return { status: response.status, payload, headers: response.headers };
}

function manualBody(name, overrides = {}) {
	return {
		mode: "manual",
		name,
		match: { method: "GET", path: "/orders", query: [], headers: [], ...(overrides.match ?? {}) },
		response: {
			status: 200,
			statusText: "OK",
			contentType: "application/json",
			headers: [
				{ name: "Content-Type", value: "application/json" },
				{ name: "X-Example", value: "yes" },
			],
			body: { encoding: "utf8", value: '{"orders":[]}', mediaType: "application/json" },
			...(overrides.response ?? {}),
		},
	};
}

function requestDefinition(overrides = {}) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name: "List orders",
		method: "GET",
		urlTemplate: "https://api.test/orders",
		query: [{ id: randomUUID(), key: "status", value: "paid", enabled: true }],
		headers: [{ id: randomUUID(), key: "X-Tenant", value: "acme", enabled: true }],
		body: { mode: "none" },
		auth: { mode: "none" },
		settings: { timeoutMs: 15000 },
		...overrides,
	};
}

describe.skipIf(!ready)("examples and mocks over HTTP", () => {
	beforeAll(async () => {
		profileA = await Profile.create({ name: "Alex", email: "alex@test.dev", avatarColor: "#2F6F5F", sortOrder: 0 });
		profileB = await Profile.create({ name: "Jordan", email: "jordan@test.dev", avatarColor: "#4C6EF5", sortOrder: 1 });
		account = await WorkspaceAccount.create({
			name: "Workspace",
			email: "workspace@test.dev",
			passwordHash: "not-used-in-this-test",
			allowedProfileIds: [profileA._id, profileB._id],
		});
		tokenA = signToken(profileA._id);
		tokenB = signToken(profileB._id);
		const app = createApp();
		server = app.listen(0);
		baseUrl = `http://127.0.0.1:${server.address().port}`;
	});

	afterAll(async () => {
		server?.close();
		if (ready) {
			await Promise.all([
				Example.deleteMany({ ownerProfileId: { $in: [profileA?._id, profileB?._id] } }),
				ExecutionHistory.deleteMany({ ownerProfileId: { $in: [profileA?._id, profileB?._id] } }),
				WorkspaceAccount.deleteMany({ _id: account?._id }),
				Profile.deleteMany({ _id: { $in: [profileA?._id, profileB?._id] } }),
			]);
		}
		await disconnectTestDatabase();
	});

	beforeEach(async () => {
		await Promise.all([
			Example.deleteMany({ ownerProfileId: { $in: [profileA._id, profileB._id] } }),
			ExecutionHistory.deleteMany({ ownerProfileId: { $in: [profileA._id, profileB._id] } }),
		]);
	});

	mtest("creates, lists, updates, and deletes examples through the API", async () => {
		const created = await api("/api/v1/examples", { method: "POST", body: manualBody("Orders OK") });
		expect(created.status).toBe(201);
		expect(created.payload.data).toMatchObject({ name: "Orders OK", match: { method: "GET", path: "/orders" } });
		const listed = await api("/api/v1/examples");
		expect(listed.payload.data).toHaveLength(1);
		const fetched = await api(`/api/v1/examples/${created.payload.data._id}`);
		expect(fetched.payload.data.response.headers).toHaveLength(2);
		const updated = await api(`/api/v1/examples/${created.payload.data._id}`, {
			method: "PUT",
			body: {
				name: "Orders renamed",
				match: { method: "POST", path: "/orders", query: [{ key: "page", value: "1" }], headers: [] },
				response: manualBody("ignored").response,
			},
		});
		expect(updated.status).toBe(200);
		expect(updated.payload.data).toMatchObject({ name: "Orders renamed", match: { method: "POST" } });
		const removed = await api(`/api/v1/examples/${created.payload.data._id}`, { method: "DELETE" });
		expect(removed.status).toBe(204);
		expect((await api("/api/v1/examples")).payload.data).toHaveLength(0);
	});

	mtest("requires authentication and never crosses profiles", async () => {
		const created = await api("/api/v1/examples", { method: "POST", body: manualBody("Private") });
		const unauthenticated = await api("/api/v1/examples", { token: "" });
		expect(unauthenticated.status).toBe(401);
		const otherProfile = await api(`/api/v1/examples/${created.payload.data._id}`, { token: tokenB });
		expect(otherProfile.status).toBe(404);
		expect((await api("/api/v1/examples", { token: tokenB })).payload.data).toHaveLength(0);
	});

	mtest("saves an example from a stored execution without changing the receipt", async () => {
		const executionId = randomUUID();
		const request = requestDefinition();
		const record = {
			ownerProfileId: profileA._id,
			executionId,
			fingerprint: fingerprintOf({ request, context: {} }),
			fingerprintKeyId: fingerprintKeyId(),
			instanceId: "test-instance",
			status: "terminal",
			outcome: "response",
			effectCertainty: "may_have_reached_target",
			request,
			context: { tabId: "tab-1", draftVersion: 1 },
			snapshot: { displayUrl: request.urlTemplate, executedUrl: "https://api.test/orders" },
			response: { status: 200 },
			startedAt: new Date(),
			finishedAt: new Date(),
		};
		await ExecutionHistory.create(record);
		const before = await ExecutionHistory.findOne({ ownerProfileId: profileA._id, executionId }).lean();
		const created = await api("/api/v1/examples", {
			method: "POST",
			body: {
				mode: "from-response",
				name: "From history",
				source: { executionId, requestName: request.name },
				request,
				response: manualBody("ignored").response,
			},
		});
		expect(created.status).toBe(201);
		expect(created.payload.data.match).toEqual({
			method: "GET",
			path: "/orders",
			query: [{ key: "status", value: "paid" }],
			headers: [{ key: "X-Tenant", value: "acme" }],
		});
		const after = await ExecutionHistory.findOne({ ownerProfileId: profileA._id, executionId }).lean();
		expect(JSON.stringify(after)).toBe(JSON.stringify(before));
	});

	mtest("mocks the current request without dispatching it", async () => {
		await api("/api/v1/examples", { method: "POST", body: manualBody("Mocked orders") });
		const resolved = await api("/api/v1/mocks/resolve", {
			method: "POST",
			body: { request: requestDefinition(), executionId: randomUUID() },
		});
		expect(resolved.status).toBe(200);
		expect(resolved.payload.data).toMatchObject({ matched: true, example: { name: "Mocked orders" } });
		expect(resolved.payload.data.result).toMatchObject({
			outcome: "mock",
			effectCertainty: "not_dispatched",
			persistence: { state: "not_persisted" },
			response: { status: 200 },
		});
		expect(await ExecutionHistory.countDocuments({ ownerProfileId: profileA._id })).toBe(0);
		const miss = await api("/api/v1/mocks/resolve", {
			method: "POST",
			body: { request: requestDefinition({ urlTemplate: "https://api.test/other" }) },
		});
		expect(miss.payload.data).toMatchObject({ matched: false, example: null });
		expect(miss.payload.data.result.error.code).toBe("MOCK_MISS");
	});

	mtest("serves capability mock routes without a session and rejects other tokens", async () => {
		await api("/api/v1/examples", { method: "POST", body: manualBody("Route example") });
		const meta = await api("/api/v1/mocks/meta");
		expect(meta.status).toBe(200);
		expect(meta.payload.data.exampleCount).toBe(1);
		const route = meta.payload.data.route;
		const served = await fetch(`${baseUrl}${route}/orders?status=paid`, { headers: { "X-Tenant": "acme" } });
		expect(served.status).toBe(200);
		expect(served.headers.get("x-tracer-mock")).toBe("matched");
		expect(await served.json()).toEqual({ orders: [] });
		const miss = await fetch(`${baseUrl}${route}/missing`);
		expect(miss.status).toBe(404);
		expect((await miss.json()).error.code).toBe("MOCK_MISS");
		const forged = await fetch(`${baseUrl}/api/v1/mocks/${profileA._id}/not-the-token/orders`);
		expect(forged.status).toBe(404);
		const otherProfileRoute = await fetch(`${baseUrl}${route.replace(String(profileA._id), String(profileB._id))}/orders`);
		expect(otherProfileRoute.status).toBe(404);
	});

	mtest("keeps real Send on the execution pipeline and out of the mock matcher", async () => {
		await api("/api/v1/examples", { method: "POST", body: manualBody("Never used by Send") });
		const blocked = await api("/api/v1/executions", {
			method: "POST",
			body: {
				executionId: randomUUID(),
				tabId: "tab-1",
				draftVersion: 1,
				request: requestDefinition({ urlTemplate: "http://169.254.169.254/latest/meta-data" }),
				context: {},
			},
		});
		expect(blocked.status).toBe(200);
		expect(blocked.payload.data).toMatchObject({ outcome: "validation_error", effectCertainty: "not_dispatched" });
		expect(blocked.payload.data.mock).toBeUndefined();
		expect(await ExecutionHistory.countDocuments({ ownerProfileId: profileA._id })).toBe(1);
	});
});
