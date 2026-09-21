import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { initConfig } from "../shared/config/index.js";
import { variablesSchema } from "../shared/utils/schemas.js";
import { connectTestDatabase, disconnectTestDatabase } from "../shared/utils/test-db.js";
import { Collection } from "./collections/collection.model.js";
import { collectionService } from "./collections/collection.service.js";
import { createCookieService } from "./cookies/cookie.service.js";
import { ProfileCookie } from "./cookies/cookie.model.js";
import { Environment } from "./environments/environment.model.js";
import { environmentService } from "./environments/environment.service.js";
import { ExecutionHistory } from "./history/history.model.js";
import { historyRepository } from "./history/history.repository.js";
import { historyService } from "./history/history.service.js";
import { ProfilePreference } from "./profiles/preference.model.js";
import { preferenceService } from "./profiles/profile.service.js";
import { createOperationRegistry } from "./executions/active-registry.js";
import { createExecutionService } from "./executions/execution.service.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase3_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase3-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase3-test-jwt-secret";
initConfig();

const ready = await connectTestDatabase();
if (ready) {
	await Promise.all([Collection.init(), Environment.init(), ProfilePreference.init(), ExecutionHistory.init(), ProfileCookie.init()]);
}

const profileA = new mongoose.Types.ObjectId();
const profileB = new mongoose.Types.ObjectId();

const TEST_TIMEOUT_MS = 20000;
const mtest = (name, fn) => test(name, fn, TEST_TIMEOUT_MS);

async function expectRejection(promise, expected) {
	let caught = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toMatchObject(expected);
}

function aggregate(name, overrides = {}) {
	return {
		name,
		description: "",
		variables: [],
		auth: { mode: "none" },
		folders: [],
		requests: [],
		...overrides,
	};
}

function requestDoc(name) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name,
		method: "GET",
		urlTemplate: "https://example.test/orders",
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		settings: { timeoutMs: 15000 },
	};
}

function variableDoc(kind, key, overrides = {}) {
	return { id: randomUUID(), key, kind, enabled: true, ...overrides };
}

async function admission(ownerProfileId, executionId, overrides = {}) {
	return historyRepository.insertAdmission({
		ownerProfileId,
		executionId,
		fingerprint: `fp-${executionId}`,
		fingerprintKeyId: "v1",
		instanceId: "phase3-test",
		status: "running",
		effectCertainty: "not_dispatched",
		persistence: { state: "saved" },
		request: { name: "Probe", method: "GET" },
		context: { tabId: "tab-1", draftVersion: 1 },
		snapshot: { displayUrl: "https://example.test/probe" },
		startedAt: new Date(),
		...overrides,
	});
}

function transportOk() {
	return {
		ok: true,
		state: { status: 200, statusText: "OK", httpVersion: "1.1", headers: [] },
		encoded: Buffer.from('{"ok":true}'),
		encodedBytes: 11,
		truncated: false,
		omittedReason: null,
		bytesSent: 64,
		timing: { totalMs: 3, firstByteMs: 1 },
	};
}

describe.skipIf(!ready)("persistence and state correctness", () => {
	beforeEach(async () => {
		await Promise.all([
			Collection.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } }),
			Environment.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } }),
			ProfilePreference.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } }),
			ExecutionHistory.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } }),
			ProfileCookie.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } }),
		]);
	});
	afterAll(disconnectTestDatabase);

	describe("collection persistence", () => {
		mtest("reads and writes stay scoped to the owning profile", async () => {
			const created = await collectionService.create({ name: "Owned by A" }, profileA);

			expect(String(created.ownerProfileId)).toBe(String(profileA));
			expect((await collectionService.list(profileA)).map((item) => item.name)).toEqual(["Owned by A"]);
			expect(await collectionService.list(profileB)).toEqual([]);
			await expectRejection(collectionService.get(String(created._id), profileB), { code: "COLLECTION_NOT_FOUND", statusCode: 404 });
		});

		mtest("two writers using the same revision produce one winner and one deterministic conflict", async () => {
			const created = await collectionService.create({ name: "Shared" }, profileA);
			const outcomes = await Promise.allSettled([
				collectionService.replace(String(created._id), profileA, created.revision, aggregate("Shared", { description: "first" })),
				collectionService.replace(String(created._id), profileA, created.revision, aggregate("Shared", { description: "second" })),
			]);

			expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
			const rejected = outcomes.find((item) => item.status === "rejected");
			expect(rejected.reason).toMatchObject({ code: "COLLECTION_REVISION_CONFLICT", statusCode: 409 });

			const stored = await collectionService.get(String(created._id), profileA);
			expect(stored.revision).toBe(2);
			expect(["first", "second"]).toContain(stored.description);
		});

		mtest("concurrent disjoint edits never merge silently or lose the winner's changes", async () => {
			const created = await collectionService.create({ name: "Concurrent" }, profileA);
			const outcomes = await Promise.allSettled([
				collectionService.replace(String(created._id), profileA, created.revision, aggregate("Concurrent", { requests: [requestDoc("Alpha")] })),
				collectionService.replace(String(created._id), profileA, created.revision, aggregate("Concurrent", { requests: [requestDoc("Beta")] })),
			]);

			const winner = outcomes.find((item) => item.status === "fulfilled").value;
			const stored = await collectionService.get(String(created._id), profileA);
			expect(stored.revision).toBe(2);
			expect(stored.requests).toHaveLength(1);
			expect(stored.requests).toEqual(winner.requests);
			expect(["Alpha", "Beta"]).toContain(stored.requests[0].name);
		});

		mtest("a stale revision conflict leaves the stored document untouched", async () => {
			const created = await collectionService.create({ name: "Stale" }, profileA);
			await collectionService.replace(String(created._id), profileA, created.revision, aggregate("Stale", { description: "kept" }));

			await expectRejection(
				collectionService.replace(String(created._id), profileA, created.revision, aggregate("Stale", { description: "overwritten" })),
				{ code: "COLLECTION_REVISION_CONFLICT", statusCode: 409 },
			);

			const stored = await collectionService.get(String(created._id), profileA);
			expect(stored.revision).toBe(2);
			expect(stored.description).toBe("kept");
		});

		mtest("stale deletes return a conflict and cross-profile deletes are not found", async () => {
			const created = await collectionService.create({ name: "Delete me" }, profileA);
			await expectRejection(collectionService.remove(String(created._id), profileB, created.revision), { code: "COLLECTION_NOT_FOUND" });
			await expectRejection(collectionService.remove(String(created._id), profileA, created.revision + 5), {
				code: "COLLECTION_REVISION_CONFLICT",
			});
			expect(await collectionService.get(String(created._id), profileA)).toBeTruthy();
			await collectionService.remove(String(created._id), profileA, created.revision);
			await expectRejection(collectionService.get(String(created._id), profileA), { code: "COLLECTION_NOT_FOUND" });
		});

		mtest("renaming onto an existing name is rejected with a conflict", async () => {
			await collectionService.create({ name: "First" }, profileA);
			const second = await collectionService.create({ name: "Second" }, profileA);

			await expectRejection(collectionService.replace(String(second._id), profileA, second.revision, aggregate("First")), {
				code: "COLLECTION_NAME_CONFLICT",
				statusCode: 409,
			});
			expect((await collectionService.get(String(second._id), profileA)).name).toBe("Second");
		});

		mtest("same-name creates racing at the same instant always fail with a 409, never a database error", async () => {
			const name = `Race ${randomUUID()}`;
			const outcomes = await Promise.allSettled([
				collectionService.create({ name }, profileA),
				collectionService.create({ name }, profileA),
			]);

			const fulfilled = outcomes.filter((item) => item.status === "fulfilled");
			const rejected = outcomes.filter((item) => item.status === "rejected");
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			expect(rejected[0].reason).toMatchObject({ code: "COLLECTION_NAME_CONFLICT", statusCode: 409 });
			expect(await Collection.countDocuments({ ownerProfileId: profileA, nameKey: name.toLowerCase() })).toBe(1);
		});

		mtest("duplicate copies every inner identifier and leaves the source untouched", async () => {
			const created = await collectionService.create({ name: "Source" }, profileA);
			const source = await collectionService.replace(
				String(created._id),
				profileA,
				created.revision,
				aggregate("Source", { requests: [requestDoc("Original")] }),
			);

			const copy = await collectionService.duplicate(String(source._id), profileA, source.revision, "Copy");
			expect(copy.name).toBe("Copy");
			expect(copy.revision).toBe(1);
			expect(String(copy.ownerProfileId)).toBe(String(profileA));
			expect(copy.requests[0].id).not.toBe(source.requests[0].id);

			const storedSource = await collectionService.get(String(source._id), profileA);
			expect(storedSource.revision).toBe(source.revision);
			expect(storedSource.requests[0].id).toBe(source.requests[0].id);
			expect(storedSource.name).toBe("Source");
		});

		mtest("duplicate with a stale revision is rejected", async () => {
			const created = await collectionService.create({ name: "Dupe" }, profileA);
			await expectRejection(collectionService.duplicate(String(created._id), profileA, created.revision + 1, "Dupe copy"), {
				code: "COLLECTION_REVISION_CONFLICT",
			});
		});
	});

	describe("environment persistence", () => {
		mtest("environment CRUD is profile-scoped", async () => {
			const created = await environmentService.create({ name: "Local", variables: [] }, profileA);

			expect((await environmentService.list(profileA)).map((item) => item.name)).toEqual(["Local"]);
			expect(await environmentService.list(profileB)).toEqual([]);
			await expectRejection(environmentService.get(String(created._id), profileB), { code: "ENVIRONMENT_NOT_FOUND", statusCode: 404 });
			await expectRejection(environmentService.remove(String(created._id), profileB, created.revision), {
				code: "ENVIRONMENT_NOT_FOUND",
			});
		});

		mtest("environment revisions enforce compare-and-set for both writers", async () => {
			const created = await environmentService.create({ name: "Env", variables: [] }, profileA);
			const outcomes = await Promise.allSettled([
				environmentService.replace(String(created._id), profileA, created.revision, { name: "Env", variables: [] }),
				environmentService.replace(String(created._id), profileA, created.revision, { name: "Env", variables: [] }),
			]);

			expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
			expect(outcomes.find((item) => item.status === "rejected").reason).toMatchObject({
				code: "ENVIRONMENT_REVISION_CONFLICT",
				statusCode: 409,
			});
			expect((await environmentService.get(String(created._id), profileA)).revision).toBe(2);
		});

		mtest("stale environment deletes return a conflict and keep the document", async () => {
			const created = await environmentService.create({ name: "Keep", variables: [] }, profileA);
			await expectRejection(environmentService.remove(String(created._id), profileA, created.revision + 1), {
				code: "ENVIRONMENT_REVISION_CONFLICT",
			});
			expect(await environmentService.get(String(created._id), profileA)).toBeTruthy();
		});

		mtest("secret references round-trip as aliases and never persist values", async () => {
			const sentinel = `secret-${randomUUID()}`;
			const stored = await environmentService.create(
				{ name: "Secrets", variables: [variableDoc("secretRef", "orders_token", { alias: "local_token" })] },
				profileA,
			);

			const raw = await Environment.findOne({ _id: stored._id, ownerProfileId: profileA }).lean();
			expect(raw.variables[0]).toMatchObject({ kind: "secretRef", alias: "local_token" });
			expect(raw.variables[0].value).toBeUndefined();
			expect(JSON.stringify(raw)).not.toContain(sentinel);

			expect(variablesSchema.safeParse([variableDoc("secretRef", "orders_token", { alias: "local_token", value: sentinel })]).success).toBe(false);
			expect(variablesSchema.safeParse([variableDoc("secretRef", "orders_token", { alias: "local_token" })]).success).toBe(true);
			expect(variablesSchema.safeParse([variableDoc("plain", "base_url", { value: "https://example.test" })]).success).toBe(true);
			expect(variablesSchema.safeParse([variableDoc("plain", "base_url")]).success).toBe(false);
		});

		mtest("environment name conflicts are deterministic for renames and instant races", async () => {
			await environmentService.create({ name: "Taken", variables: [] }, profileA);
			const second = await environmentService.create({ name: "Free", variables: [] }, profileA);
			await expectRejection(environmentService.replace(String(second._id), profileA, second.revision, { name: "Taken", variables: [] }), {
				code: "ENVIRONMENT_NAME_CONFLICT",
				statusCode: 409,
			});

			const name = `Env race ${randomUUID()}`;
			const outcomes = await Promise.allSettled([
				environmentService.create({ name, variables: [] }, profileA),
				environmentService.create({ name, variables: [] }, profileA),
			]);
			expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
			expect(outcomes.find((item) => item.status === "rejected").reason).toMatchObject({
				code: "ENVIRONMENT_NAME_CONFLICT",
				statusCode: 409,
			});
		});

		mtest("deleting an environment reconciles a stored active-environment preference", async () => {
			const environment = await environmentService.create({ name: "Active", variables: [] }, profileA);
			await preferenceService.update(profileA, { activeEnvironmentId: String(environment._id) });
			expect((await preferenceService.get(profileA)).activeEnvironmentId).toBe(String(environment._id));

			await environmentService.remove(String(environment._id), profileA, environment.revision);
			const reconciled = await preferenceService.get(profileA);
			expect(reconciled.activeEnvironmentId).toBeNull();
		});
	});

	describe("preference persistence", () => {
		mtest("preferences persist independently per profile and partial updates preserve the rest", async () => {
			await preferenceService.update(profileA, { theme: "light", sidebarCollapsed: true });
			await preferenceService.update(profileB, { theme: "dark", responseView: "raw" });

			await preferenceService.update(profileA, { responseView: "raw" });

			const first = await preferenceService.get(profileA);
			const second = await preferenceService.get(profileB);
			expect(first).toMatchObject({ theme: "light", sidebarCollapsed: true, responseView: "raw" });
			expect(second).toMatchObject({ theme: "dark", responseView: "raw", sidebarCollapsed: false });
		});

		mtest("a profile cannot select another profile's environment or collection order", async () => {
			const environment = await environmentService.create({ name: "B env", variables: [] }, profileB);
			const collection = await collectionService.create({ name: "B collection" }, profileB);

			await expectRejection(preferenceService.update(profileA, { activeEnvironmentId: String(environment._id) }), {
				code: "ENVIRONMENT_NOT_FOUND",
			});
			await expectRejection(preferenceService.update(profileA, { collectionOrder: [String(collection._id)] }), {
				code: "COLLECTION_FORBIDDEN",
				statusCode: 403,
			});
			await expectRejection(
				preferenceService.update(profileA, { lastSavedRequest: { collectionId: String(collection._id), requestId: null } }),
				{ code: "COLLECTION_NOT_FOUND" },
			);
		});

		mtest("deleted collections are filtered out of the stored collection order on read", async () => {
			const kept = await collectionService.create({ name: "Kept" }, profileA);
			const removed = await collectionService.create({ name: "Removed" }, profileA);
			await preferenceService.update(profileA, { collectionOrder: [String(kept._id), String(removed._id)] });

			await collectionService.remove(String(removed._id), profileA, removed.revision);

			const preferences = await preferenceService.get(profileA);
			expect(preferences.collectionOrder).toEqual([String(kept._id)]);
		});
	});

	describe("history persistence", () => {
		mtest("terminal records are immutable once finalization wins", async () => {
			const executionId = randomUUID();
			await admission(profileA, executionId);
			const expiresAt = new Date(Date.now() + 60_000);
			const first = await historyRepository.finalize(profileA, executionId, {
				status: "terminal",
				outcome: "response",
				expiresAt,
				response: { status: 200 },
			});
			expect(first.outcome).toBe("response");

			const late = await historyRepository.finalize(profileA, executionId, {
				status: "terminal",
				outcome: "cancelled",
				expiresAt,
				response: null,
			});
			expect(late).toBeNull();
			const stored = await historyRepository.findByExecutionId(profileA, executionId);
			expect(stored.outcome).toBe("response");
			expect(stored.response.status).toBe(200);
		});

		mtest("hide only applies to terminal owned records", async () => {
			const terminalId = randomUUID();
			await admission(profileA, terminalId);
			await historyRepository.finalize(profileA, terminalId, { status: "terminal", outcome: "response" });

			const runningId = randomUUID();
			await admission(profileA, runningId);

			await expectRejection(historyService.hide(profileA, runningId), { code: "EXECUTION_ACTIVE", statusCode: 409 });
			await expectRejection(historyService.hide(profileB, terminalId), { code: "HISTORY_NOT_FOUND", statusCode: 404 });

			const hidden = await historyService.hide(profileA, terminalId);
			expect(hidden.visible).toBe(false);
			expect(hidden.response).toBeNull();
			expect(hidden.request).toEqual({ name: null, method: null });
		});

		mtest("clear hides terminal records and leaves running records alone", async () => {
			const terminalId = randomUUID();
			await admission(profileA, terminalId);
			await historyRepository.finalize(profileA, terminalId, { status: "terminal", outcome: "response", finishedAt: new Date() });
			const runningId = randomUUID();
			await admission(profileA, runningId);

			const result = await historyService.clear(profileA);
			expect(result.modifiedCount).toBe(1);
			expect((await historyRepository.findByExecutionId(profileA, terminalId)).visible).toBe(false);
			expect((await historyRepository.findByExecutionId(profileA, runningId)).visible).toBe(true);
		});

		mtest("expired records are hidden from get and list but receipts still report expiry", async () => {
			const expiredId = randomUUID();
			await admission(profileA, expiredId);
			await historyRepository.finalize(profileA, expiredId, {
				status: "terminal",
				outcome: "response",
				expiresAt: new Date(Date.now() - 1000),
			});
			const liveId = randomUUID();
			await admission(profileA, liveId);
			await historyRepository.finalize(profileA, liveId, { status: "terminal", outcome: "response", expiresAt: new Date(Date.now() + 60_000) });

			expect((await historyService.get(profileA, expiredId)).expired).toBe(true);
			const page = await historyService.list(profileA, {});
			expect(page.items.map((item) => item.executionId)).toEqual([liveId]);
		});

		mtest("cursors keep excluding expired records", async () => {
			const ids = [];
			for (let index = 0; index < 3; index += 1) {
				const executionId = randomUUID();
				ids.push(executionId);
				await admission(profileA, executionId, { startedAt: new Date(Date.now() - index * 1000) });
				await historyRepository.finalize(profileA, executionId, { status: "terminal", outcome: "response" });
			}
			const expiredId = randomUUID();
			await admission(profileA, expiredId, { startedAt: new Date(Date.now() - 10_000) });
			await historyRepository.finalize(profileA, expiredId, {
				status: "terminal",
				outcome: "response",
				expiresAt: new Date(Date.now() - 1000),
			});

			const firstPage = await historyService.list(profileA, { limit: 2 });
			expect(firstPage.items).toHaveLength(2);
			expect(firstPage.nextCursor).toBeTruthy();
			const secondPage = await historyService.list(profileA, { limit: 2, cursor: firstPage.nextCursor });

			const seen = [...firstPage.items, ...secondPage.items].map((item) => item.executionId);
			expect(seen).toHaveLength(3);
			expect(new Set(seen).size).toBe(3);
			expect(seen).not.toContain(expiredId);
			expect(seen.sort()).toEqual([...ids].sort());
		});

		mtest("pagination is stable when several records share a startedAt", async () => {
			const startedAt = new Date();
			const ids = [];
			for (let index = 0; index < 3; index += 1) {
				const executionId = randomUUID();
				ids.push(executionId);
				await admission(profileA, executionId, { startedAt });
				await historyRepository.finalize(profileA, executionId, { status: "terminal", outcome: "response" });
			}

			const collected = [];
			let cursor;
			for (let page = 0; page < 5; page += 1) {
				const result = await historyService.list(profileA, { limit: 1, cursor });
				collected.push(...result.items.map((item) => item.executionId));
				cursor = result.nextCursor;
				if (!cursor) break;
			}
			expect(collected).toHaveLength(3);
			expect(new Set(collected).size).toBe(3);
			expect(collected.sort()).toEqual([...ids].sort());
		});

		mtest("invalid cursors are rejected and another profile's cursor cannot leak records", async () => {
			await expectRejection(historyService.list(profileA, { cursor: "not-a-cursor" }), { code: "CURSOR_INVALID" });

			const foreignId = randomUUID();
			await admission(profileB, foreignId);
			await historyRepository.finalize(profileB, foreignId, { status: "terminal", outcome: "response" });
			const otherId = randomUUID();
			await admission(profileB, otherId, { startedAt: new Date(Date.now() - 1000) });
			await historyRepository.finalize(profileB, otherId, { status: "terminal", outcome: "response" });

			const foreignPage = await historyService.list(profileB, { limit: 1 });
			const mine = randomUUID();
			await admission(profileA, mine, { startedAt: new Date(Date.now() - 5000) });
			await historyRepository.finalize(profileA, mine, { status: "terminal", outcome: "response" });

			const page = await historyService.list(profileA, { cursor: foreignPage.nextCursor });
			expect(page.items.map((item) => item.executionId)).toEqual([mine]);
		});

		mtest("clear racing a finalization never corrupts the terminal record", async () => {
			const executionId = randomUUID();
			await admission(profileA, executionId);

			await historyService.clear(profileA);
			const running = await historyRepository.findByExecutionId(profileA, executionId);
			expect(running.status).toBe("running");

			const finalized = await historyRepository.finalize(profileA, executionId, { status: "terminal", outcome: "response" });
			expect(finalized.outcome).toBe("response");
			const stored = await historyRepository.findByExecutionId(profileA, executionId);
			expect(stored.status).toBe("terminal");
			expect(stored.outcome).toBe("response");
		});
	});

	describe("save vs send separation", () => {
		mtest("sending an edited draft never mutates the saved collection", async () => {
			const created = await collectionService.create({ name: "Send target" }, profileA);
			const saved = await collectionService.replace(
				String(created._id),
				profileA,
				created.revision,
				aggregate("Send target", { requests: [requestDoc("Saved request")] }),
			);

			const draft = { ...saved.requests[0], name: "Edited draft" };
			const service = createExecutionService({
				registry: createOperationRegistry(),
				transport: async (input) => {
					input.onDispatch();
					return transportOk();
				},
				policy: {
					async validate() {
						return {
							scheme: "https",
							originalHostname: "example.test",
							authority: "example.test",
							port: 443,
							pathAndQuery: "/orders",
							ip: "93.184.216.34",
							family: 4,
							isIpLiteral: false,
							policyVersion: "1.0",
							local: false,
						};
					},
				},
			});

			const executionId = randomUUID();
			const result = await service.send(profileA, {
				executionId,
				tabId: "tab-1",
				draftVersion: 7,
				request: draft,
				context: {
					collectionId: String(saved._id),
					requestId: saved.requests[0].id,
					collectionRevision: saved.revision,
				},
			});

			expect(result.outcome).toBe("response");
			expect(result.persistence).toEqual({ state: "saved" });
			const after = await collectionService.get(String(saved._id), profileA);
			expect(after.revision).toBe(saved.revision);
			expect(after.requests).toEqual(saved.requests);
			expect(after.requests[0].name).toBe("Saved request");
			const history = await historyRepository.findByExecutionId(profileA, executionId);
			expect(history.status).toBe("terminal");
			expect(history.outcome).toBe("response");
		});
	});

	describe("cookie jar persistence", () => {
		const setCookie = (value) => ({ name: "Set-Cookie", value });

		mtest("persists, replaces, deletes, and clears cookies per profile", async () => {
			const service = createCookieService({ sessionId: "persist-session", isStoreReady: () => true });
			const stored = await service.storeResponseCookies({
				profileId: profileA,
				url: "http://api.demo.test/login",
				responseHeaders: [setCookie("sid=one; Path=/"), setCookie("theme=light; Path=/app")],
			});
			expect(stored.stored).toBe(2);
			expect(stored.warnings).toEqual([]);

			await service.storeResponseCookies({
				profileId: profileA,
				url: "http://api.demo.test/login",
				responseHeaders: [setCookie("sid=two; Path=/; Max-Age=3600")],
			});
			const listed = await service.list(profileA);
			expect(listed.cookies.map((cookie) => [cookie.name, cookie.value, cookie.session]).sort()).toEqual([
				["sid", "two", false],
				["theme", "light", true],
			]);

			await service.storeResponseCookies({
				profileId: profileB,
				url: "http://api.demo.test/login",
				responseHeaders: [setCookie("sid=other-profile; Path=/")],
			});
			expect((await service.list(profileB)).cookies.map((cookie) => cookie.value)).toEqual(["other-profile"]);

			await service.remove(profileA, listed.cookies.find((cookie) => cookie.name === "theme").id);
			expect((await service.list(profileA)).cookies.map((cookie) => cookie.name)).toEqual(["sid"]);
			let crossProfileError = null;
			try {
				await service.remove(profileB, listed.cookies.find((cookie) => cookie.name === "theme").id);
			} catch (error) {
				crossProfileError = error;
			}
			expect(crossProfileError).toMatchObject({ code: "COOKIE_NOT_FOUND", statusCode: 404 });

			await service.clear(profileA);
			expect((await service.list(profileA)).cookies).toEqual([]);
			expect((await service.list(profileB)).cookies).toHaveLength(1);
		});

		mtest("persistent cookies survive a restart while session cookies do not", async () => {
			const first = createCookieService({ sessionId: "session-one", isStoreReady: () => true });
			await first.storeResponseCookies({
				profileId: profileA,
				url: "https://api.demo.test/login",
				responseHeaders: [setCookie("session=one; Path=/; Secure"), setCookie("persistent=two; Path=/; Secure; Max-Age=86400")],
			});

			const restarted = createCookieService({ sessionId: "session-two", isStoreReady: () => true });
			const applied = await restarted.applyToRequest({ profileId: profileA, url: "https://api.demo.test/", headers: [] });
			expect(applied.headers).toEqual([{ name: "Cookie", value: "persistent=two" }]);
			expect((await restarted.list(profileA)).cookies.map((cookie) => [cookie.name, cookie.session])).toEqual([
				["persistent", false],
			]);
		});

		mtest("expired cookies are purged and never sent", async () => {
			const service = createCookieService({ sessionId: "expiry-session", isStoreReady: () => true });
			await service.storeResponseCookies({
				profileId: profileA,
				url: "http://api.demo.test/",
				responseHeaders: [setCookie("ephemeral=1; Path=/; Max-Age=1")],
			});
			await ProfileCookie.updateOne(
				{ ownerProfileId: profileA, name: "ephemeral" },
				{ $set: { expiresAt: new Date(Date.now() - 1000) } },
			);
			const applied = await service.applyToRequest({ profileId: profileA, url: "http://api.demo.test/", headers: [] });
			expect(applied.headers).toEqual([]);
			expect((await service.list(profileA)).cookies).toEqual([]);
		});

		mtest("host-only and domain cookies keep their scope through Mongo", async () => {
			const service = createCookieService({ sessionId: "scope-session", isStoreReady: () => true });
			await service.storeResponseCookies({
				profileId: profileA,
				url: "http://api.demo.test/app/start",
				responseHeaders: [setCookie("hostonly=1"), setCookie("shared=1; Domain=demo.test; Path=/app")],
			});
			const sibling = await service.applyToRequest({ profileId: profileA, url: "http://cdn.demo.test/app/page", headers: [] });
			expect(sibling.headers).toEqual([{ name: "Cookie", value: "shared=1" }]);
			const rootOnly = await service.applyToRequest({ profileId: profileA, url: "http://api.demo.test/other", headers: [] });
			expect(rootOnly.headers).toEqual([]);
			const scoped = await service.applyToRequest({ profileId: profileA, url: "http://api.demo.test/app/page", headers: [] });
			expect(scoped.headers.at(-1).value).toBe("hostonly=1; shared=1");
		});

		mtest("a repeated name and path replaces instead of duplicating", async () => {
			const service = createCookieService({ sessionId: "dup-session", isStoreReady: () => true });
			await service.storeResponseCookies({
				profileId: profileA,
				url: "http://api.demo.test/",
				responseHeaders: [setCookie("same=root; Path=/"), setCookie("same=deep; Path=/deep"), setCookie("same=deep2; Path=/deep")],
			});
			const applied = await service.applyToRequest({ profileId: profileA, url: "http://api.demo.test/deep/page", headers: [] });
			expect(applied.headers.at(-1).value).toBe("same=deep2; same=root");
		});
	});

	describe("restart and reset", () => {
		mtest("a backend restart between write and read preserves user-created state", async () => {
			const created = await collectionService.create({ name: "Survives restart" }, profileA);
			await collectionService.replace(
				String(created._id),
				profileA,
				created.revision,
				aggregate("Survives restart", { description: "persisted" }),
			);

			await disconnectTestDatabase();
			expect(await connectTestDatabase()).toBe(true);

			const afterRestart = await collectionService.get(String(created._id), profileA);
			expect(afterRestart.name).toBe("Survives restart");
			expect(afterRestart.description).toBe("persisted");
			expect(afterRestart.revision).toBe(2);
		});
	});
});
