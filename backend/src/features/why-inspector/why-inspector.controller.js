// Phase 49B — "Why?" Inspector controller.
//
// Transport concerns only: validate the bounded identifier and the optional
// supplied proof artifact, delegate to the service, and map a missing record to
// 404. The controller never builds, links, or reinterprets an explanation.
import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { WHY_LIMITS } from "./why-schema.js";
import { whyInspectorService } from "./why-inspector.service.js";

const executionIdSchema = z.uuid("Provide a valid execution identifier.");

// The supplied proof is untrusted. The bound here is a transport bound only: the
// artifact's real, stricter ceiling is enforced by Phase 47B's importer, which
// refuses oversize, tampered, and credential-shaped payloads.
const bodySchema = z
	.object({
		proof: z.union([z.string().max(WHY_LIMITS.maxProofBytes), z.record(z.string(), z.unknown()), z.null()]).optional(),
	})
	.strict();

function respond(explanation, response) {
	if (!explanation) {
		throw new AppError(404, "EXECUTION_NOT_FOUND", "No execution record exists for this identifier in this profile.");
	}
	response.json({ data: explanation });
}

export async function explainExecution(request, response, next) {
	try {
		const executionId = executionIdSchema.parse(request.params.executionId);
		const explanation = await whyInspectorService.explain(request.profileId, executionId);
		respond(explanation, response);
	} catch (error) {
		next(error);
	}
}

/**
 * Explain one execution with an optional caller-supplied Phase 47 proof artifact.
 *
 * This exists because a proof is the only portable carrier of the Phase 39/40/41/43
 * results: `POST` is the verb that lets a caller attach one to a read with no new
 * server-side state. The read itself is still a read — nothing is written.
 */
export async function explainExecutionWithProof(request, response, next) {
	try {
		const executionId = executionIdSchema.parse(request.params.executionId);
		const body = bodySchema.parse(request.body ?? {});
		const explanation = await whyInspectorService.explain(request.profileId, executionId, {
			suppliedProof: body.proof ?? null,
		});
		respond(explanation, response);
	} catch (error) {
		next(error);
	}
}
