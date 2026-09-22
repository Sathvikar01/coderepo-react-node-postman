import { request } from "../../shared/api/client.js";

export const collectionRunApi = {
	list: (collectionId) => request(`/collection-runs${collectionId ? `?collectionId=${encodeURIComponent(collectionId)}` : ""}`),
	start: (input) => request("/collection-runs", { method: "POST", body: JSON.stringify(input) }),
	get: (runId) => request(`/collection-runs/${runId}`),
	cancel: (runId) => request(`/collection-runs/${runId}/cancel`, { method: "POST" }),
	rerun: (runId) => request(`/collection-runs/${runId}/rerun`, { method: "POST" }),
};
