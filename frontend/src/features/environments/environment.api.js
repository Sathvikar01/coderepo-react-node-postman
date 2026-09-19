import { request } from "../../shared/api/client.js";

export const environmentApi = {
	list: () => request("/environments"),
	get: (environmentId) => request(`/environments/${environmentId}`),
	create: (input) => request("/environments", { method: "POST", body: JSON.stringify(input) }),
	update: (environmentId, expectedRevision, environment) =>
		request(`/environments/${environmentId}`, { method: "PUT", body: JSON.stringify({ expectedRevision, environment }) }),
	remove: (environmentId, revision) => request(`/environments/${environmentId}?revision=${revision}`, { method: "DELETE" }),
	secretAliases: () => request("/environments/secret-aliases"),
};
