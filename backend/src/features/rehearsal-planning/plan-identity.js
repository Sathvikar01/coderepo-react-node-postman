// Phase 46A — Plan identity and canonical serialization.
//
// Plan identity must commit to the exact relevant inputs so that two plans with
// the same identity are the same plan, and any semantically meaningful change to
// the inputs changes the identity. It reuses the repository's HMAC-SHA-256
// fingerprint primitive (Phase 5/fingerprint) rather than inventing an ad-hoc
// hash: a weaker hash would make plan identity forgeable and would not share the
// repository's key management.
//
// Committed inputs (in canonical form):
//   * plan kind + schema version
//   * workspace identity
//   * snapshot identity (id and/or fingerprint)
//   * source + target environment identity
//   * the impacted request set (sorted)
//   * the dependency structure (sorted, edges included)
//   * the effective blast-radius policy identity
//   * the drift identity (kind + identity-bearing summary the planner consumed)
//
// NOT committed:
//   * request bodies, headers, URLs, query strings, credentials — the planner
//     never receives them, so they cannot leak into the canonical bytes.
//   * wall-clock time, randomness, process identity — no hidden clock exists.

import { fingerprintOf, fingerprintKeyId } from "../history/fingerprint.js";
import { REHEARSAL_PLAN_KIND, REHEARSAL_PLAN_SCHEMA_VERSION } from "./plan-schema.js";

// Canonicalize a value into a key-sorted, undefined-free structure. Arrays keep
// their authored order because the planner re-sorts every array it commits to
// before fingerprinting; callers must not rely on this function to sort.
export function canonicalizePlanValue(value) {
	if (Array.isArray(value)) return value.map(canonicalizePlanValue);
	if (value && typeof value === "object") {
		const output = {};
		for (const key of Object.keys(value).sort()) {
			if (value[key] === undefined) continue;
			output[key] = canonicalizePlanValue(value[key]);
		}
		return output;
	}
	return value;
}

export function canonicalPlanJson(value) {
	return JSON.stringify(canonicalizePlanValue(value));
}

// The exact structure a plan fingerprint commits to. Built by the planner from
// already-normalized, already-sorted inputs, so identical input yields identical
// bytes regardless of the order the caller supplied it in.
export function planIdentityOf(parts) {
	return fingerprintOf({ kind: REHEARSAL_PLAN_KIND, schemaVersion: REHEARSAL_PLAN_SCHEMA_VERSION, ...parts });
}

export function planFingerprintKeyId() {
	return fingerprintKeyId();
}

// Stable comparison, independent of locale/ICU. Kept local so the planner's
// ordering never depends on a platform collator.
export function comparePlanStrings(left, right) {
	const a = String(left ?? "");
	const b = String(right ?? "");
	return a < b ? -1 : a > b ? 1 : 0;
}

// A short, human-legible digest for display only. Never used as identity.
export function planDisplayDigest(identity) {
	const text = String(identity ?? "");
	let hash = 0;
	for (let index = 0; index < text.length; index += 1) {
		hash = (hash * 31 + text.charCodeAt(index)) | 0;
	}
	return `plan:${(hash >>> 0).toString(16).padStart(8, "0")}:${text.length}`;
}
