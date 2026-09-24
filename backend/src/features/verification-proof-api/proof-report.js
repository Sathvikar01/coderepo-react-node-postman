import { z } from "zod";
import {
	PROOF_LIMITS,
	PROOF_STATES,
	PROOF_STATE_VALUES,
	digestOf,
	proofFingerprintOf,
	proofIntegrityReport,
	proofSnapshotIdentitySchema,
	proofTargetEnvironmentSchema,
	verificationProofResultSchema,
	VERIFICATION_PROOF_KIND,
	VERIFICATION_PROOF_SCHEMA_VERSION,
} from "../verification-proof/index.js";

// Phase 47B — Independent verification report.
//
// This module answers: "Given a proof (and, optionally, the current identity and
// evidence), what can an independent party establish about it?"
//
// It is deliberately separate from Phase 47A's tamper check. Phase 47A answers
// "is this envelope internally intact?". This report answers "is it intact, and
// does it still describe the world the caller is looking at now?".
//
// Truthfulness rules:
//
//   * Integrity failure is INVALID. Nothing else can override it.
//   * Identity disagreement is STALE. A proof of a different snapshot or target
//     environment is not wrong; it is about a different world.
//   * Missing current identity is UNKNOWN. Absence of evidence is never CURRENT.
//   * Supplied evidence that contradicts the proof is MISMATCH, never VALID, even
//     when the cryptographic integrity check passes.
//   * No hidden clocks. Staleness is decided only by comparing identities the
//     caller supplied against the identities the proof committed to.

export const PROOF_REPORT_KIND = "tracer.verification-proof-report";
export const PROOF_REPORT_SCHEMA_VERSION = 1;

export const PROOF_REPORT_STATUS = Object.freeze({
	VALID: "VALID",
	INVALID: "INVALID",
	STALE: "STALE",
	MISMATCH: "MISMATCH",
	UNKNOWN: "UNKNOWN",
});

export const PROOF_STALENESS = Object.freeze({
	CURRENT: "CURRENT",
	STALE: "STALE",
	UNKNOWN: "UNKNOWN",
});

export const PROOF_CHECK = Object.freeze({
	PASS: "PASS",
	FAIL: "FAIL",
	NOT_PROVIDED: "NOT_PROVIDED",
});

export const PROOF_REPORT_REASONS = Object.freeze({
	STRUCTURE_INVALID: "STRUCTURE_INVALID",
	SCHEMA_VERSION_UNSUPPORTED: "SCHEMA_VERSION_UNSUPPORTED",
	FINGERPRINT_MISMATCH: "FINGERPRINT_MISMATCH",
	FIXED_POINT_MISMATCH: "FIXED_POINT_MISMATCH",
	INTERNAL_INCONSISTENT: "INTERNAL_INCONSISTENT",
	SNAPSHOT_STALE: "SNAPSHOT_STALE",
	ENVIRONMENT_STALE: "ENVIRONMENT_STALE",
	EVIDENCE_MISMATCH: "EVIDENCE_MISMATCH",
	IDENTITY_CURRENT: "IDENTITY_CURRENT",
	CURRENT_UNKNOWN: "CURRENT_UNKNOWN",
	INTEGRITY_OK: "INTEGRITY_OK",
});

// The optional "current" observation. Every field is optional: a caller with only
// a snapshot id gets a weaker answer, never a fabricated one. Upstream envelopes
// (verification/impact/drift/contracts) are accepted as opaque values because this
// module only recomputes their Phase 47A provenance digest; it never interprets
// them, so it cannot invent verification semantics.
export const proofCurrentSchema = z
	.object({
		snapshot: proofSnapshotIdentitySchema.optional(),
		targetEnvironment: proofTargetEnvironmentSchema.optional(),
		verificationState: z.enum(PROOF_STATE_VALUES).optional(),
		verification: z.unknown().optional(),
		impact: z.unknown().optional(),
		drift: z.unknown().optional(),
		contracts: z.unknown().optional(),
	})
	.strict();

export function parseProofCurrent(value) {
	if (value === undefined || value === null) return {};
	return proofCurrentSchema.parse(value);
}

function boundedString(value, max = PROOF_LIMITS.maxIdentifierBytes) {
	return typeof value === "string" ? value.slice(0, max) : null;
}

function invalidReport(proof) {
	return {
		kind: PROOF_REPORT_KIND,
		schemaVersion: PROOF_REPORT_SCHEMA_VERSION,
		proofId: boundedString(proof?.proofId),
		fingerprint: boundedString(proof?.fingerprint),
		proofState: typeof proof?.state === "string" ? boundedString(proof.state, 64) : null,
		status: PROOF_REPORT_STATUS.INVALID,
		staleness: PROOF_STALENESS.UNKNOWN,
		checks: {
			structure: PROOF_CHECK.FAIL,
			schemaVersion: PROOF_CHECK.FAIL,
			fingerprint: PROOF_CHECK.FAIL,
			fixedPoint: PROOF_CHECK.FAIL,
			consistency: PROOF_CHECK.FAIL,
			snapshotBinding: PROOF_CHECK.NOT_PROVIDED,
			environmentBinding: PROOF_CHECK.NOT_PROVIDED,
			evidenceConsistency: PROOF_CHECK.NOT_PROVIDED,
		},
		reasons: [PROOF_REPORT_REASONS.STRUCTURE_INVALID],
		expected: null,
		current: null,
	};
}

// Internal invariants the builder guarantees. Re-checking them here makes the
// report meaningful even if a proof was produced by a different (or buggy)
// builder. A tampered proof already fails the fingerprint check; this is defense
// in depth, not the primary control.
function internalConsistencyIssues(proof) {
	const issues = [];
	const verification = proof.verification;
	if (verification.present !== (verification.state !== null)) issues.push("verification-present-state");
	if (verification.present && verification.state !== proof.state) issues.push("verification-state");
	if (!verification.present && proof.state !== PROOF_STATES.UNKNOWN) issues.push("missing-verification-state");

	if (proof.rehearsal.identityFingerprint !== proof.identity.runIdentityFingerprint) issues.push("run-identity-fingerprint");
	if (proof.rehearsal.planFingerprint !== proof.identity.planFingerprint) issues.push("plan-fingerprint");
	if (proof.rehearsal.runId !== proof.identity.runId) issues.push("run-id");
	if (proof.rehearsal.runState !== proof.identity.runState) issues.push("run-state");
	if (proof.drift.blockingCount !== proof.drift.blocking.length) issues.push("drift-blocking-count");

	const counts = {
		impacted: proof.requests.filter((request) => request.impacted).length,
		planned: proof.requests.filter((request) => request.planned).length,
		rehearsed: proof.requests.filter((request) => request.rehearsed).length,
		verified: proof.requests.filter((request) => request.verified).length,
		unverified: proof.requests.filter((request) => !request.verified).length,
		evidenceRefs: proof.requests.reduce((total, request) => total + request.evidence.length, 0),
		executions: proof.requests.reduce(
			(total, request) => total + request.evidence.filter((entry) => entry.kind === "execution").length,
			0,
		),
		assertions: proof.requests.reduce(
			(total, request) => total + request.evidence.filter((entry) => entry.kind === "assertion").length,
			0,
		),
	};
	for (const key of Object.keys(counts)) {
		if (counts[key] !== proof.counts[key]) issues.push(`count-${key}`);
	}

	const verifiedFromRequests = proof.requests
		.filter((request) => request.verified)
		.map((request) => request.requestId)
		.sort();
	const verifiedFromVerification = [...verification.verifiedRequestIds].sort();
	if (verifiedFromRequests.length !== verifiedFromVerification.length) {
		issues.push("verified-request-set");
	} else if (verifiedFromRequests.some((requestId, index) => requestId !== verifiedFromVerification[index])) {
		issues.push("verified-request-set");
	}

	if (verification.present) {
		const provenance = proof.provenance.sources.find((source) => source.source === "cross-env-verification");
		if (!provenance || provenance.digest !== verification.fingerprint) issues.push("provenance-verification");
	}
	return issues;
}

function compareSnapshot(proof, current) {
	if (!current.snapshot) return PROOF_CHECK.NOT_PROVIDED;
	const expected = proof.identity.snapshot;
	return current.snapshot.snapshotId === expected.snapshotId &&
		current.snapshot.snapshotFingerprint === expected.snapshotFingerprint
		? PROOF_CHECK.PASS
		: PROOF_CHECK.FAIL;
}

function compareEnvironment(proof, current) {
	if (!current.targetEnvironment) return PROOF_CHECK.NOT_PROVIDED;
	const expected = proof.identity.targetEnvironment;
	return current.targetEnvironment.environmentId === expected.environmentId &&
		current.targetEnvironment.environmentFingerprint === expected.environmentFingerprint
		? PROOF_CHECK.PASS
		: PROOF_CHECK.FAIL;
}

function compareEvidence(proof, current) {
	const results = [];
	if (current.verificationState !== undefined) results.push(current.verificationState === proof.state);
	if (current.verification !== undefined) {
		results.push(
			proof.verification.present && digestOf("cross-env-verification", current.verification) === proof.verification.fingerprint,
		);
	}
	if (current.impact !== undefined) {
		results.push(proof.impact.present && digestOf("change-impact", current.impact) === proof.impact.fingerprint);
	}
	if (current.drift !== undefined) {
		results.push(proof.drift.present && digestOf("environment-drift", current.drift) === proof.drift.fingerprint);
	}
	if (current.contracts !== undefined) {
		results.push(proof.contracts.present && digestOf("contract-compatibility", current.contracts) === proof.contracts.fingerprint);
	}
	if (results.length === 0) return PROOF_CHECK.NOT_PROVIDED;
	return results.every(Boolean) ? PROOF_CHECK.PASS : PROOF_CHECK.FAIL;
}

function currentEcho(current) {
	if (!current || Object.keys(current).length === 0) return null;
	return {
		snapshot: current.snapshot ?? null,
		targetEnvironment: current.targetEnvironment ?? null,
		verificationState: current.verificationState ?? null,
		provided: {
			verification: current.verification !== undefined,
			impact: current.impact !== undefined,
			drift: current.drift !== undefined,
			contracts: current.contracts !== undefined,
		},
	};
}

export function buildVerificationReport(proof, rawCurrent) {
	const parsed = verificationProofResultSchema.safeParse(proof);
	if (!parsed.success) {
		// Distinguish an unsupported version from a wholly malformed envelope so the
		// caller gets an actionable reason, but never read past a failed contract.
		const report = invalidReport(proof);
		if (proof && typeof proof === "object" && !Array.isArray(proof) && proof.kind === VERIFICATION_PROOF_KIND) {
			report.checks.schemaVersion =
				proof.schemaVersion === VERIFICATION_PROOF_SCHEMA_VERSION ? PROOF_CHECK.PASS : PROOF_CHECK.FAIL;
			if (report.checks.schemaVersion === PROOF_CHECK.FAIL) report.reasons = [PROOF_REPORT_REASONS.SCHEMA_VERSION_UNSUPPORTED];
		}
		return report;
	}

	const valid = parsed.data;
	const current = parseProofCurrent(rawCurrent);

	const integrity = proofIntegrityReport(valid);
	const fingerprintOk = !integrity.reasons.includes("FINGERPRINT_MISMATCH");
	const fixedPointOk = proofFingerprintOf(valid) === valid.fingerprint;
	const consistencyIssues = internalConsistencyIssues(valid);

	const checks = {
		structure: PROOF_CHECK.PASS,
		schemaVersion: PROOF_CHECK.PASS,
		fingerprint: fingerprintOk ? PROOF_CHECK.PASS : PROOF_CHECK.FAIL,
		fixedPoint: fixedPointOk ? PROOF_CHECK.PASS : PROOF_CHECK.FAIL,
		consistency: consistencyIssues.length === 0 ? PROOF_CHECK.PASS : PROOF_CHECK.FAIL,
		snapshotBinding: compareSnapshot(valid, current),
		environmentBinding: compareEnvironment(valid, current),
		evidenceConsistency: compareEvidence(valid, current),
	};

	const integrityFailed =
		checks.structure === PROOF_CHECK.FAIL ||
		checks.schemaVersion === PROOF_CHECK.FAIL ||
		checks.fingerprint === PROOF_CHECK.FAIL ||
		checks.fixedPoint === PROOF_CHECK.FAIL ||
		checks.consistency === PROOF_CHECK.FAIL;

	const staleness =
		checks.snapshotBinding === PROOF_CHECK.FAIL || checks.environmentBinding === PROOF_CHECK.FAIL
			? PROOF_STALENESS.STALE
			: checks.snapshotBinding === PROOF_CHECK.PASS && checks.environmentBinding === PROOF_CHECK.PASS
				? PROOF_STALENESS.CURRENT
				: PROOF_STALENESS.UNKNOWN;

	let status;
	if (integrityFailed) status = PROOF_REPORT_STATUS.INVALID;
	else if (staleness === PROOF_STALENESS.STALE) status = PROOF_REPORT_STATUS.STALE;
	else if (checks.evidenceConsistency === PROOF_CHECK.FAIL) status = PROOF_REPORT_STATUS.MISMATCH;
	else if (staleness === PROOF_STALENESS.UNKNOWN) status = PROOF_REPORT_STATUS.UNKNOWN;
	else status = PROOF_REPORT_STATUS.VALID;

	const reasons = [];
	if (checks.fingerprint === PROOF_CHECK.FAIL) reasons.push(PROOF_REPORT_REASONS.FINGERPRINT_MISMATCH);
	if (checks.fixedPoint === PROOF_CHECK.FAIL) reasons.push(PROOF_REPORT_REASONS.FIXED_POINT_MISMATCH);
	if (checks.consistency === PROOF_CHECK.FAIL) reasons.push(PROOF_REPORT_REASONS.INTERNAL_INCONSISTENT);
	if (checks.snapshotBinding === PROOF_CHECK.FAIL) reasons.push(PROOF_REPORT_REASONS.SNAPSHOT_STALE);
	if (checks.environmentBinding === PROOF_CHECK.FAIL) reasons.push(PROOF_REPORT_REASONS.ENVIRONMENT_STALE);
	if (checks.evidenceConsistency === PROOF_CHECK.FAIL) reasons.push(PROOF_REPORT_REASONS.EVIDENCE_MISMATCH);
	if (staleness === PROOF_STALENESS.CURRENT) reasons.push(PROOF_REPORT_REASONS.IDENTITY_CURRENT);
	if (staleness === PROOF_STALENESS.UNKNOWN) reasons.push(PROOF_REPORT_REASONS.CURRENT_UNKNOWN);
	if (!integrityFailed) reasons.push(PROOF_REPORT_REASONS.INTEGRITY_OK);

	return {
		kind: PROOF_REPORT_KIND,
		schemaVersion: PROOF_REPORT_SCHEMA_VERSION,
		proofId: valid.proofId,
		fingerprint: valid.fingerprint,
		proofState: valid.state,
		status,
		staleness,
		checks,
		reasons,
		expected: {
			snapshot: valid.identity.snapshot,
			targetEnvironment: valid.identity.targetEnvironment,
		},
		current: currentEcho(current),
	};
}
