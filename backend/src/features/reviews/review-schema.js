import { z } from "zod";

// Phase 50 — Review & Decision Workflow domain schema.
//
// A Review is a human decision record bound to frozen technical evidence.
// Three state axes are deliberately separate enums so they can never collapse
// into one value:
//
//   status    OPEN | IN_REVIEW | CLOSED            — where the review sits
//   decision  NONE | APPROVED | CHANGES_REQUESTED | WAIVED — what humans chose
//   freshness CURRENT | STALE                     — whether bound evidence is current
//
// Core rule: machines determine technical truth, humans determine what the team
// chooses to do about that truth. A review decision MUST NEVER modify or
// upgrade Phase 41 technical truth.

export const REVIEW_STATUS = Object.freeze({
	OPEN: "OPEN",
	IN_REVIEW: "IN_REVIEW",
	CLOSED: "CLOSED",
});

export const REVIEW_DECISION = Object.freeze({
	NONE: "NONE",
	APPROVED: "APPROVED",
	CHANGES_REQUESTED: "CHANGES_REQUESTED",
	WAIVED: "WAIVED",
});

export const REVIEW_FRESHNESS = Object.freeze({
	CURRENT: "CURRENT",
	STALE: "STALE",
});

// Explicit promote sources only. There is no automatic review creation: every
// review starts with a human pressing "Promote to Review" on one of these.
export const REVIEW_FINDING_TYPES = Object.freeze({
	CONTRACT_BREAKING: "contract_breaking",
	VERIFICATION_BLOCKED: "verification_blocked",
	VERIFICATION_UNKNOWN: "verification_unknown",
	DRIFT_BLOCKING: "drift_blocking",
	DRIFT_UNKNOWN: "drift_unknown",
	IMPACT_UNRESOLVED: "impact_unresolved",
	REHEARSAL_FAILURE: "rehearsal_failure",
	VERIFICATION_PROOF: "verification_proof",
	WHY_EVIDENCE: "why_evidence",
});

export const REVIEW_KIND = "tracer.review.v1";
export const REVIEW_SCHEMA_VERSION = 1;

export const REVIEW_AUDIT_ACTIONS = Object.freeze([
	"review.created",
	"review.assigned",
	"review.reviewer_changed",
	"review.comment_added",
	"review.mentioned",
	"review.in_review",
	"review.changes_requested",
	"review.approved",
	"review.waived",
	"review.stale",
	"review.reopened",
	"review.resolved",
]);

// Bounds live in LIMITS (shared/utils/limits.js); mirrored here for messages.
export const REVIEW_BOUNDS = Object.freeze({
	titleMax: 120,
	summaryMax: 1000,
	reasonMax: 500,
	commentBodyMax: 2000,
	commentsPerReview: 200,
	mentionsPerComment: 10,
	openReviewsPerWorkspace: 50,
});

const objectIdString = z.string().regex(/^[0-9a-fA-F]{24}$/, "Expected a 24-character object id.");

// The frozen evidence manifest binds a review to EXACT evidence. Only identity
// fields are allowed: workspace/resource/snapshot/contract/impact/drift/
// rehearsal/verification/proof/execution ids and fingerprints plus revisions.
// Bodies, headers, cookies, credentials, and secret values are rejected at the
// schema boundary so they can never enter the review, audit, or SSE layers.
const fingerprintString = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9:_.\-]+$/, "Evidence fingerprints may only carry identifier characters.");

const manifestIdString = z.string().trim().min(1).max(120);

export const evidenceManifestSchema = z
	.object({
		// workspaceId is injected from the request's workspace context on write
		// and echoed on read; callers never supply it.
		workspaceId: manifestIdString.optional(),
		resourceType: z.enum(["collection", "environment"]).optional(),
		resourceId: manifestIdString.optional(),
		revision: z.number().int().min(1).optional(),
		snapshotId: manifestIdString.optional(),
		snapshotFingerprint: fingerprintString.optional(),
		contractVersion: manifestIdString.optional(),
		contractFingerprint: fingerprintString.optional(),
		impactFingerprint: fingerprintString.optional(),
		driftFingerprint: fingerprintString.optional(),
		rehearsalRunId: manifestIdString.optional(),
		rehearsalFingerprint: fingerprintString.optional(),
		verificationFingerprint: fingerprintString.optional(),
		technicalState: z.string().trim().min(1).max(40).optional(),
		proofId: manifestIdString.optional(),
		proofFingerprint: fingerprintString.optional(),
		executionIds: z.array(manifestIdString).max(25).optional(),
	})
	.strict();

const proofArtifactText = z.string().min(1).max(3 * 1024 * 1024);

const reviewResourceBindingSchema = z
	.object({
		resourceType: z.enum(["collection", "environment"]),
		resourceId: manifestIdString,
		revision: z.number().int().min(1),
	})
	.strict();

export const createReviewSchema = z
	.object({
		title: z.string().trim().min(1).max(REVIEW_BOUNDS.titleMax),
		findingType: z.enum(Object.values(REVIEW_FINDING_TYPES)),
		findingSummary: z.string().trim().min(1).max(REVIEW_BOUNDS.summaryMax),
		// Technical truth is NEVER accepted as caller-authored fields. The
		// backend imports this artifact, verifies its HMAC-backed integrity, and
		// derives technicalState + evidence identities from the proof.
		proofArtifact: proofArtifactText,
		resource: reviewResourceBindingSchema.optional(),
		assigneeProfileId: objectIdString.optional(),
		reviewerProfileId: objectIdString.optional(),
		supersedesReviewId: objectIdString.optional(),
	})
	.strict();

export const reReviewSchema = z
	.object({
		title: z.string().trim().min(1).max(REVIEW_BOUNDS.titleMax).optional(),
		findingSummary: z.string().trim().min(1).max(REVIEW_BOUNDS.summaryMax).optional(),
		proofArtifact: proofArtifactText,
		resource: reviewResourceBindingSchema.optional(),
		assigneeProfileId: objectIdString.optional(),
		reviewerProfileId: objectIdString.optional(),
	})
	.strict();

const revisionSchema = z.coerce.number().int().min(1);

export const assignReviewSchema = z
	.object({
		expectedRevision: revisionSchema,
		assigneeProfileId: objectIdString.nullable().optional(),
	})
	.strict();

export const reviewerReviewSchema = z
	.object({
		expectedRevision: revisionSchema,
		reviewerProfileId: objectIdString.nullable().optional(),
	})
	.strict();

export const statusReviewSchema = z
	.object({
		expectedRevision: revisionSchema,
		status: z.enum([REVIEW_STATUS.IN_REVIEW, REVIEW_STATUS.OPEN, REVIEW_STATUS.CLOSED]),
	})
	.strict();

export const decisionReviewSchema = z
	.object({
		expectedRevision: revisionSchema,
		decision: z.enum([REVIEW_DECISION.APPROVED, REVIEW_DECISION.CHANGES_REQUESTED]),
		reason: z.string().trim().max(REVIEW_BOUNDS.reasonMax).optional(),
	})
	.strict();

export const waiveReviewSchema = z
	.object({
		expectedRevision: revisionSchema,
		reason: z.string().trim().min(1).max(REVIEW_BOUNDS.reasonMax),
	})
	.strict();

export const closeReviewSchema = z
	.object({
		expectedRevision: revisionSchema,
	})
	.strict();

export const commentReviewSchema = z
	.object({
		body: z.string().trim().min(1).max(REVIEW_BOUNDS.commentBodyMax),
		mentions: z.array(objectIdString).max(REVIEW_BOUNDS.mentionsPerComment).optional(),
	})
	.strict();

export const refreshReviewSchema = z
	.object({
		// Optional current proof: when omitted, refresh checks only authoritative
		// persisted identities such as the bound resource revision. Stateless
		// engine identities are never trusted from caller-authored fingerprints.
		proofArtifact: proofArtifactText.optional(),
	})
	.strict();

export function assertAuditAction(action) {
	if (!REVIEW_AUDIT_ACTIONS.includes(action)) {
		throw new Error(`Unknown review audit action: ${action}`);
	}
	return action;
}
