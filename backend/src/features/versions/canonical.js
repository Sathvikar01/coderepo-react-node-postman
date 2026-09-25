import { createHash } from "node:crypto";

// Phase 24B — deterministic canonicalization for fingerprints and diffs.
//
// Object keys sort recursively; arrays keep their stored order (request lists and
// variable lists are ordered definitions, so order is meaning, not noise). The
// output is stable across processes, so fingerprints and diffs never depend on
// insertion order or JSON serialization accidents.

export function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
		return out;
	}
	return value;
}

export function canonicalJson(value) {
	return JSON.stringify(canonicalize(value));
}

export function fingerprintSnapshot(snapshot) {
	return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}
