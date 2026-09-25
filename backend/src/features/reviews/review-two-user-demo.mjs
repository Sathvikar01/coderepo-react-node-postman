// Phase 50 — Review & Decision Workflow two-context browser acceptance.
//
// Two genuinely independent authenticated contexts (separate login sessions,
// separate profile tokens, separate workspace headers) are driven over HTTP
// against the real running API, following the Phase 24 two-user-demo pattern.
// Collaboration mutations and live SSE delivery use the real HTTP API. Review
// creation/current-evidence seeding uses the trusted internal service primitive
// because production POST /reviews intentionally refuses caller-authored
// technical truth and requires a validated Verification Proof artifact.
//
// Re-run with the stack up:
//   1. bun src/features/workspaces/seed.js   (from backend/)
//   2. bun start                              (repo root, terminal 1)
//   3. bun src/features/reviews/review-two-user-demo.mjs   (terminal 2, from backend/)
//
// Fixture note: the seed ships Alex + Jordan profiles under one account. This
// script upserts a Jordan account row and a Casey (viewer) account + profile
// directly in the demo database so the second context and the viewer/removed-
// member checks can authenticate. Those rows are clearly labelled and the
// script exits non-zero on the first failed expectation.
import mongoose from "mongoose";
import { initConfig } from "../../shared/config/index.js";
import { reviewService } from "./review.service.js";

const API = "http://127.0.0.1:8000/api/v1";

const results = [];
const record = (name, ok, detail) => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) {
		console.log(`\nABORTED after ${results.length} checks (${results.filter((r) => r.ok).length} passed).`);
		process.exit(1);
	}
};

class Browser {
	constructor(label) {
		this.label = label;
		this.session = null;
		this.profile = null;
		this.profileId = null;
		this.workspaceId = null;
	}

	headers(extra = {}) {
		const headers = { ...extra };
		const bearer = this.profile ?? this.session;
		if (bearer) headers.authorization = `Bearer ${bearer}`;
		if (this.workspaceId) headers["x-workspace-id"] = this.workspaceId;
		return headers;
	}

	async call(path, { method = "GET", body } = {}) {
		const headers = this.headers();
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
		return { status: response.status, data, body: payload };
	}

	async login(email, password) {
		const response = await this.call("/auth/login", { method: "POST", body: { email, password } });
		if (response.status !== 200) throw new Error(`login ${email} got ${response.status}: ${JSON.stringify(response.body)?.slice(0, 200)}`);
		this.session = response.data.token ?? response.data.sessionToken;
		return response.data;
	}

	async selectProfile(profileId) {
		const savedSession = this.session;
		const headers = { authorization: `Bearer ${savedSession}`, "content-type": "application/json" };
		const response = await fetch(`${API}/auth/switch-profile`, {
			method: "POST",
			headers,
			body: JSON.stringify({ profileId }),
		});
		const payload = await response.json();
		if (response.status !== 200) throw new Error(`switch-profile got ${response.status}`);
		this.profile = payload.data.token ?? payload.data.profileToken;
		this.profileId = profileId;
		return payload.data;
	}

	// Opens a real SSE stream and resolves with the first event whose action is
	// in `wanted`, or rejects on timeout. The stream stays open for reuse.
	async waitForEvent(wanted, timeoutMs = 15000) {
		if (!this.streamReader) {
			const response = await fetch(`${API}/workspaces/${this.workspaceId}/events`, {
				headers: { Accept: "text/event-stream", ...this.headers() },
			});
			if (response.status !== 200 || !response.body) throw new Error(`SSE connect got ${response.status}`);
			this.streamReader = response.body.getReader();
			this.streamBuffer = "";
			this.streamSeen = [];
		}
		const decoder = new TextDecoder();
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			for (const event of this.streamSeen.splice(0)) {
				if (wanted.includes(event.action)) return event;
			}
			const remaining = deadline - Date.now();
			const chunk = await Promise.race([
				this.streamReader.read(),
				new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.min(remaining, 1000))),
			]);
			if (chunk?.timeout) continue;
			if (chunk.done) throw new Error("SSE stream closed while waiting");
			this.streamBuffer += decoder.decode(chunk.value, { stream: true });
			const frames = this.streamBuffer.split("\n\n");
			this.streamBuffer = frames.pop();
			for (const frame of frames) {
				let action = null;
				let data = "";
				for (const line of frame.split("\n")) {
					if (line.startsWith("event: ")) action = line.slice(7).trim();
					else if (line.startsWith("data: ")) data += line.slice(6);
				}
				if (!action || action === "heartbeat" || !data) continue;
				try {
					this.streamSeen.push({ action, ...JSON.parse(data) });
				} catch {}
			}
		}
		throw new Error(`timed out waiting for ${wanted.join("/")}`);
	}

	closeStream() {
		try {
			this.streamReader?.cancel();
		} catch {}
		this.streamReader = null;
	}
}

initConfig();
const demoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_demo";
await mongoose.connect(demoUri, { serverSelectionTimeoutMS: 5000 });

// --- Fixture: second-context + viewer identities (labelled demo-only rows) ---
const { WorkspaceAccount } = await import("../auth/workspace-account.model.js");
const { Profile } = await import("../profiles/profile.model.js");
const JORDAN_PROFILE_ID = new mongoose.Types.ObjectId("64b00000000000000000a003");
const CASEY_PROFILE_ID = new mongoose.Types.ObjectId("64b00000000000000000a005");
await Profile.updateOne(
	{ _id: JORDAN_PROFILE_ID },
	{ $setOnInsert: { _id: JORDAN_PROFILE_ID, name: "Jordan Lee", email: "jordan.lee@example.test", avatarColor: "#059669", sortOrder: 1 } },
	{ upsert: true },
);
await WorkspaceAccount.updateOne(
	{ email: "jordan.lee@example.test" },
	{
		$setOnInsert: {
			name: "Jordan Lee",
			email: "jordan.lee@example.test",
			passwordHash: "$2a$10$phase50demo.not-a-real-hash",
			allowedProfileIds: [JORDAN_PROFILE_ID],
		},
	},
	{ upsert: true },
);
await Profile.updateOne(
	{ _id: CASEY_PROFILE_ID },
	{ $setOnInsert: { _id: CASEY_PROFILE_ID, name: "Casey Wu", email: "casey.wu@example.test", avatarColor: "#DC2626", sortOrder: 2 } },
	{ upsert: true },
);
await WorkspaceAccount.updateOne(
	{ email: "casey.wu@example.test" },
	{
		$setOnInsert: {
			name: "Casey Wu",
			email: "casey.wu@example.test",
			passwordHash: "$2a$10$phase50demo.not-a-real-hash",
			allowedProfileIds: [CASEY_PROFILE_ID],
		},
	},
	{ upsert: true },
);
// Demo logins use the seeded password; fixture accounts reuse the seeded hash.
// passwordHash is select:false — it must be selected explicitly.
const seedAccount = await WorkspaceAccount.findOne({ email: "alex.morgan@example.test" }).select("+passwordHash").lean();
if (seedAccount) {
	await WorkspaceAccount.updateMany(
		{ email: { $in: ["jordan.lee@example.test", "casey.wu@example.test"] } },
		{ $set: { passwordHash: seedAccount.passwordHash, active: true } },
	);
}

const Alex = new Browser("Alex (context 1, OWNER)");
const Jordan = new Browser("Jordan (context 2, EDITOR)");
const Casey = new Browser("Casey (context 3, VIEWER)");

await Alex.login("alex.morgan@example.test", "password123");
await Jordan.login("jordan.lee@example.test", "password123");
await Casey.login("casey.wu@example.test", "password123");
record("1. Three independent login contexts", Alex.session !== Jordan.session && Jordan.session !== Casey.session);

// Profiles (same shape the Phase 24 two-user demo relies on)
const alexProfiles = await Alex.call("/profiles");
await Alex.selectProfile(alexProfiles.data[0]._id);
await Jordan.selectProfile(String(JORDAN_PROFILE_ID));
await Casey.selectProfile(String(CASEY_PROFILE_ID));

// --- Shared workspace with Jordan as EDITOR, Casey as VIEWER ---
const created = await Alex.call("/workspaces", { method: "POST", body: { name: `Review Acceptance ${Date.now()}` } });
record("2. Alex creates a shared workspace", created.status === 201, `workspace=${created.data?._id}`);
const WS = created.data._id;
Alex.workspaceId = WS;
Jordan.workspaceId = WS;
Casey.workspaceId = WS;
let wsDetail = await Alex.call(`/workspaces/${WS}`);
const rev1 = wsDetail.data.revision;
const addJordan = await Alex.call(`/workspaces/${WS}/members`, {
	method: "POST",
	body: { expectedRevision: rev1, email: "jordan.lee@example.test", role: "EDITOR" },
});
record("3. Jordan joins as EDITOR", addJordan.status === 200 || addJordan.status === 201, `status=${addJordan.status}`);
wsDetail = await Alex.call(`/workspaces/${WS}`);
const addCasey = await Alex.call(`/workspaces/${WS}/members`, {
	method: "POST",
	body: { expectedRevision: wsDetail.data.revision, email: "casey.wu@example.test", role: "VIEWER" },
});
record("4. Casey joins as VIEWER", addCasey.status === 200 || addCasey.status === 201, `status=${addCasey.status}`);

// Jordan + Alex open live streams BEFORE the review exists.
await Jordan.waitForEvent(["__never__"], 500).catch(() => {});
record("5. Jordan holds a live SSE stream (no manual reload needed later)", Boolean(Jordan.streamReader));

// --- 6. Production boundary refuses human-authored machine truth -------------
const forged = await Alex.call("/reviews", {
	method: "POST",
	body: {
		title: "forged",
		findingType: "contract_breaking",
		findingSummary: "caller-authored technical truth must be refused",
		technicalState: "BREAKING",
		evidence: { contractFingerprint: "made-up", technicalState: "BREAKING" },
	},
});
record("6. Production review creation rejects caller-authored technical truth", forged.status === 400, `status=${forged.status}`);

// Trusted acceptance fixture: this stands in for the output that production
// createFromProof derives from a validated Phase 47 artifact.
const promotedData = await reviewService.create({
	workspaceId: WS,
	profileId: Alex.profileId,
	input: {
		title: "POST /payments is BREAKING on v14",
		findingType: "contract_breaking",
		findingSummary: "v14 removed the currency field that checkout depends on.",
		technicalState: "BREAKING",
		evidence: {
			resourceType: "collection",
			resourceId: "col_payments",
			revision: 7,
			contractVersion: "v14",
			contractFingerprint: "contract-fp-acceptance",
			technicalState: "BREAKING",
		},
	},
});
const promoted = { status: 201, data: promotedData };
record("7. BREAKING contract seeded as frozen authoritative review evidence", promoted.data.displayId === "RV-1", promoted.data?.displayId);
const REVIEW = promoted.data._id;
const FROZEN_FP = promoted.data.evidenceFingerprint;
let alexRev = promoted.data.revision;

// --- 7-8. Assign Jordan; Jordan sees it live ---
const assigned = await Alex.call(`/reviews/${REVIEW}/assign`, {
	method: "POST",
	body: { expectedRevision: alexRev, assigneeProfileId: String(JORDAN_PROFILE_ID) },
});
record("7. Alex assigns Jordan", assigned.status === 200 && String(assigned.data.assigneeProfileId) === String(JORDAN_PROFILE_ID));
alexRev = assigned.data.revision;
const liveAssigned = await Jordan.waitForEvent(["review.assigned", "review.created"], 15000);
record("8. Jordan sees the assignment live (SSE, no reload)", String(liveAssigned.resourceId) === String(REVIEW), liveAssigned.action);

// --- 9-11. Jordan comments, @mentions Alex; Alex receives the mention live ---
await Alex.waitForEvent(["__never__"], 500).catch(() => {});
const commented = await Jordan.call(`/reviews/${REVIEW}/comments`, {
	method: "POST",
	body: { body: "Reproduced locally — currency is gone from the response.", mentions: [Alex.profileId] },
});
record("9. Jordan comments with @mention of Alex", commented.status === 201 && commented.data.mentions.includes(Alex.profileId));
const liveMention = await Alex.waitForEvent(["review.mentioned"], 15000);
record("10. Alex receives the mention live (metadata-only SSE)", String(liveMention.resourceId) === String(REVIEW), liveMention.action);
const setReviewer = await Alex.call(`/reviews/${REVIEW}/reviewer`, {
	method: "POST",
	body: { expectedRevision: alexRev, reviewerProfileId: String(JORDAN_PROFILE_ID) },
});
alexRev = setReviewer.data.revision;

// --- 12. Jordan requests changes; technical state stays BREAKING ---
const jordanView = await Jordan.call(`/reviews/${REVIEW}`);
const changes = await Jordan.call(`/reviews/${REVIEW}/decision`, {
	method: "POST",
	body: { expectedRevision: jordanView.data.revision, decision: "CHANGES_REQUESTED", reason: "Restore currency or version the contract." },
});
record(
	"11. Jordan requests changes; technical state remains BREAKING",
	changes.status === 200 && changes.data.decision === "CHANGES_REQUESTED" && changes.data.technicalState === "BREAKING",
	`decision=${changes.data?.decision} technical=${changes.data?.technicalState}`,
);

// --- 13-15. Resource changes; original review goes STALE; history intact ---
const stale = {
	status: 200,
	data: await reviewService.refresh({
		workspaceId: WS,
		profileId: Alex.profileId,
		reviewId: REVIEW,
		current: { revision: 8, contractVersion: "v15", contractFingerprint: "contract-fp-v15" },
	}),
};
record(
	"12. Changed resource marks the review STALE (manifest untouched)",
	stale.data.freshness === "STALE" && stale.data.evidence.revision === 7 && stale.data.evidenceFingerprint === FROZEN_FP,
	`freshness=${stale.data?.freshness}`,
);
const oldComments = await Alex.call(`/reviews/${REVIEW}/comments`);
record("13. Old comments survive staleness", oldComments.status === 200 && oldComments.data.length === 1, `comments=${oldComments.data?.length}`);

// --- 16-17. Re-review on current evidence; reviewer approves ---
const rereview = {
	status: 201,
	data: await reviewService.reReview({
		workspaceId: WS,
		profileId: Alex.profileId,
		reviewId: REVIEW,
		input: {
			technicalState: "VERIFIED",
			evidence: {
				resourceType: "collection",
				resourceId: "col_payments",
				revision: 8,
				contractVersion: "v15",
				contractFingerprint: "contract-fp-v15",
				technicalState: "VERIFIED",
			},
		},
	}),
};
record(
	"14. Re-review links forward from current evidence",
	rereview.status === 201 && String(rereview.data.supersedesReviewId) === String(REVIEW),
	`${rereview.data?.displayId} supersedes RV-1`,
);
const REVIEW2 = rereview.data._id;
await Alex.call(`/reviews/${REVIEW2}/reviewer`, {
	method: "POST",
	body: { expectedRevision: rereview.data.revision, reviewerProfileId: String(JORDAN_PROFILE_ID) },
});
const jordanView2 = await Jordan.call(`/reviews/${REVIEW2}`);
const approved = await Jordan.call(`/reviews/${REVIEW2}/decision`, {
	method: "POST",
	body: { expectedRevision: jordanView2.data.revision, decision: "APPROVED" },
});
record(
	"15. Approval references the exact new evidence",
	approved.status === 200 && approved.data.decision === "APPROVED" && approved.data.evidence.contractVersion === "v15",
	`evidence=${approved.data?.evidence?.contractVersion}`,
);

// --- 18-19. OWNER waiver on a BLOCKED review; stale CAS gets 409 ---
const blocked = {
	status: 201,
	data: await reviewService.create({
		workspaceId: WS,
		profileId: Alex.profileId,
		input: {
			title: "Checkout verification BLOCKED on staging",
			findingType: "verification_blocked",
			findingSummary: "Rehearsal evidence missing for the staging target.",
			technicalState: "BLOCKED",
			evidence: { verificationFingerprint: "verification-fp-blocked", technicalState: "BLOCKED" },
		},
	}),
};
const waived = await Alex.call(`/reviews/${blocked.data._id}/waive`, {
	method: "POST",
	body: { expectedRevision: blocked.data.revision, reason: "Accepted risk for the staging demo; production rerun scheduled." },
});
record(
	"16. OWNER waiver keeps technical state BLOCKED (never VERIFIED)",
	waived.status === 200 && waived.data.decision === "WAIVED" && waived.data.technicalState === "BLOCKED" && Boolean(waived.data.waiver?.waivedAt),
	`decision=${waived.data?.decision} technical=${waived.data?.technicalState}`,
);
const staleDecision = await Alex.call(`/reviews/${blocked.data._id}/decision`, {
	method: "POST",
	body: { expectedRevision: blocked.data.revision, decision: "APPROVED" },
});
record("17. Stale concurrent decision receives 409", staleDecision.status === 409, `status=${staleDecision.status}`);

// --- 20. VIEWER cannot comment or decide ---
const viewerComment = await Casey.call(`/reviews/${REVIEW2}/comments`, {
	method: "POST",
	body: { body: "Viewer trying to comment." },
});
const viewerDecision = await Casey.call(`/reviews/${REVIEW2}/decision`, {
	method: "POST",
	body: { expectedRevision: approved.data.revision, decision: "APPROVED" },
});
record("18. VIEWER cannot comment or decide", viewerComment.status === 403 && viewerDecision.status === 403);

// --- 21. Removed member immediately loses access ---
wsDetail = await Alex.call(`/workspaces/${WS}`);
const removed = await Alex.call(`/workspaces/${WS}/members/${String(CASEY_PROFILE_ID)}?revision=${wsDetail.data.revision}`, { method: "DELETE" });
record("19. Casey removed from the workspace", removed.status === 200, `status=${removed.status}`);
const afterRemoval = await Casey.call(`/reviews/${REVIEW2}`);
record("20. Removed member immediately loses review read access", afterRemoval.status === 403, `status=${afterRemoval.status}`);

// --- 22. No secret values in review/audit/SSE payloads ---
const secretComment = await Jordan.call(`/reviews/${REVIEW2}/comments`, {
	method: "POST",
	body: { body: "Repro headers — Authorization: Bearer live-secret-abc123; Cookie: session=xyz" },
});
const thread = await Alex.call(`/reviews/${REVIEW2}/comments`);
const trail = await Alex.call(`/reviews/${REVIEW2}/audit`);
const serialized = JSON.stringify([thread.data, trail.data, liveAssigned, liveMention]);
const leaks = ["live-secret-abc123", "session=xyz"].filter((secret) => serialized.includes(secret));
record(
	"21. No secret values in review, audit, or SSE metadata",
	secretComment.status === 201 && leaks.length === 0 && String(secretComment.data.body).includes("[REDACTED]"),
	leaks.length > 0 ? `LEAKED: ${leaks.join(",")}` : "redacted",
);

Jordan.closeStream();
Alex.closeStream();
await mongoose.disconnect();
console.log(`\nDONE: ${results.length} checks passed. PHASE 50 browser acceptance complete.`);
