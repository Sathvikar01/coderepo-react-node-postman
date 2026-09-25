/**
 * Phase 50 — Review & Decision Workflow domain tests.
 *
 * Machines determine technical truth; humans determine what the team chooses
 * to do about that truth. These tests prove the workflow end to end against
 * MongoDB: promote-to-review with a frozen evidence fingerprint, assignment,
 * comments/@mentions, decisions that never touch technical state, staleness
 * that preserves history, re-review lineage, owner-only waiver, CAS conflicts,
 * secret redaction, and the open-review bound.
 */
import mongoose from "mongoose";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { WorkspaceAccount } from "../auth/workspace-account.model.js";
import { Profile } from "../profiles/profile.model.js";
import { ResourceVersion } from "../versions/version.model.js";
import { verificationProofApiService } from "../verification-proof-api/index.js";
import { Workspace } from "../workspaces/workspace.model.js";
import { workspaceService } from "../workspaces/workspace.service.js";
import { reviewEvidenceFingerprintOf } from "./review-identity.js";
import { createReviewSchema, REVIEW_DECISION, REVIEW_FRESHNESS, REVIEW_STATUS } from "./review-schema.js";
import { Review, ReviewAudit, ReviewComment, ReviewCounter } from "./review.model.js";
import { reviewService } from "./review.service.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase3_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase50-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase50-test-jwt-secret";
initConfig();

const ready = await connectTestDatabase();
if (ready) {
	await Promise.all([Review.syncIndexes(), ReviewCounter.syncIndexes(), ReviewComment.syncIndexes(), ReviewAudit.syncIndexes(), Workspace.syncIndexes(), Profile.syncIndexes()]);
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
	await Profile.deleteMany({ _id: { $in: [ALEX, JORDAN, CASEY] } });
	await Profile.insertMany([
		{ _id: ALEX, name: "Alex Morgan", email: "alex.morgan@example.test", avatarColor: "#4F46E5", sortOrder: 0 },
		{ _id: JORDAN, name: "Jordan Lee", email: "jordan.lee@example.test", avatarColor: "#059669", sortOrder: 1 },
		{ _id: CASEY, name: "Casey Wu", email: "casey.wu@example.test", avatarColor: "#DC2626", sortOrder: 2 },
	]);
	await WorkspaceAccount.deleteMany({ email: { $in: ["jordan.lee@example.test", "casey.wu@example.test"] } });
	await WorkspaceAccount.insertMany([
		{ name: "Jordan Lee", email: "jordan.lee@example.test", passwordHash: "$2a$10$not-a-real-hash", allowedProfileIds: [JORDAN] },
		{ name: "Casey Wu", email: "casey.wu@example.test", passwordHash: "$2a$10$not-a-real-hash", allowedProfileIds: [CASEY] },
	]);
}

function evidenceInput(overrides = {}) {
	return {
		resourceType: "collection",
		resourceId: "col_payments",
		revision: 7,
		contractVersion: "v14",
		contractFingerprint: "contract-fp-abc123",
		verificationFingerprint: "verification-fp-def456",
		technicalState: "BLOCKED",
		...overrides,
	};
}

function createInput(overrides = {}) {
	return {
		title: "POST /payments is BREAKING on v14",
		findingType: "contract_breaking",
		findingSummary: "The v14 contract removed the currency field that checkout depends on.",
		technicalState: "BREAKING",
		evidence: evidenceInput(),
		...overrides,
	};
}

function proofFixtureFor(workspaceId, overrides = {}) {
	return {
		proofId: "proof-phase50",
		fingerprint: "proof-fingerprint-phase50",
		state: "BLOCKED",
		identity: {
			workspaceId: String(workspaceId),
			snapshot: { snapshotId: "snap-50", snapshotFingerprint: "snapshot-fp-50" },
			targetEnvironment: { environmentId: "env-staging", environmentFingerprint: "env-fp-50" },
			planFingerprint: "plan-fp-50",
			runId: "run-50",
			runIdentityFingerprint: "run-fp-50",
		},
		verification: { fingerprint: "verification-fp-50" },
		impact: { resolved: true, truncated: false, unknownCount: 0, fingerprint: "impact-fp-50" },
		drift: { blockingCount: 0, blocking: [], fingerprint: "drift-fp-50" },
		rehearsal: { runId: "run-50", runState: "COMPLETED", identityFingerprint: "run-fp-50" },
		contracts: { classes: { breaking: 1 } },
		provenance: {
			sources: [
				{ source: "contract-compatibility", digest: "contract-fp-50" },
				{ source: "cross-env-verification", digest: "verification-fp-50" },
			],
		},
		...overrides,
	};
}

describe.skipIf(!ready)("review decision workflow", () => {
	beforeEach(async () => {
		await Promise.all([
			Review.deleteMany({}),
			ReviewCounter.deleteMany({}),
			ReviewComment.deleteMany({}),
			ReviewAudit.deleteMany({}),
			ResourceVersion.deleteMany({ resourceId: "col_payments" }),
			Workspace.deleteMany({ ownerProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
		]);
		await seedProfiles();
	});

	mtest("production creation derives technical truth from a validated proof instead of caller fields", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		const rejected = createReviewSchema.safeParse({
			title: "forged",
			findingType: "contract_breaking",
			findingSummary: "caller tries to type machine truth",
			technicalState: "BREAKING",
			evidence: { contractFingerprint: "made-up" },
		});
		expect(rejected.success).toBe(false);

		const originalImport = verificationProofApiService.importProof;
		verificationProofApiService.importProof = () => ({ proof: proofFixtureFor(ws._id) });
		try {
			const review = await reviewService.createFromProof({
				workspaceId: ws._id,
				profileId: ALEX,
				input: {
					title: "POST /payments is breaking",
					findingType: "contract_breaking",
					findingSummary: "Derived from a verified proof artifact.",
					proofArtifact: "{validated-test-artifact}",
				},
			});
			expect(review.technicalState).toBe("BREAKING");
			expect(review.evidence.proofId).toBe("proof-phase50");
			expect(review.evidence.proofFingerprint).toBe("proof-fingerprint-phase50");
			expect(review.evidence.snapshotFingerprint).toBe("snapshot-fp-50");
			expect(review.evidence.contractFingerprint).toBe("contract-fp-50");
		} finally {
			verificationProofApiService.importProof = originalImport;
		}
	});

	mtest("proof-derived creation rejects a finding the proof does not actually contain", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		const originalImport = verificationProofApiService.importProof;
		verificationProofApiService.importProof = () => ({
			proof: proofFixtureFor(ws._id, { contracts: { classes: { breaking: 0 } } }),
		});
		try {
			await expectRejection(
				reviewService.createFromProof({
					workspaceId: ws._id,
					profileId: ALEX,
					input: {
						title: "not actually breaking",
						findingType: "contract_breaking",
						findingSummary: "Should fail closed.",
						proofArtifact: "{validated-test-artifact}",
					},
				}),
				{ code: "REVIEW_SOURCE_MISMATCH" },
			);
		} finally {
			verificationProofApiService.importProof = originalImport;
		}
	});

	mtest("promote binds the exact evidence fingerprint deterministically", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		const review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		expect(review.displayId).toBe("RV-1");
		expect(review.status).toBe(REVIEW_STATUS.OPEN);
		expect(review.decision).toBe(REVIEW_DECISION.NONE);
		expect(review.freshness).toBe(REVIEW_FRESHNESS.CURRENT);
		expect(review.technicalState).toBe("BREAKING");
		const expected = reviewEvidenceFingerprintOf({ ...evidenceInput(), workspaceId: String(ws._id) });
		expect(review.evidenceFingerprint).toBe(expected);
	});

	mtest("assign, comment, @mention, and request-changes keep technical state intact", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		await workspaceService.addMember(ws._id, ALEX, { email: "jordan.lee@example.test", role: "EDITOR", expectedRevision: ws.revision });
		let review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });

		review = await reviewService.assign({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id, expectedRevision: review.revision, assigneeProfileId: String(JORDAN) });
		expect(review.assigneeProfileId).toBe(String(JORDAN));

		review = await reviewService.setReviewer({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id, expectedRevision: review.revision, reviewerProfileId: String(JORDAN) });
		expect(review.reviewerProfileId).toBe(String(JORDAN));

		const comment = await reviewService.comment({
			workspaceId: ws._id,
			profileId: JORDAN,
			reviewId: review._id,
			body: "Reproduced locally. The currency field is gone from the response.",
			mentions: [String(ALEX)],
		});
		expect(comment.mentions).toEqual([String(ALEX)]);

		review = await reviewService.decide({
			workspaceId: ws._id,
			profileId: JORDAN,
			reviewId: review._id,
			expectedRevision: review.revision,
			decision: "CHANGES_REQUESTED",
			reason: "Restore the currency field or version the contract.",
		});
		expect(review.decision).toBe(REVIEW_DECISION.CHANGES_REQUESTED);
		// Human decision recorded; technical truth untouched.
		expect(review.technicalState).toBe("BREAKING");

		const comments = await reviewService.listComments({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id });
		expect(comments).toHaveLength(1);
		const audit = await reviewService.listAudit({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id });
		const actions = audit.map((entry) => entry.action);
		expect(actions).toContain("review.created");
		expect(actions).toContain("review.assigned");
		expect(actions).toContain("review.comment_added");
		expect(actions).toContain("review.mentioned");
		expect(actions).toContain("review.changes_requested");
	});

	mtest("resource change marks the review STALE without rewriting history", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		let review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		const frozenManifest = { ...review.evidence };
		const frozenFingerprint = review.evidenceFingerprint;

		await reviewService.comment({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id, body: "Holding for the contract fix.", mentions: [] });

		const refreshed = await reviewService.refresh({
			workspaceId: ws._id,
			profileId: ALEX,
			reviewId: review._id,
			current: { revision: 8, contractVersion: "v15", contractFingerprint: "contract-fp-xyz789" },
		});
		expect(refreshed.freshness).toBe(REVIEW_FRESHNESS.STALE);
		expect(refreshed.staleChangedFields).toContain("revision");
		expect(refreshed.staleChangedFields).toContain("contractVersion");
		// Old manifest and fingerprint preserved, not silently followed.
		expect(refreshed.evidence).toMatchObject({ revision: 7, contractVersion: "v14" });
		expect(refreshed.evidenceFingerprint).toBe(frozenFingerprint);
		expect(refreshed.evidence.revision).toBe(frozenManifest.revision);

		// Old discussion survives staleness.
		const comments = await reviewService.listComments({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id });
		expect(comments).toHaveLength(1);

		// A stale APPROVED stays APPROVED+STALE, never CURRENT, never unapproved.
		const approved = await reviewService.decide({
			workspaceId: ws._id,
			profileId: ALEX,
			reviewId: refreshed._id,
			expectedRevision: refreshed.revision,
			decision: "APPROVED",
		});
		expect(approved.decision).toBe(REVIEW_DECISION.APPROVED);
		expect(approved.freshness).toBe(REVIEW_FRESHNESS.STALE);
	});

	mtest("live version tip marks staleness even when the caller omits current revision", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		const review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		await ResourceVersion.create({
			workspaceId: ws._id,
			resourceType: "collection",
			resourceId: "col_payments",
			revision: 9,
			actorProfileId: ALEX,
			action: "UPDATED",
			fingerprint: "tip-fingerprint",
			snapshot: { name: "payments" },
		});
		const refreshed = await reviewService.refresh({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id, current: {} });
		expect(refreshed.freshness).toBe(REVIEW_FRESHNESS.STALE);
		expect(refreshed.staleChangedFields).toContain("revision");
	});

	mtest("re-review creates a new linked review and preserves the old one", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		const original = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		await reviewService.refresh({
			workspaceId: ws._id,
			profileId: ALEX,
			reviewId: original._id,
			current: { revision: 8 },
		});
		const rereview = await reviewService.reReview({
			workspaceId: ws._id,
			profileId: ALEX,
			reviewId: original._id,
			input: { technicalState: "VERIFIED", evidence: evidenceInput({ revision: 8, technicalState: "VERIFIED" }) },
		});
		expect(rereview.displayId).toBe("RV-2");
		expect(rereview.supersedesReviewId).toBe(String(original._id));
		expect(rereview.technicalState).toBe("VERIFIED");
		expect(rereview.freshness).toBe(REVIEW_FRESHNESS.CURRENT);

		const untouched = await reviewService.get({ workspaceId: ws._id, profileId: ALEX, reviewId: original._id });
		expect(untouched.freshness).toBe(REVIEW_FRESHNESS.STALE);
		expect(untouched.evidence.revision).toBe(7);
	});

	mtest("owner waiver preserves technical state, author, reason, fingerprint, and timestamp", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		let review = await reviewService.create({
			workspaceId: ws._id,
			profileId: ALEX,
			input: createInput({ findingType: "verification_blocked", technicalState: "BLOCKED", evidence: evidenceInput({ technicalState: "BLOCKED" }) }),
		});
		review = await reviewService.waive({
			workspaceId: ws._id,
			profileId: ALEX,
			reviewId: review._id,
			expectedRevision: review.revision,
			reason: "Accepted risk for the staging demo; production rerun scheduled.",
		});
		expect(review.decision).toBe(REVIEW_DECISION.WAIVED);
		// A waiver must NEVER display as VERIFIED: technical state stays BLOCKED.
		expect(review.technicalState).toBe("BLOCKED");
		expect(review.waiver.technicalState).toBe("BLOCKED");
		expect(review.waiver.reason).toContain("staging demo");
		expect(review.waiver.evidenceFingerprint).toBe(review.evidenceFingerprint);
		expect(review.waiver.waivedAt).toBeTruthy();
		expect(String(review.waiver.authorProfileId)).toBe(String(ALEX));
	});

	mtest("two reviewers on the same stale revision: first wins, second gets 409", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		await workspaceService.addMember(ws._id, ALEX, { email: "jordan.lee@example.test", role: "EDITOR", expectedRevision: ws.revision });
		const review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		const staleRevision = review.revision;
		await reviewService.assign({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id, expectedRevision: staleRevision, assigneeProfileId: String(JORDAN) });
		await expectRejection(
			reviewService.assign({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id, expectedRevision: staleRevision, assigneeProfileId: String(ALEX) }),
			{ code: "REVIEW_REVISION_CONFLICT" },
		);
		await expectRejection(
			reviewService.decide({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id, expectedRevision: staleRevision, decision: "APPROVED" }),
			{ code: "REVIEW_REVISION_CONFLICT" },
		);
	});

	mtest("credential-looking comment values are redacted, never stored raw", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		const review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		const comment = await reviewService.comment({
			workspaceId: ws._id,
			profileId: ALEX,
			reviewId: review._id,
			body: "Repro headers — Authorization: Bearer super-secret-token-123; Cookie: session=abc",
			mentions: [],
		});
		expect(comment.redacted).toBe(true);
		expect(comment.body).toContain("Authorization: [REDACTED]");
		expect(comment.body).toContain("Cookie: [REDACTED]");
		expect(comment.body).not.toContain("super-secret-token-123");
		expect(comment.body).not.toContain("session=abc");
		const audit = await reviewService.listAudit({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id });
		const serialized = JSON.stringify(audit);
		expect(serialized).not.toContain("super-secret-token-123");
	});

	mtest("comments never modify review decision state", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		const review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		await reviewService.comment({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id, body: "Phase 41 should say VERIFIED now.", mentions: [] });
		const reloaded = await reviewService.get({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id });
		expect(reloaded.decision).toBe(REVIEW_DECISION.NONE);
		expect(reloaded.technicalState).toBe("BREAKING");
		expect(reloaded.revision).toBe(review.revision);
	});
});

describe.skipIf(!ready)("review security boundaries", () => {
	beforeEach(async () => {
		await Promise.all([
			Review.deleteMany({}),
			ReviewCounter.deleteMany({}),
			ReviewComment.deleteMany({}),
			ReviewAudit.deleteMany({}),
			Workspace.deleteMany({ ownerProfileId: { $in: [ALEX, JORDAN, CASEY] } }),
		]);
		await seedProfiles();
	});

	mtest("cross-workspace and outsider review access is denied", async () => {
		const wsA = await workspaceService.create({ name: "Team A" }, ALEX);
		const wsB = await workspaceService.create({ name: "Team B" }, JORDAN);
		const review = await reviewService.create({ workspaceId: wsA._id, profileId: ALEX, input: createInput() });
		// Jordan is not a member of Team A: every entry point denies.
		await expectRejection(reviewService.get({ workspaceId: wsA._id, profileId: JORDAN, reviewId: review._id }), { code: "REVIEW_FORBIDDEN" });
		await expectRejection(reviewService.list({ workspaceId: wsA._id, profileId: JORDAN }), { code: "REVIEW_FORBIDDEN" });
		// Jordan cannot reach Team A's review through their own workspace either.
		await expectRejection(reviewService.get({ workspaceId: wsB._id, profileId: JORDAN, reviewId: review._id }), { code: "REVIEW_NOT_FOUND" });
	});

	mtest("removed member immediately loses review mutation access", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		await workspaceService.addMember(ws._id, ALEX, { email: "jordan.lee@example.test", role: "EDITOR", expectedRevision: ws.revision });
		const review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		const latest = await workspaceService.resolveContext({ profileId: ALEX, requestedWorkspaceId: ws._id });
		await workspaceService.removeMember(ws._id, ALEX, { profileId: String(JORDAN), expectedRevision: latest.workspace.revision });
		await expectRejection(
			reviewService.comment({ workspaceId: ws._id, profileId: JORDAN, reviewId: review._id, body: "Trying after removal.", mentions: [] }),
			{ code: "REVIEW_FORBIDDEN" },
		);
		await expectRejection(reviewService.get({ workspaceId: ws._id, profileId: JORDAN, reviewId: review._id }), { code: "REVIEW_FORBIDDEN" });
	});

	mtest("viewers may read but cannot comment, assign, decide, waive, or change status", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		await workspaceService.addMember(ws._id, ALEX, { email: "casey.wu@example.test", role: "VIEWER", expectedRevision: ws.revision });
		const review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		const readable = await reviewService.get({ workspaceId: ws._id, profileId: CASEY, reviewId: review._id });
		expect(readable.displayId).toBe("RV-1");
		await expectRejection(reviewService.create({ workspaceId: ws._id, profileId: CASEY, input: createInput({ title: "viewer promote" }) }), { code: "REVIEW_FORBIDDEN" });
		await expectRejection(
			reviewService.comment({ workspaceId: ws._id, profileId: CASEY, reviewId: review._id, body: "Viewer comment.", mentions: [] }),
			{ code: "REVIEW_FORBIDDEN" },
		);
		await expectRejection(
			reviewService.assign({ workspaceId: ws._id, profileId: CASEY, reviewId: review._id, expectedRevision: review.revision, assigneeProfileId: String(CASEY) }),
			{ code: "REVIEW_FORBIDDEN" },
		);
		await expectRejection(
			reviewService.decide({ workspaceId: ws._id, profileId: CASEY, reviewId: review._id, expectedRevision: review.revision, decision: "APPROVED" }),
			{ code: "REVIEW_FORBIDDEN" },
		);
		await expectRejection(
			reviewService.waive({ workspaceId: ws._id, profileId: CASEY, reviewId: review._id, expectedRevision: review.revision, reason: "Viewer waiver." }),
			{ code: "REVIEW_FORBIDDEN" },
		);
		await expectRejection(
			reviewService.setStatus({ workspaceId: ws._id, profileId: CASEY, reviewId: review._id, expectedRevision: review.revision, status: "IN_REVIEW" }),
			{ code: "REVIEW_FORBIDDEN" },
		);
	});

	mtest("an editor assignee cannot approve unless they are the designated reviewer", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		await workspaceService.addMember(ws._id, ALEX, { email: "jordan.lee@example.test", role: "EDITOR", expectedRevision: ws.revision });
		let review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		review = await reviewService.assign({
			workspaceId: ws._id,
			profileId: ALEX,
			reviewId: review._id,
			expectedRevision: review.revision,
			assigneeProfileId: String(JORDAN),
		});
		await expectRejection(
			reviewService.decide({
				workspaceId: ws._id,
				profileId: JORDAN,
				reviewId: review._id,
				expectedRevision: review.revision,
				decision: "APPROVED",
			}),
			{ code: "REVIEW_FORBIDDEN" },
		);
		review = await reviewService.setReviewer({
			workspaceId: ws._id,
			profileId: ALEX,
			reviewId: review._id,
			expectedRevision: review.revision,
			reviewerProfileId: String(JORDAN),
		});
		const approved = await reviewService.decide({
			workspaceId: ws._id,
			profileId: JORDAN,
			reviewId: review._id,
			expectedRevision: review.revision,
			decision: "APPROVED",
		});
		expect(approved.decision).toBe("APPROVED");
	});

	mtest("waive requires owner authority and a non-empty reason", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		await workspaceService.addMember(ws._id, ALEX, { email: "jordan.lee@example.test", role: "EDITOR", expectedRevision: ws.revision });
		const review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		await expectRejection(
			reviewService.waive({ workspaceId: ws._id, profileId: JORDAN, reviewId: review._id, expectedRevision: review.revision, reason: "Editor waiver." }),
			{ code: "REVIEW_FORBIDDEN" },
		);
		await expectRejection(
			reviewService.waive({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id, expectedRevision: review.revision, reason: "   " }),
			{ code: "VALIDATION_ERROR" },
		);
	});

	mtest("manipulated evidence is rejected or detected, never trusted", async () => {
		const ws = await workspaceService.create({ name: "Review Team" }, ALEX);
		// Unknown evidence fields (a smuggled body) fail the strict schema upstream;
		// here the service recomputes: a tampered manifest never matches the fingerprint.
		const review = await reviewService.create({ workspaceId: ws._id, profileId: ALEX, input: createInput() });
		const tampered = { ...review.evidence, contractFingerprint: "forged-fingerprint" };
		expect(reviewEvidenceFingerprintOf(tampered)).not.toBe(review.evidenceFingerprint);
		// Assigning a non-member is refused.
		await expectRejection(
			reviewService.assign({ workspaceId: ws._id, profileId: ALEX, reviewId: review._id, expectedRevision: review.revision, assigneeProfileId: String(JORDAN) }),
			{ code: "VALIDATION_ERROR" },
		);
	});
});

afterAll(disconnectTestDatabase);
