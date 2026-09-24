import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { utf8Bytes } from "../../shared/utils/limits.js";
import { VERIFICATION_STATE, VERIFICATION_STATES } from "../cross-env-verification/index.js";

// Phase 47A — Deterministic Verification Proof Core. Schema and closed vocabulary.
//
// This module is the only place that knows the accepted shape of a proof input
// and a proof envelope. Anything it cannot parse throws a typed AppError rather
// than silently degrading, because a proof built on half-understood evidence is
// worse than no proof.
//
// Two rules shape the whole file:
//
//   1. Everything is bounded. Request count, evidence refs, findings, provenance
//      entries, and total serialized size all have a hard ceiling, so a caller
//      cannot persist a pathological document.
//   2. Nothing sensitive enters. Bodies, credentials, cookies, bearer tokens, and
//      resolved secrets are not part of any accepted shape. Strings that look like
//      a credential are refused outright rather than redacted: a proof is a
//      machine-written record, so a secret in one is a bug, not data.

export const VERIFICATION_PROOF_KIND = "tracer.verification-proof";
export const VERIFICATION_PROOF_SCHEMA_VERSION = 1;
export const VERIFICATION_PROOF_ALGORITHM = "HMAC-SHA-256";
export const VERIFICATION_PROOF_CANONICALIZATION = "key-sorted-json-v1";

// ---------------------------------------------------------------------------
// Proof state — a closed vocabulary, borrowed verbatim from Phase 41.
// ---------------------------------------------------------------------------
//
// The proof never invents its own confidence ladder. It reuses the four Phase 41
// evidence states so that "proof state == underlying verified evidence state" is
// a value equality, not an approximation. Re-exporting the Phase 41 object (rather
// than re-typing the literals) makes that identity structural: if Phase 41 ever
// changes a token, this core cannot silently drift from it.
export const PROOF_STATES = Object.freeze({
	VERIFIED: VERIFICATION_STATE.VERIFIED,
	BLOCKED: VERIFICATION_STATE.BLOCKED,
	NEEDS_REHEARSAL: VERIFICATION_STATE.NEEDS_REHEARSAL,
	UNKNOWN: VERIFICATION_STATE.UNKNOWN,
});

export const PROOF_STATE_VALUES = Object.freeze(Object.values(PROOF_STATES));

// Priority orders the states by how much *unverified* claim they carry. A higher
// priority is a weaker / more blocked conclusion. "Never upgrade evidence" means a
// proof may never move to a strictly lower priority than the evidence it cites.
export const PROOF_STATE_PRIORITY = Object.freeze({
	[PROOF_STATES.VERIFIED]: 0,
	[PROOF_STATES.UNKNOWN]: 1,
	[PROOF_STATES.NEEDS_REHEARSAL]: 2,
	[PROOF_STATES.BLOCKED]: 3,
});

// ---------------------------------------------------------------------------
// Reason codes — explanatory, never verdicts.
// ---------------------------------------------------------------------------
//
// These describe *why* the proof says what it says. They are not verification
// verdicts and cannot change the state; the state is copied from Phase 41.
export const PROOF_REASON_CODES = Object.freeze({
	VERIFICATION_PRESENT: "VERIFICATION_PRESENT",
	VERIFICATION_MISSING: "VERIFICATION_MISSING",
	EVIDENCE_PRESENT: "EVIDENCE_PRESENT",
	EVIDENCE_MISSING: "EVIDENCE_MISSING",
	IMPACT_PRESENT: "IMPACT_PRESENT",
	IMPACT_MISSING: "IMPACT_MISSING",
	DRIFT_PRESENT: "DRIFT_PRESENT",
	DRIFT_MISSING: "DRIFT_MISSING",
	BLOCKING_DRIFT_PRESENT: "BLOCKING_DRIFT_PRESENT",
	NO_IMPACTED_REQUESTS: "NO_IMPACTED_REQUESTS",
	NO_REHEARSED_REQUESTS: "NO_REHEARSED_REQUESTS",
	VERIFIED_REQUESTS_PRESENT: "VERIFIED_REQUESTS_PRESENT",
});

export const PROOF_REASON_CODE_VALUES = Object.freeze(Object.values(PROOF_REASON_CODES));

// Typed, machine-readable refusals. Anything the proof cannot establish fails
// closed with one of these codes instead of a best-effort continuation.
export const PROOF_ERROR_CODES = Object.freeze({
	MALFORMED_INPUT: "VERIFICATION_PROOF_MALFORMED_INPUT",
	MISSING_IDENTITY: "VERIFICATION_PROOF_MISSING_IDENTITY",
	MISSING_TIMESTAMP: "VERIFICATION_PROOF_MISSING_TIMESTAMP",
	IDENTITY_MISMATCH: "VERIFICATION_PROOF_IDENTITY_MISMATCH",
	INCONSISTENT_EVIDENCE: "VERIFICATION_PROOF_INCONSISTENT_EVIDENCE",
	EVIDENCE_UPGRADE: "VERIFICATION_PROOF_EVIDENCE_UPGRADE",
	INVALID_RESULT: "VERIFICATION_PROOF_INVALID_RESULT",
	TAMPERED: "VERIFICATION_PROOF_TAMPERED",
	LIMIT_EXCEEDED: "VERIFICATION_PROOF_LIMIT_EXCEEDED",
});

export const PROOF_ERROR_CODE_VALUES = Object.freeze(Object.values(PROOF_ERROR_CODES));

// Hard bounds. Every accumulator has an explicit ceiling rather than an implicit
// "whatever the caller passed".
export const PROOF_LIMITS = Object.freeze({
	maxRequests: 5000,
	maxEvidenceRefsPerRequest: 64,
	maxFindings: 512,
	maxContracts: 5000,
	maxProvenance: 32,
	maxIdentifierBytes: 256,
	maxTimestampBytes: 64,
	maxSerializedBytes: 2 * 1024 * 1024,
});

// A string that could carry a credential. Rejected rather than redacted.
const CREDENTIAL_SHAPED = [
	/\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\./,
	/\b(sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_\-]{12,}/,
];

export function isCredentialShaped(value) {
	return CREDENTIAL_SHAPED.some((pattern) => pattern.test(String(value)));
}

function byteLimit(maxBytes, label) {
	return z
		.string()
		.min(1)
		.refine((value) => utf8Bytes(value) <= maxBytes, `${label} is limited to ${maxBytes} bytes.`);
}

// An identifier. Control characters and credential-shaped text are refused so a
// pathological value cannot smuggle a control sequence or a secret into a proof.
function identifier(label, maxBytes = PROOF_LIMITS.maxIdentifierBytes) {
	return byteLimit(maxBytes, label)
		.refine((value) => !/[\u0000-\u001f\u007f]/.test(value), `${label} cannot contain control characters.`)
		.refine((value) => !isCredentialShaped(value), `${label} cannot contain credential-shaped text.`);
}

// A fingerprint. Hex-or-token-shaped, never credential-shaped.
const fingerprint = z
	.string()
	.min(1)
	.max(PROOF_LIMITS.maxIdentifierBytes)
	.refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value), "A fingerprint cannot contain whitespace or control characters.")
	.refine((value) => !isCredentialShaped(value), "A fingerprint cannot contain credential-shaped text.");

const optionalId = identifier("Identifiers").nullable().optional();

function proofError(statusCode, code, message, details) {
	return new AppError(statusCode, code, message, details);
}

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------
//
// The wrapper validates only what it owns: workspace/snapshot/target identity,
// the explicit timestamp, and the shape of the optional integration hooks. The
// upstream artifacts (plan, run, verification, evidence, contracts) are validated
// by their OWN cores through their public parsers in the builder, so there is
// exactly one definition of each upstream shape.

export const proofSnapshotIdentitySchema = z
	.object({
		snapshotId: identifier("Snapshot ids"),
		snapshotFingerprint: fingerprint,
	})
	.strict();

export const proofTargetEnvironmentSchema = z
	.object({
		environmentId: identifier("Environment ids"),
		environmentFingerprint: fingerprint,
		environmentName: identifier("Environment names").nullish(),
	})
	.strict();

export const proofVerifierSchema = z
	.object({
		id: identifier("Verifier ids").nullish(),
		version: identifier("Verifier versions").nullish(),
	})
	.strict();

export const proofInputSchema = z
	.object({
		workspaceId: identifier("Workspace ids"),
		snapshot: proofSnapshotIdentitySchema,
		targetEnvironment: proofTargetEnvironmentSchema,
		// Upstream artifacts: owned and validated by their own cores.
		plan: z.unknown(),
		run: z.unknown().optional(),
		execution: z.unknown().optional(),
		evidence: z.unknown().optional(),
		verification: z.unknown().optional(),
		impact: z.unknown().optional(),
		drift: z.unknown().optional(),
		contracts: z.unknown().optional(),
		executedStepIds: z.array(identifier("Executed step ids")).max(PROOF_LIMITS.maxRequests).optional(),
		stopReason: identifier("Stop reasons").nullish(),
		terminated: z.boolean().optional(),
		// The explicit, caller-supplied instant the proof was minted. It is part of
		// the fingerprinted content, so identical inputs (including this instant)
		// produce byte-identical proofs across processes.
		verifiedAt: z.union([z.string().min(1), z.date()]),
		verifier: proofVerifierSchema.optional(),
	})
	.strict();

function parseWith(value, schema, code, message) {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
		throw proofError(400, code, message, { issues });
	}
	return parsed.data;
}

export function parseProofInput(value) {
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
		throw proofError(400, PROOF_ERROR_CODES.MALFORMED_INPUT, "A verification proof input object is required.");
	}
	if (value.plan === undefined || value.plan === null) {
		throw proofError(400, PROOF_ERROR_CODES.MISSING_IDENTITY, "A Phase 46A rehearsal plan is required.", { field: "plan" });
	}
	return parseWith(value, proofInputSchema, PROOF_ERROR_CODES.MALFORMED_INPUT, "The verification proof input is not valid.");
}

// ---------------------------------------------------------------------------
// Result contract
// ---------------------------------------------------------------------------

const findingSchema = z
	.object({
		code: identifier("Finding codes"),
		requestId: optionalId,
		evidenceId: optionalId,
	})
	.strict();

const evidenceRefSchema = z
	.object({
		kind: z.enum(["execution", "assertion"]),
		refId: identifier("Evidence reference ids"),
		outcome: identifier("Outcomes").nullish(),
		status: identifier("Assertion statuses").nullish(),
		complete: z.boolean().nullish(),
	})
	.strict();

const contractSummarySchema = z
	.object({
		total: z.number().int().min(0),
		breaking: z.number().int().min(0),
		nonBreaking: z.number().int().min(0),
		unknown: z.number().int().min(0),
	})
	.strict();

const requestEntrySchema = z
	.object({
		requestId: identifier("Request ids"),
		collectionId: optionalId,
		impacted: z.boolean(),
		impactKind: z.enum(["direct", "indirect"]).nullable(),
		planned: z.boolean(),
		rehearsed: z.boolean(),
		verified: z.boolean(),
		evidence: z.array(evidenceRefSchema).max(PROOF_LIMITS.maxEvidenceRefsPerRequest),
		contract: z
			.object({
				compared: z.boolean(),
				compatible: z.boolean().nullable(),
				summary: contractSummarySchema.nullable(),
			})
			.strict()
			.nullable(),
	})
	.strict();

export const verificationProofResultSchema = z
	.object({
		kind: z.literal(VERIFICATION_PROOF_KIND),
		schemaVersion: z.literal(VERIFICATION_PROOF_SCHEMA_VERSION),
		proofId: identifier("Proof ids"),
		fingerprint: fingerprint,
		fingerprintKeyId: identifier("Fingerprint key ids"),
		integrity: z
			.object({
				algorithm: z.literal(VERIFICATION_PROOF_ALGORITHM),
				canonicalization: z.literal(VERIFICATION_PROOF_CANONICALIZATION),
			})
			.strict(),
		verifiedAt: identifier("Verified-at timestamps", PROOF_LIMITS.maxTimestampBytes),
		state: z.enum(PROOF_STATE_VALUES),
		stateReasons: z.array(z.enum(PROOF_REASON_CODE_VALUES)),
		identity: z
			.object({
				workspaceId: identifier("Workspace ids"),
				snapshot: proofSnapshotIdentitySchema,
				targetEnvironment: proofTargetEnvironmentSchema,
				planFingerprint: fingerprint,
				planId: identifier("Plan ids"),
				runId: identifier("Run ids"),
				runIdentityFingerprint: fingerprint,
				runState: identifier("Run states"),
			})
			.strict(),
		verification: z
			.object({
				present: z.boolean(),
				state: z.enum(PROOF_STATE_VALUES).nullable(),
				fingerprint: fingerprint.nullable(),
				affectedRequestIds: z.array(z.string().min(1)),
				requiredRehearsalRequestIds: z.array(z.string().min(1)),
				verifiedRequestIds: z.array(z.string().min(1)),
				blockers: z.array(findingSchema).max(PROOF_LIMITS.maxFindings),
				warnings: z.array(findingSchema).max(PROOF_LIMITS.maxFindings),
				summary: z
					.object({
						affectedRequests: z.number().int().min(0),
						requiredRehearsals: z.number().int().min(0),
						verifiedRequests: z.number().int().min(0),
						blockers: z.number().int().min(0),
						warnings: z.number().int().min(0),
					})
					.strict()
					.nullable(),
			})
			.strict(),
		rehearsal: z
			.object({
				planFingerprint: fingerprint,
				runId: identifier("Run ids"),
				identityFingerprint: fingerprint,
				runState: identifier("Run states"),
				completedStepIds: z.array(z.string().min(1)),
				pendingStepIds: z.array(z.string().min(1)),
				executedStepIds: z.array(z.string().min(1)),
				stopReason: optionalId,
				terminated: z.boolean(),
			})
			.strict(),
		impact: z
			.object({
				present: z.boolean(),
				resolved: z.boolean().nullable(),
				truncated: z.boolean().nullable(),
				directRequestIds: z.array(z.string().min(1)),
				indirectRequestIds: z.array(z.string().min(1)),
				unknownCount: z.number().int().min(0),
				fingerprint: fingerprint.nullable(),
			})
			.strict(),
		drift: z
			.object({
				present: z.boolean(),
				identical: z.boolean().nullable(),
				blockingCount: z.number().int().min(0),
				blocking: z.array(
					z
						.object({
							category: identifier("Drift categories"),
							path: optionalId,
							severity: identifier("Drift severities"),
							status: identifier("Drift statuses").nullish(),
						})
						.strict(),
				),
				fingerprint: fingerprint.nullable(),
			})
			.strict(),
		contracts: z
			.object({
				present: z.boolean(),
				compared: z.number().int().min(0),
				compatible: z.number().int().min(0),
				incompatible: z.number().int().min(0),
				unknown: z.number().int().min(0),
				classes: contractSummarySchema,
			})
			.strict(),
		requests: z.array(requestEntrySchema).max(PROOF_LIMITS.maxRequests),
		counts: z
			.object({
				impacted: z.number().int().min(0),
				planned: z.number().int().min(0),
				rehearsed: z.number().int().min(0),
				verified: z.number().int().min(0),
				unverified: z.number().int().min(0),
				evidenceRefs: z.number().int().min(0),
				executions: z.number().int().min(0),
				assertions: z.number().int().min(0),
			})
			.strict(),
		provenance: z
			.object({
				verifier: proofVerifierSchema,
				sources: z
					.array(
						z
							.object({
								source: identifier("Provenance sources"),
								ref: optionalId,
								digest: fingerprint.nullable(),
							})
							.strict(),
					)
					.max(PROOF_LIMITS.maxProvenance),
			})
			.strict(),
	})
	.strict();

// A result that fails its own contract is a bug, not data.
export function assertProofResult(result) {
	const parsed = verificationProofResultSchema.safeParse(result);
	if (!parsed.success) {
		throw proofError(500, PROOF_ERROR_CODES.INVALID_RESULT, "The verification proof failed its own contract check.", {
			issues: parsed.error.issues.slice(0, 8),
		});
	}
	return parsed.data;
}

// A proof that exceeds the size ceiling is refused rather than truncated: a
// truncated proof would be a different, unverifiable claim.
export function assertProofSize(result) {
	const bytes = utf8Bytes(JSON.stringify(result));
	if (bytes > PROOF_LIMITS.maxSerializedBytes) {
		throw proofError(400, PROOF_ERROR_CODES.LIMIT_EXCEEDED, "The verification proof exceeds the maximum serialized size.", {
			bytes,
			maxSerializedBytes: PROOF_LIMITS.maxSerializedBytes,
		});
	}
	return bytes;
}

export { proofError, identifier, fingerprint, VERIFICATION_STATES };
