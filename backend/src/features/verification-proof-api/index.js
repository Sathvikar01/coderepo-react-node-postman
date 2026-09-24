// Phase 47B — Verification Proof API.
//
// The public boundary for the portable verification-proof transport layer. This
// layer answers four questions and adds no verification semantics of its own:
//
//   * Can a proof be produced from recorded evidence?            → `build`
//   * Can it leave the machine as a portable artifact?            → `exportProof`
//   * Can that artifact be taken back in without being trusted?   → `importProof`
//   * Can it be independently checked for integrity and currency? → `verify`
//
// Design decisions that matter to callers:
//
//   * Generation-on-demand, no persistence. A proof is a pure, content-addressed
//     function of its inputs, so there is nothing to store, migrate, or leak. The
//     artifact is the record; `retrieve` recomputes identity from the artifact the
//     caller already holds and never reads a server-side proof table.
//   * Reuse, not reimplementation. All proof construction and integrity checking
//     delegates to `../verification-proof`. The `PROOF_STATES` re-export is the
//     phase's vocabulary, not a second definition of it.
//   * Fail closed. Unsupported versions, tampered envelopes, reserved keys,
//     oversized payloads, and credential-shaped text are refused with typed errors
//     rather than repaired.
//   * Profile scoped. A build refuses evidence that names another owner, so a
//     caller cannot mint a proof over someone else's execution records.

export {
	PROOF_ARTIFACT_ERROR_CODES,
	PROOF_ARTIFACT_KIND,
	PROOF_ARTIFACT_LIMITS,
	PROOF_ARTIFACT_MAX_BYTES,
	PROOF_ARTIFACT_SCHEMA_VERSION,
	artifactFingerprintOf,
	buildProofArtifact,
	parseProofArtifactText,
	proofArtifactFilename,
	proofArtifactSchema,
	serializeProofArtifact,
} from "./proof-artifact.js";

export {
	PROOF_CHECK,
	PROOF_REPORT_KIND,
	PROOF_REPORT_REASONS,
	PROOF_REPORT_SCHEMA_VERSION,
	PROOF_REPORT_STATUS,
	PROOF_STALENESS,
	buildVerificationReport,
	parseProofCurrent,
	proofCurrentSchema,
} from "./proof-report.js";

export {
	PROOF_API_ERROR_CODES,
	createVerificationProofApiService,
	verificationProofApiService,
} from "./verification-proof.service.js";

export { PROOF_API_ARTIFACT_META, parseProofBuildRequest } from "./verification-proof.controller.js";
export { verificationProofRouter } from "./verification-proof.routes.js";

export { PROOF_STATES } from "../verification-proof/index.js";
