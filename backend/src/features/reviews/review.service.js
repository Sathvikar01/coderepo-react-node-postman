import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { LIMITS } from "../../shared/utils/limits.js";
import { Profile } from "../profiles/profile.model.js";
import { ResourceVersion } from "../versions/version.model.js";
import { verificationProofApiService } from "../verification-proof-api/index.js";
import { publishWorkspaceEvent } from "../workspaces/workspace-events.js";
import { Workspace } from "../workspaces/workspace.model.js";
import { changedEvidenceFields, displayIdForSequence, reviewEvidenceFingerprintOf, reviewFingerprintKeyId } from "./review-identity.js";
import { REVIEW_BOUNDS, REVIEW_DECISION, REVIEW_FINDING_TYPES, REVIEW_FRESHNESS, REVIEW_STATUS } from "./review-schema.js";
import { reviewAuditRepository, reviewCommentRepository, reviewRepository } from "./review.repository.js";

// Phase 50 — Review & Decision Workflow service.
//
// MACHINES DETERMINE TECHNICAL TRUTH. HUMANS DETERMINE WHAT THE TEAM CHOOSES
// TO DO ABOUT THAT TRUTH.
//
// Nothing in this module ever writes to Phase 41 verification results,
// contract-compatibility results, proofs, or WHY evidence. Reviews READ frozen
// identity fields (ids, fingerprints, revisions) and record human decisions
// beside them. `technicalState` is copied once at promote time and is
// immutable afterwards: `BLOCKED + WAIVED` stays BLOCKED technically.

const OPEN_REVIEWS = [REVIEW_STATUS.OPEN, REVIEW_STATUS.IN_REVIEW];

function notFound() {
	return new AppError(404, "REVIEW_NOT_FOUND", "The requested review does not exist in this workspace.");
}

function conflict(message = "This review changed since it was loaded. Reload before retrying.") {
	return new AppError(409, "REVIEW_REVISION_CONFLICT", message);
}

function forbidden(message = "Your workspace role does not allow this review action.") {
	return new AppError(403, "REVIEW_FORBIDDEN", message);
}

function requireCurrentOpenDecision(review) {
	if (review.freshness === REVIEW_FRESHNESS.STALE) {
		throw new AppError(409, "REVIEW_STALE_REQUIRES_REREVIEW", "This review is stale. Create a re-review from current evidence before recording a new decision.");
	}
	if (review.status === REVIEW_STATUS.CLOSED) {
		throw new AppError(409, "REVIEW_CLOSED", "This review is closed. Reopen it before recording a new decision.");
	}
}

async function workspaceOrThrow(workspaceId) {
	if (!mongoose.isValidObjectId(workspaceId)) throw notFound();
	const workspace = await Workspace.findById(workspaceId).lean();
	if (!workspace) throw new AppError(404, "WORKSPACE_NOT_FOUND", "The requested workspace does not exist.");
	return workspace;
}

function memberRole(workspace, profileId) {
	const member = (workspace.members ?? []).find((entry) => String(entry.profileId) === String(profileId));
	return member?.role ?? null;
}

function requireMembership(workspace, profileId) {
	const role = memberRole(workspace, profileId);
	if (!role) throw new AppError(403, "REVIEW_FORBIDDEN", "Only current workspace members may access reviews.");
	return role;
}

function requireProfilesAreMembers(workspace, profileIds, what) {
	const members = new Set((workspace.members ?? []).map((entry) => String(entry.profileId)));
	for (const id of profileIds) {
		if (!members.has(String(id))) {
			throw new AppError(400, "VALIDATION_ERROR", `${what} must be a current workspace member.`);
		}
	}
}

// Comment bodies are human discussion. Credential-looking values are redacted
// (not rejected) so discussion stays possible while stored rows, audit rows,
// and live events can never carry a secret.
const REDACT_PATTERNS = [
		{ pattern: /(authorization\s*:\s*)([^\n;]+)/gi, replace: "$1[REDACTED]" },
	{ pattern: /(cookie\s*:\s*)([^\n;]+)/gi, replace: "$1[REDACTED]" },
	{ pattern: /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*)([^\s;,\n]+)/gi, replace: "$1[REDACTED]" },
	{ pattern: /(bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, replace: "$1[REDACTED]" },
	{ pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[REDACTED-PRIVATE-KEY]" },
];

export function redactSecretsFromText(value) {
	let output = String(value ?? "");
	let redacted = false;
	for (const { pattern, replace } of REDACT_PATTERNS) {
		pattern.lastIndex = 0;
		if (pattern.test(output)) {
			pattern.lastIndex = 0;
			output = output.replace(pattern, replace);
			redacted = true;
		}
	}
	return { body: output, redacted };
}

async function actorName(profileId) {
	if (!profileId) return null;
	const profile = await Profile.findById(profileId).select("name").lean();
	return profile?.name ?? null;
}

async function publishReviewEvent({ workspaceId, action, review, actorProfileId, revision }) {
	try {
		await publishWorkspaceEvent({
			workspaceId: String(workspaceId),
			action,
			resourceType: "review",
			resourceId: String(review._id),
			revision: revision ?? review.revision ?? null,
			actorProfileId: actorProfileId ? String(actorProfileId) : null,
			actorName: await actorName(actorProfileId),
			timestamp: new Date().toISOString(),
		});
	} catch {
		// Live delivery is advisory only and must never break authoritative writes.
	}
}

async function appendAudit({ workspaceId, review, action, actorProfileId, previous, summary }) {
	await reviewAuditRepository.append({
		workspaceId,
		reviewId: review._id,
		action,
		actorProfileId: actorProfileId ?? null,
		previousRevision: previous?.revision ?? null,
		newRevision: review.revision ?? null,
		previousDecision: previous?.decision ?? null,
		newDecision: review.decision ?? null,
		previousFreshness: previous?.freshness ?? null,
		newFreshness: review.freshness ?? null,
		evidenceFingerprint: review.evidenceFingerprint ?? null,
		summary: String(summary).slice(0, 300),
	});
}

function serializeReview(review) {
	if (!review) return null;
	return {
		...review,
		_id: String(review._id),
		workspaceId: String(review.workspaceId),
		assigneeProfileId: review.assigneeProfileId ? String(review.assigneeProfileId) : null,
		reviewerProfileId: review.reviewerProfileId ? String(review.reviewerProfileId) : null,
		createdByProfileId: review.createdByProfileId ? String(review.createdByProfileId) : null,
		supersedesReviewId: review.supersedesReviewId ? String(review.supersedesReviewId) : null,
	};
}


function reviewSourceMismatch(message, details) {
	return new AppError(422, "REVIEW_SOURCE_MISMATCH", message, details);
}

function provenanceDigest(proof, source) {
	return (proof?.provenance?.sources ?? []).find((entry) => entry?.source === source)?.digest ?? null;
}

// A review source is derived only from a Phase 47 Verification Proof that passed
// the existing artifact importer/integrity checks. Humans choose what to discuss;
// they do not type technical truth or machine fingerprints.
export function deriveReviewSourceFromProof(proof, findingType, expectedWorkspaceId) {
	if (!proof || typeof proof !== "object") throw reviewSourceMismatch("A validated Verification Proof is required.");
	if (String(proof.identity?.workspaceId ?? "") !== String(expectedWorkspaceId)) {
		throw reviewSourceMismatch("The Verification Proof belongs to a different workspace.", {
			expectedWorkspaceId: String(expectedWorkspaceId),
			actualWorkspaceId: proof.identity?.workspaceId ?? null,
		});
	}

	let technicalState;
	switch (findingType) {
		case REVIEW_FINDING_TYPES.CONTRACT_BREAKING:
			if ((proof.contracts?.classes?.breaking ?? 0) < 1) {
				throw reviewSourceMismatch("This proof does not contain a breaking contract finding.");
			}
			technicalState = "BREAKING";
			break;
		case REVIEW_FINDING_TYPES.VERIFICATION_BLOCKED:
			if (proof.state !== "BLOCKED") throw reviewSourceMismatch("This proof is not BLOCKED.");
			technicalState = "BLOCKED";
			break;
		case REVIEW_FINDING_TYPES.VERIFICATION_UNKNOWN:
			if (proof.state !== "UNKNOWN") throw reviewSourceMismatch("This proof is not UNKNOWN.");
			technicalState = "UNKNOWN";
			break;
		case REVIEW_FINDING_TYPES.DRIFT_BLOCKING:
			if ((proof.drift?.blockingCount ?? 0) < 1) throw reviewSourceMismatch("This proof does not contain blocking drift.");
			technicalState = "BLOCKING_DRIFT";
			break;
		case REVIEW_FINDING_TYPES.DRIFT_UNKNOWN: {
			const hasUnknown = (proof.drift?.blocking ?? []).some((entry) => entry?.severity === "unknown" || entry?.status === "unknown");
			if (!hasUnknown) throw reviewSourceMismatch("This proof does not contain unknown drift.");
			technicalState = "UNKNOWN_DRIFT";
			break;
		}
		case REVIEW_FINDING_TYPES.IMPACT_UNRESOLVED:
			if (
				proof.impact?.resolved !== false &&
				proof.impact?.truncated !== true &&
				(proof.impact?.unknownCount ?? 0) < 1
			) {
				throw reviewSourceMismatch("This proof does not contain unresolved impact.");
			}
			technicalState = "UNRESOLVED";
			break;
		case REVIEW_FINDING_TYPES.REHEARSAL_FAILURE:
			if (!["FAILED", "ABORTED"].includes(proof.rehearsal?.runState)) {
				throw reviewSourceMismatch("This proof does not contain a failed or aborted rehearsal.");
			}
			technicalState = proof.rehearsal.runState;
			break;
		case REVIEW_FINDING_TYPES.VERIFICATION_PROOF:
		case REVIEW_FINDING_TYPES.WHY_EVIDENCE:
			technicalState = proof.state;
			break;
		default:
			throw reviewSourceMismatch("The requested review finding type is not supported.");
	}

	const evidence = {
		workspaceId: String(expectedWorkspaceId),
		snapshotId: proof.identity.snapshot.snapshotId,
		snapshotFingerprint: proof.identity.snapshot.snapshotFingerprint,
		targetEnvironmentId: proof.identity.targetEnvironment.environmentId,
		targetEnvironmentFingerprint: proof.identity.targetEnvironment.environmentFingerprint,
		planFingerprint: proof.identity.planFingerprint,
		impactFingerprint: proof.impact?.fingerprint ?? provenanceDigest(proof, "change-impact"),
		driftFingerprint: proof.drift?.fingerprint ?? provenanceDigest(proof, "environment-drift"),
		rehearsalRunId: proof.rehearsal?.runId ?? proof.identity.runId,
		rehearsalFingerprint: proof.rehearsal?.identityFingerprint ?? proof.identity.runIdentityFingerprint,
		verificationFingerprint: proof.verification?.fingerprint ?? provenanceDigest(proof, "cross-env-verification"),
		contractFingerprint: provenanceDigest(proof, "contract-compatibility"),
		technicalState,
		proofId: proof.proofId,
		proofFingerprint: proof.fingerprint,
	};
	for (const key of Object.keys(evidence)) {
		if (evidence[key] === null || evidence[key] === undefined) delete evidence[key];
	}
	return { technicalState, evidence };
}

async function assertResourceBinding(workspaceId, resource) {
	if (!resource) return null;
	const row = await ResourceVersion.findOne({
		workspaceId,
		resourceType: resource.resourceType,
		resourceId: resource.resourceId,
		revision: resource.revision,
	})
		.select("resourceType resourceId revision")
		.lean();
	if (!row) {
		throw reviewSourceMismatch("The bound resource revision does not exist in this workspace.", {
			resourceType: resource.resourceType,
			resourceId: resource.resourceId,
			revision: resource.revision,
		});
	}
	return {
		resourceType: resource.resourceType,
		resourceId: resource.resourceId,
		revision: resource.revision,
	};
}

export const reviewService = {
	// Public HTTP creation boundary. The imported proof is already validated by
	// Phase 47B; this method derives all machine-owned fields server-side.
	async createFromProof({ workspaceId, profileId, input }) {
		const imported = verificationProofApiService.importProof(profileId, input.proofArtifact);
		const source = deriveReviewSourceFromProof(imported.proof, input.findingType, workspaceId);
		const resource = await assertResourceBinding(workspaceId, input.resource);
		return this.create({
			workspaceId,
			profileId,
			input: {
				title: input.title,
				findingType: input.findingType,
				findingSummary: input.findingSummary,
				technicalState: source.technicalState,
				evidence: { ...source.evidence, ...(resource ?? {}) },
				assigneeProfileId: input.assigneeProfileId ?? null,
				reviewerProfileId: input.reviewerProfileId ?? null,
				supersedesReviewId: input.supersedesReviewId ?? null,
			},
		});
	},

	// --- Promote to Review -------------------------------------------------
	// Explicit creation only: the caller names the finding type and the exact
	// frozen evidence. Nothing here auto-sends, auto-saves, or re-executes.
	async create({ workspaceId, profileId, input }) {
		const workspace = await workspaceOrThrow(workspaceId);
		const role = requireMembership(workspace, profileId);
		if (role !== "OWNER" && role !== "EDITOR") throw forbidden("Only workspace owners and editors may promote findings to review.");

		const openCount = await reviewRepository.countOpenByWorkspace(workspace._id);
		const openBound = LIMITS.openReviewsPerWorkspace ?? REVIEW_BOUNDS.openReviewsPerWorkspace;
		if (openCount >= openBound) {
			throw new AppError(409, "REVIEW_LIMIT_REACHED", `This workspace already has ${openBound} open reviews. Resolve one before promoting another.`);
		}

		const assignees = [input.assigneeProfileId, input.reviewerProfileId].filter(Boolean);
		if (assignees.length > 0) requireProfilesAreMembers(workspace, assignees, "Review assignment");

		if (input.supersedesReviewId) {
			const previous = await reviewRepository.findByIdInWorkspace(input.supersedesReviewId, workspace._id);
			if (!previous) throw notFound();
		}

		const evidence = { ...input.evidence, workspaceId: String(workspace._id) };
		const evidenceFingerprint = reviewEvidenceFingerprintOf(evidence);
		const counter = await reviewRepository.nextSequence(workspace._id);

		const created = await reviewRepository.create({
			workspaceId: workspace._id,
			displayId: displayIdForSequence(counter.sequence),
			sequence: counter.sequence,
			title: input.title,
			findingType: input.findingType,
			findingSummary: input.findingSummary,
			technicalState: input.technicalState,
			status: REVIEW_STATUS.OPEN,
			decision: REVIEW_DECISION.NONE,
			freshness: REVIEW_FRESHNESS.CURRENT,
			assigneeProfileId: input.assigneeProfileId ?? null,
			reviewerProfileId: input.reviewerProfileId ?? null,
			evidence,
			evidenceFingerprint,
			evidenceFingerprintKeyId: reviewFingerprintKeyId(),
			supersedesReviewId: input.supersedesReviewId ?? null,
			createdByProfileId: profileId,
		});

		const review = serializeReview(created.toObject ? created.toObject() : created);
		await appendAudit({
			workspaceId: workspace._id,
			review,
			action: "review.created",
			actorProfileId: profileId,
			previous: null,
			summary: `${review.displayId} promoted: ${input.findingType} (${input.technicalState})`,
		});
		await publishReviewEvent({ workspaceId: workspace._id, action: "review.created", review, actorProfileId: profileId });
		if (review.assigneeProfileId) {
			await appendAudit({
				workspaceId: workspace._id,
				review,
				action: "review.assigned",
				actorProfileId: profileId,
				previous: null,
				summary: `${review.displayId} initially assigned to ${review.assigneeProfileId}`,
			});
			await publishReviewEvent({ workspaceId: workspace._id, action: "review.assigned", review, actorProfileId: profileId });
		}
		if (review.reviewerProfileId) {
			await appendAudit({
				workspaceId: workspace._id,
				review,
				action: "review.reviewer_changed",
				actorProfileId: profileId,
				previous: null,
				summary: `${review.displayId} initial reviewer set to ${review.reviewerProfileId}`,
			});
			await publishReviewEvent({ workspaceId: workspace._id, action: "review.reviewer_changed", review, actorProfileId: profileId });
		}
		return review;
	},

	async list({ workspaceId, profileId, status, assignedToMe } = {}) {
		const workspace = await workspaceOrThrow(workspaceId);
		requireMembership(workspace, profileId);
		const rows = await reviewRepository.listByWorkspace(workspace._id, {
			status: status ?? null,
			assigneeProfileId: assignedToMe ? profileId : null,
			limit: 100,
		});
		return rows.map(serializeReview);
	},

	async get({ workspaceId, profileId, reviewId }) {
		const workspace = await workspaceOrThrow(workspaceId);
		requireMembership(workspace, profileId);
		const review = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!review) throw notFound();
		return serializeReview(review);
	},

	// --- Assignment ----------------------------------------------------------
	async assign({ workspaceId, profileId, reviewId, expectedRevision, assigneeProfileId }) {
		const workspace = await workspaceOrThrow(workspaceId);
		const role = requireMembership(workspace, profileId);
		const review = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!review) throw notFound();

		if (assigneeProfileId) requireProfilesAreMembers(workspace, [assigneeProfileId], "Review assignee");
		if (role === "VIEWER") throw forbidden("Viewers may not assign reviews.");
		// Editors may only assign work to themselves; owners may assign anyone.
		if (role === "EDITOR") {
			if (assigneeProfileId && String(assigneeProfileId) !== String(profileId)) {
				throw forbidden("Editors may only assign reviews to themselves.");
			}
			if (!assigneeProfileId && review.assigneeProfileId && String(review.assigneeProfileId) !== String(profileId)) {
				throw forbidden("Editors may only clear their own assignment.");
			}
		}
		// Assignment never grants resource permissions; membership/roles are untouched.

		const previous = { ...review };
		const updated = await reviewRepository.replaceWithRevision(review._id, workspace._id, expectedRevision, {
			assigneeProfileId: assigneeProfileId ?? null,
		});
		if (!updated) throw conflict();
		const out = serializeReview(updated);
		await appendAudit({
			workspaceId: workspace._id,
			review: out,
			action: "review.assigned",
			actorProfileId: profileId,
			previous,
			summary: `${out.displayId} assigned to ${assigneeProfileId ?? "nobody"}`,
		});
		await publishReviewEvent({ workspaceId: workspace._id, action: "review.assigned", review: out, actorProfileId: profileId });
		return out;
	},

	async setReviewer({ workspaceId, profileId, reviewId, expectedRevision, reviewerProfileId }) {
		const workspace = await workspaceOrThrow(workspaceId);
		const role = requireMembership(workspace, profileId);
		const review = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!review) throw notFound();

		if (reviewerProfileId) requireProfilesAreMembers(workspace, [reviewerProfileId], "Review reviewer");
		if (role === "VIEWER") throw forbidden("Viewers may not change the reviewer.");
		if (role === "EDITOR") {
			if (reviewerProfileId && String(reviewerProfileId) !== String(profileId)) {
				throw forbidden("Editors may only designate themselves as reviewer.");
			}
			if (!reviewerProfileId && review.reviewerProfileId && String(review.reviewerProfileId) !== String(profileId)) {
				throw forbidden("Editors may only clear themselves as reviewer.");
			}
		}

		const previous = { ...review };
		const updated = await reviewRepository.replaceWithRevision(review._id, workspace._id, expectedRevision, {
			reviewerProfileId: reviewerProfileId ?? null,
		});
		if (!updated) throw conflict();
		const out = serializeReview(updated);
		await appendAudit({
			workspaceId: workspace._id,
			review: out,
			action: "review.reviewer_changed",
			actorProfileId: profileId,
			previous,
			summary: `${out.displayId} reviewer set to ${reviewerProfileId ?? "nobody"}`,
		});
		await publishReviewEvent({ workspaceId: workspace._id, action: "review.updated", review: out, actorProfileId: profileId });
		return out;
	},

	// --- Status --------------------------------------------------------------
	async setStatus({ workspaceId, profileId, reviewId, expectedRevision, status }) {
		const workspace = await workspaceOrThrow(workspaceId);
		const role = requireMembership(workspace, profileId);
		if (role !== "OWNER") throw forbidden("Only workspace owners may change review status.");
		const review = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!review) throw notFound();

		const previous = { ...review };
		const patch = { status };
		if (status === REVIEW_STATUS.CLOSED) patch.closedAt = new Date();
		else patch.closedAt = null;
		const updated = await reviewRepository.replaceWithRevision(review._id, workspace._id, expectedRevision, patch);
		if (!updated) throw conflict();
		const out = serializeReview(updated);
		const action = status === REVIEW_STATUS.CLOSED ? "review.resolved" : status === REVIEW_STATUS.IN_REVIEW ? "review.in_review" : "review.reopened";
		await appendAudit({
			workspaceId: workspace._id,
			review: out,
			action,
			actorProfileId: profileId,
			previous,
			summary: `${out.displayId} moved to ${status}`,
		});
		await publishReviewEvent({ workspaceId: workspace._id, action: "review.updated", review: out, actorProfileId: profileId });
		return out;
	},

	// --- Decisions -----------------------------------------------------------
	// APPROVED accepts the reviewed evidence/state. It NEVER changes technical
	// truth: the stored `technicalState` and every bound fingerprint are untouched.
	async decide({ workspaceId, profileId, reviewId, expectedRevision, decision, reason }) {
		const workspace = await workspaceOrThrow(workspaceId);
		const role = requireMembership(workspace, profileId);
		const review = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!review) throw notFound();
		requireCurrentOpenDecision(review);
		if (role === "VIEWER") throw forbidden("Viewers may not record review decisions.");
		if (role === "EDITOR") {
			const isReviewer = review.reviewerProfileId && String(review.reviewerProfileId) === String(profileId);
			if (!isReviewer) throw forbidden("Editors may only decide reviews when they are the designated reviewer.");
		}
		if (decision === REVIEW_DECISION.CHANGES_REQUESTED && reason && reason.length > REVIEW_BOUNDS.reasonMax) {
			throw new AppError(400, "VALIDATION_ERROR", "The change-request reason is too long.");
		}

		const previous = { ...review };
		const updated = await reviewRepository.replaceWithRevision(review._id, workspace._id, expectedRevision, {
			decision,
			decisionReason: decision === REVIEW_DECISION.CHANGES_REQUESTED ? (reason ?? null) : null,
			decidedByProfileId: profileId,
			decidedAt: new Date(),
		});
		if (!updated) throw conflict();
		const out = serializeReview(updated);
		const action = decision === REVIEW_DECISION.APPROVED ? "review.approved" : "review.changes_requested";
		await appendAudit({
			workspaceId: workspace._id,
			review: out,
			action,
			actorProfileId: profileId,
			previous,
			summary: `${out.displayId} ${decision === REVIEW_DECISION.APPROVED ? "approved" : "requested changes"} (technical state still ${out.technicalState})`,
		});
		await publishReviewEvent({ workspaceId: workspace._id, action: "review.decision_changed", review: out, actorProfileId: profileId });
		return out;
	},

	// WAIVED is OWNER-only, requires a non-empty reason, and prominently
	// preserves technical state + author + reason + evidence fingerprint +
	// timestamp. A waiver must NEVER display as VERIFIED.
	async waive({ workspaceId, profileId, reviewId, expectedRevision, reason }) {
		const workspace = await workspaceOrThrow(workspaceId);
		const role = requireMembership(workspace, profileId);
		if (role !== "OWNER") throw forbidden("Only workspace owners may waive a review.");
		if (!reason || !String(reason).trim()) throw new AppError(400, "VALIDATION_ERROR", "A waiver requires a reason.");
		const review = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!review) throw notFound();
		requireCurrentOpenDecision(review);

		const previous = { ...review };
		const updated = await reviewRepository.replaceWithRevision(review._id, workspace._id, expectedRevision, {
			decision: REVIEW_DECISION.WAIVED,
			decisionReason: String(reason).slice(0, REVIEW_BOUNDS.reasonMax),
			decidedByProfileId: profileId,
			decidedAt: new Date(),
			waiver: {
				authorProfileId: profileId,
				reason: String(reason).slice(0, REVIEW_BOUNDS.reasonMax),
				technicalState: review.technicalState,
				evidenceFingerprint: review.evidenceFingerprint,
				waivedAt: new Date(),
			},
		});
		if (!updated) throw conflict();
		const out = serializeReview(updated);
		await appendAudit({
			workspaceId: workspace._id,
			review: out,
			action: "review.waived",
			actorProfileId: profileId,
			previous,
			summary: `${out.displayId} waived by owner; technical state remains ${out.technicalState}`,
		});
		await publishReviewEvent({ workspaceId: workspace._id, action: "review.decision_changed", review: out, actorProfileId: profileId });
		return out;
	},

	// --- Comments + @mentions --------------------------------------------------
	// Discussion only. Comment prose is never fed back into Phase 41, contract
	// compatibility, proofs, or WHY technical conclusions.
	async comment({ workspaceId, profileId, reviewId, body, mentions }) {
		const workspace = await workspaceOrThrow(workspaceId);
		const role = requireMembership(workspace, profileId);
		if (role === "VIEWER") throw forbidden("Viewers may read reviews but not comment.");
		const review = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!review) throw notFound();

		const mentionIds = (mentions ?? []).map(String);
		if (mentionIds.length > 0) requireProfilesAreMembers(workspace, mentionIds, "Mentioned member");

		const existing = await reviewCommentRepository.countByReview(review._id);
		if (existing >= REVIEW_BOUNDS.commentsPerReview) {
			throw new AppError(409, "REVIEW_COMMENT_LIMIT", "This review already has the maximum number of comments.");
		}

		const { body: cleanBody, redacted } = redactSecretsFromText(body);
		const created = await reviewCommentRepository.create({
			workspaceId: workspace._id,
			reviewId: review._id,
			authorProfileId: profileId,
			body: cleanBody,
			mentions: mentionIds,
		});
		const comment = {
			...created.toObject(),
			_id: String(created._id),
			reviewId: String(created.reviewId),
			authorProfileId: String(created.authorProfileId),
			mentions: (created.mentions ?? []).map(String),
			redacted,
		};
		await appendAudit({
			workspaceId: workspace._id,
			review: serializeReview(review),
			action: "review.comment_added",
			actorProfileId: profileId,
			previous: review,
			summary: `Comment added to ${review.displayId}${redacted ? " (secrets redacted)" : ""}`,
		});
		await publishReviewEvent({ workspaceId: workspace._id, action: "review.comment_added", review: serializeReview(review), actorProfileId: profileId });
		for (const mentionedId of mentionIds) {
			await appendAudit({
				workspaceId: workspace._id,
				review: serializeReview(review),
				action: "review.mentioned",
				actorProfileId: profileId,
				previous: review,
				summary: `${review.displayId} mentioned ${mentionedId}`,
			});
			// Metadata-only live event: the mentioned member's client refetches the
			// review; no email, no external provider, no prose payload beyond ids.
			await publishReviewEvent({ workspaceId: workspace._id, action: "review.mentioned", review: serializeReview(review), actorProfileId: profileId });
		}
		return comment;
	},

	async listComments({ workspaceId, profileId, reviewId }) {
		const workspace = await workspaceOrThrow(workspaceId);
		requireMembership(workspace, profileId);
		const review = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!review) throw notFound();
		const rows = await reviewCommentRepository.listByReview(review._id, REVIEW_BOUNDS.commentsPerReview);
		return rows.map((row) => ({
			...row,
			_id: String(row._id),
			reviewId: String(row.reviewId),
			authorProfileId: String(row.authorProfileId),
			mentions: (row.mentions ?? []).map(String),
		}));
	},

	async listAudit({ workspaceId, profileId, reviewId }) {
		const workspace = await workspaceOrThrow(workspaceId);
		requireMembership(workspace, profileId);
		const review = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!review) throw notFound();
		const rows = await reviewAuditRepository.listByReview(review._id, 200);
		return rows.map((row) => ({
			...row,
			_id: String(row._id),
			reviewId: String(row.reviewId),
			workspaceId: String(row.workspaceId),
			actorProfileId: row.actorProfileId ? String(row.actorProfileId) : null,
		}));
	},

	// --- Staleness -------------------------------------------------------------
	// The review never follows newer evidence silently. `refresh` compares the
	// frozen manifest against caller-supplied current identities (and, for
	// persisted collection/environment revisions, the live version tip). Any
	// bound identity that changed flips CURRENT→STALE, records which fields
	// changed, and preserves the old manifest and old decisions for history.
	// A stale APPROVED stays `decision=APPROVED, freshness=STALE`: never
	// magically unapproved, never CURRENT.
	async refresh({ workspaceId, profileId, reviewId, current }) {
		const workspace = await workspaceOrThrow(workspaceId);
		const role = requireMembership(workspace, profileId);
		if (role === "VIEWER") throw forbidden("Viewers may read reviews but not refresh review evidence.");
		const review = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!review) throw notFound();
		if (review.freshness === REVIEW_FRESHNESS.STALE) return serializeReview(review);

		const live = { ...(review.evidence ?? {}), ...(current ?? {}) };
		// Fill persisted resource revisions from the version tip when the frozen
		// manifest binds a resource but the caller did not supply a current one.
		if (review.evidence?.resourceType && review.evidence?.resourceId && live.revision === undefined) {
			const tip = await ResourceVersion.findOne({
				workspaceId: workspace._id,
				resourceType: review.evidence.resourceType,
				resourceId: review.evidence.resourceId,
			})
				.sort({ revision: -1 })
				.select("revision")
				.lean();
			if (tip) live.revision = tip.revision;
		}

		const changed = changedEvidenceFields(review.evidence, live);
		if (changed.length === 0) return serializeReview(review);

		const stale = await reviewRepository.markStale(review._id, workspace._id, changed);
		const out = serializeReview(stale ?? { ...review, freshness: REVIEW_FRESHNESS.STALE, staleChangedFields: changed });
		await appendAudit({
			workspaceId: workspace._id,
			review: out,
			action: "review.stale",
			actorProfileId: profileId,
			previous: review,
			summary: `${out.displayId} went STALE: ${changed.join(", ")}`,
		});
		await publishReviewEvent({ workspaceId: workspace._id, action: "review.stale", review: out, actorProfileId: profileId });
		return out;
	},

	async refreshFromProof({ workspaceId, profileId, reviewId, proofArtifact }) {
		const review = await reviewRepository.findByIdInWorkspace(reviewId, workspaceId);
		if (!review) throw notFound();
		if (!proofArtifact) return this.refresh({ workspaceId, profileId, reviewId, current: {} });
		const imported = verificationProofApiService.importProof(profileId, proofArtifact);
		const source = deriveReviewSourceFromProof(imported.proof, review.findingType, workspaceId);
		return this.refresh({ workspaceId, profileId, reviewId, current: source.evidence });
	},

	// --- Re-review ---------------------------------------------------------------
	// Never mutates the old manifest. Creates a NEW review bound to current
	// evidence and links it via `supersedesReviewId`; old decisions stay visible.
	async reReviewFromProof({ workspaceId, profileId, reviewId, input }) {
		const workspace = await workspaceOrThrow(workspaceId);
		requireMembership(workspace, profileId);
		const previous = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!previous) throw notFound();
		return this.createFromProof({
			workspaceId,
			profileId,
			input: {
				title: input?.title ?? `Re-review of ${previous.displayId}`,
				findingType: previous.findingType,
				findingSummary: input?.findingSummary ?? previous.findingSummary,
				proofArtifact: input.proofArtifact,
				resource: input.resource,
				assigneeProfileId: input?.assigneeProfileId ?? null,
				reviewerProfileId: input?.reviewerProfileId ?? null,
				supersedesReviewId: String(previous._id),
			},
		});
	},

	// Trusted internal/test primitive retained for deterministic service tests.
	// Production HTTP routes use createFromProof/reReviewFromProof instead.
	async reReview({ workspaceId, profileId, reviewId, input }) {
		const workspace = await workspaceOrThrow(workspaceId);
		requireMembership(workspace, profileId);
		const previous = await reviewRepository.findByIdInWorkspace(reviewId, workspace._id);
		if (!previous) throw notFound();
		const created = await this.create({
			workspaceId,
			profileId,
			input: {
				title: input?.title ?? `Re-review of ${previous.displayId}`,
				findingType: previous.findingType,
				findingSummary: input?.findingSummary ?? previous.findingSummary,
				technicalState: input?.technicalState ?? previous.technicalState,
				evidence: input?.evidence ?? { ...previous.evidence },
				assigneeProfileId: input?.assigneeProfileId ?? null,
				reviewerProfileId: input?.reviewerProfileId ?? null,
				supersedesReviewId: String(previous._id),
			},
		});
		return created;
	},
};
