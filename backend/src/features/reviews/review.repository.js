import { Review, ReviewAudit, ReviewComment, ReviewCounter } from "./review.model.js";

// Phase 50 — thin persistence boundary for the Review domain. Authorization,
// validation, and technical-truth separation live in the service; this module
// only reads and writes rows.

const REVIEW_SUMMARY = "-__v";

export const reviewRepository = {
	nextSequence: (workspaceId) =>
		ReviewCounter.findOneAndUpdate(
			{ workspaceId },
			{ $inc: { sequence: 1 } },
			{ new: true, upsert: true, setDefaultsOnInsert: true },
		).lean(),

	create: (input) => Review.create(input),

	findById: (id) => Review.findById(id).lean(),

	findByIdInWorkspace: (id, workspaceId) => Review.findOne({ _id: id, workspaceId }).lean(),

	listByWorkspace: (workspaceId, { status, assigneeProfileId, limit } = {}) => {
		const filter = { workspaceId };
		if (status) filter.status = status;
		if (assigneeProfileId) filter.assigneeProfileId = assigneeProfileId;
		return Review.find(filter).select(REVIEW_SUMMARY).sort({ updatedAt: -1, _id: -1 }).limit(limit).lean();
	},

	countOpenByWorkspace: (workspaceId) =>
		Review.countDocuments({ workspaceId, status: { $in: ["OPEN", "IN_REVIEW"] } }),

	// Revision-checked mutation: two reviewers on the same stale revision race,
	// the first wins and the second gets null (typed 409 upstream). No silent merge.
	replaceWithRevision: (id, workspaceId, expectedRevision, update) =>
		Review.findOneAndUpdate(
			{ _id: id, workspaceId, revision: expectedRevision },
			{ $set: { ...update, revision: expectedRevision + 1 } },
			{ new: true, runValidators: true },
		).lean(),

	markStale: (id, workspaceId, changedFields) =>
		Review.findOneAndUpdate(
			{ _id: id, workspaceId, freshness: "CURRENT" },
			{
				$set: {
					freshness: "STALE",
					staleChangedFields: changedFields,
				},
				$inc: { revision: 1 },
			},
			{ new: true },
		).lean(),

	listBySuperseded: (reviewId) => Review.find({ supersedesReviewId: reviewId }).select("_id displayId title").lean(),
};

export const reviewCommentRepository = {
	countByReview: (reviewId) => ReviewComment.countDocuments({ reviewId }),
	create: (input) => ReviewComment.create(input),
	listByReview: (reviewId, limit) =>
		ReviewComment.find({ reviewId }).sort({ createdAt: 1, _id: 1 }).limit(limit).lean(),
};

export const reviewAuditRepository = {
	append: (entry) => ReviewAudit.create({ ...entry, createdAt: new Date() }),
	listByReview: (reviewId, limit) =>
		ReviewAudit.find({ reviewId }).sort({ createdAt: 1, _id: 1 }).limit(limit).lean(),
};
