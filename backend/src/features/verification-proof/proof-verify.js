import {
	PROOF_ERROR_CODES,
	VERIFICATION_PROOF_KIND,
	VERIFICATION_PROOF_SCHEMA_VERSION,
	proofError,
} from "./proof-schema.js";
import { fingerprintsEqual, proofFingerprintKeyId, proofFingerprintOf, proofIdOf } from "./proof-identity.js";

// Phase 47A — tamper evidence.
//
// A proof carries an HMAC over its own committed content. Verification recomputes
// that HMAC from the envelope, so any edit to a committed field — a state bump, a
// swapped snapshot, an added verified request — changes the fingerprint and is
// detected. The derived fields (`proofId`, `fingerprint`, `fingerprintKeyId`,
// `integrity`) are excluded from the commitment, which makes the envelope a fixed
// point rather than a recursive hash.
//
// Verification never repairs, rewrites, or downgrades. It reports, and the strict
// wrapper refuses.

const DERIVED_FIELDS = ["proofId", "fingerprint", "fingerprintKeyId", "integrity"];

export function proofIntegrityReport(proof) {
	const reasons = [];
	if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
		return { valid: false, reasons: ["NOT_AN_OBJECT"], expectedFingerprint: null, expectedProofId: null };
	}
	if (proof.kind !== VERIFICATION_PROOF_KIND) reasons.push("WRONG_KIND");
	if (proof.schemaVersion !== VERIFICATION_PROOF_SCHEMA_VERSION) reasons.push("WRONG_SCHEMA_VERSION");

	const expectedFingerprint = proofFingerprintOf(proof);
	if (typeof proof.fingerprint !== "string" || !fingerprintsEqual(proof.fingerprint, expectedFingerprint)) {
		reasons.push("FINGERPRINT_MISMATCH");
	}
	const expectedProofId = proofIdOf(expectedFingerprint);
	if (proof.proofId !== expectedProofId) reasons.push("PROOF_ID_MISMATCH");
	if (typeof proof.fingerprintKeyId !== "string" || proof.fingerprintKeyId !== proofFingerprintKeyId()) {
		reasons.push("FINGERPRINT_KEY_MISMATCH");
	}

	return {
		valid: reasons.length === 0,
		reasons,
		expectedFingerprint,
		expectedProofId,
		derivedFields: DERIVED_FIELDS,
	};
}

export function verifyProofIntegrity(proof) {
	return proofIntegrityReport(proof).valid;
}

export function assertProofIntegrity(proof) {
	const report = proofIntegrityReport(proof);
	if (!report.valid) {
		throw proofError(409, PROOF_ERROR_CODES.TAMPERED, "The verification proof failed its integrity check.", {
			reasons: report.reasons,
			expectedFingerprint: report.expectedFingerprint,
		});
	}
	return proof;
}

// Prove that a proof corresponds to a set of evidence by rebuilding it. Because
// the builder is pure and deterministic, an identical input must reproduce an
// identical fingerprint. This catches a proof that is internally consistent but
// was not produced from the evidence the caller thinks it was.
export function verifyProofMatchesEvidence(proof, build, input) {
	const rebuilt = build(input);
	return {
		matches: rebuilt.fingerprint === proof?.fingerprint,
		expectedFingerprint: rebuilt.fingerprint,
		actualFingerprint: typeof proof?.fingerprint === "string" ? proof.fingerprint : null,
	};
}
