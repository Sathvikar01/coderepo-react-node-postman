import { isSensitiveHeader } from "../contract-registry/contract-schema.js";

// Phase 43A — Response normalization.
//
// Turns a caller-supplied observed response into the normalized form the pure
// comparison rules consume. Two jobs matter here:
//
//   1. Credential-bearing headers are dropped before any finding is constructed.
//      This is the single choke point where a raw header becomes comparable data,
//      so no rule downstream can leak one by forgetting to check.
//   2. The body is classified honestly. A body the engine cannot interpret is
//      flagged as such rather than being coerced into a plausible-looking value,
//      because guessing here would turn uncertainty into a compatibility claim.

// Property names that can rewire prototypes or otherwise subvert a consumer that
// deep-merges parsed input. Phase 42A fixed exactly this class of bug on the
// contract side; the engine refuses the same keys in observed data so comparison
// never walks into a mutated prototype.
export const SUSPECT_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

// How a body was supplied, so the rules can distinguish "no body", "a real JSON
// null", and "a body the engine cannot interpret".
export const BODY_REPRESENTATION = Object.freeze({
	ABSENT: "absent",
	DECODED: "decoded",
	PARSED_JSON: "parsed_json",
	OPAQUE_STRING: "opaque_string",
	MALFORMED: "malformed",
});

function safeOwnEntries(value) {
	// A plain object is walked by own enumerable string keys only. Values are read
	// through `Object.prototype.hasOwnProperty`, so an inherited or accessor-backed
	// property cannot silently contribute.
	const output = [];
	for (const key of Object.keys(value)) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		output.push(key);
	}
	return output;
}

// Detect a value that is a real plain object rather than an array, null, or a
// class instance the engine has no vocabulary for.
export function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

// Classify an arbitrary decoded value into the contract vocabulary's observable
// type. Returns `null` for values the vocabulary cannot express, so the caller can
// report uncertainty instead of guessing.
export function observableTypeOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "string") return "string";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "object") return "object";
	// `undefined`, functions, symbols, and bigints have no contract representation.
	return null;
}

// Normalize headers into a case-insensitive map of name -> value.
//
// Sensitive names are dropped, not redacted: a credential-bearing header has no
// role in a compatibility finding, so the safest representation is absence.
// Duplicate names are folded with the first value winning per HTTP semantics for
// the purpose of this comparison, and the original name casing is preserved for
// presentation.
export function normalizeHeaders(headers) {
	const byLowerName = new Map();
	const droppedSensitive = [];

	function consider(name, value) {
		const trimmed = String(name ?? "").trim();
		if (!trimmed) return;
		const lower = trimmed.toLowerCase();
		if (SUSPECT_PROPERTY_NAMES.has(lower)) return;
		if (isSensitiveHeader(lower)) {
			// Record only the name, never the value.
			if (!droppedSensitive.includes(lower)) droppedSensitive.push(lower);
			return;
		}
		if (byLowerName.has(lower)) return;
		byLowerName.set(lower, { name: trimmed, lowerName: lower, value: value === undefined || value === null ? null : String(value) });
	}

	if (Array.isArray(headers)) {
		for (const row of headers) {
			if (row === null || row === undefined) continue;
			if (Array.isArray(row)) {
				consider(row[0], row[1]);
				continue;
			}
			if (typeof row === "string") {
				const index = row.indexOf(":");
				if (index < 0) continue;
				consider(row.slice(0, index), row.slice(index + 1).trim());
				continue;
			}
			if (typeof row === "object") {
				const name = row.name ?? row.key ?? null;
				if (name !== null) consider(name, row.value);
			}
		}
	} else if (headers && typeof headers === "object") {
		// A map or a Headers-like object. `forEach` is used when available so a real
		// `Headers` instance works, and own entries otherwise.
		if (typeof headers.forEach === "function" && !Array.isArray(headers)) {
			try {
				headers.forEach((value, name) => consider(name, value));
			} catch {
				for (const name of Object.getOwnPropertyNames(headers)) consider(name, headers[name]);
			}
		} else {
			for (const name of Object.getOwnPropertyNames(headers)) consider(name, headers[name]);
		}
	}

	return { byLowerName, droppedSensitive };
}

// Decide how a body should be interpreted.
//
// A malformed string that looks like JSON is reported as MALFORMED rather than
// treated as an opaque string. Reporting it opaque would compare the contract's
// object shape against `"string"` and produce a confident BREAKING finding for
// what is actually a caller-side parse failure.
export function normalizeBody({ body, rawBody, contentType } = {}) {
	const hasBody = body !== undefined;
	if (hasBody) {
		if (body === null) return { representation: BODY_REPRESENTATION.DECODED, value: null };
		if (typeof body === "string") {
			const mediaType = String(contentType ?? "").split(";")[0].trim().toLowerCase();
			const looksJson = mediaType === "application/json" || mediaType.endsWith("+json");
			if (looksJson || /^\s*[[{"]/.test(body)) {
				try {
					return { representation: BODY_REPRESENTATION.PARSED_JSON, value: JSON.parse(body) };
				} catch {
					return { representation: BODY_REPRESENTATION.MALFORMED, value: null };
				}
			}
			return { representation: BODY_REPRESENTATION.OPAQUE_STRING, value: body };
		}
		if (observableTypeOf(body) === null) return { representation: BODY_REPRESENTATION.MALFORMED, value: null };
		return { representation: BODY_REPRESENTATION.DECODED, value: body };
	}

	if (rawBody !== undefined && rawBody !== null && rawBody !== "") {
		const mediaType = String(contentType ?? "").split(";")[0].trim().toLowerCase();
		const looksJson = mediaType === "application/json" || mediaType.endsWith("+json");
		if (looksJson || /^\s*[[{"]/.test(rawBody)) {
			try {
				return { representation: BODY_REPRESENTATION.PARSED_JSON, value: JSON.parse(rawBody) };
			} catch {
				return { representation: BODY_REPRESENTATION.MALFORMED, value: null };
			}
		}
		return { representation: BODY_REPRESENTATION.OPAQUE_STRING, value: rawBody };
	}

	return { representation: BODY_REPRESENTATION.ABSENT, value: null };
}

// Normalize the whole supplied response. Pure: the input object is never mutated.
export function normalizeObservedResponse(response = {}) {
	const { byLowerName, droppedSensitive } = normalizeHeaders(response.headers);
	const body = normalizeBody({ body: response.body, rawBody: response.rawBody, contentType: response.contentType });
	const identity = response.identity ?? null;

	return {
		status: response.status,
		headers: byLowerName,
		body,
		contentType: response.contentType ?? null,
		// Only non-sensitive header names are exposed for reporting.
		droppedSensitiveHeaders: [...droppedSensitive].sort(),
		identity: identity
			? {
					requestId: identity.requestId ?? null,
					workspaceId: identity.workspaceId ?? null,
					collectionId: identity.collectionId ?? null,
					profileId: identity.profileId ?? null,
					snapshotId: identity.snapshotId ?? null,
					snapshotFingerprint: identity.snapshotFingerprint ?? null,
					executionId: identity.executionId ?? null,
					label: identity.label ?? null,
				}
			: null,
		// The representation is carried through so rules can report UNKNOWN instead of
		// fabricating a type for a body they could not interpret.
		bodyRepresentation: body.representation,
	};
}

// Whether a value can safely be walked as a container during comparison.
export function isWalkableObject(value) {
	return isPlainObject(value);
}

export { safeOwnEntries };
