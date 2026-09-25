/**
 * Phase 24 — Collaboration + Versioning domain tests.
 *
 * These tests exercise the persisted Workspace domain end to end against MongoDB:
 * membership/role resolution, revision-checked membership mutations, workspace-scoped
 * collections and environments, workspace-aware preferences, the bounded activity feed,
 * and the boundary between shared definitions and profile-scoped execution history.
 *
 * The permission matrix and credential-isolation guarantees are covered separately in
 * `workspace.security.test.js`.
 */
import mongoose from "mongoose";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { WorkspaceAccount } from "../auth/workspace-account.model.js";
import { Collection } from "../collections/collection.model.js";
import { collectionService } from "../collections/collection.service.js";
import { Environment } from "../environments/environment.model.js";
import { environmentService } from "../environments/environment.service.js";
import { ExecutionHistory } from "../history/history.model.js";
import { historyRepository } from "../history/history.repository.js";
import { historyService } from "../history/history.service.js";
import { Profile } from "../profiles/profile.model.js";
import { ProfilePreference } from "../profiles/preference.model.js";
import { preferenceService } from "../profiles/profile.service.js";
import { WorkspaceActivity } from "./workspace-activity.model.js";
import { Workspace } from "./workspace.model.js";
import { workspaceService } from "./workspace.service.js";
import { resolveScope } from "./workspace-scope.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase3_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase24-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase24-test-jwt-secret";
initConfig();

const ready = await connectTestDatabase();
if (ready) {
	// `syncIndexes` (not `init`) so the declared partial uniqueness contracts are the
	// ones actually enforced: a non-partial `ownerProfileId_1_nameKey_1` left over from
	// the pre-collaboration schema would reject legitimate cross-workspace name reuse.
	await Promise.all([
		Collection.syncIndexes(),
		Environment.syncIndexes(),
		ProfilePreference.init(),
		ExecutionHistory.init(),
		Workspace.init(),
		WorkspaceActivity.init(),
		Profile.init(),
		WorkspaceAccount.init(),
	]);
}

const ALEX = new mongoose.Types.ObjectId("64b00000000000000000a002");
const JORDAN = new mongoose.Types.ObjectId("64b00000000000000000a003");
const CASEY = new mongoose.Types.ObjectId("64b00000000000000000a004");

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
		{ _id: ALEX, name: "Alex Morgan", email: "alex.morgan@example.test", avatarColor: "#4F46E5", sortOrder: 0 },
		{ _id: JORDAN, name: "Jordan Lee", email: "jordan.lee@example.test", avatarColor: "#059669", sortOrder: 1 },
		{ _id: CASEY, name: "Casey Wu", email: "casey.wu@example.test", avatarColor: "#DC2626", sortOrder: 2 },
	]);
	await WorkspaceAccount.insertMany([
		{
			name: "Jordan Lee",
			email: "jordan.lee@example.test",
			passwordHash: "$2a$10$not-a-real-hash",
			allowedProfileIds: [JORDAN],
		},
		{
			name: "Casey Wu",
			email: "casey.wu@example.test",
			passwordHash: "$2a$10$not-a-real-hash",
			allowedProfileIds: [CASEY],
		},
	]);
}

// Mirrors what `resolveWorkspaceContext` attaches in a real request.
async function scopeFor(profileId, workspaceId) {
	const { workspace, role } = await workspaceService.resolveContext({ profileId, requestedWorkspaceId: workspaceId });
	return { workspaceId: String(workspace._id), actorProfileId: String(profileId), role };
}

async function sharedWorkspace(roleForJordan = "EDITOR") {
	const created = await workspaceService.create({ name: "API Platform Team" }, ALEX);
	await workspaceService.addMember(created._id, ALEX, {
		email: "jordan.lee@example.test",
		role: roleForJordan,
		expectedRevision: created.revision,
	});
	return created._id;
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
		settings: { timeoutMs: 15000 },
	};
}

function collectionInput(name, extra = {}) {
	return { name, description: "", variables: [], auth: { mode: "none" }, folders: [], requests: [requestDoc("List orders")], ...extra };
}

describe.skipIf(!ready)("collaboration and versioning", () => {
	beforeEach(async () => {
		await Promise.all([
			WorkspaceActivity.deleteMany({ actorProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
			Workspace.deleteMany({ ownerProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
			Collection.deleteMany({ ownerProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
			Environment.deleteMany({ ownerProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
			ProfilePreference.deleteMany({ ownerProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
			ExecutionHistory.deleteMany({ ownerProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
			WorkspaceAccount.deleteMany({ email: { $in: ["jordan.lee@example.test", "casey.wu@example.test"] } }),
			Profile.deleteMany({ _id: { $in: [ALEX, JORDAN, CASEY] } }),
		]);
		await seedProfiles();
	});
	afterAll(disconnectTestDatabase);

	describe("workspace membership", () => {
		mtest("creator becomes the sole OWNER and the workspace appears in their list", async () => {
			const created = await workspaceService.create({ name: "API Platform Team" }, ALEX);
			expect(created).toMatchObject({ name: "API Platform Team", role: "OWNER", isPersonal: false, memberCount: 1, revision: 1 });
			expect(created.capabilities).toMatchObject({ manageMembers: true, renameWorkspace: true, execute: true, read: true });

			const summaries = await workspaceService.listForProfile(ALEX);
			expect(summaries.some((entry) => entry._id === created._id && entry.isActive)).toBe(true);

			const activity = await workspaceService.listActivity(created._id, ALEX, {});
			expect(activity.entries[0]).toMatchObject({ action: "workspace.created", actorName: "Alex Morgan" });
		});

		mtest("a shared workspace exposes the real member list with resolved names and emails", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const detail = await workspaceService.get(workspaceId, JORDAN);
			expect(detail.role).toBe("EDITOR");
			expect(detail.members.map((member) => [member.name, member.role])).toEqual([
				["Alex Morgan", "OWNER"],
				["Jordan Lee", "EDITOR"],
			]);
			expect(detail.members.find((member) => member.name === "Jordan Lee")?.isSelf).toBe(true);
		});

		mtest("sharing by email resolves an existing account and rejects unknown or duplicate members", async () => {
			const created = await workspaceService.create({ name: "API Platform Team" }, ALEX);
			await expectRejection(
				workspaceService.addMember(created._id, ALEX, { email: "nobody@example.test", role: "EDITOR", expectedRevision: 1 }),
				{ statusCode: 404, code: "USER_NOT_FOUND" },
			);
			const shared = await workspaceService.addMember(created._id, ALEX, {
				email: "JORDAN.LEE@example.test",
				role: "EDITOR",
				expectedRevision: created.revision,
			});
			expect(shared.revision).toBe(2);
			await expectRejection(
				workspaceService.addMember(created._id, ALEX, { email: "jordan.lee@example.test", role: "VIEWER", expectedRevision: 2 }),
				{ statusCode: 409, code: "MEMBER_EXISTS" },
			);
			const activity = await workspaceService.listActivity(created._id, ALEX, {});
			expect(activity.entries.some((entry) => entry.action === "member.added" && entry.targetLabel === "Jordan Lee")).toBe(true);
		});

		mtest("role changes and removals are revision-checked and take effect immediately", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const afterRole = await workspaceService.changeRole(workspaceId, ALEX, {
				profileId: String(JORDAN),
				role: "VIEWER",
				expectedRevision: 2,
			});
			expect(afterRole.revision).toBe(3);
			const jordanScope = await scopeFor(JORDAN, workspaceId);
			expect(jordanScope.role).toBe("VIEWER");
			await expectRejection(collectionService.create(collectionInput("Blocked"), jordanScope), {
				statusCode: 403,
				code: "WORKSPACE_FORBIDDEN",
			});

			// A stale revision must never silently overwrite a newer membership change.
			await expectRejection(
				workspaceService.changeRole(workspaceId, ALEX, { profileId: String(JORDAN), role: "EDITOR", expectedRevision: 2 }),
				{ statusCode: 409, code: "WORKSPACE_REVISION_CONFLICT" },
			);

			const afterRemove = await workspaceService.removeMember(workspaceId, ALEX, {
				profileId: String(JORDAN),
				expectedRevision: afterRole.revision,
			});
			expect(afterRemove.memberCount).toBe(1);
			await expectRejection(workspaceService.resolveContext({ profileId: JORDAN, requestedWorkspaceId: workspaceId }), {
				statusCode: 403,
				code: "WORKSPACE_FORBIDDEN",
			});
			const activity = await workspaceService.listActivity(workspaceId, ALEX, {});
			expect(activity.entries.map((entry) => entry.action)).toContain("member.removed");
		});

		mtest("a workspace always keeps at least one owner", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			await expectRejection(
				workspaceService.changeRole(workspaceId, ALEX, { profileId: String(ALEX), role: "EDITOR", expectedRevision: 2 }),
				{ statusCode: 409, code: "LAST_OWNER" },
			);
			await expectRejection(workspaceService.removeMember(workspaceId, ALEX, { profileId: String(ALEX), expectedRevision: 2 }), {
				statusCode: 409,
				code: "LAST_OWNER",
			});
			// Promoting a second owner makes the downgrade legal again.
			const promoted = await workspaceService.changeRole(workspaceId, ALEX, {
				profileId: String(JORDAN),
				role: "OWNER",
				expectedRevision: 2,
			});
			const demoted = await workspaceService.changeRole(workspaceId, JORDAN, {
				profileId: String(ALEX),
				role: "EDITOR",
				expectedRevision: promoted.revision,
			});
			expect(demoted.members.filter((member) => member.role === "OWNER").map((member) => member.name)).toEqual(["Jordan Lee"]);
		});

		mtest("workspace names are unique per owner and the member limit is enforced", async () => {
			await workspaceService.create({ name: "Team" }, ALEX);
			await expectRejection(workspaceService.create({ name: "  team  " }, ALEX), {
				statusCode: 409,
				code: "WORKSPACE_NAME_CONFLICT",
			});
			const other = await workspaceService.create({ name: "Team" }, JORDAN);
			expect(other.name).toBe("Team");
		});

		mtest("renaming is owner-only and revision-checked", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			await expectRejection(
				workspaceService.rename(workspaceId, JORDAN, { name: "Renamed", expectedRevision: 2 }),
				{ statusCode: 403, code: "WORKSPACE_FORBIDDEN" },
			);
			const renamed = await workspaceService.rename(workspaceId, ALEX, { name: "Renamed Team", expectedRevision: 2 });
			expect(renamed).toMatchObject({ name: "Renamed Team", revision: 3 });
			await expectRejection(workspaceService.rename(workspaceId, ALEX, { name: "Nope", expectedRevision: 2 }), {
				statusCode: 409,
				code: "WORKSPACE_REVISION_CONFLICT",
			});
		});
	});

	describe("workspace resolution", () => {
		mtest("an explicit workspace id is honored and validated against membership", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const resolved = await workspaceService.resolveContext({ profileId: JORDAN, requestedWorkspaceId: workspaceId });
			expect(String(resolved.workspace._id)).toBe(String(workspaceId));
			expect(resolved.role).toBe("EDITOR");
			const alexPersonal = await workspaceService.ensurePersonalWorkspace(CASEY);
			await expectRejection(
				workspaceService.resolveContext({ profileId: ALEX, requestedWorkspaceId: String(alexPersonal._id) }),
				{ statusCode: 403, code: "WORKSPACE_FORBIDDEN" },
			);
			await expectRejection(workspaceService.resolveContext({ profileId: ALEX, requestedWorkspaceId: "not-an-id" }), {
				statusCode: 404,
				code: "WORKSPACE_NOT_FOUND",
			});
			await expectRejection(
				workspaceService.resolveContext({ profileId: ALEX, requestedWorkspaceId: new mongoose.Types.ObjectId().toString() }),
				{ statusCode: 404, code: "WORKSPACE_NOT_FOUND" },
			);
		});

		mtest("the stored active workspace wins, then the first membership, then a personal workspace", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			await preferenceService.update(JORDAN, { activeWorkspaceId: String(workspaceId) });
			const resolved = await workspaceService.resolveContext({ profileId: JORDAN });
			expect(String(resolved.workspace._id)).toBe(String(workspaceId));
			expect(resolved.role).toBe("EDITOR");

			const fresh = await workspaceService.resolveContext({ profileId: CASEY });
			expect(fresh.role).toBe("OWNER");
			expect(fresh.workspace.personalForProfileId).toBeTruthy();
		});

		mtest("legacy profile scopes and ObjectId scopes converge on one personal workspace", async () => {
			const fromString = await resolveScope(String(ALEX));
			const fromObjectId = await resolveScope(ALEX);
			expect(fromString.scoped).toBe(false);
			expect(fromObjectId.scoped).toBe(false);
			expect(fromString.workspaceId).toBe(fromObjectId.workspaceId);
			expect(await workspaceService.ensurePersonalWorkspace(ALEX)).toMatchObject({
				_id: new mongoose.Types.ObjectId(fromString.workspaceId),
			});
			await expectRejection(resolveScope({ nope: true }), { statusCode: 500, code: "WORKSPACE_SCOPE_REQUIRED" });
		});
	});

	describe("workspace-scoped collections and environments", () => {
		mtest("names are unique inside a workspace but reusable across workspaces", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const alexScope = await scopeFor(ALEX, workspaceId);
			const jordanScope = await scopeFor(JORDAN, workspaceId);
			const created = await collectionService.create(collectionInput("Orders API"), alexScope);
			expect(created.workspaceId.toString()).toBe(String(workspaceId));
			expect(created.createdByProfileId.toString()).toBe(String(ALEX));

			// Same workspace, same name: refused.
			await expectRejection(collectionService.create(collectionInput("orders api"), jordanScope), {
				statusCode: 409,
				code: "COLLECTION_NAME_CONFLICT",
			});
			// A different workspace may reuse the name freely.
			const personal = await workspaceService.ensurePersonalWorkspace(JORDAN);
			const personalScope = await scopeFor(JORDAN, String(personal._id));
			const other = await collectionService.create(collectionInput("Orders API"), personalScope);
			expect(other.workspaceId.toString()).toBe(String(personal._id));

			// Neither workspace can read the other's collection.
			await expectRejection(collectionService.get(other._id, alexScope), { statusCode: 404, code: "COLLECTION_NOT_FOUND" });
			await expectRejection(collectionService.get(created._id, personalScope), { statusCode: 404, code: "COLLECTION_NOT_FOUND" });
		});

		mtest("listing is limited to the active workspace", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const shared = await collectionService.create(collectionInput("Shared orders"), await scopeFor(ALEX, workspaceId));
			const personal = await workspaceService.ensurePersonalWorkspace(ALEX);
			await collectionService.create(collectionInput("Private notes"), await scopeFor(ALEX, String(personal._id)));

			const listedShared = await collectionService.list(await scopeFor(JORDAN, workspaceId));
			expect(listedShared.map((item) => item.name)).toEqual(["Shared orders"]);
			const listedPersonal = await collectionService.list(await scopeFor(ALEX, String(personal._id)));
			expect(listedPersonal.map((item) => item.name)).toEqual(["Private notes"]);
			expect(listedShared.some((item) => String(item._id) === String(shared._id))).toBe(true);

			// A legacy caller with no workspace header gets the historical author-scoped view
			// (both rows were authored by Alex) and never another profile's rows.
			const legacyAlex = await collectionService.list(ALEX);
			expect(legacyAlex.map((item) => item.name).sort()).toEqual(["Private notes", "Shared orders"]);
			const legacyJordan = await collectionService.list(JORDAN);
			expect(legacyJordan).toEqual([]);
		});

		mtest("an editor save is revision-checked and the loser gets attributed conflict details", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const alexScope = await scopeFor(ALEX, workspaceId);
			const jordanScope = await scopeFor(JORDAN, workspaceId);
			const created = await collectionService.create(collectionInput("Orders API"), alexScope);

			// Both collaborators loaded revision 1. Alex saves first.
			const winner = await collectionService.replace(
				created._id,
				alexScope,
				1,
				collectionInput("Orders API", { description: "Saved by Alex" }),
			);
			expect(winner).toMatchObject({ revision: 2, description: "Saved by Alex" });
			expect(winner.updatedByProfileId.toString()).toBe(String(ALEX));

			const conflict = await expectRejection(
				collectionService.replace(
					created._id,
					jordanScope,
					1,
					collectionInput("Orders API", { description: "Saved by Jordan" }),
				),
				{ statusCode: 409, code: "COLLECTION_REVISION_CONFLICT" },
			);
			expect(conflict.details).toMatchObject({
				expectedRevision: 1,
				currentRevision: 2,
				lastUpdatedByProfileId: String(ALEX),
				lastUpdatedByName: "Alex Morgan",
			});
			// The loser's change was not applied, and a reloaded save succeeds.
			expect((await collectionService.get(created._id, jordanScope)).description).toBe("Saved by Alex");
			const retried = await collectionService.replace(
				created._id,
				jordanScope,
				2,
				collectionInput("Orders API", { description: "Saved by Jordan" }),
			);
			expect(retried).toMatchObject({ revision: 3, description: "Saved by Jordan" });
			expect(retried.updatedByProfileId.toString()).toBe(String(JORDAN));
		});

		mtest("deletes are revision-checked, workspace-scoped, and recorded in the activity feed", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const alexScope = await scopeFor(ALEX, workspaceId);
			const jordanScope = await scopeFor(JORDAN, workspaceId);
			const created = await collectionService.create(collectionInput("Orders API"), alexScope);
			await collectionService.replace(created._id, jordanScope, 1, collectionInput("Orders API", { description: "bumped" }));
			await expectRejection(collectionService.remove(created._id, jordanScope, 1), {
				statusCode: 409,
				code: "COLLECTION_REVISION_CONFLICT",
			});
			await collectionService.remove(created._id, jordanScope, 2);
			const activity = await workspaceService.listActivity(workspaceId, ALEX, {});
			expect(activity.entries.map((entry) => entry.action)).toContain("collection.deleted");
			await expectRejection(collectionService.get(created._id, alexScope), { statusCode: 404, code: "COLLECTION_NOT_FOUND" });
		});

		mtest("environments share the same workspace boundary and revision contract", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const alexScope = await scopeFor(ALEX, workspaceId);
			const jordanScope = await scopeFor(JORDAN, workspaceId);
			const created = await environmentService.create({ name: "Staging", variables: [] }, alexScope);
			const visible = await environmentService.list(jordanScope);
			expect(visible.map((item) => item.name)).toEqual(["Staging"]);

			const bumped = await environmentService.replace(created._id, jordanScope, 1, { name: "Staging", variables: [] });
			expect(bumped.revision).toBe(2);
			await expectRejection(environmentService.replace(created._id, alexScope, 1, { name: "Staging", variables: [] }), {
				statusCode: 409,
				code: "ENVIRONMENT_REVISION_CONFLICT",
			});

			const personal = await workspaceService.ensurePersonalWorkspace(JORDAN);
			await expectRejection(environmentService.get(created._id, await scopeFor(JORDAN, String(personal._id))), {
				statusCode: 404,
				code: "ENVIRONMENT_NOT_FOUND",
			});
		});
	});

	describe("activity feed", () => {
		mtest("the feed is newest-first, attributed, bounded, and paged", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const alexScope = await scopeFor(ALEX, workspaceId);
			for (const name of ["One", "Two", "Three"]) await collectionService.create(collectionInput(name), alexScope);

			const page = await workspaceService.listActivity(workspaceId, JORDAN, { limit: 3 });
			expect(page.limit).toBe(3);
			expect(page.entries.length).toBe(3);
			expect(page.total).toBeGreaterThan(3);
			expect(page.entries[0].createdAt.getTime()).toBeGreaterThanOrEqual(page.entries[2].createdAt.getTime());
			expect(page.entries.every((entry) => typeof entry.actorName === "string")).toBe(true);

			const cursor = page.entries.at(-1).createdAt.toISOString();
			const next = await workspaceService.listActivity(workspaceId, JORDAN, { limit: 3, before: cursor });
			expect(next.entries.every((entry) => entry.createdAt.getTime() < new Date(cursor).getTime())).toBe(true);
			await expectRejection(workspaceService.listActivity(workspaceId, JORDAN, { before: "not-a-date" }), {
				statusCode: 400,
				code: "VALIDATION_ERROR",
			});
		});

		mtest("the feed never stores authorization, cookie, or secret material", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			await workspaceService.rename(workspaceId, ALEX, { name: "Renamed", expectedRevision: 2 });
			const raw = await WorkspaceActivity.find({ workspaceId }).lean();
			const serialized = JSON.stringify(raw);
			expect(serialized).not.toMatch(/authorization|cookie|bearer|password|api[_-]?key/i);
			expect(raw.every((entry) => Object.keys(entry.metadata ?? {}).every((key) => !/token|secret|value|header/i.test(key)))).toBe(true);
		});
	});

	describe("workspace-aware preferences", () => {
		mtest("the active workspace must be one the profile belongs to", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const other = await workspaceService.create({ name: "Private" }, CASEY);
			await expectRejection(preferenceService.update(JORDAN, { activeWorkspaceId: other._id }), {
				statusCode: 403,
				code: "WORKSPACE_FORBIDDEN",
			});
			const updated = await preferenceService.update(JORDAN, { activeWorkspaceId: String(workspaceId) });
			expect(updated.activeWorkspaceId).toBe(String(workspaceId));
		});

		mtest("active environment and collection order are validated against the active workspace", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const jordanScope = await scopeFor(JORDAN, workspaceId);
			const sharedEnv = await environmentService.create({ name: "Local", variables: [] }, jordanScope);
			const sharedCollection = await collectionService.create(collectionInput("Orders"), jordanScope);
			const personal = await workspaceService.ensurePersonalWorkspace(JORDAN);
			const personalEnv = await environmentService.create(
				{ name: "Local", variables: [] },
				await scopeFor(JORDAN, String(personal._id)),
			);

			// Pointing at a resource from another workspace is refused outright.
			await expectRejection(
				preferenceService.update(JORDAN, { activeEnvironmentId: String(personalEnv._id) }, workspaceId),
				{ statusCode: 404, code: "ENVIRONMENT_NOT_FOUND" },
			);
			// And a collection order that mixes workspaces is refused.
			await expectRejection(
				preferenceService.update(JORDAN, { collectionOrder: [String(sharedCollection._id)] }, String(personal._id)),
				{ statusCode: 403, code: "COLLECTION_FORBIDDEN" },
			);

			const scoped = await preferenceService.update(
				JORDAN,
				{ activeEnvironmentId: String(sharedEnv._id), collectionOrder: [String(sharedCollection._id)] },
				workspaceId,
			);
			expect(scoped.activeEnvironmentId).toBe(String(sharedEnv._id));
			expect(scoped.collectionOrder).toEqual([String(sharedCollection._id)]);

			// Reading with a different workspace filters the stale ids back out.
			const personalView = await preferenceService.get(JORDAN, String(personal._id));
			expect(personalView.activeEnvironmentId).toBeNull();
			expect(personalView.collectionOrder).toEqual([]);
		});

		mtest("legacy preference reads and writes without a workspace still work unchanged", async () => {
			const created = await collectionService.create(collectionInput("Legacy"), ALEX);
			const updated = await preferenceService.update(ALEX, { collectionOrder: [String(created._id)], theme: "light" });
			expect(updated).toMatchObject({ theme: "light", collectionOrder: [String(created._id)] });
			const reread = await preferenceService.get(ALEX);
			expect(reread).toMatchObject({ theme: "light", collectionOrder: [String(created._id)] });
		});
	});

	describe("shared definitions do not share private evidence", () => {
		mtest("execution history stays profile-scoped even inside a shared workspace", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const executionId = new mongoose.Types.ObjectId().toString();
			await historyRepository.insertAdmission({
				ownerProfileId: ALEX,
				executionId,
				fingerprint: `fp-${executionId}`,
				fingerprintKeyId: "v1",
				instanceId: "phase24-test",
				status: "running",
				effectCertainty: "not_dispatched",
				persistence: { state: "saved" },
				request: { name: "Alex private probe", method: "GET" },
				context: { tabId: "tab-1", draftVersion: 1 },
				snapshot: { displayUrl: "https://example.test/private" },
				startedAt: new Date(),
			});

			const alexHistory = await historyService.list(ALEX, { limit: 10 });
			expect(alexHistory.items.map((item) => item.executionId)).toContain(executionId);
			const jordanHistory = await historyService.list(JORDAN, { limit: 10 });
			expect(jordanHistory.items).toEqual([]);
			expect(await historyService.get(JORDAN, executionId)).toBeNull();
			// Jordan is a full EDITOR of the shared workspace and still cannot see it.
			expect((await scopeFor(JORDAN, workspaceId)).role).toBe("EDITOR");
		});
	});
});
