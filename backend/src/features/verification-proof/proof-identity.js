import crypto from "node:crypto";
import { fingerprintOf, fingerprintKeyId } from "../history/fingerprint.js";
import { VERIFICATION_PROOF_KIND, VERIFICATION_PROOF_SCHEMA_VERSION } from "./proof-schema.js";

// Phase 47A — canonicalization and tamper-evidence primitives.
//
// A verification proof is only useful if two independent processes, given the
// same evidence, produce the same bytes. This module is the single place that
// defines "the same bytes":
//
//   * key-sorted object keys, undefined dropped, array order preserved;
//   * a fingerprint that is HMAC-SHA-256 over that canonical JSON, keyed by the
//     same fingerprint key the history core already uses, so a proof cannot be
//     forged by a caller who can compute a plain hash.
//
// It deliberately reuses `fingerprintOf`/`fingerprintKeyId` from the history core
// rather than inventing a second hash: two hashes in one product is two key
// rotations, two bug surfaces, and one of them will be wrong.

// The proof's fingerprint commits to everything except the fields that are
// derived FROM it. Those are stripped before hashing, so the envelope is a
// fixed point: `proofFingerprintOf(proof)` reproduces `proof.fingerprint`.
export const PROOF_UNFINGERPRINTED_KEYS = Object.freeze(["proofId", "fingerprint", "fingerprintKeyId", "integrity"]);

export function compareProofStrings(left, right) {
	const a = String(left);
	const b = String(right);
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

// Canonical JSON: sorted keys, undefined removed, arrays kept in authored order.
// Callers that commit to a set must sort it themselves; array order is a signal,
// not noise.
export function canonicalizeProofValue(value) {
	if (Array.isArray(value)) return value.map(canonicalizeProofValue);
	if (value && typeof value === "object") {
		const output = {};
		for (const key of Object.keys(value).sort(compareProofStrings)) {
			if (value[key] === undefined) continue;
			output[key] = canonicalizeProofValue(value[key]);
		}
		return output;
	}
	return value;
}

export function canonicalProofJson(value) {
	return JSON.stringify(canonicalizeProofValue(value));
}

// The proof identity. `parts` is the proof body minus the derived fields.
export function proofIdentityOf(parts) {
	return fingerprintOf({
		kind: VERIFICATION_PROOF_KIND,
		schemaVersion: VERIFICATION_PROOF_SCHEMA_VERSION,
		...parts,
	});
}

export function proofFingerprintKeyId() {
	return fingerprintKeyId();
}

// A stable, human-legible id derived from the fingerprint. It is not a second
// secret; it exists so logs and URLs can name a proof without carrying 64 chars.
export function proofIdOf(fingerprint) {
	return `proof_${String(fingerprint).slice(0, 32)}`;
}

function omitKeys(value, keys) {
	const output = {};
	for (const key of Object.keys(value)) {
		if (keys.includes(key)) continue;
		output[key] = value[key];
	}
	return output;
}

// Recompute the fingerprint from a complete proof envelope. Because the derived
// fields are stripped first, this is a pure function of the committed content.
export function proofFingerprintOf(proof) {
	return proofIdentityOf(omitKeys(proof, PROOF_UNFINGERPRINTED_KEYS));
}

// One-way digest of an upstream artifact, recorded as provenance. It binds the
// proof to the exact artifact it consumed without copying the artifact.
export function digestOf(source, value) {
	if (value === undefined || value === null) return null;
	return fingerprintOf({ kind: "tracer.verification-proof.provenance", source, value });
}

// Constant-time comparison for the integrity check. Length is compared first
// because `timingSafeEqual` throws on a length mismatch.
export function fingerprintsEqual(left, right) {
	const a = Buffer.from(String(left ?? ""), "utf8");
	const b = Buffer.from(String(right ?? ""), "utf8");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}
