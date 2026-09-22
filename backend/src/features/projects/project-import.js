// TracerProjectV1 -> domain import.
//
// Every portable project is validated before anything is returned: parseProject
// validates the portable schema, then each collection and environment is
// validated against the same domain schemas the workspace uses for writes. One
// invalid entry fails the whole import; nothing is partially applied.
//
// Unknown fields are never silently dropped into the domain. They survive in
// the portable document (project-serialize.js), but applying them to a
// workspace fails closed because the workspace cannot represent semantics it
// does not understand.
//
// Assertions. The portable envelope is mapped onto the Phase 12 request
// assertion field before domain validation. Phase 12's request schema owns
// assertion semantics and fails closed on anything it cannot represent; this
// layer only carries the versioned envelope shape.

import { z } from "zod";
import { LIMITS } from "../../shared/utils/limits.js";
import { collectionAggregateSchema, variablesSchema } from "../../shared/utils/schemas.js";
import { tracerProjectSchema } from "./project-schema.js";
import { parseProject, projectInvalid } from "./project-serialize.js";

const environmentAggregateSchema = z
	.object({ name: z.string().trim().min(1).max(LIMITS.name), variables: variablesSchema })
	.strict();

export function projectToDomain(project) {
	const value = typeof project === "string" ? parseProject(project) : project;
	const result = tracerProjectSchema.safeParse(value);
	if (!result.success) throw projectInvalid(result.error);
	const parsed = result.data;

	const collections = parsed.collections.map((collection, index) => {
		const applied = {
			...collection,
			requests: collection.requests.map((request) =>
				request.assertions === undefined ? request : { ...request, assertions: request.assertions.items },
			),
		};
		const valid = collectionAggregateSchema.safeParse(applied);
		if (!valid.success)
			throw projectInvalid(valid.error, "PROJECT_DOMAIN_INVALID", `Collection "${collection.name}" cannot be applied to this workspace.`, {
				index,
				collection: collection.name,
			});
		return valid.data;
	});

	const environments = parsed.environments.map((environment, index) => {
		const valid = environmentAggregateSchema.safeParse({ name: environment.name, variables: environment.variables });
		if (!valid.success)
			throw projectInvalid(valid.error, "PROJECT_DOMAIN_INVALID", `Environment "${environment.name}" cannot be applied to this workspace.`, {
				index,
				environment: environment.name,
			});
		return valid.data;
	});

	return { collections, environments, examples: parsed.examples };
}
