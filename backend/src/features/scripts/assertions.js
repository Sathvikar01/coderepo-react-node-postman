import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";

// Deterministic, declarative assertions. Definitions are stored on the request; at
// execution time they are evaluated against the same bounded response view used by
// the Phase 11 test script and recorded in the same test-result model. No user code
// is evaluated here, so this is not a second scripting runtime.

export const ASSERTION_TARGETS = ["status", "header", "body", "json"];
export const ASSERTION_OPERATORS_BY_TARGET = {
	status: ["equals", "range"],
	header: ["exists", "equals", "contains"],
	body: ["equals", "contains"],
	json: ["exists", "equals"],
};
export const ASSERTION_VALUE_TYPES = ["string", "number", "boolean", "null"];

const MAX_PATH_SEGMENTS = 32;

function text(value, max) {
	return typeof value === "string" ? value.slice(0, max) : "";
}

function bounded(value) {
	const rendered = typeof value === "string" ? value : String(value ?? "");
	if (utf8Bytes(rendered) <= LIMITS.scriptTextFieldBytes) return rendered;
	return `${rendered.slice(0, LIMITS.scriptTextFieldBytes)}…`;
}

export function assertionsDefinitionOf(request) {
	const rows = Array.isArray(request?.assertions) ? request.assertions : [];
	const definitions = [];
	for (const row of rows) {
		if (!row || row.enabled === false) continue;
		definitions.push(normalizeAssertion(row, definitions.length));
		if (definitions.length >= LIMITS.assertionsPerRequest) break;
	}
	return definitions;
}

export function normalizeAssertion(raw, index = 0) {
	const target = text(raw?.target, 16);
	return {
		id: text(raw?.id, 64) || `assertion-${index + 1}`,
		name: text(raw?.name, LIMITS.assertionName).trim() || `Assertion ${index + 1}`,
		target,
		operator: text(raw?.operator, 16),
		path: text(raw?.path, LIMITS.assertionPathBytes),
		expected: text(raw?.expected, LIMITS.assertionValueBytes),
		valueType: ASSERTION_VALUE_TYPES.includes(raw?.valueType) ? raw.valueType : "string",
		min: Number.isInteger(raw?.min) ? raw.min : null,
		max: Number.isInteger(raw?.max) ? raw.max : null,
	};
}

export function resolveJsonPath(root, path) {
	const body = String(path ?? "").trim().replace(/^\$\.?/, "");
	if (body === "") return { found: true, value: root };
	const segments = [];
	const pattern = /([^.[\]]+)|\[(\d+)\]/g;
	let match = pattern.exec(body);
	while (match !== null && segments.length < MAX_PATH_SEGMENTS) {
		segments.push(match[1] !== undefined ? match[1] : Number(match[2]));
		match = pattern.exec(body);
	}
	let cursor = root;
	for (const segment of segments) {
		if (cursor === null || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, segment))
			return { found: false, value: undefined };
		cursor = cursor[segment];
	}
	return { found: true, value: cursor };
}

function deepEqual(left, right) {
	if (left === right) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

function display(value) {
	if (value === undefined) return "<missing>";
	if (typeof value === "string") return bounded(JSON.stringify(value));
	try {
		const rendered = JSON.stringify(value);
		return rendered === undefined ? String(value) : bounded(rendered);
	} catch {
		return bounded(String(value));
	}
}

function parseExpected(assertion) {
	if (assertion.valueType === "null") return { ok: true, value: null };
	if (assertion.valueType === "number") {
		const value = Number(assertion.expected);
		if (!Number.isFinite(value)) return { ok: false, message: "This assertion needs a numeric expected value." };
		return { ok: true, value };
	}
	if (assertion.valueType === "boolean") {
		if (assertion.expected === "true") return { ok: true, value: true };
		if (assertion.expected === "false") return { ok: true, value: false };
		return { ok: false, message: "This assertion needs true or false as its expected value." };
	}
	return { ok: true, value: assertion.expected };
}

function record(assertion, status, message, expected, actual) {
	return {
		name: assertion.name,
		status,
		message: message ?? null,
		assertionId: assertion.id,
		kind: assertion.target || null,
		operator: assertion.operator || null,
		path: assertion.path || null,
		expected: expected ?? null,
		actual: actual ?? null,
	};
}

function evaluateStatus(assertion, view) {
	const actual = Number(view?.status ?? 0);
	if (assertion.operator === "equals") {
		const expected = Number(assertion.expected);
		if (!Number.isFinite(expected))
			return record(assertion, "error", "The status assertion has no numeric expected value.", null, String(actual));
		return expected === actual
			? record(assertion, "passed", null, String(expected), String(actual))
			: record(assertion, "failed", `Expected status ${expected} but received ${actual}.`, String(expected), String(actual));
	}
	if (assertion.operator === "range") {
		const min = assertion.min ?? 100;
		const max = assertion.max ?? 599;
		const range = `${min}-${max}`;
		return actual >= min && actual <= max
			? record(assertion, "passed", null, range, String(actual))
			: record(assertion, "failed", `Expected status within ${range} but received ${actual}.`, range, String(actual));
	}
	return record(assertion, "error", `Unknown status operator "${assertion.operator}".`, null, String(actual));
}

function evaluateHeader(assertion, view) {
	const name = assertion.path.trim();
	if (!name) return record(assertion, "error", "The header assertion is missing a header name.", null, null);
	const values = (view?.headers ?? [])
		.filter((header) => String(header?.name ?? "").toLowerCase() === name.toLowerCase())
		.map((header) => String(header?.value ?? ""));
	const actual = values.length > 0 ? bounded(values.join(", ")) : "<missing>";
	if (assertion.operator === "exists") {
		return values.length > 0
			? record(assertion, "passed", null, "present", actual)
			: record(assertion, "failed", `Expected header "${name}" to be present.`, "present", "<missing>");
	}
	if (assertion.operator === "equals") {
		return values.some((value) => value === assertion.expected)
			? record(assertion, "passed", null, bounded(assertion.expected), actual)
			: record(assertion, "failed", `Expected header "${name}" to equal ${display(assertion.expected)} but received ${actual}.`, bounded(assertion.expected), actual);
	}
	if (assertion.operator === "contains") {
		return values.some((value) => value.includes(assertion.expected))
			? record(assertion, "passed", null, bounded(assertion.expected), actual)
			: record(assertion, "failed", `Expected header "${name}" to contain ${display(assertion.expected)} but received ${actual}.`, bounded(assertion.expected), actual);
	}
	return record(assertion, "error", `Unknown header operator "${assertion.operator}".`, null, actual);
}

function evaluateBody(assertion, view) {
	if (view?.binary) return record(assertion, "error", "The response body is binary and cannot be compared as text.", null, null);
	const body = view?.body === null || view?.body === undefined ? "" : String(view.body);
	if (assertion.operator === "equals") {
		return body === assertion.expected
			? record(assertion, "passed", null, bounded(assertion.expected), bounded(body))
			: record(assertion, "failed", `Expected the response body to equal ${display(assertion.expected)}.`, bounded(assertion.expected), bounded(body));
	}
	if (assertion.operator === "contains") {
		return body.includes(assertion.expected)
			? record(assertion, "passed", null, bounded(assertion.expected), bounded(body))
			: record(assertion, "failed", `Expected the response body to contain ${display(assertion.expected)}.`, bounded(assertion.expected), bounded(body));
	}
	return record(assertion, "error", `Unknown body operator "${assertion.operator}".`, null, bounded(body));
}

function evaluateJson(assertion, view) {
	if (view?.binary) return record(assertion, "error", "The response body is binary and cannot be parsed as JSON.", null, null);
	const body = view?.body === null || view?.body === undefined ? "" : String(view.body);
	if (body === "") return record(assertion, "error", "The response body is empty and cannot be parsed as JSON.", null, null);
	let data;
	try {
		data = JSON.parse(body);
	} catch {
		return record(assertion, "error", "The response body is not valid JSON.", null, null);
	}
	const path = assertion.path.trim();
	if (!path) return record(assertion, "error", "The JSON assertion is missing a path.", null, null);
	const { found, value } = resolveJsonPath(data, path);
	const actual = found ? display(value) : "<missing>";
	if (assertion.operator === "exists") {
		return found
			? record(assertion, "passed", null, "present", actual)
			: record(assertion, "failed", `Expected JSON path "${path}" to exist.`, "present", "<missing>");
	}
	if (assertion.operator === "equals") {
		const parsed = parseExpected(assertion);
		if (!parsed.ok) return record(assertion, "error", parsed.message, bounded(assertion.expected), actual);
		const expected = display(parsed.value);
		if (!found)
			return record(assertion, "failed", `Expected JSON path "${path}" to equal ${expected} but the path is missing.`, expected, "<missing>");
		return deepEqual(value, parsed.value)
			? record(assertion, "passed", null, expected, actual)
			: record(assertion, "failed", `Expected JSON path "${path}" to equal ${expected} but received ${actual}.`, expected, actual);
	}
	return record(assertion, "error", `Unknown JSON operator "${assertion.operator}".`, null, actual);
}

export function evaluateAssertion(assertion, view) {
	if (assertion.target === "status") return evaluateStatus(assertion, view);
	if (assertion.target === "header") return evaluateHeader(assertion, view);
	if (assertion.target === "body") return evaluateBody(assertion, view);
	if (assertion.target === "json") return evaluateJson(assertion, view);
	return record(assertion, "error", `Unknown assertion target "${assertion.target}".`, null, null);
}

export function evaluateAssertions(assertions, view) {
	const records = [];
	for (const assertion of assertions ?? []) {
		if (records.length >= LIMITS.assertionsPerRequest) break;
		records.push(evaluateAssertion(assertion, view));
	}
	return records;
}

// Deterministic failure predicate over an immutable result snapshot. The Flight
// Recorder and any minimization tooling can consume this without re-running HTTP.
export function executionFailurePredicate(results) {
	const tests = Array.isArray(results?.tests) ? results.tests : [];
	const failures = tests
		.filter((test) => test?.status !== "passed")
		.map((test) => ({
			name: test.name ?? null,
			status: test.status ?? "error",
			assertionId: test.assertionId ?? null,
			kind: test.kind ?? null,
			operator: test.operator ?? null,
			path: test.path ?? null,
			expected: test.expected ?? null,
			actual: test.actual ?? null,
		}));
	return { failed: failures.length > 0, failures };
}
