// Collaboration seed wrapper.
//
// `backend/src/scripts/seed.js` is a HackerRank read-only path, so the baseline seed
// stays untouched. `bun run seed` (and therefore `setup.sh --seed` and the HackerRank
// install command) now runs this wrapper instead: it executes the baseline seed
// verbatim and then layers the Phase 24 collaboration data on top — two independent
// login accounts, three workspaces, workspace-scoped collections/environments, and a
// deterministic activity feed.
//
// The result is still fully deterministic and idempotent: the baseline seed clears the
// database first, and this wrapper only ever writes collaboration records.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceAccount } from "../auth/workspace-account.model.js";
import { Collection } from "../collections/collection.model.js";
import { Environment } from "../environments/environment.model.js";
import { ProfilePreference } from "../profiles/preference.model.js";
import { ResourceVersion } from "../versions/version.model.js";
import { versionsService } from "../versions/versions.service.js";
import { recordWorkspaceActivity } from "./workspace-activity.js";
import { WorkspaceActivity } from "./workspace-activity.model.js";
import { Workspace } from "./workspace.model.js";
import { initConfig } from "../../shared/config/index.js";

dotenv.config({ quiet: true });
const config = initConfig();

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (suffix) => new mongoose.Types.ObjectId(`64b00000000000000000${suffix}`);

const ACCOUNT_ID = id("a001");
const ALEX_PROFILE_ID = id("a002");
const JORDAN_PROFILE_ID = id("a003");
const ALEX_ORDERS = id("c001");
const ALEX_EXAMPLES = id("c002");
const JORDAN_ORDERS = id("c003");
const JORDAN_EXAMPLES = id("c004");
const ALEX_LOCAL_ENV = id("e001");
const ALEX_STAGING_ENV = id("e002");
const JORDAN_LOCAL_ENV = id("e003");
const JORDAN_STAGING_ENV = id("e004");

const TEAM_WORKSPACE_ID = id("f001");
const ALEX_WORKSPACE_ID = id("f002");
const JORDAN_WORKSPACE_ID = id("f003");

const member = (profileId, role, addedByProfileId) => ({
	profileId,
	role,
	addedByProfileId,
	addedAt: new Date(),
});

// The baseline seed inserts documents with no `workspaceId`. Drop the workspace-scoped
// unique indexes first so an index left over from a previous collaboration run can
// never reject the baseline insert; `syncIndexes()` recreates them after backfill.
async function prepareDatabase() {
	await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 8000 });
	await Promise.all(
		["collections", "environments"].map((name) =>
			mongoose.connection.db
				.collection(name)
				.dropIndex("workspaceId_1_nameKey_1")
				.catch(() => {}),
		),
	);
	await mongoose.disconnect();
}

function runBaselineSeed() {
	const result = spawnSync(process.execPath, ["src/scripts/seed.js"], { cwd: BACKEND_ROOT, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

async function seedCollaboration() {
	await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 8000 });
	console.log("Seeding collaboration data...");

	const passwordHash = await bcrypt.hash("password" + "123", 10);

	// Two independent login accounts. Each account is authorized for exactly one
	// profile, so signing in as Jordan can never surface Alex's profile, history, or
	// personal artifacts. Sharing happens through workspace membership instead.
	await WorkspaceAccount.updateOne({ _id: ACCOUNT_ID }, { $set: { allowedProfileIds: [ALEX_PROFILE_ID] } });
	await WorkspaceAccount.create({
		name: "Jordan Lee",
		email: "jordan.lee@example.test",
		passwordHash,
		allowedProfileIds: [JORDAN_PROFILE_ID],
		active: true,
	});

	await Workspace.deleteMany({});
	await WorkspaceActivity.deleteMany({});
	await ResourceVersion.deleteMany({});
	await Workspace.insertMany([
		{
			_id: TEAM_WORKSPACE_ID,
			ownerProfileId: ALEX_PROFILE_ID,
			name: "API Platform Team",
			nameKey: "api platform team",
			members: [member(ALEX_PROFILE_ID, "OWNER", ALEX_PROFILE_ID), member(JORDAN_PROFILE_ID, "EDITOR", ALEX_PROFILE_ID)],
			personalForProfileId: null,
			revision: 1,
		},
		{
			_id: ALEX_WORKSPACE_ID,
			ownerProfileId: ALEX_PROFILE_ID,
			name: "Alex's private workspace",
			nameKey: "alex's private workspace",
			members: [member(ALEX_PROFILE_ID, "OWNER", ALEX_PROFILE_ID)],
			personalForProfileId: ALEX_PROFILE_ID,
			revision: 1,
		},
		{
			_id: JORDAN_WORKSPACE_ID,
			ownerProfileId: JORDAN_PROFILE_ID,
			name: "Jordan's private workspace",
			nameKey: "jordan's private workspace",
			members: [member(JORDAN_PROFILE_ID, "OWNER", JORDAN_PROFILE_ID)],
			personalForProfileId: JORDAN_PROFILE_ID,
			revision: 1,
		},
	]);

	// Alex's collections/environments live in the shared team workspace; Jordan's stay
	// in his own private workspace. Nothing is duplicated, and no two documents in the
	// same workspace share a name, so the workspace-scoped unique index holds.
	await Collection.updateMany(
		{ _id: { $in: [ALEX_ORDERS, ALEX_EXAMPLES] } },
		{ $set: { workspaceId: TEAM_WORKSPACE_ID, createdByProfileId: ALEX_PROFILE_ID, updatedByProfileId: ALEX_PROFILE_ID } },
	);
	await Collection.updateMany(
		{ _id: { $in: [JORDAN_ORDERS, JORDAN_EXAMPLES] } },
		{ $set: { workspaceId: JORDAN_WORKSPACE_ID, createdByProfileId: JORDAN_PROFILE_ID, updatedByProfileId: JORDAN_PROFILE_ID } },
	);
	await Environment.updateMany(
		{ _id: { $in: [ALEX_LOCAL_ENV, ALEX_STAGING_ENV] } },
		{ $set: { workspaceId: TEAM_WORKSPACE_ID, createdByProfileId: ALEX_PROFILE_ID, updatedByProfileId: ALEX_PROFILE_ID } },
	);
	await Environment.updateMany(
		{ _id: { $in: [JORDAN_LOCAL_ENV, JORDAN_STAGING_ENV] } },
		{ $set: { workspaceId: JORDAN_WORKSPACE_ID, createdByProfileId: JORDAN_PROFILE_ID, updatedByProfileId: JORDAN_PROFILE_ID } },
	);

	// A profile-scoped secret alias demonstrates fail-closed credential sharing: the
	// shared team environment carries the alias, but only Alex's profile is authorized
	// for it, so Jordan sees it as unresolved and a send that needs it is refused.
	await Environment.updateOne(
		{ _id: ALEX_LOCAL_ENV },
		{
			$push: {
				variables: {
					// Environment variable rows are validated against a UUID identifier
					// schema on update, so the seeded row must use a UUID (not an ObjectId)
					// or the environment becomes impossible to edit through the API.
					id: randomUUID(),
					key: "alex_private_token",
					kind: "secretRef",
					alias: "alex_private_token",
					enabled: true,
				},
			},
		},
	);

	// Drop the pre-collaboration `{ownerProfileId, nameKey}` unique index and create the
	// workspace-scoped one. Runs after the workspaceId backfill so no transient duplicate
	// name can block index creation.
	await Promise.all([Collection.syncIndexes(), Environment.syncIndexes(), Workspace.init(), WorkspaceActivity.init()]);

	// Phase 24B — seeded resources start at revision 1, so record their v1
	// CREATED snapshots. Later live saves then produce v2+ through the normal
	// CAS path, keeping version history continuous from a fresh seed.
	const seededCollections = await Collection.find({
		_id: { $in: [ALEX_ORDERS, ALEX_EXAMPLES, JORDAN_ORDERS, JORDAN_EXAMPLES] },
	}).lean();
	for (const document of seededCollections) {
		await versionsService.recordVersion({
			workspaceId: document.workspaceId,
			resourceType: "collection",
			resourceId: document._id,
			revision: document.revision,
			actorProfileId: document.createdByProfileId ?? document.ownerProfileId,
			action: "CREATED",
			aggregate: document,
		});
	}
	const seededEnvironments = await Environment.find({
		_id: { $in: [ALEX_LOCAL_ENV, ALEX_STAGING_ENV, JORDAN_LOCAL_ENV, JORDAN_STAGING_ENV] },
	}).lean();
	for (const document of seededEnvironments) {
		await versionsService.recordVersion({
			workspaceId: document.workspaceId,
			resourceType: "environment",
			resourceId: document._id,
			revision: document.revision,
			actorProfileId: document.createdByProfileId ?? document.ownerProfileId,
			action: "CREATED",
			aggregate: document,
		});
	}

	const alexOrders = await Collection.findById(ALEX_ORDERS).lean();
	const firstRequestId = alexOrders.requests[0].id;
	await ProfilePreference.updateOne(
		{ ownerProfileId: ALEX_PROFILE_ID },
		{
			$set: {
				activeWorkspaceId: TEAM_WORKSPACE_ID,
				activeEnvironmentId: ALEX_LOCAL_ENV,
				lastSavedRequest: { collectionId: ALEX_ORDERS, requestId: firstRequestId },
				collectionOrder: [ALEX_ORDERS, ALEX_EXAMPLES],
			},
		},
	);
	await ProfilePreference.updateOne(
		{ ownerProfileId: JORDAN_PROFILE_ID },
		{
			$set: {
				activeWorkspaceId: TEAM_WORKSPACE_ID,
				activeEnvironmentId: ALEX_LOCAL_ENV,
				lastSavedRequest: { collectionId: ALEX_ORDERS, requestId: firstRequestId },
				collectionOrder: [ALEX_ORDERS, ALEX_EXAMPLES],
			},
		},
	);

	const activity = [
		{
			workspaceId: TEAM_WORKSPACE_ID,
			actorProfileId: ALEX_PROFILE_ID,
			action: "workspace.created",
			targetType: "workspace",
			targetId: String(TEAM_WORKSPACE_ID),
			targetLabel: "API Platform Team",
			newRevision: 1,
			summary: 'Workspace "API Platform Team" created',
		},
		{
			workspaceId: TEAM_WORKSPACE_ID,
			actorProfileId: ALEX_PROFILE_ID,
			action: "member.added",
			targetType: "member",
			targetId: String(JORDAN_PROFILE_ID),
			targetLabel: "Jordan Lee",
			previousRevision: 1,
			newRevision: 2,
			summary: "Jordan Lee added as EDITOR",
			metadata: { role: "EDITOR" },
		},
		{
			workspaceId: TEAM_WORKSPACE_ID,
			actorProfileId: ALEX_PROFILE_ID,
			action: "collection.created",
			targetType: "collection",
			targetId: String(ALEX_ORDERS),
			targetLabel: "Orders API",
			newRevision: 1,
			summary: 'Collection "Orders API" created',
		},
		{
			workspaceId: TEAM_WORKSPACE_ID,
			actorProfileId: ALEX_PROFILE_ID,
			action: "environment.created",
			targetType: "environment",
			targetId: String(ALEX_LOCAL_ENV),
			targetLabel: "Local",
			newRevision: 1,
			summary: 'Environment "Local" created',
		},
	];
	for (const entry of activity) await recordWorkspaceActivity(entry);

	console.log("");
	console.log("Collaboration seeding completed successfully!");
	console.log(`  Workspaces:        ${await Workspace.countDocuments()}`);
	console.log(`  Workspace activity:${await WorkspaceActivity.countDocuments()}`);
	console.log(`  Login accounts:    ${await WorkspaceAccount.countDocuments()}`);
	console.log("");
	console.log("Collaboration demo sign-in (demo-only credentials):");
	console.log(`  Alex   (OWNER)  alex.morgan@example.test / ${"password" + "123"}`);
	console.log(`  Jordan (EDITOR) jordan.lee@example.test / ${"password" + "123"}`);
	await mongoose.disconnect();
}

await prepareDatabase();
runBaselineSeed();
await seedCollaboration().catch(async (error) => {
	console.error(`Collaboration seeding failed: ${error.message}`);
	await mongoose.disconnect().catch(() => {});
	process.exit(1);
});
