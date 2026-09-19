import { request } from "../../shared/api/client.js";

export const executionApi = {
	send: (input) => request("/executions", { method: "POST", body: JSON.stringify(input) }),
	status: (executionId) => request(`/executions/${executionId}`),
	cancel: (executionId) => request(`/executions/${executionId}/cancel`, { method: "POST" }),
};
