import { Router } from "express";
import {
	addReviewComment,
	assignReview,
	closeReview,
	createReview,
	decideReview,
	getReview,
	listReviewAudit,
	listReviewComments,
	listReviews,
	reReview,
	refreshReview,
	setReviewReviewer,
	setReviewStatus,
	waiveReview,
} from "./review.controller.js";

// Phase 50 — Review & Decision Workflow routes.
//
// Mounted workspace-scoped (requireWorkspaceAuth + resolveProfileContext +
// resolveWorkspaceContext in app.js), so every handler re-resolves current
// membership and role: a removed member loses mutation access immediately.
// Reads stay available to all current members; mutations are fail-closed by
// role inside the service.

export const reviewRouter = Router();

reviewRouter.post("/reviews", createReview);
reviewRouter.get("/reviews", listReviews);
reviewRouter.get("/reviews/:reviewId", getReview);
reviewRouter.post("/reviews/:reviewId/assign", assignReview);
reviewRouter.post("/reviews/:reviewId/reviewer", setReviewReviewer);
reviewRouter.post("/reviews/:reviewId/status", setReviewStatus);
reviewRouter.post("/reviews/:reviewId/decision", decideReview);
reviewRouter.post("/reviews/:reviewId/waive", waiveReview);
reviewRouter.post("/reviews/:reviewId/close", closeReview);
reviewRouter.post("/reviews/:reviewId/comments", addReviewComment);
reviewRouter.get("/reviews/:reviewId/comments", listReviewComments);
reviewRouter.get("/reviews/:reviewId/audit", listReviewAudit);
reviewRouter.post("/reviews/:reviewId/refresh", refreshReview);
reviewRouter.post("/reviews/:reviewId/rereview", reReview);
