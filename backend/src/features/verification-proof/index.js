// Phase 47A — Deterministic Verification Proof Core.
//
// Public boundary. One question and nothing else:
//
//   "Given the exact snapshot, target environment, rehearsal run, verification
//    result, and the evidence behind it, produce a tamper-evident record of
//    exactly what was verified."
//
// This core PLANS NOTHING and EXECUTES NOTHING. It consumes the public result
// envelopes of Phases 39 (change impact), 40 (environment drift), 41 (cross-env
// verification), 43 (contract compatibility), 46A (rehearsal plan), 46B (run
// identity) and 46C (execution evidence), and emits a `VerificationProofV1`
// envelope. It never sends a request, reads a database, resolves DNS, or writes
// state.
//
// Truthfulness invariants:
//
//   * proof state == the Phase 41 evidence state, copied — never recomputed,
//     never upgraded;
//   * a proof with no verification is UNKNOWN, never VERIFIED;
//   * identity or consistency contradictions fail closed with a typed error;
//   * the fingerprint is HMAC-SHA-256 over canonical, key-sorted JSON using the
//     same fingerprint key the history core uses.
//
// Usage:
//
//   const proof = buildVerificationProof({
//     workspaceId,
//     snapshot: { snapshotId, snapshotFingerprint },
//     targetEnvironment: { environmentId, environmentFingerprint, environmentName },
//     plan, run, evidence, verification, impact, drift, contracts,
//     verifiedAt: "2026-09-24T10:00:00.000Z",
//   });
//
//   proof.state            // VERIFIED | BLOCKED | NEEDS_REHEARSAL | UNKNOWN
//   proof.fingerprint      // HMAC-SHA-256 over the committed content
//   verifyProofIntegrity(proof)   // true | false

export {
	VERIFICATION_PROOF_KIND,
	VERIFICATION_PROOF_SCHEMA_VERSION,
	VERIFICATION_PROOF_ALGORITHM,
	VERIFICATION_PROOF_CANONICALIZATION,
	PROOF_STATES,
	PROOF_STATE_VALUES,
	PROOF_STATE_PRIORITY,
	PROOF_REASON_CODES,
	PROOF_REASON_CODE_VALUES,
	PROOF_ERROR_CODES,
	PROOF_ERROR_CODE_VALUES,
	PROOF_LIMITS,
	isCredentialShaped,
	proofInputSchema,
	proofSnapshotIdentitySchema,
	proofTargetEnvironmentSchema,
	proofVerifierSchema,
	verificationProofResultSchema,
	parseProofInput,
	assertProofResult,
	assertProofSize,
} from "./proof-schema.js";

export {
	PROOF_UNFINGERPRINTED_KEYS,
	compareProofStrings,
	canonicalizeProofValue,
	canonicalProofJson,
	proofIdentityOf,
	proofFingerprintOf,
	proofFingerprintKeyId,
	proofIdOf,
	digestOf,
	fingerprintsEqual,
} from "./proof-identity.js";

export { buildVerificationProof, assertNoEvidenceUpgrade, canonicalProofJsonOf } from "./proof-builder.js";

export { proofIntegrityReport, verifyProofIntegrity, assertProofIntegrity, verifyProofMatchesEvidence } from "./proof-verify.js";
