import mongoose from "mongoose";
import {
	REVIEW_DECISION,
	REVIEW_FINDING_TYPES,
	REVIEW_FRESHNESS,
	REVIEW_STATUS,
} from "./review-schema.js";

// Phase 50 — persisted Review domain.
//
// One Review row binds frozen technical evidence (identity fields only — never
// bodies, headers, cookies, or secrets) to a human decision workflow. The three
// state axes stay separate fields so `decision=WAIVED + freshness=STALE` can
// never collapse into a single misleading value, and a waiver can never read
// as VERIFIED.

const evidenceSchema = new mongoose.Schema(
	{
		workspaceId: { type: String, required: true, maxlength: 120 },
		resourceType: { type: String, enum: ["collection", "environment"], default: null },
		resourceId: { type: String, default: null, maxlength: 120 },
		revision: { type: Number, default: null, min: 1 },
		snapshotId: { type: String, default: null, maxlength: 120 },
		snapshotFingerprint: { type: String, default: null, maxlength: 128 },
		targetEnvironmentId: { type: String, default: null, maxlength: 120 },
		targetEnvironmentFingerprint: { type: String, default: null, maxlength: 128 },
		planFingerprint: { type: String, default: null, maxlength: 128 },
		contractVersion: { type: String, default: null, maxlength: 120 },
		contractFingerprint: { type: String, default: null, maxlength: 128 },
		impactFingerprint: { type: String, default: null, maxlength: 128 },
		driftFingerprint: { type: String, default: null, maxlength: 128 },
		rehearsalRunId: { type: String, default: null, maxlength: 120 },
		rehearsalFingerprint: { type: String, default: null, maxlength: 128 },
		verificationFingerprint: { type: String, default: null, maxlength: 128 },
		technicalState: { type: String, default: null, maxlength: 40 },
		proofId: { type: String, default: null, maxlength: 120 },
		proofFingerprint: { type: String, default: null, maxlength: 128 },
		executionIds: { type: [String], default: [] },
	},
	{ _id: false },
);

const reviewSchema = new mongoose.Schema(
	{
		workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
		// Human display id, unique per workspace: RV-101, RV-102, ...
		displayId: { type: String, required: true, maxlength: 24 },
		sequence: { type: Number, required: true, min: 1 },
		title: { type: String, required: true, trim: true, maxlength: 120 },
		findingType: { type: String, enum: Object.values(REVIEW_FINDING_TYPES), required: true },
		findingSummary: { type: String, required: true, trim: true, maxlength: 1000 },
		// The technical state at promote time (e.g. BREAKING, BLOCKED, UNKNOWN).
		// Immutable: later verification runs never rewrite it.
		technicalState: { type: String, required: true, maxlength: 40 },
		status: { type: String, enum: Object.values(REVIEW_STATUS), required: true, default: REVIEW_STATUS.OPEN },
		decision: { type: String, enum: Object.values(REVIEW_DECISION), required: true, default: REVIEW_DECISION.NONE },
		freshness: { type: String, enum: Object.values(REVIEW_FRESHNESS), required: true, default: REVIEW_FRESHNESS.CURRENT },
		assigneeProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		reviewerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		evidence: { type: evidenceSchema, required: true },
		evidenceFingerprint: { type: String, required: true, maxlength: 128 },
		evidenceFingerprintKeyId: { type: String, default: null, maxlength: 120 },
		// Bounded waiver reason. A waiver preserves technical state, author,
		// reason, evidence fingerprint, and timestamp — and never displays as VERIFIED.
		waiver: {
			authorProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
			reason: { type: String, default: null, maxlength: 500 },
			technicalState: { type: String, default: null, maxlength: 40 },
			evidenceFingerprint: { type: String, default: null, maxlength: 128 },
			waivedAt: { type: Date, default: null },
		},
		decisionReason: { type: String, default: null, maxlength: 500 },
		decidedByProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		decidedAt: { type: Date, default: null },
		// Re-review lineage. A re-review is a NEW review linked to the previous
		// one; the old manifest is never mutated.
		supersedesReviewId: { type: mongoose.Schema.Types.ObjectId, ref: "Review", default: null },
		staleChangedFields: { type: [String], default: [] },
		revision: { type: Number, required: true, default: 1 },
		createdByProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		closedAt: { type: Date, default: null },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

reviewSchema.index({ workspaceId: 1, displayId: 1 }, { unique: true });
reviewSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });

// Per-workspace monotonic display-id counter. `findOneAndUpdate` with upsert
// makes concurrent "Promote to Review" clicks serialize into RV-N, RV-N+1.
const reviewCounterSchema = new mongoose.Schema(
	{
		workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, unique: true },
		sequence: { type: Number, required: true, default: 0 },
	},
	{ versionKey: false },
);

// Comments attach ONLY to review items — there is no general workspace chat.
// Stored in their own collection so appending a comment never bumps the review
// revision and two commenters never CAS-conflict with each other. Comments are
// human discussion only and must never become Phase 41/WHY/Proof evidence.
const reviewCommentSchema = new mongoose.Schema(
	{
		workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
		reviewId: { type: mongoose.Schema.Types.ObjectId, ref: "Review", required: true, index: true },
		authorProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true },
		body: { type: String, required: true, trim: true, maxlength: 2000 },
		// Persisted profile ids, not display strings: membership removal later
		// revokes visibility deterministically.
		mentions: { type: [mongoose.Schema.Types.ObjectId], default: [] },
	},
	{ timestamps: { createdAt: true, updatedAt: false }, versionKey: false, minimize: false },
);

reviewCommentSchema.index({ reviewId: 1, createdAt: 1, _id: 1 });

// Immutable audit trail. Rows are append-only; nothing here ever carries
// credentials, Authorization/Cookie values, resolved secrets, or bodies.
const reviewAuditSchema = new mongoose.Schema(
	{
		workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
		reviewId: { type: mongoose.Schema.Types.ObjectId, ref: "Review", required: true, index: true },
		action: { type: String, required: true, maxlength: 40 },
		actorProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		previousRevision: { type: Number, default: null },
		newRevision: { type: Number, default: null },
		previousDecision: { type: String, default: null, maxlength: 24 },
		newDecision: { type: String, default: null, maxlength: 24 },
		previousFreshness: { type: String, default: null, maxlength: 24 },
		newFreshness: { type: String, default: null, maxlength: 24 },
		evidenceFingerprint: { type: String, default: null, maxlength: 128 },
		summary: { type: String, required: true, maxlength: 300 },
		createdAt: { type: Date, default: Date.now },
	},
	{ versionKey: false, minimize: false },
);

reviewAuditSchema.index({ reviewId: 1, createdAt: 1, _id: 1 });

export const Review = mongoose.models.Review ?? mongoose.model("Review", reviewSchema);
export const ReviewCounter = mongoose.models.ReviewCounter ?? mongoose.model("ReviewCounter", reviewCounterSchema);
export const ReviewComment = mongoose.models.ReviewComment ?? mongoose.model("ReviewComment", reviewCommentSchema);
export const ReviewAudit = mongoose.models.ReviewAudit ?? mongoose.model("ReviewAudit", reviewAuditSchema);
