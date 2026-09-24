import { request } from "../../shared/api/client.js";

// Phase 49 — "Why?" Inspector API client.
//
// A thin transport wrapper over the Phase 49 projection endpoint. It adds no
// semantics: it never derives precedence, never resolves a secret, never decides
// a verification state, and never persists anything. The backend explanation is
// rendered as returned.
export const whyInspectorApi = {
	explainExecution: (executionId) => request(`/why/executions/${encodeURIComponent(executionId)}`),
};
