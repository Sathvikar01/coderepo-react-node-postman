import { randomUUID } from "node:crypto";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";
import { MANAGED_TRANSPORT_HEADERS } from "../executions/request-compiler.js";
import { assertionsDefinitionOf, evaluateAssertions } from "./assertions.js";
import { runSandboxedScript } from "./sandbox.js";

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function scriptDefinitionOf(request) {
	return {
		preRequest: typeof request?.scripts?.preRequest === "string" ? request.scripts.preRequest : "",
		test: typeof request?.scripts?.test === "string" ? request.scripts.test : "",
	};
}

function plainScope(variables) {
	const scope = {};
	for (const variable of variables ?? []) {
		if (variable.enabled === false || variable.kind !== "plain") continue;
		scope[variable.key] = String(variable.value ?? "");
	}
	return scope;
}

export function scriptVariableScopes(collection, environment) {
	const collectionScope = plainScope(collection?.variables);
	const environmentScope = plainScope(environment?.variables);
	return { collection: collectionScope, environment: environmentScope, merged: { ...collectionScope, ...environmentScope } };
}

function secretReferenceKeys(collection, environment) {
	const keys = new Set();
	for (const variable of [...(collection?.variables ?? []), ...(environment?.variables ?? [])]) {
		if (variable.kind === "secretRef") keys.add(variable.key);
	}
	return keys;
}

function requestView(request) {
	return {
		method: String(request?.method ?? ""),
		url: String(request?.urlTemplate ?? ""),
		headers: (request?.headers ?? [])
			.filter((row) => row.enabled !== false)
			.map((row) => ({ name: String(row.key ?? ""), value: String(row.value ?? "") })),
	};
}

function responseView(response) {
	const body = response?.body ?? null;
	let text = body && body.encoding === "utf8" ? String(body.value ?? "") : null;
	let truncated = Boolean(body?.truncated);
	if (text !== null && utf8Bytes(text) > LIMITS.scriptResponseBodyBytes) {
		text = text.slice(0, LIMITS.scriptResponseBodyBytes);
		truncated = true;
	}
	return {
		status: response?.status ?? 0,
		statusText: String(response?.statusText ?? ""),
		headers: (response?.headers ?? []).map((header) => ({ name: String(header.name ?? ""), value: String(header.value ?? "") })),
		body: text,
		binary: Boolean(body) && body.encoding === "base64",
		truncated,
	};
}

function emptyMutations() {
	return { headers: [], variables: [] };
}

function phaseWarning(label, error) {
	return { code: error.code, message: `${label} script: ${error.message}` };
}

export function applyHeaderMutations(rows, mutations, warnings) {
	const next = rows.map((row) => ({ ...row }));
	let changed = false;
	for (const mutation of mutations) {
		const name = String(mutation.name ?? "").trim();
		const lower = name.toLowerCase();
		if (!name || !HEADER_TOKEN.test(name) || /[\r\n]/.test(String(mutation.value ?? ""))) {
			warnings.push({ code: "SCRIPT_HEADER_INVALID", message: `The script tried to set an invalid header ("${name || "unnamed"}") and it was skipped.` });
			continue;
		}
		if (MANAGED_TRANSPORT_HEADERS.has(lower)) {
			warnings.push({ code: "SCRIPT_HEADER_RESERVED", message: `The script tried to change the managed header "${name}" and it was skipped.` });
			continue;
		}
		if (mutation.op === "remove") {
			const remaining = next.filter((row) => String(row.key ?? "").toLowerCase() !== lower);
			if (remaining.length !== next.length) {
				next.length = 0;
				next.push(...remaining);
				changed = true;
			}
			continue;
		}
		const existing = next.find((row) => String(row.key ?? "").toLowerCase() === lower);
		if (existing) {
			existing.value = String(mutation.value ?? "");
			existing.enabled = true;
		} else {
			next.push({ id: randomUUID(), key: name, value: String(mutation.value ?? ""), enabled: true });
		}
		changed = true;
	}
	return { rows: next, changed, warnings };
}

export function applyVariableWrites(overlay, writes, reservedKeys, warnings) {
	let changed = false;
	for (const write of writes) {
		const key = String(write.key ?? "");
		if (!VARIABLE_KEY.test(key)) {
			warnings.push({ code: "SCRIPT_VARIABLE_INVALID", message: `The script tried to write an invalid variable name ("${key || "unnamed"}") and it was skipped.` });
			continue;
		}
		if (reservedKeys.has(key)) {
			warnings.push({ code: "SCRIPT_VARIABLE_RESERVED", message: `The script tried to write the secret reference "${key}"; secret references are read-only.` });
			continue;
		}
		if (write.op === "unset") overlay.set(key, null);
		else overlay.set(key, String(write.value ?? ""));
		changed = true;
	}
	return changed;
}

function phaseRecord(status, error, output) {
	return {
		status,
		error: error ?? null,
		console: output?.console ?? [],
		mutations: {
			headers: (output?.headers ?? []).map((mutation) => ({ op: mutation.op, name: mutation.name })),
			variables: (output?.variables ?? []).map((mutation) => ({ op: mutation.op, key: mutation.key })),
		},
	};
}

export function composeScriptResults({ preRequest = null, postResponse = null, tests = [] } = {}) {
	const counts = { passed: 0, failed: 0, errors: 0 };
	for (const test of tests) {
		if (test.status === "passed") counts.passed += 1;
		else if (test.status === "error") counts.errors += 1;
		else counts.failed += 1;
	}
	for (const phase of [preRequest, postResponse]) {
		if (phase?.status === "error") counts.errors += 1;
	}
	return { version: 1, preRequest, postResponse, tests, counts };
}

export function mergePostResponseResults(results, postResponse, tests) {
	if (!results) return composeScriptResults({ postResponse, tests });
	return composeScriptResults({
		preRequest: results.preRequest,
		postResponse,
		tests,
	});
}

export function createScriptService({ sandbox = runSandboxedScript } = {}) {
	function runPreRequest({ request, collection, environment }) {
		const definition = scriptDefinitionOf(request);
		if (!definition.preRequest.trim()) return { request, variables: new Map(), phase: null, warnings: [] };
		const scope = scriptVariableScopes(collection, environment);
		const outcome = sandbox({
			source: definition.preRequest,
			phase: "prerequest",
			input: {
				phase: "prerequest",
				request: requestView(request),
				variables: scope.merged,
				collection: scope.collection,
				environment: scope.environment,
				response: null,
			},
		});
		if (!outcome.ok) {
			return {
				request,
				variables: new Map(),
				phase: phaseRecord("error", outcome.error, null),
				warnings: [phaseWarning("Pre-request", outcome.error)],
			};
		}
		const warnings = [];
		const headers = applyHeaderMutations(request?.headers ?? [], outcome.output.headers, warnings);
		const variables = new Map();
		applyVariableWrites(variables, outcome.output.variables, secretReferenceKeys(collection, environment), warnings);
		const phase = phaseRecord(outcome.error ? "error" : "passed", outcome.error, outcome.output);
		if (outcome.error) warnings.push(phaseWarning("Pre-request", outcome.error));
		return {
			request: headers.changed ? { ...request, headers: headers.rows } : request,
			variables,
			phase,
			warnings,
		};
	}

	function runPostResponse({ request, response, collection, environment, variables = null }) {
		const definition = scriptDefinitionOf(request);
		const assertions = assertionsDefinitionOf(request);
		const hasScript = Boolean(definition.test.trim());
		if (!hasScript && assertions.length === 0) return { phase: null, tests: [], warnings: [] };
		const view = responseView(response);
		const warnings = [];
		let phase = phaseRecord("passed", null, null);
		let tests = [];
		if (hasScript) {
			const scope = scriptVariableScopes(collection, environment);
			const merged = { ...scope.merged };
			if (variables) {
				for (const [key, value] of variables) {
					if (value === null) delete merged[key];
					else merged[key] = String(value);
				}
			}
			const outcome = sandbox({
				source: definition.test,
				phase: "test",
				input: {
					phase: "test",
					request: requestView(request),
					variables: merged,
					collection: scope.collection,
					environment: scope.environment,
					response: view,
				},
			});
			if (!outcome.ok) {
				phase = phaseRecord("error", outcome.error, null);
				warnings.push(phaseWarning("Test", outcome.error));
			} else {
				const scratch = new Map();
				applyVariableWrites(scratch, outcome.output.variables, secretReferenceKeys(collection, environment), warnings);
				phase = phaseRecord(outcome.error ? "error" : "passed", outcome.error, outcome.output);
				if (outcome.error) warnings.push(phaseWarning("Test", outcome.error));
				tests = outcome.output.tests;
			}
		}
		tests = tests.concat(evaluateAssertions(assertions, view));
		return { phase, tests, warnings };
	}

	function skippedPostResponse(request) {
		const definition = scriptDefinitionOf(request);
		if (!definition.test.trim() && assertionsDefinitionOf(request).length === 0)
			return { phase: null, tests: [], warnings: [] };
		return { phase: phaseRecord("skipped", null, null), tests: [], warnings: [] };
	}

	return { runPreRequest, runPostResponse, skippedPostResponse };
}

export const scriptService = createScriptService();
