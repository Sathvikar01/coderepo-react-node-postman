import {
	assignReviewSchema,
	closeReviewSchema,
	commentReviewSchema,
	createReviewSchema,
	decisionReviewSchema,
	refreshReviewSchema,
	reviewerReviewSchema,
	statusReviewSchema,
	waiveReviewSchema,
} from "./review-schema.js";
import { reviewService } from "./review.service.js";

function profileIdOf(request) {
	return request.profileId ?? request.auth?.profileId ?? null;
}

export async function createReview(request, response, next) {
	try {
		const input = createReviewSchema.parse(request.body);
		response.status(201).json({
			data: await reviewService.create({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				input,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function listReviews(request, response, next) {
	try {
		response.json({
			data: await reviewService.list({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				status: request.query?.status ?? null,
				assignedToMe: request.query?.assignedToMe === "true",
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function getReview(request, response, next) {
	try {
		response.json({
			data: await reviewService.get({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function assignReview(request, response, next) {
	try {
		const { expectedRevision, assigneeProfileId } = assignReviewSchema.parse(request.body);
		response.json({
			data: await reviewService.assign({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
				expectedRevision,
				assigneeProfileId: assigneeProfileId ?? null,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function setReviewReviewer(request, response, next) {
	try {
		const { expectedRevision, reviewerProfileId } = reviewerReviewSchema.parse(request.body);
		response.json({
			data: await reviewService.setReviewer({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
				expectedRevision,
				reviewerProfileId: reviewerProfileId ?? null,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function setReviewStatus(request, response, next) {
	try {
		const { expectedRevision, status } = statusReviewSchema.parse(request.body);
		response.json({
			data: await reviewService.setStatus({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
				expectedRevision,
				status,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function decideReview(request, response, next) {
	try {
		const { expectedRevision, decision, reason } = decisionReviewSchema.parse(request.body);
		response.json({
			data: await reviewService.decide({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
				expectedRevision,
				decision,
				reason: reason ?? null,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function waiveReview(request, response, next) {
	try {
		const { expectedRevision, reason } = waiveReviewSchema.parse(request.body);
		response.json({
			data: await reviewService.waive({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
				expectedRevision,
				reason,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function closeReview(request, response, next) {
	try {
		const { expectedRevision } = closeReviewSchema.parse(request.body);
		response.json({
			data: await reviewService.setStatus({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
				expectedRevision,
				status: "CLOSED",
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function addReviewComment(request, response, next) {
	try {
		const { body, mentions } = commentReviewSchema.parse(request.body);
		response.status(201).json({
			data: await reviewService.comment({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
				body,
				mentions: mentions ?? [],
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function listReviewComments(request, response, next) {
	try {
		response.json({
			data: await reviewService.listComments({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function listReviewAudit(request, response, next) {
	try {
		response.json({
			data: await reviewService.listAudit({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function refreshReview(request, response, next) {
	try {
		const { current } = refreshReviewSchema.parse(request.body);
		response.json({
			data: await reviewService.refresh({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
				current,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function reReview(request, response, next) {
	try {
		response.status(201).json({
			data: await reviewService.reReview({
				workspaceId: request.workspaceId,
				profileId: profileIdOf(request),
				reviewId: request.params.reviewId,
				input: request.body ?? {},
			}),
		});
	} catch (error) {
		next(error);
	}
}
