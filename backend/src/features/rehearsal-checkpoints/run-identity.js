import { compareStrings } from "./ordering.js";
import { fingerprintOf, fingerprintKeyId } from "../history/fingerprint.js";
import { REHEARSAL_CHECKPOINT_SCHEMA_VERSION } from "./checkpoint-schema.js";

// Phase 46B — Run identity binding.
//
// The identity of a rehearsal run is what makes "resume under the same premises"
// checkable. A run is bound immutably to:
//
//   * the workspace
//   * the snapshot (id + exact content fingerprint)
//   * the target environment (id + exact content fingerprint)
//   * the plan (id + exact content fingerprint)
//   * the policy (id + fingerprint), when one was supplied
//
// Any difference in any one of those is a different run. There is no partial
// match, no "the request was the same", and no tolerance for a re-created
// environment that happens to reuse an id: reuse of an id with changed content is
// caught by the fingerprint.

// A stable, platform-independent comparison. Used so ordering never depends on
// ICU data or locale.
export { compareStrings };

// The exact, flat structure an identity fingerprint commits to. Deliberately
// identity-only: no state, no timestamps, no owner, no progress.
export function identityBindings(identity) {
	return {
		schemaVersion: REHEARSAL_CHECKPOINT_SCHEMA_VERSION,
		workspaceId: identity.workspaceId,
		snapshotId: identity.snapshotId,
		snapshotFingerprint: identity.snapshotFingerprint,
		environmentId: identity.targetEnvironment.environmentId,
		environmentFingerprint: identity.targetEnvironment.environmentFingerprint,
		planId: identity.planId,
		planFingerprint: identity.planFingerprint,
		policyId: identity.policyId ?? null,
		policyFingerprint: identity.policyFingerprint ?? null,
	};
}

export function identityFingerprint(identity) {
	return fingerprintOf({ kind: "rehearsal-run-identity", identity: identityBindings(identity) });
}

export function identityFingerprintKeyId() {
	return fingerprintKeyId();
}

// Compare two identities field by field. Returns the list of fields that differ,
// in a deterministic order. An empty list means the two identities are the same
// run.
//
// This is deliberately *not* a fingerprint comparison: a caller needs to see
// exactly which binding disagreed, and "the hashes differ" is not actionable.
export function identityDifferences(left, right) {
	const differences = [];
	const bindingsLeft = identityBindings(left);
	const bindingsRight = identityBindings(right);
	for (const key of Object.keys(bindingsLeft).sort(compareStrings)) {
		if (key === "schemaVersion") continue;
		if (bindingsLeft[key] !== bindingsRight[key]) differences.push(key);
	}
	return differences;
}

export function identitiesMatch(left, right) {
	return identityDifferences(left, right).length === 0;
}

// A canonical, key-sorted JSON of the identity. Byte-stable across runs and
// processes, which is what makes checkpoint state deterministic.
export function canonicalIdentityJson(identity) {
	return canonicalizeJson(identityBindings(identity));
}

// Canonicalize an arbitrary value into a key-sorted, undefined-free JSON string.
// Rules, applied in order:
//
//   1. Object keys are emitted in ascending code-unit order.
//   2. `undefined` members are dropped, so omitted and explicit-undefined agree.
//   3. Arrays keep their authored order — order is meaningful for step lists.
//   4. `null` is preserved: "absent" and "explicitly null" are different claims.
export function canonicalizeValue(value) {
	if (Array.isArray(value)) return value.map(canonicalizeValue);
	if (value && typeof value === "object") {
		const output = {};
		for (const key of Object.keys(value).sort(compareStrings)) {
			if (value[key] === undefined) continue;
			output[key] = canonicalizeValue(value[key]);
		}
		return output;
	}
	return value;
}

export function canonicalizeJson(value) {
	return JSON.stringify(canonicalizeValue(value));
}
