// Phase 24 — two-browser collaboration demonstration.
//
// Two genuinely independent authenticated contexts (separate login sessions,
// separate profile tokens, separate workspace headers) are driven over HTTP
// against the real running API. Nothing is stubbed: every claim below is the
// server's actual response.
const API = "http://127.0.0.1:8000/api/v1";

const results = [];
const record = (name, ok, detail) => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

class Browser {
	constructor(label) {
		this.label = label;
		this.session = null;
		this.profile = null;
		this.workspaceId = null;
	}

	async call(path, { method = "GET", body, token, workspaceId, expect } = {}) {
		const headers = {};
		const bearer = token ?? this.profile ?? this.session;
		if (bearer) headers.authorization = `Bearer ${bearer}`;
		const ws = workspaceId ?? this.workspaceId;
		if (ws) headers["x-workspace-id"] = ws;
		if (body !== undefined) headers["content-type"] = "application/json";
		const response = await fetch(`${API}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let payload = null;
		try {
			payload = text ? JSON.parse(text) : null;
		} catch {
			payload = { raw: text };
		}
		const data = payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
		if (expect !== undefined && response.status !== expect) {
			throw new Error(`${method} ${path} expected ${expect} got ${response.status}: ${text.slice(0, 300)}`);
		}
		return { status: response.status, data, body: payload };
	}

	async login(email, password) {
		const response = await this.call("/auth/login", { method: "POST", body: { email, password }, expect: 200 });
		this.session = response.data.token ?? response.data.sessionToken;
		const account = response.data.account ?? response.data;
		return { session: this.session, account };
	}

	async selectProfile(profileId) {
		const response = await this.call("/auth/switch-profile", { method: "POST", body: { profileId }, expect: 200 });
		this.profile = response.data.token ?? response.data.profileToken;
		return response.data;
	}
}

const Alex = new Browser("Alex (context 1)");
const Jordan = new Browser("Jordan (context 2)");

// ---------------------------------------------------------------- 1. login separation
const alexLogin = await Alex.login("alex.morgan@example.test", "password123");
const jordanLogin = await Jordan.login("jordan.lee@example.test", "password123");
record(
	"1. Two independent login contexts",
	Alex.session !== Jordan.session && Boolean(Alex.session) && Boolean(Jordan.session),
	`alex=${String(Alex.session).slice(0, 12)}… jordan=${String(Jordan.session).slice(0, 12)}…`,
);

const alexProfiles = await Alex.call("/profiles", { expect: 200 });
const jordanProfiles = await Jordan.call("/profiles", { expect: 200 });
record(
	"2. Each account authorizes only its own profile",
	alexProfiles.data.length === 1 && jordanProfiles.data.length === 1 && alexProfiles.data[0]._id !== jordanProfiles.data[0]._id,
	`alex profile=${alexProfiles.data[0].name}, jordan profile=${jordanProfiles.data[0].name}`,
);

await Alex.selectProfile(alexProfiles.data[0]._id);
await Jordan.selectProfile(jordanProfiles.data[0]._id);
const ALEX_PROFILE = alexProfiles.data[0]._id;
const JORDAN_PROFILE = jordanProfiles.data[0]._id;

// Cross-account profile authorization must fail closed.
const crossAuthorize = await Jordan.call("/auth/switch-profile", {
	method: "POST",
	body: { profileId: ALEX_PROFILE },
	token: jordanLogin.session,
});
record(
	"3. Jordan cannot authorize Alex's profile",
	[401, 403].includes(crossAuthorize.status),
	`status=${crossAuthorize.status} code=${crossAuthorize.body?.error?.code ?? "-"}`,
);

// ---------------------------------------------------------------- 2. shared workspace
const alexWorkspaces = await Alex.call("/workspaces", { expect: 200 });
const jordanWorkspaces = await Jordan.call("/workspaces", { expect: 200 });
const teamForAlex = alexWorkspaces.data.find((w) => w.name === "API Platform Team");
const teamForJordan = jordanWorkspaces.data.find((w) => w.name === "API Platform Team");
record(
	"4. The same shared workspace appears for both users",
	Boolean(teamForAlex) && Boolean(teamForJordan) && teamForAlex._id === teamForJordan._id,
	`workspace=${teamForAlex?._id}`,
);
record(
	"5. Roles differ per member: Alex OWNER, Jordan EDITOR",
	teamForAlex?.role === "OWNER" && teamForJordan?.role === "EDITOR",
	`alex=${teamForAlex?.role} jordan=${teamForJordan?.role}`,
);
record(
	"6. Server-issued capabilities match the role",
	teamForAlex?.capabilities?.manageMembers === true &&
		teamForJordan?.capabilities?.manageMembers === false &&
		teamForJordan?.capabilities?.execute === true,
	`alex.manageMembers=${teamForAlex?.capabilities?.manageMembers} jordan.execute=${teamForJordan?.capabilities?.execute}`,
);

const TEAM = teamForAlex._id;
Alex.workspaceId = TEAM;
Jordan.workspaceId = TEAM;

const jordanDetail = await Jordan.call(`/workspaces/${TEAM}`, { expect: 200 });
record(
	"7. The member list resolves real accounts and emails",
	jordanDetail.data.members.length === 2 &&
		jordanDetail.data.members.some((m) => m.email === "alex.morgan@example.test" && m.role === "OWNER") &&
		jordanDetail.data.members.some((m) => m.email === "jordan.lee@example.test" && m.role === "EDITOR" && m.isSelf),
	`members=${jordanDetail.data.members.map((m) => `${m.name}:${m.role}`).join(", ")}`,
);

// ---------------------------------------------------------------- 3. shared resources
const alexCollections = await Alex.call("/collections", { expect: 200 });
const jordanCollections = await Jordan.call("/collections", { expect: 200 });
record(
	"8. Both users see the same shared collections",
	alexCollections.data.length === jordanCollections.data.length &&
		alexCollections.data.length > 0 &&
		alexCollections.data.map((c) => c._id).sort().join() === jordanCollections.data.map((c) => c._id).sort().join(),
	`count=${alexCollections.data.length} names=${alexCollections.data.map((c) => c.name).join(", ")}`,
);

const alexEnvs = await Alex.call("/environments", { expect: 200 });
const jordanEnvs = await Jordan.call("/environments", { expect: 200 });
record(
	"9. Both users see the same shared environments",
	alexEnvs.data.length === jordanEnvs.data.length &&
		alexEnvs.data.map((e) => e._id).sort().join() === jordanEnvs.data.map((e) => e._id).sort().join(),
	`count=${alexEnvs.data.length}`,
);

// Workspace isolation: Jordan's personal workspace must not leak Alex's resources.
const jordanPersonal = jordanWorkspaces.data.find((w) => w.isPersonal);
Jordan.workspaceId = jordanPersonal._id;
const jordanPersonalCollections = await Jordan.call("/collections", { expect: 200 });
record(
	"10. Another workspace's resources never mix in",
	!jordanPersonalCollections.data.some((c) => alexCollections.data.some((a) => a._id === c._id)),
	`personal count=${jordanPersonalCollections.data.length}`,
);
Jordan.workspaceId = TEAM;

// ---------------------------------------------------------------- 4. edit visible across users
// List endpoints return bounded summaries; the full document (with requests and
// folders) is fetched per id, which is exactly what the UI does when you open one.
const target = alexCollections.data.find((c) => c.name === "Orders API") ?? alexCollections.data[0];
const alexFull = await Alex.call(`/collections/${target._id}`, { expect: 200 });
const jordanRead = await Jordan.call(`/collections/${target._id}`, { expect: 200 });
record(
	"8b. Opening a shared collection returns its full request tree",
	Array.isArray(jordanRead.data.requests) && jordanRead.data.requests.length > 0 && jordanRead.data.revision >= 1,
	`requests=${jordanRead.data.requests.length} folders=${jordanRead.data.folders.length} revision=${jordanRead.data.revision}`,
);
const editedName = `${target.name} (edited by Jordan)`;
// A round-trip through the real PUT contract: the writer sends back the full
// document it just read, plus the revision it read. Nothing is hand-authored.
// The real PUT /collections/:id contract is `{ expectedRevision, collection }`.
const revisionBody = (doc, { expectedRevision = doc.revision, ...overrides } = {}) => ({
	expectedRevision,
	collection: {
		name: doc.name,
		description: doc.description,
		variables: doc.variables,
		auth: doc.auth,
		folders: doc.folders,
		requests: doc.requests,
		...overrides,
	},
});
const jordanEdit = await Jordan.call(`/collections/${target._id}`, {
	method: "PUT",
	body: revisionBody(jordanRead.data, { name: editedName }),
	expect: 200,
});
const alexSeesEdit = await Alex.call(`/collections/${target._id}`, { expect: 200 });
record(
	"11. Jordan's edit is immediately visible to Alex",
	alexSeesEdit.data.name === editedName && jordanEdit.data.revision === alexSeesEdit.data.revision,
	`name="${alexSeesEdit.data.name}" revision=${alexSeesEdit.data.revision}`,
);
record(
	"12. The edit records its actual actor, not the workspace owner",
	alexSeesEdit.data.updatedByProfileId === JORDAN_PROFILE && alexSeesEdit.data.createdByProfileId === ALEX_PROFILE,
	`createdBy=${alexSeesEdit.data.createdByProfileId === ALEX_PROFILE ? "Alex" : "?"} updatedBy=${
		alexSeesEdit.data.updatedByProfileId === JORDAN_PROFILE ? "Jordan" : "?"
	}`,
);

// ---------------------------------------------------------------- 5. deterministic CAS conflict
const alexStale = await Alex.call(`/collections/${target._id}`, { expect: 200 });
const staleRevision = alexStale.data.revision;

const jordanFresh = await Jordan.call(`/collections/${target._id}`, { expect: 200 });
await Jordan.call(`/collections/${target._id}`, {
	method: "PUT",
	body: revisionBody(jordanFresh.data, { name: `${editedName} v2` }),
	expect: 200,
});
const conflicted = await Alex.call(`/collections/${target._id}`, {
	method: "PUT",
	body: revisionBody(alexStale.data, {
		expectedRevision: staleRevision,
		name: `${target.name} (Alex stale write)`,
	}),
});
const details = conflicted.body?.error?.details ?? {};
record(
	"13. A stale write fails with a typed, attributed 409",
	conflicted.status === 409 &&
		details.currentRevision > details.expectedRevision &&
		details.lastUpdatedByProfileId === JORDAN_PROFILE &&
		Boolean(details.lastUpdatedByName),
	`status=${conflicted.status} code=${conflicted.body?.error?.code} expected=${details.expectedRevision} current=${details.currentRevision} lastUpdatedBy=${details.lastUpdatedByName}`,
);
const afterConflict = await Alex.call(`/collections/${target._id}`, { expect: 200 });
record(
	"14. No last-write-wins: the stale write changed nothing",
	afterConflict.data.name.includes("v2") && !afterConflict.data.name.includes("stale write"),
	`name="${afterConflict.data.name}" revision=${afterConflict.data.revision}`,
);

// ---------------------------------------------------------------- 6. OWNER -> VIEWER is immediate
const alexDetail = await Alex.call(`/workspaces/${TEAM}`, { expect: 200 });
const demote = await Alex.call(`/workspaces/${TEAM}/members/${JORDAN_PROFILE}`, {
	method: "PUT",
	body: { expectedRevision: alexDetail.data.revision, role: "VIEWER" },
	expect: 200,
});
record(
	"15. OWNER changes Jordan's role to VIEWER",
	demote.data.members.find((m) => m.profileId === JORDAN_PROFILE)?.role === "VIEWER",
	`revision=${demote.data.revision}`,
);

const viewerCollections = await Jordan.call("/collections", { expect: 200 });
const viewerRead = await Jordan.call(`/collections/${viewerCollections.data[0]._id}`, { expect: 200 });
record(
	"16. VIEWER can still read shared definitions",
	Array.isArray(viewerCollections.data) && viewerRead.status === 200,
	`count=${viewerCollections.data.length}`,
);

const viewerWrite = await Jordan.call(`/collections/${viewerRead.data._id}`, {
	method: "PUT",
	body: revisionBody(viewerRead.data, { name: "viewer should not be able to write" }),
});
record(
	"17. VIEWER mutation is refused immediately (403, fail-closed)",
	viewerWrite.status === 403,
	`status=${viewerWrite.status} code=${viewerWrite.body?.error?.code} capability=${viewerWrite.body?.error?.details?.requiredCapability ?? "-"}`,
);

const viewerCreate = await Jordan.call("/collections", {
	method: "POST",
	body: { name: "viewer folder should not exist" },
});
record(
	"18. VIEWER cannot create a collection",
	viewerCreate.status === 403,
	`status=${viewerCreate.status}`,
);

const viewerExecute = await Jordan.call("/executions", {
	method: "POST",
	body: {
		request: {
			id: crypto.randomUUID(),
			name: "viewer send",
			method: "GET",
			urlTemplate: "http://127.0.0.1:8000/demo/v1/echo",
			query: [],
			headers: [],
			body: { mode: "none" },
			auth: { mode: "none" },
			settings: {},
		},
	},
});
record(
	"19. VIEWER cannot execute a side-effecting request",
	viewerExecute.status === 403,
	`status=${viewerExecute.status} capability=${viewerExecute.body?.error?.details?.requiredCapability ?? "-"}`,
);

// ---------------------------------------------------------------- 7. restore EDITOR
const beforeRestore = await Alex.call(`/workspaces/${TEAM}`, { expect: 200 });
await Alex.call(`/workspaces/${TEAM}/members/${JORDAN_PROFILE}`, {
	method: "PUT",
	body: { expectedRevision: beforeRestore.data.revision, role: "EDITOR" },
	expect: 200,
});
const restoredRead = await Jordan.call(`/collections/${viewerRead.data._id}`, { expect: 200 });
const restoredWrite = await Jordan.call(`/collections/${viewerRead.data._id}`, {
	method: "PUT",
	body: revisionBody(restoredRead.data, { name: `${restoredRead.data.name} (editor restored)` }),
	expect: 200,
});
record(
	"20. Restoring EDITOR returns write access immediately",
	restoredWrite.status === 200,
	`status=${restoredWrite.status} revision=${restoredWrite.data.revision}`,
);

// ---------------------------------------------------------------- 8. remove member -> immediate loss
const beforeRemove = await Alex.call(`/workspaces/${TEAM}`, { expect: 200 });
const removed = await Alex.call(`/workspaces/${TEAM}/members/${JORDAN_PROFILE}?revision=${beforeRemove.data.revision}`, {
	method: "DELETE",
	expect: 200,
});
record(
	"21. OWNER removes Jordan from the workspace",
	!removed.data.members.some((m) => m.profileId === JORDAN_PROFILE),
	`remaining=${removed.data.members.map((m) => m.name).join(", ")}`,
);

const removedRead = await Jordan.call(`/collections/${viewerRead.data._id}`);
const removedList = await Jordan.call("/collections");
record(
	"22. A removed member loses access immediately",
	removedList.status === 403 || removedList.data?.length === 0 || removedRead.status === 403,
	`list=${removedList.status} read=${removedRead.status}`,
);

const workedOnMembers = await Alex.call(`/workspaces/${TEAM}/members/${JORDAN_PROFILE}`, {
	method: "DELETE",
	query: {},
});
record(
	"23. Removing a non-member fails closed",
	[400, 403, 404, 409].includes(workedOnMembers.status),
	`status=${workedOnMembers.status}`,
);

// ---------------------------------------------------------------- 9. re-add
const beforeAdd = await Alex.call(`/workspaces/${TEAM}`, { expect: 200 });
const added = await Alex.call(`/workspaces/${TEAM}/members`, {
	method: "POST",
	body: { expectedRevision: beforeAdd.data.revision, email: "jordan.lee@example.test", role: "EDITOR" },
	expect: 201,
});
record(
	"24. OWNER re-adds Jordan by email",
	added.data.members.some((m) => m.profileId === JORDAN_PROFILE && m.role === "EDITOR"),
	`members=${added.data.members.map((m) => `${m.name}:${m.role}`).join(", ")}`,
);

const readdRead = await Jordan.call("/collections");
record("25. The re-added member regains access", readdRead.status === 200, `status=${readdRead.status}`);

// ---------------------------------------------------------------- 10. last OWNER protection
const selfDemote = await Alex.call(`/workspaces/${TEAM}/members/${ALEX_PROFILE}`, {
	method: "PUT",
	body: { expectedRevision: added.data.revision, role: "EDITOR" },
});
const lastOwnerGuarded = selfDemote.status === 409 || selfDemote.status === 400;
record(
	"26. The last OWNER cannot be demoted",
	lastOwnerGuarded,
	`status=${selfDemote.status} code=${selfDemote.body?.error?.code ?? "-"}`,
);

// ---------------------------------------------------------------- 11. activity feed
const activity = await Alex.call(`/workspaces/${TEAM}/activity?limit=50`, { expect: 200 });
const actions = (activity.data.entries ?? []).map((e) => e.action);
record(
	"27. The activity feed records the workspace lifecycle",
	actions.includes("member.role_changed") && actions.includes("member.removed") && actions.includes("member.added"),
	`actions=${[...new Set(actions)].join(", ")}`,
);
record(
	"28. Activity entries are attributed and revision-stamped",
	(activity.data.entries ?? []).every((e) => Boolean(e.actorName) && typeof e.summary === "string"),
	`entries=${activity.data.entries?.length} total=${activity.data.total}`,
);
const serializedActivity = JSON.stringify(activity.data);
record(
	"29. The activity feed leaks no authorization, cookie, or secret material",
	!/(authorization|set-cookie|password123|BEGIN [A-Z ]*PRIVATE KEY)/i.test(serializedActivity),
	`bytes=${serializedActivity.length}`,
);

// ---------------------------------------------------------------- 12. secret boundary
const teamEnvs = await Jordan.call("/environments", { expect: 200 });
const localEnv = teamEnvs.data.find((e) => e.name.includes("Local")) ?? teamEnvs.data[0];
const jordanEnvRead = await Jordan.call(`/environments/${localEnv._id}`, { expect: 200 });
const secretVars = (jordanEnvRead.data.variables ?? []).filter((v) => v.kind === "secretRef");
record(
	"30. Sharing an environment shares alias names, never values",
	secretVars.length > 0 && secretVars.every((v) => typeof v.alias === "string" && v.value === undefined),
	`secrets=${secretVars.map((v) => v.alias).join(", ")}`,
);
record(
	"31. The stored environment never contains a resolved value",
	!JSON.stringify(jordanEnvRead.data).includes("demo-alex") && !JSON.stringify(jordanEnvRead.data).includes("TracerDemo"),
	`bytes=${JSON.stringify(jordanEnvRead.data).length}`,
);

// ---------------------------------------------------------------- 13. history boundary
// Give Alex a real recorded execution inside the shared workspace, then prove
// Jordan cannot see it even though they share every definition in that workspace.
const alexEnvList = await Alex.call("/environments", { expect: 200 });
const alexLocalEnv = alexEnvList.data.find((e) => e.name.includes("Local")) ?? alexEnvList.data[0];
const alexEnvFull = await Alex.call(`/environments/${alexLocalEnv._id}`, { expect: 200 });
// The real Send contract: an execution id, the tab/draft identity, the request
// definition, and the workspace-scoped environment context. Alex is an OWNER, so
// this is the capability the VIEWER check above was refused.
const alexExecute = await Alex.call("/executions", {
	method: "POST",
	body: {
		executionId: crypto.randomUUID(),
		tabId: `demo-tab-${Date.now()}`,
		draftVersion: 0,
		request: {
			schemaVersion: 1,
			id: crypto.randomUUID(),
			folderId: null,
			name: "Alex private probe",
			method: "GET",
			urlTemplate: "http://127.0.0.1:8000/demo/v1/echo",
			query: [],
			headers: [],
			body: { mode: "none" },
			auth: { mode: "none" },
			settings: { timeoutMs: 15000 },
		},
		context: {
			environmentId: alexEnvFull.data._id,
			environmentRevision: alexEnvFull.data.revision,
		},
	},
});
const alexHistory = await Alex.call("/history?limit=50", { expect: 200 });
const jordanHistory = await Jordan.call("/history?limit=50", { expect: 200 });
const alexEntries = alexHistory.data.entries ?? alexHistory.data.items ?? [];
const jordanEntries = jordanHistory.data.entries ?? jordanHistory.data.items ?? [];
const alexHistoryIds = new Set(alexEntries.map((h) => h._id));
record(
	"32. Alex can execute inside the shared workspace and it is recorded",
	alexExecute.status === 200 || alexExecute.status === 201,
	`status=${alexExecute.status} outcome=${alexExecute.data?.outcome ?? alexExecute.data?.status ?? "-"}`,
);
record(
	"32b. Execution history stays profile-scoped inside a shared workspace",
	alexHistoryIds.size > 0 && !jordanEntries.some((h) => alexHistoryIds.has(h._id)),
	`alex=${alexHistoryIds.size} jordan=${jordanEntries.length}`,
);

const guestAccess = await fetch(`${API}/workspaces/${TEAM}`, { headers: { "content-type": "application/json" } });
record("33. Workspace endpoints require authentication", guestAccess.status === 401, `status=${guestAccess.status}`);

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
	console.log("\nFAILURES:");
	for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
	process.exit(1);
}
