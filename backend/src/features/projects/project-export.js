// Domain -> TracerProjectV1 export.
//
// The input is exactly what the repositories return, so lean Mongo documents
// are fine: persistence bookkeeping (_id, ownerProfileId, nameKey, revision,
// timestamps) and execution state (cookies, history, send-only overrides) are
// simply not part of the mapping and can never reach the portable file.
//
// Secret safety fails closed. A secret reference that carries a value, a
// credential template without a variable reference, or an example match rule
// on a credential-bearing header aborts the export instead of producing a file
// that would leak or misrepresent credentials.
//
// Assertions (Phase 12) are attached through the narrow versioned envelope in
// project-schema.js: assertionsByRequestId is a plain map from request id to
// { contract, items }. Anything that is not that envelope fails closed.

import { AppError } from "../../shared/errors/app-error.js";
import { CREDENTIAL_REFERENCE, collectionAggregateSchema } from "../../shared/utils/schemas.js";
import { SENSITIVE_MATCH_HEADERS } from "../mocks/mock-matcher.js";
import {
	ASSERTIONS_CONTRACT,
	portableAssertionsSchema,
	TRACER_PROJECT_KIND,
	TRACER_PROJECT_VERSION,
	tracerProjectSchema,
} from "./project-schema.js";
import { projectInvalid } from "./project-serialize.js";

const CREDENTIAL_TEMPLATE_FIELDS = {
	bearer: ["tokenTemplate"],
	basic: ["usernameTemplate", "passwordTemplate"],
	apiKey: ["valueTemplate"],
};

const AGGREGATE_FIELDS = ["name", "description", "variables", "auth", "folders", "requests"];

function assertVariablesSecretSafe(variables, where) {
	(variables ?? []).forEach((variable, index) => {
		if (variable?.kind !== "secretRef") return;
		const key = variable.key ?? String(index);
		if (variable.value !== undefined)
			throw new AppError(
				422,
				"PROJECT_SECRET_UNSAFE",
				`Secret reference "${key}" carries a value; a portable project only stores aliases.`,
				{ where, key: variable.key ?? null },
			);
		if (!variable.alias)
			throw new AppError(422, "PROJECT_SECRET_UNSAFE", `Secret reference "${key}" has no alias to reference.`, {
				where,
				key: variable.key ?? null,
			});
	});
}

function assertAuthSecretSafe(auth, where) {
	const fields = CREDENTIAL_TEMPLATE_FIELDS[auth?.mode];
	if (!fields) return;
	for (const field of fields) {
		if (!CREDENTIAL_REFERENCE.test(auth[field] ?? ""))
			throw new AppError(
				422,
				"PROJECT_SECRET_UNSAFE",
				`A literal ${auth.mode} credential cannot be exported; store it as a secret reference and use a variable template.`,
				{ where, field },
			);
	}
}

function assertCollectionSecretSafe(collection, index) {
	const where = `collections.${index}`;
	assertVariablesSecretSafe(collection?.variables, `${where}.variables`);
	assertAuthSecretSafe(collection?.auth, `${where}.auth`);
	(collection?.requests ?? []).forEach((request, requestIndex) => {
		assertAuthSecretSafe(request?.auth, `${where}.requests.${requestIndex}.auth`);
	});
}

function assertExampleSecretSafe(example, index) {
	(example?.match?.headers ?? []).forEach((rule, ruleIndex) => {
		if (SENSITIVE_MATCH_HEADERS.has(String(rule?.key ?? "").toLowerCase()))
			throw new AppError(
				422,
				"PROJECT_SECRET_UNSAFE",
				`Example "${example?.name ?? index}" matches on "${rule.key}", which carries credentials.`,
				{ where: `examples.${index}.match.headers.${ruleIndex}` },
			);
	});
}

function aggregateFrom(collection) {
	const picked = {};
	for (const field of AGGREGATE_FIELDS) {
		if (collection?.[field] !== undefined) picked[field] = collection[field];
	}
	return picked;
}

function withAssertions(request, assertionsByRequestId) {
	const candidate = assertionsByRequestId?.[request.id];
	if (candidate === undefined) return request;
	const result = portableAssertionsSchema.safeParse(candidate);
	if (!result.success)
		throw projectInvalid(
			result.error,
			"PROJECT_ASSERTIONS_UNSUPPORTED",
			`Assertions for request "${request.name}" are not in the supported "${ASSERTIONS_CONTRACT}" envelope; assertion semantics belong to Phase 12.`,
		);
	return { ...request, assertions: result.data };
}

function exampleFromDomain(example) {
	return {
		name: example?.name,
		source: {
			type: example?.source?.type ?? "manual",
			requestId: example?.source?.requestId ?? null,
			requestName: example?.source?.requestName ?? null,
		},
		match: example?.match,
		response: example?.response,
	};
}

export function projectFromDomain({ name, collections, environments = [], examples = [], assertionsByRequestId } = {}) {
	if (!Array.isArray(collections) || collections.length === 0)
		throw new AppError(400, "PROJECT_INVALID", "A portable project requires at least one collection.");
	collections.forEach(assertCollectionSecretSafe);
	environments.forEach((environment, index) => assertVariablesSecretSafe(environment?.variables, `environments.${index}.variables`));
	examples.forEach(assertExampleSecretSafe);

	const project = {
		schemaVersion: TRACER_PROJECT_VERSION,
		kind: TRACER_PROJECT_KIND,
		description: "",
		collections: collections.map((collection, index) => {
			const result = collectionAggregateSchema.safeParse(aggregateFrom(collection));
			if (!result.success)
				throw projectInvalid(
					result.error,
					"PROJECT_DOMAIN_INVALID",
					`Collection "${collection?.name ?? index}" is not a valid workspace collection and cannot be exported.`,
				);
			return {
				name: result.data.name,
				description: result.data.description,
				variables: result.data.variables,
				auth: result.data.auth,
				folders: result.data.folders,
				requests: result.data.requests.map((request) => withAssertions(request, assertionsByRequestId)),
			};
		}),
		environments: environments.map((environment) => ({ name: environment?.name, variables: environment?.variables ?? [] })),
		examples: examples.map(exampleFromDomain),
	};
	if (typeof name === "string" && name.trim()) project.name = name.trim();

	const result = tracerProjectSchema.safeParse(project);
	if (!result.success) throw projectInvalid(result.error);
	return result.data;
}
