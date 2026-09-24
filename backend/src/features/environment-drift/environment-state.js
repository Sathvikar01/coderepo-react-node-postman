import { AppError } from "../../shared/errors/app-error.js";

// Phase 40A — environment-state adapter and canonical effective-state builder.
//
// Inputs are the persisted environment documents (lean Mongo docs) or the
// canonical snapshot shape `{ id, name, variables }`. The adapter normalizes
// both, validates the environment shape, and fails closed when the stored
// configuration cannot be read reliably.
//
// The builder then merges the (shared) collection scope with each environment
// scope and indexes every variable reference in the workspace. It never
// resolves a secret reference to a value: a secretRef binding carries only its
// alias. Canonicalization is deliberate:
//   * variables are keyed by name, so array order is presentation noise;
//   * object keys never participate in equality;
//   * provenance (collection vs environment) is ignored for equality, so an
//     override that produces the same effective value is not drift;
//   * row order inside requests is preserved, because it can affect execution.
//
// A reference index is shared by both sides because the collection is shared;
// the comparator still receives it per side so a future phase can compare two
// workspaces without changing the engine interface.

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VARIABLE_KEY = 64;
const MAX_VARIABLES = 100;

function malformed(reason) {
	return new AppError(422, "ENVIRONMENT_DRIFT_MALFORMED", "The environment configuration is not readable.", {
		reason: typeof reason === "string" ? reason : null,
	});
}

function asString(value, fallback = "") {
	return typeof value === "string" ? value : fallback;
}

function normalizeId(value) {
	if (value === undefined || value === null) return null;
	return String(value);
}

function ownerProfileOf(record) {
	if (!record || typeof record !== "object") return null;
	return normalizeId(record.ownerProfileId ?? record.profileId ?? null);
}

// Collects every `{{ name }}` reference in a template. A fresh regex is used per
// call so no module-level lastIndex state can leak between calls.
export function collectTemplateReferences(text) {
	const keys = new Set();
	if (typeof text !== "string" || !text.includes("{{")) return keys;
	const pattern = new RegExp(PLACEHOLDER.source, "g");
	let match;
	while ((match = pattern.exec(text)) !== null) keys.add(match[1]);
	return keys;
}

// Validates and canonicalizes one environment scope. `side` only labels errors.
// A null/undefined environment is a valid "no environment selected" state.
export function adaptEnvironment(environment, side = "environment") {
	if (environment === null || environment === undefined) {
		return { id: null, name: null, ownerProfileId: null, revision: null, variables: [] };
	}
	if (typeof environment !== "object" || Array.isArray(environment)) {
		throw malformed(`${side} environment must be an object`);
	}
	const rawVariables = environment.variables ?? [];
	if (!Array.isArray(rawVariables)) throw malformed(`${side} environment variables must be an array`);
	if (rawVariables.length > MAX_VARIABLES) throw malformed(`${side} environment declares too many variables`);

	const seen = new Set();
	const variables = rawVariables.map((variable, index) => {
		if (!variable || typeof variable !== "object" || Array.isArray(variable)) {
			throw malformed(`${side} variable at index ${index} is not an object`);
		}
		const key = asString(variable.key).trim();
		if (!key || key.length > MAX_VARIABLE_KEY || !VARIABLE_KEY.test(key)) {
			throw malformed(`${side} variable at index ${index} has an invalid name`);
		}
		const nameKey = key.toLowerCase();
		if (seen.has(nameKey)) throw malformed(`${side} environment declares "${key}" more than once`);
		seen.add(nameKey);

		const enabled = variable.enabled !== false;
		const id = normalizeId(variable.id);
		if (variable.kind === "secretRef") {
			const alias = asString(variable.alias).trim();
			if (!alias) throw malformed(`${side} secret reference "${key}" is missing an alias`);
			// A secretRef stores an alias and never a value. Any stray value is
			// dropped before it can reach a result.
			return { id, key, kind: "secretRef", alias, enabled };
		}
		if (variable.kind === "plain") {
			return { id, key, kind: "plain", value: asString(variable.value, ""), enabled };
		}
		throw malformed(`${side} variable "${key}" has an unknown kind`);
	});

	return {
		id: normalizeId(environment.id ?? environment._id ?? null),
		name: environment.name === undefined || environment.name === null ? null : String(environment.name),
		ownerProfileId: ownerProfileOf(environment),
		revision: Number.isInteger(environment.revision) ? environment.revision : null,
		variables,
	};
}

function bindingOf(variable, scope) {
	if (variable.kind === "secretRef") return { kind: "secretRef", alias: variable.alias, scope };
	return { kind: "plain", value: variable.value ?? "", scope };
}

// Defensive read of the shared collection scope. Collection drift is out of
// scope for this phase, so a malformed collection variable is skipped rather
// than failing the whole comparison.
function collectionVariables(collection) {
	if (!collection || typeof collection !== "object") return [];
	const raw = Array.isArray(collection.variables) ? collection.variables : [];
	const output = [];
	for (const variable of raw) {
		if (!variable || typeof variable !== "object") continue;
		const key = asString(variable.key).trim();
		if (!key || !VARIABLE_KEY.test(key)) continue;
		if (variable.kind === "secretRef") {
			const alias = asString(variable.alias).trim();
			if (!alias) continue;
			output.push({ id: normalizeId(variable.id), key, kind: "secretRef", alias, enabled: variable.enabled !== false });
		} else if (variable.kind === "plain") {
			output.push({ id: normalizeId(variable.id), key, kind: "plain", value: asString(variable.value, ""), enabled: variable.enabled !== false });
		}
	}
	return output;
}

function authTemplateFields(auth) {
	if (!auth || typeof auth !== "object") return [];
	if (auth.mode === "bearer") return [["tokenTemplate", auth.tokenTemplate]];
	if (auth.mode === "basic")
		return [
			["usernameTemplate", auth.usernameTemplate],
			["passwordTemplate", auth.passwordTemplate],
		];
	if (auth.mode === "apiKey") return [["valueTemplate", auth.valueTemplate]];
	return [];
}

// Indexes every variable reference in the shared workspace. The `referenceId`
// is the deterministic identity a drift entry can point at: a request id, a
// collection variable id, or `collection.auth`.
export function buildWorkspaceReferences(collection) {
	const references = [];
	const roles = { auth: new Set(), header: new Set(), url: new Set(), query: new Set(), body: new Set(), script: new Set(), variable: new Set() };
	const collectionId = normalizeId(collection?.id ?? collection?._id ?? null);
	if (!collection || typeof collection !== "object") return { collectionId, references, roles };

	const scan = (text, category, referenceId, requestId, field) => {
		for (const key of collectTemplateReferences(text)) {
			references.push({ key, category, referenceId, requestId, field });
			if (roles[category]) roles[category].add(key);
		}
	};

	for (const variable of collectionVariables(collection)) {
		if (variable.kind !== "plain") continue;
		scan(variable.value, "variable", variable.id, null, `collection.variables.${variable.key}.value`);
	}

	const collectionAuthFields = authTemplateFields(collection.auth);
	for (const [field, template] of collectionAuthFields) {
		scan(template, "auth", "collection.auth", null, `collection.auth.${field}`);
	}

	const requests = Array.isArray(collection.requests) ? collection.requests : [];
	for (const request of requests) {
		if (!request || typeof request !== "object") continue;
		const requestId = normalizeId(request.id);
		const prefix = `requests.${requestId ?? "?"}`;
		// A request that inherits collection authentication is affected by any
		// change to the collection auth references, so it is indexed as a
		// distinct affected reference as well as the collection itself.
		if (request.auth?.mode === "inherit") {
			for (const [field, template] of collectionAuthFields) scan(template, "auth", requestId, requestId, `${prefix}.auth.inherit.${field}`);
		}
		scan(request.urlTemplate, "url", requestId, requestId, `${prefix}.urlTemplate`);
		for (const row of Array.isArray(request.query) ? request.query : []) {
			if (!row || row.enabled === false) continue;
			scan(row.value, "query", requestId, requestId, `${prefix}.query.${row.key ?? "?"}`);
		}
		for (const row of Array.isArray(request.headers) ? request.headers : []) {
			if (!row || row.enabled === false) continue;
			scan(row.value, "header", requestId, requestId, `${prefix}.headers.${row.key ?? "?"}`);
		}
		const body = request.body;
		if (body && typeof body === "object") {
			if (body.mode === "json" || body.mode === "text") scan(body.text, "body", requestId, requestId, `${prefix}.body.text`);
			if (body.mode === "urlencoded") {
				for (const row of Array.isArray(body.rows) ? body.rows : []) {
					if (!row || row.enabled === false) continue;
					scan(row.value, "body", requestId, requestId, `${prefix}.body.rows.${row.key ?? "?"}`);
				}
			}
		}
		for (const [field, template] of authTemplateFields(request.auth)) {
			scan(template, "auth", requestId, requestId, `${prefix}.auth.${field}`);
		}
		const scripts = request.scripts;
		if (scripts && typeof scripts === "object") {
			scan(scripts.preRequest, "script", requestId, requestId, `${prefix}.scripts.preRequest`);
			scan(scripts.test, "script", requestId, requestId, `${prefix}.scripts.test`);
		}
	}

	return { collectionId, references, roles };
}

// Builds the canonical effective state for one side of the comparison.
export function buildEffectiveEnvironmentState({ collection = null, environment = null, side = "environment" } = {}) {
	const adapted = adaptEnvironment(environment, side);
	const declared = new Map();
	for (const variable of adapted.variables) declared.set(variable.key, bindingOf(variable, "environment"));

	const effective = new Map();
	for (const variable of collectionVariables(collection)) {
		if (variable.enabled) effective.set(variable.key, bindingOf(variable, "collection"));
	}
	for (const variable of adapted.variables) {
		if (variable.enabled) effective.set(variable.key, bindingOf(variable, "environment"));
	}

	const { collectionId, references, roles } = buildWorkspaceReferences(collection);
	const referencedKeys = new Set(references.map((reference) => reference.key));

	return { environment: adapted, collectionId, declared, effective, references, roles, referencedKeys };
}
