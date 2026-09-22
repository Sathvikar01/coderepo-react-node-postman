import { request } from "../../shared/api/client.js";

export const executionIntelligenceApi = {
	receipt: (executionId) => request(`/execution-intelligence/receipts/${executionId}`),
	compare: (baseExecutionId, candidateExecutionId) =>
		request("/execution-intelligence/comparisons", {
			method: "POST",
			body: JSON.stringify({ baseExecutionId, candidateExecutionId }),
		}),
	exportCapsule: (executionId, includeResponseBody = false) =>
		request("/execution-intelligence/capsules/export", {
			method: "POST",
			body: JSON.stringify({ executionId, includeResponseBody }),
		}),
	importCapsule: (text) =>
		request("/execution-intelligence/capsules/import", { method: "POST", body: JSON.stringify({ text }) }),
	startMinimization: (input) =>
		request("/execution-intelligence/minimizations", { method: "POST", body: JSON.stringify(input) }),
	minimization: (jobId) => request(`/execution-intelligence/minimizations/${jobId}`),
	cancelMinimization: (jobId) => request(`/execution-intelligence/minimizations/${jobId}/cancel`, { method: "POST" }),
};
