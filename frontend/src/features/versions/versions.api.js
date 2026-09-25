import { request } from "../../shared/api/client.js";

// Phase 24B — version history API surface. Every call is scoped by the active
// profile token plus the `x-workspace-id` header the shared client attaches;
// the backend enforces current membership and role on each route.
export const versionsApi = {
	collection: {
		list: (collectionId) => request(`/collections/${collectionId}/versions`),
		get: (collectionId, revision) => request(`/collections/${collectionId}/versions/${revision}`),
		compare: (collectionId, revisionA, revisionB) =>
			request(`/collections/${collectionId}/versions/${revisionA}/compare/${revisionB}`),
		restore: (collectionId, sourceRevision, expectedCurrentRevision) =>
			request(`/collections/${collectionId}/restore`, {
				method: "POST",
				body: JSON.stringify({ sourceRevision, expectedCurrentRevision }),
			}),
	},
	environment: {
		list: (environmentId) => request(`/environments/${environmentId}/versions`),
		get: (environmentId, revision) => request(`/environments/${environmentId}/versions/${revision}`),
		compare: (environmentId, revisionA, revisionB) =>
			request(`/environments/${environmentId}/versions/${revisionA}/compare/${revisionB}`),
		restore: (environmentId, sourceRevision, expectedCurrentRevision) =>
			request(`/environments/${environmentId}/restore`, {
				method: "POST",
				body: JSON.stringify({ sourceRevision, expectedCurrentRevision }),
			}),
	},
};
