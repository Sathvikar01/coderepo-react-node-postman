import { request } from "../../shared/api/client.js";

export const exampleApi = {
	list: () => request("/examples"),
	get: (exampleId) => request(`/examples/${exampleId}`),
	create: (input) => request("/examples", { method: "POST", body: JSON.stringify(input) }),
	update: (exampleId, input) => request(`/examples/${exampleId}`, { method: "PUT", body: JSON.stringify(input) }),
	remove: (exampleId) => request(`/examples/${exampleId}`, { method: "DELETE" }),
};
