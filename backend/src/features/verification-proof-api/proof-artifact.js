import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { utf8Bytes } from "../../shared/utils/limits.js";
import {
	PROOF_LIMITS,
	VERIFICATION_PROOF_ALGORITHM,
	VERIFICATION_PROOF_CANONICALIZATION,
	VERIFICATION_PROOF_KIND,
	VERIFICATION_PROOF_SCHEMA_VERSION,
	assertProofIntegrity,
	assertProofResult,
	assertProofSize,
	canonicalProofJson,
	digestOf,
	isCredentialShaped,
	verificationProofResultSchema,
} from "../verification-proof/index.js";

// Phase 47B — Portable Verification Proof artifact.
//
// This module is the transport boundary for a Phase 47A proof. It answers one
// question and nothing else:
//
//   "Turn a proof into a self-describing, deterministic JSON artifact, and turn
//    that artifact back into a proof without trusting the bytes."
//
// It does NOT introduce a second proof. The embedded `proof` is the Phase 47A
// envelope, byte-for-byte. The wrapper adds exactly the metadata a detached file
// needs to be recognized and checked later: a closed kind, a schema version, the
// proof fingerprint, the key id that produced it, and a keyed digest over the
// wrapper's own identity fields.
//
// Rules:
//
//   * Deterministic. The same proof always serializes to the same bytes. There is
//     no clock, no random filename, and no user-supplied filename.
//   * Bounded. A hard byte ceiling is enforced before parsing, so a hostile import
//     cannot exhaust memory.
//   * Fail closed. Unsupported versions, tampered envelopes, reserved keys, and
//     secret-bearing text are refused with a typed error rather than repaired.
//   * Never executes. Parsing an artifact produces data; it never sends a request,
//     writes state, or upgrades the embedded proof.

export const PROOF_ARTIFACT_KIND = "tracer.verification-proof-artifact";
export const PROOF_ARTIFACT_SCHEMA_VERSION = 1;

// The artifact is a thin wrapper around a proof that is already capped at
// `PROOF_LIMITS.maxSerializedBytes`. The extra headroom covers the wrapper fields
// and canonical whitespace without letting an import grow unbounded.
export const PROOF_ARTIFACT_MAX_BYTES = PROOF_LIMITS.maxSerializedBytes + 256 * 1024;

export const PROOF_ARTIFACT_LIMITS = Object.freeze({
	maxBytes: PROOF_ARTIFACT_MAX_BYTES,
	maxFilenameBytes: 128,
});

export const PROOF_ARTIFACT_ERROR_CODES = Object.freeze({
	MALFORMED: "VERIFICATION_PROOF_ARTIFACT_MALFORMED",
	UNSUPPORTED_VERSION: "VERIFICATION_PROOF_ARTIFACT_UNSUPPORTED_VERSION",
	TOO_LARGE: "VERIFICATION_PROOF_ARTIFACT_TOO_LARGE",
	TAMPERED: "VERIFICATION_PROOF_ARTIFACT_TAMPERED",
	SECRET_TEXT: "VERIFICATION_PROOF_ARTIFACT_SECRET_TEXT",
});

// Object keys that can be used to mutate prototypes through a JSON payload. The
// proof schema never names any of them, so a JSON reviver rejects them at every
// depth before Zod ever sees the object.
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const artifactFingerprintSchema = z.string().min(1).max(PROOF_LIMITS.maxIdentifierBytes);

export const proofArtifactSchema = z
	.object({
		kind: z.literal(PROOF_ARTIFACT_KIND),
		schemaVersion: z.literal(PROOF_ARTIFACT_SCHEMA_VERSION),
		proof: verificationProofResultSchema,
		fingerprint: artifactFingerprintSchema,
		fingerprintKeyId: artifactFingerprintSchema,
		integrity: z
			.object({
				algorithm: z.literal(VERIFICATION_PROOF_ALGORITHM),
				canonicalization: z.literal(VERIFICATION_PROOF_CANONICALIZATION),
				artifactFingerprint: artifactFingerprintSchema,
			})
			.strict(),
	})
	.strict();

function artifactError(statusCode, code, message, details) {
	return new AppError(statusCode, code, message, details);
}

// A keyed digest over the wrapper's own identity fields. It binds the artifact
// envelope to the proof it claims to carry. The embedded proof still has its own
// fingerprint; this is defense in depth against wrapper-only edits.
export function artifactFingerprintOf(proof) {
	return digestOf("verification-proof-artifact", {
		kind: PROOF_ARTIFACT_KIND,
		schemaVersion: PROOF_ARTIFACT_SCHEMA_VERSION,
		proofId: proof?.proofId ?? null,
		fingerprint: proof?.fingerprint ?? null,
		fingerprintKeyId: proof?.fingerprintKeyId ?? null,
	});
}

// Wrap an already-built, integrity-checked proof. The proof is validated against
// its own contract and its own fingerprint before it is embedded, so an artifact
// can never launder a tampered proof.
export function buildProofArtifact(proof) {
	const parsed = assertProofResult(proof);
	assertProofIntegrity(parsed);
	assertProofSize(parsed);
	return {
		kind: PROOF_ARTIFACT_KIND,
		schemaVersion: PROOF_ARTIFACT_SCHEMA_VERSION,
		proof: parsed,
		fingerprint: parsed.fingerprint,
		fingerprintKeyId: parsed.fingerprintKeyId,
		integrity: {
			algorithm: parsed.integrity.algorithm,
			canonicalization: parsed.integrity.canonicalization,
			artifactFingerprint: artifactFingerprintOf(parsed),
		},
	};
}

// Canonical, byte-stable JSON. Two exports of the same proof are identical, which
// is what makes an artifact safe to hash, diff, or commit.
export function serializeProofArtifact(artifact) {
	return canonicalProofJson(artifact);
}

// A deterministic filename derived from the proof identity, never from caller
// input. `proofId` is already schema-validated, but it is sanitized anyway so a
// filename can never carry a path separator.
export function proofArtifactFilename(proofId) {
	const safe = String(proofId ?? "")
		.replace(/[^A-Za-z0-9._-]/g, "")
		.slice(0, PROOF_ARTIFACT_LIMITS.maxFilenameBytes);
	return `${safe || "verification-proof"}.json`;
}

function parseArtifactJson(text) {
	try {
		return JSON.parse(text, (key, value) => {
			if (RESERVED_KEYS.has(key)) {
				throw artifactError(
					400,
					PROOF_ARTIFACT_ERROR_CODES.MALFORMED,
					"The proof artifact contains a reserved object key.",
					{ key },
				);
			}
			return value;
		});
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw artifactError(400, PROOF_ARTIFACT_ERROR_CODES.MALFORMED, "The proof artifact is not valid JSON.");
	}
}

// Import an artifact as untrusted input. Returns the validated artifact and the
// embedded proof. It never executes, persists, mutates, or upgrades anything.
export function parseProofArtifactText(text) {
	if (typeof text !== "string" || text.length === 0) {
		throw artifactError(400, PROOF_ARTIFACT_ERROR_CODES.MALFORMED, "A proof artifact JSON string is required.");
	}
	const bytes = utf8Bytes(text);
	if (bytes > PROOF_ARTIFACT_MAX_BYTES) {
		throw artifactError(413, PROOF_ARTIFACT_ERROR_CODES.TOO_LARGE, "The proof artifact exceeds the maximum size.", {
			bytes,
			maxBytes: PROOF_ARTIFACT_MAX_BYTES,
		});
	}
	if (isCredentialShaped(text)) {
		throw artifactError(
			422,
			PROOF_ARTIFACT_ERROR_CODES.SECRET_TEXT,
			"The proof artifact contains credential-shaped text and was refused.",
		);
	}

	const raw = parseArtifactJson(text);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw artifactError(400, PROOF_ARTIFACT_ERROR_CODES.MALFORMED, "The proof artifact must be a JSON object.");
	}
	if (raw.kind !== PROOF_ARTIFACT_KIND) {
		throw artifactError(400, PROOF_ARTIFACT_ERROR_CODES.MALFORMED, "The artifact kind is not recognized.", {
			kind: typeof raw.kind === "string" ? raw.kind.slice(0, 128) : null,
		});
	}
	if (raw.schemaVersion !== PROOF_ARTIFACT_SCHEMA_VERSION) {
		throw artifactError(
			422,
			PROOF_ARTIFACT_ERROR_CODES.UNSUPPORTED_VERSION,
			"The artifact schema version is not supported.",
			{ schemaVersion: raw.schemaVersion ?? null, supported: PROOF_ARTIFACT_SCHEMA_VERSION },
		);
	}
	if (raw.proof?.schemaVersion !== VERIFICATION_PROOF_SCHEMA_VERSION) {
		throw artifactError(
			422,
			PROOF_ARTIFACT_ERROR_CODES.UNSUPPORTED_VERSION,
			"The embedded proof schema version is not supported.",
			{ schemaVersion: raw.proof?.schemaVersion ?? null, supported: VERIFICATION_PROOF_SCHEMA_VERSION },
		);
	}

	const parsed = proofArtifactSchema.safeParse(raw);
	if (!parsed.success) {
		throw artifactError(400, PROOF_ARTIFACT_ERROR_CODES.MALFORMED, "The proof artifact is not valid.", {
			issues: parsed.error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
		});
	}
	const artifact = parsed.data;

	// The wrapper must agree with the proof it carries. A disagreement means the
	// envelope was edited, not that the proof changed.
	if (
		artifact.fingerprint !== artifact.proof.fingerprint ||
		artifact.fingerprintKeyId !== artifact.proof.fingerprintKeyId ||
		artifact.integrity.algorithm !== artifact.proof.integrity.algorithm ||
		artifact.integrity.canonicalization !== artifact.proof.integrity.canonicalization
	) {
		throw artifactError(409, PROOF_ARTIFACT_ERROR_CODES.TAMPERED, "The artifact metadata disagrees with the proof it carries.", {
			reason: "METADATA_MISMATCH",
		});
	}
	if (artifactFingerprintOf(artifact.proof) !== artifact.integrity.artifactFingerprint) {
		throw artifactError(409, PROOF_ARTIFACT_ERROR_CODES.TAMPERED, "The artifact envelope failed its integrity check.", {
			reason: "ARTIFACT_FINGERPRINT_MISMATCH",
		});
	}

	// The Phase 47A core owns proof integrity. Reuse it rather than re-deriving the
	// fingerprint here; it throws its own typed TAMPERED error.
	assertProofIntegrity(artifact.proof);

	return { artifact, proof: artifact.proof };
}
