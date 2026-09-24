import { request } from "../../shared/api/client.js";

export const investigationApi = {
	start: (input) => request("/execution-intelligence/investigations", { method: "POST", body: JSON.stringify(input) }),
	status: (investigationId) => request(`/execution-intelligence/investigations/${investigationId}`),
	cancel: (investigationId) => request(`/execution-intelligence/investigations/${investigationId}/cancel`, { method: "POST" }),
	exportCapsule: (investigationId) => request(`/execution-intelligence/investigations/${investigationId}/capsule`),
};
