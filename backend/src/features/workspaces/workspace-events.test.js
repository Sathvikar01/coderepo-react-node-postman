/**
 * Phase 24B — live workspace event origin identity.
 *
 * The broker must tag each advisory event with the originating browser session
 * so that session can recognise its own echo, while a different session on the
 * same profile still receives the event intact. These tests drive the real
 * middleware context into `recordWorkspaceActivity` and read what the broker
 * would deliver.
 */
import mongoose from "mongoose";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { captureClientOrigin, currentClientOrigin, normalizeClientOrigin } from "../../shared/middleware/client-origin.js";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { WorkspaceAccount } from "../auth/workspace-account.model.js";
import { Collection } from "../collections/collection.model.js";
import { collectionService } from "../collections/collection.service.js";
import { Profile } from "../profiles/profile.model.js";
import { WorkspaceActivity } from "./workspace-activity.model.js";
import { publishWorkspaceEvent, replayAfter, resetWorkspaceEventBroker, subscribeWorkspace } from "./workspace-events.js";
import { Workspace } from "./workspace.model.js";
import { workspaceService } from "./workspace.service.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase3_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase24b-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase24b-test-jwt-secret";
initConfig();

const ready = await connectTestDatabase();
if (ready) {
	await Promise.all([Collection.init(), Workspace.init(), WorkspaceActivity.init(), Profile.init(), WorkspaceAccount.init()]);
}

const ALEX = new mongoose.Types.ObjectId("64b00000000000000000b001");
const TEST_TIMEOUT_MS = 20000;
const mtest = (name, fn) => test(name, fn, TEST_TIMEOUT_MS);

function collectionInput(name) {
	return {
		name,
		description: "",
		variables: [],
	auth: { mode: "none" },
		folders: [],
		requests: [
			{
				schemaVersion: 1,
				id: new mongoose.Types.ObjectId().toString(),
				folderId: null,
				name: "List orders",
				method: "GET",
				urlTemplate: "https://example.test/orders",
				query: [],
				headers: [],
				body: { mode: "none" },
				auth: { mode: "none" },
				settings: { timeoutMs: 15000 },
			},
		],
	};
}

function fakeRequest(origin) {
	return { get: (header) => (header.toLowerCase() === "x-tracer-origin" ? origin : undefined) };
}

async function withOrigin(origin, work) {
	return new Promise((resolve, reject) => {
		captureClientOrigin(fakeRequest(origin), {}, async () => {
			try {
				resolve(await work());
			} catch (error) {
				reject(error);
			}
		});
	});
}

describe("client origin normalization", () => {
	test("accepts a bounded opaque session token and trims surrounding whitespace", () => {
		expect(normalizeClientOrigin("  session-abc.123  ")).toBe("session-abc.123");
	});

	test("rejects missing, oversized, and control-character values", () => {
		expect(normalizeClientOrigin(undefined)).toBeNull();
		expect(normalizeClientOrigin("")).toBeNull();
		expect(normalizeClientOrigin("x".repeat(129))).toBeNull();
		expect(normalizeClientOrigin("bad value with spaces")).toBeNull();
		expect(normalizeClientOrigin("line\nbreak")).toBeNull();
	});

	test("currentClientOrigin is only visible inside the captured context", () => {
		expect(currentClientOrigin()).toBeNull();
		return withOrigin("session-1", () => {
			expect(currentClientOrigin()).toBe("session-1");
		});
	});
});

describe("broker event origin", () => {
	beforeEach(() => resetWorkspaceEventBroker());

	test("keeps a caller-supplied origin on the published event and replay", () => {
		const event = publishWorkspaceEvent({ workspaceId: "ws-1", action: "collection.updated", originClientId: "session-A" });
		expect(event.originClientId).toBe("session-A");
		expect(replayAfter("ws-1", null).map((entry) => entry.originClientId)).toEqual(["session-A"]);
	});

	test("defaults to null when no session is known", () => {
		const event = publishWorkspaceEvent({ workspaceId: "ws-2", action: "collection.updated" });
		expect(event.originClientId).toBeNull();
	});

	test("does not collapse two sessions that share a profile", () => {
		publishWorkspaceEvent({ workspaceId: "ws-3", action: "collection.updated", actorProfileId: "p1", originClientId: "session-A" });
		publishWorkspaceEvent({ workspaceId: "ws-3", action: "collection.updated", actorProfileId: "p1", originClientId: "session-B" });
		expect(replayAfter("ws-3", null).map((entry) => entry.originClientId)).toEqual(["session-A", "session-B"]);
	});
});

describe.skipIf(!ready)("recorded activity carries the request session origin", () => {
	beforeEach(async () => {
		resetWorkspaceEventBroker();
		await Promise.all([
			Collection.deleteMany({ ownerProfileId: ALEX }),
			WorkspaceActivity.deleteMany({ actorProfileId: ALEX }),
			Workspace.deleteMany({ ownerProfileId: ALEX }),
			WorkspaceAccount.deleteMany({ email: "alex.origin@example.test" }),
			Profile.deleteMany({ _id: ALEX }),
		]);
		await Profile.create({ _id: ALEX, name: "Alex Morgan", email: "alex.morgan.origin@example.test", avatarColor: "#4F46E5", sortOrder: 0 });
		await WorkspaceAccount.create({ name: "Alex", email: "alex.origin@example.test", passwordHash: "$2a$10$not-a-real-hash", allowedProfileIds: [ALEX] });
	});
	afterAll(disconnectTestDatabase);

	mtest("tags the collection.created event with the exact session origin", async () => {
		const workspace = await workspaceService.create({ name: "Origin Team" }, ALEX);
		const workspaceId = String(workspace._id);
		const seen = [];
		const unsubscribe = subscribeWorkspace(workspaceId, ALEX, {
			send: (event) => seen.push(event),
			close: () => {},
		});
		try {
			await withOrigin("session-A", () =>
				collectionService.create(collectionInput("Orders"), { workspaceId, actorProfileId: String(ALEX), role: "OWNER" }),
			);
		} finally {
			unsubscribe();
		}
		const created = seen.find((event) => event.action === "collection.created");
		expect(created).toBeTruthy();
		expect(created.originClientId).toBe("session-A");
	});

	mtest("distinguishes two sessions on the same profile in the delivered stream", async () => {
		const workspace = await workspaceService.create({ name: "Two Session Team" }, ALEX);
		const workspaceId = String(workspace._id);
		const scope = { workspaceId, actorProfileId: String(ALEX), role: "OWNER" };
		const seen = [];
		const unsubscribe = subscribeWorkspace(workspaceId, ALEX, {
			send: (event) => seen.push(event),
			close: () => {},
		});
		try {
			await withOrigin("session-A", () => collectionService.create(collectionInput("First"), scope));
			await withOrigin("session-B", () => collectionService.create(collectionInput("Second"), scope));
		} finally {
			unsubscribe();
		}
		const created = seen.filter((event) => event.action === "collection.created");
		expect(created.map((event) => event.originClientId)).toEqual(["session-A", "session-B"]);
	});

	mtest("records a null origin for a seed/CLI write outside a request context", async () => {
		const workspace = await workspaceService.create({ name: "No Origin Team" }, ALEX);
		const workspaceId = String(workspace._id);
		const seen = [];
		const unsubscribe = subscribeWorkspace(workspaceId, ALEX, {
			send: (event) => seen.push(event),
			close: () => {},
		});
		try {
			await collectionService.create(collectionInput("Plain"), { workspaceId, actorProfileId: String(ALEX), role: "OWNER" });
		} finally {
			unsubscribe();
		}
		const created = seen.find((event) => event.action === "collection.created");
		expect(created.originClientId).toBeNull();
	});
});
