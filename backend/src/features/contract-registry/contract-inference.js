import { CONTRACT_LIMITS, CONTRACT_VALUE_TYPES, isSensitiveHeader } from "./contract-schema.js";

// Phase 42A — Deterministic contract inference.
//
// Derives a *candidate* contract from a response payload the caller already holds.
// This module never executes a request, never reads a database, and never consults
// the clock: it is a pure function of its arguments.
//
// The honesty rules matter more than the coverage:
//
//   * Only observable types are inferred. A number is `number`; there is no
//     guessing about integer vs. float, format, or range.
//   * Optionality is never guessed. One sample cannot tell you whether a field is
//     required, so `requiredProperties` is always empty and no node is marked
//     required.
//   * Enums are never invented. One observed value is not a closed set, so `enum`
//     is never emitted.
//   * Provenance is always `inferred`, so a consumer can tell an inferred contract
//     from an authored one.
//
// Inference is bounded by the same limits the schema enforces, and it degrades by
// truncating rather than by throwing, because a large real payload is normal. What
// was truncated is reported in `warnings` rather than hidden.

const PLAIN_OBJECT = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function observableTypeOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "string") return "string";
	if (typeof value === "object") return "object";
	// `undefined`, functions, symbols, and bigints have no contract representation;
	// they are reported as `null` and flagged rather than silently mistyped.
	return "null";
}

// Infer one node. Depth, property count, and array breadth are all capped; hitting
// a cap records a warning and stops descending rather than failing.
function inferNode(value, { depth, maxDepth, warnings, path }) {
	const type = observableTypeOf(value);
	if ((value === undefined || typeof value === "bigint" || typeof value === "function") && value !== null) {
		warnings.push(`value at ${path || "$"} has no contract representation and was recorded as null`);
	}
	const node = { type };

	// `maxDepth` is the deepest level a node may occupy, and a node at that level may
	// not be a container. Inference therefore stops nesting one level earlier than a
	// naive `depth >= maxDepth` check would, so the value it hands back always parses
	// under the same schema that will store it.
	const containerLimit = maxDepth - 1;

	if (type === "array") {
		if (depth >= containerLimit) {
			warnings.push(`array at ${path || "$"} was truncated at the maximum depth of ${maxDepth}`);
			return node;
		}
		// A single element shape describes the array. Mixed-type arrays are described
		// by their first element only, and that ambiguity is reported.
		const observed = new Set(value.map((item) => observableTypeOf(item)));
		if (observed.size > 1)
			warnings.push(`array at ${path || "$"} contains ${observed.size} element types; only the first element's shape is described`);
		if (value.length > 0) node.items = inferNode(value[0], { depth: depth + 1, maxDepth, warnings, path: `${path}[0]` });
		return node;
	}

	if (type === "object") {
		if (depth >= containerLimit) {
			warnings.push(`object at ${path || "$"} was truncated at the maximum depth of ${maxDepth}`);
			return node;
		}
		const keys = Object.keys(value).sort();
		const properties = {};
		let emitted = 0;
		for (const key of keys) {
			if (emitted >= CONTRACT_LIMITS.maxPropertiesPerObject) {
				warnings.push(`object at ${path || "$"} exceeded ${CONTRACT_LIMITS.maxPropertiesPerObject} properties; remaining properties were dropped`);
				break;
			}
			properties[key] = inferNode(value[key], { depth: depth + 1, maxDepth, warnings, path: path ? `${path}.${key}` : key });
			emitted += 1;
		}
		// `requiredProperties` is intentionally omitted: one sample cannot prove
		// requiredness.
		node.properties = properties;
		return node;
	}

	return node;
}

// Infer expected headers. Sensitive header names are dropped by policy, not
// redacted, because a contract must never carry a credential-bearing header.
function inferHeaders(headers = [], warnings) {
	const seen = new Set();
	const output = [];
	for (const header of headers) {
		const name = String(header?.name ?? header?.key ?? "").trim();
		if (!name) continue;
		const key = name.toLowerCase();
		if (isSensitiveHeader(key)) {
			warnings.push(`header "${name}" was omitted because it carries credentials`);
			continue;
		}
		if (seen.has(key)) {
			warnings.push(`header "${name}" appeared more than once and was recorded once`);
			continue;
		}
		seen.add(key);
		if (output.length >= CONTRACT_LIMITS.maxHeaders) {
			warnings.push(`more than ${CONTRACT_LIMITS.maxHeaders} response headers were observed; the remainder were dropped`);
			break;
		}
		output.push({ name, value: header?.value === undefined || header?.value === null ? null : String(header.value), required: false });
	}
	return output;
}

// Parse a body that may arrive as a string or as an already-decoded value. JSON
// text is parsed so the contract describes structure rather than one big string.
function decodeBody({ body, bodyValue, contentType }) {
	const mediaType = String(contentType ?? "").split(";")[0].trim().toLowerCase();
	if (bodyValue !== undefined && bodyValue !== null) return { value: bodyValue, parsed: true };
	if (body === undefined || body === null || body === "") return { value: null, parsed: false };
	if (typeof body === "object") return { value: body, parsed: true };
	const looksJson = mediaType === "application/json" || mediaType.endsWith("+json");
	if (looksJson || /^\s*[[{]/.test(body)) {
		try {
			return { value: JSON.parse(body), parsed: true };
		} catch {
			return { value: body, parsed: false };
		}
	}
	return { value: body, parsed: false };
}

// Build a candidate contract body from a caller-supplied response payload.
export function inferContractBody({ status, statuses, headers, body, bodyValue, contentType } = {}) {
	const warnings = [];
	const bodyOut = {
		status: typeof status === "number" ? status : null,
		statuses: Array.isArray(statuses) ? [...new Set(statuses)].sort((left, right) => left - right) : [],
		headers: inferHeaders(headers, warnings),
		bodyType: null,
		body: null,
	};

	const decoded = decodeBody({ body, bodyValue, contentType });
	if (decoded.value !== null) {
		const node = inferNode(decoded.value, { depth: 0, maxDepth: CONTRACT_LIMITS.maxDepth, warnings, path: "$" });
		bodyOut.body = node;
		bodyOut.bodyType = node.type;
	}

	return { body: bodyOut, warnings };
}

// Full candidate contract. Identity and naming are the caller's to supply; this
// helper only produces the content and the provenance label.
export function inferContractFromResponse({ response = {}, name, description = "" } = {}) {
	const { body, warnings } = inferContractBody({
		status: response.status,
		statuses: response.statuses,
		headers: response.headers,
		body: response.body,
		bodyValue: response.bodyValue,
		contentType: response.contentType,
	});
	return {
		provenance: "inferred",
		name: name ?? "Inferred contract",
		description,
		body,
		// Warnings are returned alongside the candidate so a caller can show exactly
		// what inference did not establish. They are not part of the contract.
		warnings,
	};
}

// Exposed for tests and for consumers that need to reason about the vocabulary.
export const INFERRED_TYPES = [...CONTRACT_VALUE_TYPES];
