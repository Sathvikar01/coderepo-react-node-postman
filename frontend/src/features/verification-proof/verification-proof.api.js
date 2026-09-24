import { request } from "../../shared/api/client.js";

// Phase 47C — Verification Proof API client.
//
// A thin transport wrapper over the Phase 47B endpoints. It adds no verification
// semantics of its own: it never constructs a proof, never recomputes a
// fingerprint, and never decides whether a proof is current. The backend remains
// authoritative for every one of those questions.
//
// The `verify` call deliberately forwards `current` only when the caller supplies
// it. Passing `undefined` makes the backend answer UNKNOWN rather than CURRENT,
// which the UI must surface truthfully instead of guessing.
export const verificationProofApi = {
	build: (input) => request("/verification-proofs", { method: "POST", body: JSON.stringify({ input }) }),
	exportProof: (payload) => request("/verification-proofs/export", { method: "POST", body: JSON.stringify(payload) }),
	importProof: (text) => request("/verification-proofs/import", { method: "POST", body: JSON.stringify({ text }) }),
	verify: (payload) => request("/verification-proofs/verify", { method: "POST", body: JSON.stringify(payload) }),
	retrieve: (payload) => request("/verification-proofs/retrieve", { method: "POST", body: JSON.stringify(payload) }),
};
