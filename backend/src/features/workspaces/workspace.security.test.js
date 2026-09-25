/**
 * Phase 24 — Collaboration + Versioning security tests.
 *
 * Proves the authorization boundary moved from resource ownership to workspace
 * membership, that the capability matrix fails closed, that a removed member loses
 * access immediately, and that saved shared definitions never carry a resolved
 * credential from one profile to another.
 */
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getConfig, initConfig } from "../../shared/config/index.js";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { WorkspaceAccount } from "../auth/workspace-account.model.js";
import { Collection } from "../collections/collection.model.js";
import { collectionService } from "../collections/collection.service.js";
import { Environment } from "../environments/environment.model.js";
import { environmentService } from "../environments/environment.service.js";
import { Profile } from "../profiles/profile.model.js";
import { filterAuthorizedProfiles, profileService } from "../profiles/profile.service.js";
import { WorkspaceActivity } from "./workspace-activity.model.js";
import { Workspace } from "./workspace.model.js";
import { sanitizeActivityMetadata } from "./workspace-activity.js";
import { capabilitiesFor, hasCapability } from "./workspace-roles.js";
import { assertScopeCapability } from "./workspace-scope.js";
import { workspaceService } from "./workspace.service.js";
import { requireWorkspaceCapability, resolveWorkspaceContext } from "../../shared/middleware/workspace-context.js";

const ALEX = new mongoose.Types.ObjectId("64b00000000000000000a002");
const JORDAN = new mongoose.Types.ObjectId("64b00000000000000000a003");
const CASEY = new mongoose.Types.ObjectId("64b00000000000000000a004");

const SHARED_TOKEN = "phase24-shared-demo-token-value";
const PRIVATE_TOKEN = "phase24-alex-private-token-value";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase3_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase24-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase24-test-jwt-secret";
process.env.DEMO_LOCAL_TOKEN = SHARED_TOKEN;
process.env.DEMO_ALEX_PRIVATE_TOKEN = PRIVATE_TOKEN;
process.env.SERVER_SECRET_ALIASES_JSON = JSON.stringify([
	{ alias: "shared_token", env: "DEMO_LOCAL_TOKEN", profileIds: [] },
	{ alias: "alex_private_token", env: "DEMO_ALEX_PRIVATE_TOKEN", profileIds: [String(ALEX)] },
]);
const priorAliases = process.env.SERVER_SECRET_ALIASES_JSON;
initConfig();

const ready = await connectTestDatabase();
if (ready) {
	await Promise.all([
		Collection.init(),
		Environment.init(),
		Workspace.init(),
		WorkspaceActivity.init(),
		Profile.init(),
		WorkspaceAccount.init(),
	]);
}

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
		{ name: "Alex Morgan", email: "alex.morgan@example.test", passwordHash: "x", allowedProfileIds: [ALEX] },
		{ name: "Jordan Lee", email: "jordan.lee@example.test", passwordHash: "x", allowedProfileIds: [JORDAN] },
	]);
}

async function scopeFor(profileId, workspaceId) {
	const { workspace, role } = await workspaceService.resolveContext({ profileId, requestedWorkspaceId: workspaceId });
	return { workspaceId: String(workspace._id), actorProfileId: String(profileId), role };
}

async function sharedWorkspace(roleForJordan = "VIEWER") {
	const created = await workspaceService.create({ name: "API Platform Team" }, ALEX);
	await workspaceService.addMember(created._id, ALEX, {
		email: "jordan.lee@example.test",
		role: roleForJordan,
		expectedRevision: created.revision,
	});
	return created._id;
}

function fakeRequest({ profileId, header = null, query = {} }) {
	return {
		profileId,
		query,
		get: (name) => (name.toLowerCase() === "x-workspace-id" ? header : undefined),
	};
}

function runMiddleware(middleware, request) {
	return new Promise((resolve) => {
		middleware(request, {}, (error) => resolve({ error: error ?? null, request }));
	});
}

const COLLECTION_INPUT = { name: "Orders API", description: "", variables: [], auth: { mode: "none" }, folders: [], requests: [] };

describe.skipIf(!ready)("collaboration security", () => {
	beforeAll(() => initConfig());
	beforeEach(async () => {
		await Promise.all([
			WorkspaceActivity.deleteMany({ actorProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
			Workspace.deleteMany({ ownerProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
			Collection.deleteMany({ ownerProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
			Environment.deleteMany({ ownerProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
			WorkspaceAccount.deleteMany({ email: { $in: ["alex.morgan@example.test", "jordan.lee@example.test"] } }),
			Profile.deleteMany({ _id: { $in: [ALEX, JORDAN, CASEY] } }),
		]);
		await seedProfiles();
	});
	afterAll(async () => {
		process.env.SERVER_SECRET_ALIASES_JSON = priorAliases ?? "";
		initConfig();
		await disconnectTestDatabase();
	});

	describe("capability matrix", () => {
		mtest("unknown or missing roles grant nothing", () => {
			expect(capabilitiesFor(null)).toBeNull();
			expect(capabilitiesFor("ADMIN")).toBeNull();
			expect(capabilitiesFor("owner")).toBeNull();
			for (const capability of ["read", "execute", "writeCollections", "manageMembers"]) {
				expect(hasCapability(undefined, capability)).toBe(false);
				expect(hasCapability("VIEWER", capability)).toBe(capability === "read");
			}
			expect(hasCapability("EDITOR", "manageMembers")).toBe(false);
			expect(hasCapability("EDITOR", "renameWorkspace")).toBe(false);
			expect(hasCapability("EDITOR", "execute")).toBe(true);
		});

		mtest("a viewer can read the shared definitions but cannot write or execute", async () => {
			const workspaceId = await sharedWorkspace("VIEWER");
			const viewerScope = await scopeFor(JORDAN, workspaceId);
			await environmentService.create({ name: "Local", variables: [] }, await scopeFor(ALEX, workspaceId));
			expect((await environmentService.list(viewerScope)).map((item) => item.name)).toEqual(["Local"]);

			const write = await expectRejection(collectionService.create(COLLECTION_INPUT, viewerScope), {
				statusCode: 403,
				code: "WORKSPACE_FORBIDDEN",
			});
			expect(write.details).toMatchObject({ requiredCapability: "writeCollections", role: "VIEWER" });
			await expectRejection(environmentService.create({ name: "Nope", variables: [] }, viewerScope), {
				statusCode: 403,
				code: "WORKSPACE_FORBIDDEN",
			});
			expect(() => assertScopeCapability(viewerScope, "execute")).toThrow();
		});

		mtest("the execute gate rejects viewers and admits editors at the route boundary", () => {
			const middleware = requireWorkspaceCapability("execute");
			const viewer = fakeRequest({ profileId: String(JORDAN) });
			viewer.workspaceRole = "VIEWER";
			return runMiddleware(middleware, viewer).then(({ error }) => {
				expect(error).toMatchObject({ statusCode: 403, code: "WORKSPACE_FORBIDDEN" });
				const editor = fakeRequest({ profileId: String(JORDAN) });
				editor.workspaceRole = "EDITOR";
				return runMiddleware(middleware, editor).then(({ error: allowed }) => {
					expect(allowed).toBeNull();
					const unknown = fakeRequest({ profileId: String(JORDAN) });
					unknown.workspaceRole = undefined;
					return runMiddleware(middleware, unknown).then(({ error: denied }) => {
						expect(denied).toMatchObject({ statusCode: 403 });
					});
				});
			});
		});
	});

	describe("workspace context middleware", () => {
		mtest("a forged workspace header cannot reach a workspace the profile is not in", async () => {
			const workspaceId = await sharedWorkspace("VIEWER");
			const outsider = await workspaceService.create({ name: "Casey private" }, CASEY);
			// A member presenting a valid workspace header is accepted.
			const member = await runMiddleware(
				resolveWorkspaceContext,
				fakeRequest({ profileId: String(JORDAN), header: String(workspaceId) }),
			);
			expect(member.error).toBeNull();
			expect(member.request.workspaceId).toBe(String(workspaceId));
			expect(member.request.workspaceRole).toBe("VIEWER");
			expect(member.request.workspaceCapabilities).toMatchObject({ execute: false, manageMembers: false });
			expect(member.request.workspaceScope).toMatchObject({ actorProfileId: String(JORDAN) });

			// A non-member presenting someone else's workspace id is refused.
			const intruder = await runMiddleware(
				resolveWorkspaceContext,
				fakeRequest({ profileId: String(JORDAN), header: String(outsider._id) }),
			);
			expect(intruder.error).toMatchObject({ statusCode: 403, code: "WORKSPACE_FORBIDDEN" });

			// An unknown workspace id is a 404 and never creates a workspace.
			const unknown = await runMiddleware(
				resolveWorkspaceContext,
				fakeRequest({ profileId: String(JORDAN), header: new mongoose.Types.ObjectId().toString() }),
			);
			expect(unknown.error).toMatchObject({ statusCode: 404, code: "WORKSPACE_NOT_FOUND" });

			// No selected profile is a hard 401 before any workspace is resolved.
			const anonymous = await runMiddleware(resolveWorkspaceContext, fakeRequest({ profileId: null }));
			expect(anonymous.error).toMatchObject({ statusCode: 401, code: "PROFILE_REQUIRED" });
		});

		mtest("removing a member revokes access on the very next request", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			expect(
				(
					await runMiddleware(
						resolveWorkspaceContext,
						fakeRequest({ profileId: String(JORDAN), header: String(workspaceId) }),
					)
				).error,
			).toBeNull();
			const afterRemove = await workspaceService.removeMember(workspaceId, ALEX, {
				profileId: String(JORDAN),
				expectedRevision: 2,
			});
			expect(afterRemove.memberCount).toBe(1);
			const revoked = await runMiddleware(
				resolveWorkspaceContext,
				fakeRequest({ profileId: String(JORDAN), header: String(workspaceId) }),
			);
			expect(revoked.error).toMatchObject({ statusCode: 403, code: "WORKSPACE_FORBIDDEN" });
			// Jordan still owns their own personal workspace, so access loss is scoped.
			const personal = await workspaceService.resolveContext({ profileId: JORDAN });
			expect(personal.role).toBe("OWNER");
			expect(String(personal.workspace._id)).not.toBe(String(workspaceId));
		});
	});

	describe("credential isolation", () => {
		mtest("secret aliases are scoped to the requesting profile", () => {
			expect(environmentService.resolveSecretAlias(String(ALEX), "shared_token")).toBe(SHARED_TOKEN);
			expect(environmentService.resolveSecretAlias(String(ALEX), "alex_private_token")).toBe(PRIVATE_TOKEN);
			expect(environmentService.resolveSecretAlias(String(JORDAN), "alex_private_token")).toBeNull();
			expect(environmentService.resolveSecretAlias(String(JORDAN), "unknown_alias")).toBeNull();
			expect(environmentService.secretAliases(String(JORDAN)).map((entry) => entry.alias)).toEqual(["shared_token"]);
			expect(environmentService.secretAliases(String(ALEX)).map((entry) => entry.alias)).toEqual([
				"shared_token",
				"alex_private_token",
			]);
		});

		mtest("a shared environment shares only definitions, never a resolved credential", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const alexScope = await scopeFor(ALEX, workspaceId);
			const jordanScope = await scopeFor(JORDAN, workspaceId);
			const created = await environmentService.create(
				{
					name: "Shared local",
					variables: [
						{ id: new mongoose.Types.ObjectId().toString(), key: "base_url", kind: "plain", value: "http://127.0.0.1:8000", enabled: true },
						{ id: new mongoose.Types.ObjectId().toString(), key: "orders_token", kind: "secretRef", alias: "alex_private_token", enabled: true },
					],
				},
				alexScope,
			);

			const asJordan = await environmentService.get(created._id, jordanScope);
			const serialized = JSON.stringify(asJordan);
			expect(serialized).not.toContain(PRIVATE_TOKEN);
			expect(serialized).not.toContain(SHARED_TOKEN);
			expect(asJordan.variables.find((variable) => variable.key === "orders_token")).toMatchObject({
				kind: "secretRef",
				alias: "alex_private_token",
			});

			// The stored document never held a resolved value either, even though Alex
			// authored it while holding the private credential.
			const stored = await Environment.findById(created._id).lean();
			expect(JSON.stringify(stored)).not.toContain(PRIVATE_TOKEN);
			expect(stored.variables.some((variable) => variable.value === PRIVATE_TOKEN)).toBe(false);

			// A collaborator's own secret resolution still works for shared aliases.
			expect(environmentService.resolveSecretAlias(String(JORDAN), "shared_token")).toBe(SHARED_TOKEN);
		});
	});

	describe("activity redaction", () => {
		mtest("credential-shaped keys and nested payloads are dropped from metadata", () => {
			expect(
				sanitizeActivityMetadata({
					authorization: "Bearer abc",
					cookie: "session=1",
					api_key: "k",
					token: "t",
					body: { big: true },
					headers: ["x"],
					value: "secret",
					revision: 3,
					field: "name",
					changed: ["name", "description"],
				}),
			).toEqual({ revision: 3, field: "name", changed: ["name", "description"] });
			expect(sanitizeActivityMetadata({ blob: "x".repeat(4000) }).blob.length).toBe(200);
			const oversized = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, "x".repeat(200)]));
			expect(sanitizeActivityMetadata(oversized)).toEqual({});
			expect(sanitizeActivityMetadata(null)).toEqual({});
			expect(sanitizeActivityMetadata({ name: "y".repeat(500) }).name.length).toBe(200);
		});

		mtest("the persisted feed never records a secret value", async () => {
			const workspaceId = await sharedWorkspace("EDITOR");
			const alexScope = await scopeFor(ALEX, workspaceId);
			await environmentService.create(
				{
					name: "Shared local",
					variables: [
						{ id: new mongoose.Types.ObjectId().toString(), key: "orders_token", kind: "secretRef", alias: "alex_private_token", enabled: true },
					],
				},
				alexScope,
			);
			await collectionService.create(COLLECTION_INPUT, alexScope);
			const raw = JSON.stringify(await WorkspaceActivity.find({ workspaceId }).lean());
			expect(raw).not.toContain(PRIVATE_TOKEN);
			expect(raw).not.toContain(SHARED_TOKEN);
			expect(raw).not.toMatch(/authorization|bearer|cookie|password/i);
		});
	});

	describe("account and workspace isolation", () => {
		mtest("an account only sees the profiles it is allowed to select", async () => {
			const all = await profileService.list();
			expect(all.length).toBeGreaterThanOrEqual(3);
			const jordanOnly = await profileService.list({ allowedProfileIds: [String(JORDAN)] });
			expect(jordanOnly.map((profile) => profile.email)).toEqual(["jordan.lee@example.test"]);
			expect(filterAuthorizedProfiles([{ _id: ALEX }, { _id: JORDAN }], [String(JORDAN)])).toEqual([{ _id: JORDAN }]);
			// A missing allow-list keeps the historical "all profiles" behaviour.
			expect(filterAuthorizedProfiles([{ _id: ALEX }], undefined)).toHaveLength(1);
		});

		mtest("a workspace is only listed for, and readable by, its members", async () => {
			const workspaceId = await sharedWorkspace("VIEWER");
			const jordanList = await workspaceService.listForProfile(JORDAN);
			expect(jordanList.map((entry) => entry.name)).toContain("API Platform Team");
			expect(jordanList.every((entry) => entry.role === "VIEWER" || entry.isPersonal)).toBe(true);

			const caseyList = await workspaceService.listForProfile(CASEY);
			expect(caseyList.map((entry) => entry.name)).not.toContain("API Platform Team");

			await expectRejection(workspaceService.get(workspaceId, CASEY), { statusCode: 403, code: "WORKSPACE_FORBIDDEN" });
			await expectRejection(workspaceService.listActivity(workspaceId, CASEY, {}), {
				statusCode: 403,
				code: "WORKSPACE_FORBIDDEN",
			});
			await expectRejection(
				workspaceService.addMember(workspaceId, JORDAN, { email: "casey.wu@example.test", role: "EDITOR", expectedRevision: 2 }),
				{ statusCode: 403, code: "WORKSPACE_FORBIDDEN" },
			);
			await expectRejection(workspaceService.rename(workspaceId, JORDAN, { name: "Stolen", expectedRevision: 2 }), {
				statusCode: 403,
				code: "WORKSPACE_FORBIDDEN",
			});
		});

		mtest("configured secret aliases are the only ones the process knows about", () => {
			expect(getConfig().secretAliases.map((entry) => entry.alias)).toEqual(["shared_token", "alex_private_token"]);
			expect(getConfig().secretAliases.every((entry) => entry.env.startsWith("DEMO_"))).toBe(true);
		});
	});
});
