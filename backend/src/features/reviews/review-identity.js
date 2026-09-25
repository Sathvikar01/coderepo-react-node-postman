import { fingerprintOf, fingerprintKeyId } from "../history/fingerprint.js";
import { REVIEW_KIND, REVIEW_SCHEMA_VERSION } from "./review-schema.js";

// Phase 50 — review evidence identity.
//
// Reuses the history-core HMAC-SHA-256 `fingerprintOf` (same key, same key id)
// rather than inventing a second hash: the review fingerprint commits to the
// canonical frozen evidence manifest, so two processes given the same evidence
// produce the same fingerprint and any manipulated id/fingerprint is detected
// by comparison, not by trust.

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const output = {};
		for (const key of Object.keys(value).sort()) {
			if (value[key] === undefined) continue;
			output[key] = canonicalize(value[key]);
		}
		return output;
	}
	return value;
}

export function canonicalizeEvidenceManifest(manifest) {
	return canonicalize(manifest ?? {});
}

export function reviewEvidenceFingerprintOf(manifest) {
	return fingerprintOf({
		kind: "tracer.review.evidence",
		reviewKind: REVIEW_KIND,
		schemaVersion: REVIEW_SCHEMA_VERSION,
		evidence: canonicalizeEvidenceManifest(manifest),
	});
}

export function reviewFingerprintKeyId() {
	return fingerprintKeyId();
}

// Compares a live/current evidence manifest against the frozen one bound at
// review creation. Returns the list of identity fields that changed. Only
// fields present in the frozen manifest are compared: the review must not
// silently follow newer evidence, so extra current fields are ignored and
// missing current fields for a bound identity count as a change.
export function changedEvidenceFields(frozenManifest, currentManifest) {
	const frozen = frozenManifest ?? {};
	const current = currentManifest ?? {};
	const changed = [];
	for (const key of Object.keys(frozen).sort()) {
		if (key === "workspaceId") continue;
		const before = JSON.stringify(canonicalize(frozen[key]));
		const after = current[key] === undefined ? "<missing>" : JSON.stringify(canonicalize(current[key]));
		if (before !== after) changed.push(key);
	}
	return changed;
}

export function displayIdForSequence(sequence) {
	return `RV-${sequence}`;
}
