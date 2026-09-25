import { request } from "../../shared/api/client.js";

// Phase 50 — Review & Decision Workflow API client.
//
// A thin transport wrapper over the review endpoints. It adds no review
// semantics of its own: it never computes fingerprints, never decides
// staleness, and never interprets technical state. The backend remains
// authoritative for every one of those questions.
export const reviewsApi = {
	list: ({ status, assignedToMe } = {}) => {
		const query = new URLSearchParams();
		if (status) query.set("status", status);
		if (assignedToMe) query.set("assignedToMe", "true");
		const suffix = query.toString();
		return request(`/reviews${suffix ? `?${suffix}` : ""}`);
	},
	get: (reviewId) => request(`/reviews/${reviewId}`),
	create: (input) => request("/reviews", { method: "POST", body: JSON.stringify(input) }),
	assign: (reviewId, expectedRevision, assigneeProfileId) =>
		request(`/reviews/${reviewId}/assign`, {
			method: "POST",
			body: JSON.stringify({ expectedRevision, assigneeProfileId }),
		}),
	setReviewer: (reviewId, expectedRevision, reviewerProfileId) =>
		request(`/reviews/${reviewId}/reviewer`, {
			method: "POST",
			body: JSON.stringify({ expectedRevision, reviewerProfileId }),
		}),
	setStatus: (reviewId, expectedRevision, status) =>
		request(`/reviews/${reviewId}/status`, {
			method: "POST",
			body: JSON.stringify({ expectedRevision, status }),
		}),
	decide: (reviewId, expectedRevision, decision, reason) =>
		request(`/reviews/${reviewId}/decision`, {
			method: "POST",
			body: JSON.stringify({ expectedRevision, decision, reason }),
		}),
	waive: (reviewId, expectedRevision, reason) =>
		request(`/reviews/${reviewId}/waive`, {
			method: "POST",
			body: JSON.stringify({ expectedRevision, reason }),
		}),
	close: (reviewId, expectedRevision) =>
		request(`/reviews/${reviewId}/close`, { method: "POST", body: JSON.stringify({ expectedRevision }) }),
	comments: (reviewId) => request(`/reviews/${reviewId}/comments`),
	addComment: (reviewId, body, mentions) =>
		request(`/reviews/${reviewId}/comments`, {
			method: "POST",
			body: JSON.stringify({ body, mentions }),
		}),
	audit: (reviewId) => request(`/reviews/${reviewId}/audit`),
	refresh: (reviewId, proofArtifact = null) =>
		request(`/reviews/${reviewId}/refresh`, {
			method: "POST",
			body: JSON.stringify(proofArtifact ? { proofArtifact } : {}),
		}),
	rereview: (reviewId, input) =>
		request(`/reviews/${reviewId}/rereview`, { method: "POST", body: JSON.stringify(input ?? {}) }),
};
