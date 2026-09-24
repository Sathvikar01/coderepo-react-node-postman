import { fingerprintOf, fingerprintKeyId } from "../history/fingerprint.js";
import { CONTRACT_SCHEMA_VERSION } from "./contract-schema.js";

// Phase 42A — Canonicalization and fingerprinting.
//
// A contract's canonical form is the byte string that its fingerprint commits to.
// Two contracts that mean the same thing must produce the same canonical form even
// if their authors ordered object keys differently; two contracts that mean
// different things must not.
//
// The rules, applied in order:
//
//   1. Object keys are emitted in ascending code-unit order.
//   2. `undefined` members are dropped, so an omitted field and an explicit
//      `undefined` canonicalize identically.
//   3. Arrays keep their authored order — order is meaningful for status sets and
//      required-property lists.
//   4. `null` is preserved: "absent" and "explicitly null" are different claims.
//   5. Only the contract content participates. Identity, lifecycle state, version
//      number, and timestamps are excluded so re-publishing identical content is
//      detectable as a no-op.

// Canonicalize an arbitrary value into a key-sorted, undefined-free structure.
export function canonicalizeContractValue(value) {
	if (Array.isArray(value)) return value.map(canonicalizeContractValue);
	if (value && typeof value === "object") {
		const output = {};
		for (const key of Object.keys(value).sort()) {
			if (value[key] === undefined) continue;
			output[key] = canonicalizeContractValue(value[key]);
		}
		return output;
	}
	return value;
}

// The exact structure a fingerprint commits to. Deliberately content-only.
export function contractContentOf(contract) {
	const body = contract.body ?? {};
	const headers = (body.headers ?? []).map((header) => ({
		name: String(header.name).trim().toLowerCase(),
		value: header.value ?? null,
		required: Boolean(header.required),
	}));
	// Header order is not semantically meaningful, so canonical ordering is imposed
	// here rather than left to the caller.
	headers.sort((left, right) => compareStrings(left.name, right.name));

	const statuses = [...(body.statuses ?? [])];
	// A status set is a set: order and duplication carry no meaning, so a caller's
	// ordering cannot change the fingerprint.
	statuses.sort((left, right) => left - right);

	return canonicalizeContractValue({
		schemaVersion: CONTRACT_SCHEMA_VERSION,
		provenance: contract.provenance ?? "explicit",
		body: {
			status: body.status ?? null,
			statuses,
			headers,
			bodyType: body.bodyType ?? null,
			body: body.body ?? null,
		},
	});
}

export function canonicalContractJson(contract) {
	return JSON.stringify(contractContentOf(contract));
}

// Content fingerprint. Uses the repository's HMAC-SHA-256 primitive so contract
// fingerprints share the same key management as execution fingerprints.
export function contractFingerprint(contract) {
	return fingerprintOf({ kind: "api-contract", content: contractContentOf(contract) });
}

export function contractFingerprintKeyId() {
	return fingerprintKeyId();
}

// Stable comparison used everywhere ordering matters, so the canonical form does
// not depend on the platform's locale or ICU data.
export function compareStrings(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

// A short, human-legible digest of the canonical content, for display only. Never
// used as an identity or an equality check.
export function canonicalContractSummary(contract) {
	const canonical = canonicalContractJson(contract);
	let hash = 0;
	for (let index = 0; index < canonical.length; index += 1) {
		hash = (hash * 31 + canonical.charCodeAt(index)) | 0;
	}
	return `contract:${(hash >>> 0).toString(16).padStart(8, "0")}:${canonical.length}`;
}
