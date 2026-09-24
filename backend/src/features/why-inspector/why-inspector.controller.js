// Phase 49 — "Why?" Inspector controller.
//
// Transport concerns only: validate the bounded identifier, delegate to the
// service, and map a missing record to 404. The controller never builds or
// reinterprets an explanation.
import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { whyInspectorService } from "./why-inspector.service.js";

const executionIdSchema = z.uuid("Provide a valid execution identifier.");

export async function explainExecution(request, response, next) {
	try {
		const executionId = executionIdSchema.parse(request.params.executionId);
		const explanation = await whyInspectorService.explain(request.profileId, executionId);
		if (!explanation) {
			throw new AppError(404, "EXECUTION_NOT_FOUND", "No execution record exists for this identifier in this profile.");
		}
		response.json({ data: explanation });
	} catch (error) {
		next(error);
	}
}
