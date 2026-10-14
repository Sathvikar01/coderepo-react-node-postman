/**
 * Phase 24B — version history and live stream security tests.
 *
 * Proves the workspace boundary holds for versions and events: outsiders and
 * removed members get nothing, VIEWERs cannot restore, cross-workspace version
 * ids fail closed, snapshots and event payloads carry no credential material,
 * and restore still honors CAS.
 */
import mongoose from "mongoose";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { Collection } from "../collections/collection.model.js";
import { collectionService } from "../collections/collection.service.js";
import { Environment } from "../environments/environment.model.js";
import { environmentService } from "../environments/environment.service.js";
import { Profile } from "../profiles/profile.model.js";
import { WorkspaceAccount } from "../auth/workspace-account.model.js";
import { Workspace } from "../workspaces/workspace.model.js";
import { WorkspaceActivity } from "../workspaces/workspace-activity.model.js";
import { workspaceService } from "../workspaces/workspace.service.js";
import { streamWorkspaceEvents } from "../workspaces/workspace.controller.js";
import {
	closeStreamsForProfile,
	publishWorkspaceEvent,
	replayAfter,
	resetWorkspaceEventBroker,
	subscribeWorkspace,
} from "../workspaces/workspace-events.js";
import { ResourceVersion } from "./version.model.js";
import { versionsService } from "./versions.service.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase3_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase24b-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase24b-test-jwt-secret";
initConfig();

const ready = await connectTestDatabase();
if (ready) {
	await Promise.all([
		Collection.syncIndexes(),
		Environment.syncIndexes(),
		Workspace.init(),
		WorkspaceActivity.init(),
		Profile.init(),
		WorkspaceAccount.init(),
		ResourceVersion.init(),
	]);
}

const ALEX = new mongoose.Types.ObjectId("64b00000000000000000c002");
const JORDAN = new mongoose.Types.ObjectId("64b00000000000000000c003");
const CASEY = new mongoose.Types.ObjectId("64b00000000000000000c004");
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
	return caught;
}

function requestDoc(name) {
	return {
		schemaVersion: 1,
		id: new mongoose.Types.ObjectId().toString(),
		folderId: null,
		name,
		method: "GET",
		urlTemplate: "https://example.test/orders",
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		scripts: { preRequest: "", test: "" },
		assertions: [],
		settings: { timeoutMs: 15000 },
	};
}

async function seedProfiles() {
	await Profile.insertMany([
		{ _id: ALEX, name: "Alex Morgan", email: "alex.24bs@example.test", avatarColor: "#4F46E5", sortOrder: 0 },
		{ _id: JORDAN, name: "Jordan Lee", email: "jordan.24bs@example.test", avatarColor: "#059669", sortOrder: 1 },
		{ _id: CASEY, name: "Casey Wu", email: "casey.24bs@example.test", avatarColor: "#DC2626", sortOrder: 2 },
	]);
	await WorkspaceAccount.insertMany([
		{ name: "Alex Morgan", email: "alex.24bs@example.test", passwordHash: "$2a$10$not-a-real-hash", allowedProfileIds: [ALEX] },
		{ name: "Jordan Lee", email: "jordan.24bs@example.test", passwordHash: "$2a$10$not-a-real-hash", allowedProfileIds: [JORDAN] },
		{ name: "Casey Wu", email: "casey.24bs@example.test", passwordHash: "$2a$10$not-a-real-hash", allowedProfileIds: [CASEY] },
	]);
}

async function scopeFor(profileId, workspaceId) {
	const { workspace, role } = await workspaceService.resolveContext({ profileId, requestedWorkspaceId: workspaceId });
	return { workspaceId: String(workspace._id), actorProfileId: String(profileId), role };
}

const outsiderScope = (workspaceId) => ({ workspaceId: String(workspaceId), actorProfileId: String(CASEY), role: null });

function sseHarness(profileId, workspaceId) {
	const written = [];
	let ended = false;
	let nextError = null;
	const request = {
		params: { workspaceId: String(workspaceId) },
		profileId: String(profileId),
		query: {},
		get: () => null,
		on: () => {},
	};
	const response = {
		writeHead: () => {},
		flushHeaders: () => {},
		write: (chunk) => written.push(String(chunk)),
		end: () => {
			ended = true;
		},
	};
	const next = (error) => {
		nextError = error;
	};
	return { request, response, next, written, ended: () => ended, error: () => nextError };
}

describe("phase 24B version/stream security", () => {
	beforeEach(async () => {
		resetWorkspaceEventBroker();
		if (!ready) return;
		await Promise.all([
			Collection.deleteMany({}),
			Environment.deleteMany({}),
			Profile.deleteMany({}),
			WorkspaceAccount.deleteMany({}),
			Workspace.deleteMany({}),
			WorkspaceActivity.deleteMany({}),
			ResourceVersion.deleteMany({}),
		]);
		await seedProfiles();
	});

	mtest("outsider cannot list, inspect, compare, or restore versions", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const scope = await scopeFor(ALEX, workspaceId);
		const created = await collectionService.create(
			{ name: "Orders API", description: "", variables: [], auth: { mode: "none" }, folders: [], requests: [requestDoc("List")] },
			scope,
		);
		const outsider = outsiderScope(workspaceId);
		await expectRejection(versionsService.list("collection", created._id, outsider), { statusCode: 403, code: "WORKSPACE_FORBIDDEN" });
		await expectRejection(versionsService.get("collection", created._id, 1, outsider), { statusCode: 403, code: "WORKSPACE_FORBIDDEN" });
		await expectRejection(versionsService.compare("collection", created._id, 1, 1, outsider), { statusCode: 403, code: "WORKSPACE_FORBIDDEN" });
		await expectRejection(
			versionsService.restore("collection", created._id, outsider, { sourceRevision: 1, expectedCurrentRevision: 1 }),
			{ statusCode: 403, code: "WORKSPACE_FORBIDDEN" },
		);
	});

	mtest("outsider cannot subscribe to the workspace event stream", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const harness = sseHarness(CASEY, workspaceId);
		await streamWorkspaceEvents(harness.request, harness.response, harness.next);
		expect(harness.error()).toMatchObject({ statusCode: 403, code: "WORKSPACE_FORBIDDEN" });
		expect(harness.written.join("")).not.toContain("text/event-stream");
	});

	mtest("removed member stream closes and receives no future events", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const received = [];
		let closed = false;
		const unsubscribe = subscribeWorkspace(workspaceId, JORDAN, {
			send: (event) => received.push(event),
			close: () => {
				closed = true;
			},
		});
		// Jordan is still subscribed: a collection event reaches them.
		publishWorkspaceEvent({ workspaceId, action: "collection.updated", resourceType: "collection", resourceId: "c1", revision: 2, actorProfileId: ALEX });
		expect(received).toHaveLength(1);
		expect(closed).toBe(false);
		// Removal closes the stream with the removal notice as the last event.
		publishWorkspaceEvent({ workspaceId, action: "member.removed", resourceType: "member", resourceId: String(JORDAN), actorProfileId: ALEX });
		expect(closed).toBe(true);
		expect(received[received.length - 1].action).toBe("member.removed");
		const countAfterRemoval = received.length;
		publishWorkspaceEvent({ workspaceId, action: "collection.updated", resourceType: "collection", resourceId: "c1", revision: 3, actorProfileId: ALEX });
		expect(received).toHaveLength(countAfterRemoval);
		unsubscribe();
	});

	mtest("removed member cannot re-subscribe and next canonical request stays 403", async () => {
		if (!ready) return;
		let workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		await workspaceService.addMember(workspaceId, ALEX, { email: "jordan.24bs@example.test", role: "EDITOR", expectedRevision: 1 });
		const detail = await workspaceService.get(String(workspaceId), ALEX);
		await workspaceService.removeMember(workspaceId, ALEX, { profileId: String(JORDAN), expectedRevision: detail.revision });
		const harness = sseHarness(JORDAN, workspaceId);
		await streamWorkspaceEvents(harness.request, harness.response, harness.next);
		expect(harness.error()).toMatchObject({ statusCode: 403, code: "WORKSPACE_FORBIDDEN" });
		await expectRejection(workspaceService.resolveContext({ profileId: JORDAN, requestedWorkspaceId: workspaceId }), {
			statusCode: 403,
			code: "WORKSPACE_FORBIDDEN",
		});
	});

	mtest("VIEWER can inspect and compare but cannot restore", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		await workspaceService.addMember(workspaceId, ALEX, { email: "jordan.24bs@example.test", role: "VIEWER", expectedRevision: 1 });
		const alexScope = await scopeFor(ALEX, workspaceId);
		const jordanScope = await scopeFor(JORDAN, workspaceId);
		const created = await collectionService.create(
			{ name: "Orders API", description: "", variables: [], auth: { mode: "none" }, folders: [], requests: [requestDoc("List")] },
			alexScope,
		);
		const rows = await versionsService.list("collection", created._id, jordanScope);
		expect(rows).toHaveLength(1);
		const compared = await versionsService.compare("collection", created._id, 1, 1, jordanScope);
		expect(compared.identical).toBe(true);
		await expectRejection(
			versionsService.restore("collection", created._id, jordanScope, { sourceRevision: 1, expectedCurrentRevision: 1 }),
			{ statusCode: 403, code: "WORKSPACE_FORBIDDEN" },
		);
	});

	mtest("cross-workspace version id access fails closed", async () => {
		if (!ready) return;
		const workspaceA = await workspaceService.create({ name: "Team A" }, ALEX).then((workspace) => workspace._id);
		const workspaceB = await workspaceService.create({ name: "Team B" }, ALEX).then((workspace) => workspace._id);
		const scopeA = await scopeFor(ALEX, workspaceA);
		const scopeB = await scopeFor(ALEX, workspaceB);
		const created = await environmentService.create({ name: "Prod", variables: [] }, scopeA);
		// Same resource id is invisible from workspace B: the loader gates first.
		await expectRejection(versionsService.list("environment", created._id, scopeB), { statusCode: 404 });
		await expectRejection(versionsService.get("environment", created._id, 1, scopeB), { statusCode: 404 });
	});

	mtest("version snapshots and streamed events carry no credential material", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const scope = await scopeFor(ALEX, workspaceId);
		const created = await collectionService.create(
			{
				name: "Orders API",
				description: "",
				variables: [],
				auth: { mode: "none" },
				folders: [],
				requests: [
					requestDoc("Call", {
						headers: [{ id: new mongoose.Types.ObjectId().toString(), key: "Authorization", value: "Bearer top-secret-live", enabled: true }],
					}),
				],
			},
			scope,
		);
		const [row] = await versionsService.list("collection", created._id, scope);
		const snapshotText = JSON.stringify(row.snapshot);
		expect(snapshotText).not.toContain("top-secret-live");
		const compared = await versionsService.compare("collection", created._id, 1, 1, scope);
		expect(JSON.stringify(compared)).not.toContain("top-secret-live");
		const event = publishWorkspaceEvent({
			workspaceId,
			action: "collection.updated",
			resourceType: "collection",
			resourceId: String(created._id),
			revision: 1,
			actorProfileId: ALEX,
			actorName: "Alex Morgan",
		});
		const envelope = JSON.stringify(event);
		expect(envelope).not.toContain("top-secret-live");
		expect(envelope).not.toContain("Bearer");
		// `originClientId` is an opaque, client-generated per-session correlation token:
		// it authorizes nothing, carries no credential, and is null when no request
		// context produced the event (seed/CLI writes).
		expect(event.originClientId).toBeNull();
		expect(Object.keys(event).sort()).toEqual(
			[
				"action",
				"actorName",
				"actorProfileId",
				"id",
				"originClientId",
				"resourceId",
				"resourceType",
				"revision",
				"timestamp",
				"workspaceId",
			].sort(),
		);
	});

	mtest("stream handler replays missed events and supports closeStreamsForProfile", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const first = publishWorkspaceEvent({ workspaceId, action: "collection.created", resourceType: "collection", resourceId: "c1", revision: 1, actorProfileId: ALEX });
		publishWorkspaceEvent({ workspaceId, action: "collection.updated", resourceType: "collection", resourceId: "c1", revision: 2, actorProfileId: ALEX });
		expect(replayAfter(workspaceId, first.id)).toHaveLength(1);
		// workspaceService.create also persists a workspace.created activity row,
		// which the broker relays: replay holds it plus the two published events.
		expect(replayAfter(workspaceId, null)).toHaveLength(3);
		let closed = false;
		subscribeWorkspace(workspaceId, ALEX, { send: () => {}, close: () => { closed = true; } });
		expect(closeStreamsForProfile(workspaceId, ALEX)).toBe(1);
		expect(closed).toBe(true);
	});
});

afterAll(async () => {
	resetWorkspaceEventBroker();
	await disconnectTestDatabase();
});
