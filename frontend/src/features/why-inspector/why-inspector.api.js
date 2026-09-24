import { request } from "../../shared/api/client.js";

// Phase 49 — "Why?" Inspector API client.
//
// A thin transport wrapper over the Phase 49 projection endpoint. It adds no
// semantics: it never derives precedence, never resolves a secret, never decides
// a verification state, and never persists anything. The backend explanation is
// rendered as returned.
export const whyInspectorApi = {
	explainExecution: (executionId) => request(`/why/executions/${encodeURIComponent(executionId)}`),
	// Explain with a caller-supplied Phase 47 proof artifact. The proof is
	// forwarded opaquely for this read only: nothing is persisted, nothing is
	// constructed here, and the backend linkage layer strictly parses it.
	explainExecutionWithProof: (executionId, proof) =>
		request(`/why/executions/${encodeURIComponent(executionId)}`, { method: "POST", body: JSON.stringify({ proof }) }),
};
