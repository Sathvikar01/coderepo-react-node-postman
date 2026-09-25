/**
 * Phase 24B — immutable resource version history domain tests.
 *
 * Covers version recording on create/update, snapshot safety (credential
 * scrubbing, secretRef preservation), retry-safe idempotent writes, bounded
 * retention, deterministic compare, restore-as-new-revision with CAS, and
 * version cleanup on resource delete — for both collections and environments.
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
import { ResourceVersion } from "./version.model.js";
import { versionRepository } from "./version.repository.js";
import { versionsService } from "./versions.service.js";
import { diffSnapshots } from "./compare.js";
import { buildSafeSnapshot, snapshotHoldsSecrets } from "./snapshot.js";

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

const ALEX = new mongoose.Types.ObjectId("64b00000000000000000b002");
const JORDAN = new mongoose.Types.ObjectId("64b00000000000000000b003");
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

async function seedProfiles() {
	await Profile.insertMany([
		{ _id: ALEX, name: "Alex Morgan", email: "alex.24b@example.test", avatarColor: "#4F46E5", sortOrder: 0 },
		{ _id: JORDAN, name: "Jordan Lee", email: "jordan.24b@example.test", avatarColor: "#059669", sortOrder: 1 },
	]);
	await WorkspaceAccount.insertMany([
		{ name: "Alex Morgan", email: "alex.24b@example.test", passwordHash: "$2a$10$not-a-real-hash", allowedProfileIds: [ALEX] },
		{ name: "Jordan Lee", email: "jordan.24b@example.test", passwordHash: "$2a$10$not-a-real-hash", allowedProfileIds: [JORDAN] },
	]);
}

async function scopeFor(profileId, workspaceId) {
	const { workspace, role } = await workspaceService.resolveContext({ profileId, requestedWorkspaceId: workspaceId });
	return { workspaceId: String(workspace._id), actorProfileId: String(profileId), role };
}

function requestDoc(name, overrides = {}) {
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
		...overrides,
	};
}

function collectionInput(name, requests = [requestDoc("List orders")]) {
	return {
		name,
		description: "",
		variables: [],
		auth: { mode: "none" },
		folders: [],
		requests,
	};
}

describe("phase 24B version history", () => {
	beforeEach(async () => {
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

	mtest("collection create records an immutable v1 CREATED version", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const scope = await scopeFor(ALEX, workspaceId);
		const created = await collectionService.create(collectionInput("Orders API"), scope);
		const rows = await versionsService.list("collection", created._id, scope);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			revision: 1,
			action: "CREATED",
			resourceId: String(created._id),
			actorProfileId: String(ALEX),
			actorName: "Alex Morgan",
		});
		expect(rows[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(rows[0].snapshot.name).toBe("Orders API");
		expect(rows[0].snapshot.requests).toHaveLength(1);
	});

	mtest("collection update records v2 UPDATED with a new fingerprint", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const scope = await scopeFor(ALEX, workspaceId);
		const created = await collectionService.create(collectionInput("Orders API"), scope);
		const [original] = created.requests;
		const updated = await collectionService.replace(created._id, scope, 1, {
			...collectionInput("Orders API"),
			requests: [{ ...original, method: "POST" }],
		});
		expect(updated.revision).toBe(2);
		const rows = await versionsService.list("collection", created._id, scope);
		expect(rows.map((row) => row.revision)).toEqual([2, 1]);
		expect(rows[0].action).toBe("UPDATED");
		expect(rows[0].actorName).toBe("Alex Morgan");
		expect(rows[0].previousRevision).toBe(1);
		expect(rows[0].fingerprint).not.toBe(rows[1].fingerprint);
	});

	mtest("snapshots scrub literal header credentials but keep structure", async () => {
		if (!ready) return;
		const aggregate = collectionInput("Secured", [
			requestDoc("Call", {
				headers: [
					{ id: new mongoose.Types.ObjectId().toString(), key: "Authorization", value: "Bearer live-token-123", enabled: true },
					{ id: new mongoose.Types.ObjectId().toString(), key: "X-Tenant", value: "acme", enabled: true },
				],
			}),
		]);
		const snapshot = buildSafeSnapshot("collection", aggregate);
		expect(snapshot.requests[0].headers).toHaveLength(2);
		expect(snapshot.requests[0].headers[0]).toMatchObject({ key: "Authorization", value: "[redacted]" });
		expect(snapshot.requests[0].headers[1]).toMatchObject({ key: "X-Tenant", value: "acme" });
		expect(snapshotHoldsSecrets(snapshot)).toBe(false);
		expect(JSON.stringify(snapshot)).not.toContain("live-token-123");
	});

	mtest("environment snapshots keep secretRef aliases and never values", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const scope = await scopeFor(ALEX, workspaceId);
		const created = await environmentService.create(
			{
				name: "Production",
				variables: [
					{ id: new mongoose.Types.ObjectId().toString(), key: "base_url", kind: "plain", value: "https://api.example.test", enabled: true },
					{ id: new mongoose.Types.ObjectId().toString(), key: "api_token", kind: "secretRef", alias: "prod-token", enabled: true },
				],
			},
			scope,
		);
		const rows = await versionsService.list("environment", created._id, scope);
		expect(rows).toHaveLength(1);
		expect(rows[0].snapshot.variables).toHaveLength(2);
		expect(rows[0].snapshot.variables[1]).toMatchObject({ kind: "secretRef", alias: "prod-token" });
		expect(rows[0].snapshot.variables[1].value).toBeUndefined();
	});

	mtest("retried version writes do not duplicate history", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const scope = await scopeFor(ALEX, workspaceId);
		const created = await collectionService.create(collectionInput("Orders API"), scope);
		const first = await versionRepository.get("collection", String(created._id), 1);
		const second = await versionsService.recordVersion({
			workspaceId: String(workspaceId),
			resourceType: "collection",
			resourceId: String(created._id),
			revision: 1,
			actorProfileId: String(ALEX),
			action: "CREATED",
			aggregate: created,
		});
		expect(String(second._id)).toBe(String(first._id));
		expect(await versionRepository.count("collection", String(created._id))).toBe(1);
	});

	mtest("retention keeps only the newest 20 versions per resource", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const scope = await scopeFor(ALEX, workspaceId);
		let current = await collectionService.create(collectionInput("Orders API"), scope);
		for (let index = 2; index <= 22; index += 1) {
			current = await collectionService.replace(current._id, scope, current.revision, {
				...collectionInput("Orders API"),
				description: `save ${index}`,
			});
		}
		expect(current.revision).toBe(22);
		const rows = await versionsService.list("collection", current._id, scope);
		expect(rows).toHaveLength(20);
		expect(rows[0].revision).toBe(22);
		expect(rows[rows.length - 1].revision).toBe(3);
		expect(await versionsService.get("collection", current._id, 2, scope).catch(() => null)).toBeNull();
	}, 60000);

	mtest("compare returns deterministic structured paths", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const scope = await scopeFor(ALEX, workspaceId);
		const [kept, removed] = [requestDoc("Keep"), requestDoc("Drop")];
		const created = await collectionService.create(collectionInput("Orders API", [kept, removed]), scope);
		const updated = await collectionService.replace(created._id, scope, 1, {
			...collectionInput("Orders API", [{ ...kept, method: "PATCH" }, requestDoc("Fresh")]),
			variables: [{ id: new mongoose.Types.ObjectId().toString(), key: "base_url", kind: "plain", value: "https://v2.example.test", enabled: true }],
		});
		const result = await versionsService.compare("collection", created._id, 1, updated.revision, scope);
		expect(result.identical).toBe(false);
		expect(result.truncated).toBe(false);
		const paths = result.changes.map((change) => `${change.change} ${change.path}`);
		expect(paths).toContain(`changed requests[id=${kept.id}].method`);
		expect(paths).toContain(`removed requests[id=${removed.id}]`);
		expect(paths).toContain("added variables[key=base_url]");
		// Deterministic across runs: same input order, same output order.
		const again = await versionsService.compare("collection", created._id, 1, updated.revision, scope);
		expect(again.changes).toEqual(result.changes);
		const same = await versionsService.compare("collection", created._id, 2, 2, scope);
		expect(same.identical).toBe(true);
		expect(same.changes).toEqual([]);
	});

	mtest("oversized diffs return a typed truncated result", async () => {
		const before = { name: "A", variables: [], requests: [] };
		const requests = [];
		for (let index = 0; index < 100; index += 1) {
			const id = new mongoose.Types.ObjectId().toString();
			requests.push({ id, name: `r${index}`, urlTemplate: "https://example.test/a" });
		}
		const after = {
			name: "A",
			variables: requests.map((request, index) => ({ key: `var_${index}`, kind: "plain", value: "x", enabled: true })),
			requests: requests.map((request) => ({ ...request, name: `${request.name}-changed`, urlTemplate: "https://example.test/b" })),
		};
		const result = diffSnapshots(
			{ ...before, requests: requests.map((request) => ({ ...request })) },
			after,
		);
		expect(result.truncated).toBe(true);
		expect(result.changes).toHaveLength(200);
	});

	mtest("restore creates a new revision and never rewrites history", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const scope = await scopeFor(ALEX, workspaceId);
		const created = await collectionService.create(collectionInput("Orders API", [requestDoc("List")]), scope);
		const requestId = created.requests[0].id;
		const v2 = await collectionService.replace(created._id, scope, 1, {
			...collectionInput("Orders API"),
			requests: [{ ...created.requests[0], method: "POST" }],
		});
		expect(v2.revision).toBe(2);
		const { resource, version } = await versionsService.restore("collection", created._id, scope, {
			sourceRevision: 1,
			expectedCurrentRevision: 2,
		});
		expect(resource.revision).toBe(3);
		expect(resource.requests.find((request) => request.id === requestId).method).toBe("GET");
		expect(version).toMatchObject({ revision: 3, action: "RESTORED", sourceRevision: 1, previousRevision: 2 });
		// Earlier rows are untouched.
		const v1 = await versionsService.get("collection", created._id, 1, scope);
		expect(v1.action).toBe("CREATED");
		expect(v1.snapshot.requests[0].method).toBe("GET");
		const activity = await workspaceService.listActivity(String(workspaceId), ALEX, {});
		expect(activity.entries.some((entry) => entry.action === "collection.restored")).toBe(true);
	});

	mtest("stale restore returns the attributed 409 without force overwrite", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		await workspaceService.addMember(workspaceId, ALEX, { email: "jordan.24b@example.test", role: "EDITOR", expectedRevision: 1 });
		const alexScope = await scopeFor(ALEX, workspaceId);
		const jordanScope = await scopeFor(JORDAN, workspaceId);
		const created = await collectionService.create(collectionInput("Orders API"), alexScope);
		// Jordan advances the tip after Alex opened the restore dialog.
		await collectionService.replace(created._id, jordanScope, 1, { ...collectionInput("Orders API"), description: "jordan" });
		const error = await expectRejection(
			versionsService.restore("collection", created._id, alexScope, { sourceRevision: 1, expectedCurrentRevision: 1 }),
			{ statusCode: 409, code: "COLLECTION_REVISION_CONFLICT" },
		);
		expect(error.details.lastUpdatedByName).toBe("Jordan Lee");
		const versions = await versionsService.list("collection", created._id, alexScope);
		expect(versions[0]).toMatchObject({ revision: 2, actorProfileId: String(JORDAN), actorName: "Jordan Lee" });
		const current = await collectionService.get(created._id, alexScope);
		expect(current.revision).toBe(2);
	});

	mtest("resource delete removes its version rows", async () => {
		if (!ready) return;
		const workspaceId = await workspaceService.create({ name: "Team" }, ALEX).then((workspace) => workspace._id);
		const scope = await scopeFor(ALEX, workspaceId);
		const created = await collectionService.create(collectionInput("Orders API"), scope);
		await collectionService.remove(created._id, scope, 1);
		expect(await versionRepository.count("collection", String(created._id))).toBe(0);
	});
});

afterAll(async () => {
	await disconnectTestDatabase();
});
