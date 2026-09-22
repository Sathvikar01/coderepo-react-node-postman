import { z } from "zod";
import { executionIntelligenceService } from "./execution-intelligence.service.js";

const executionIdSchema = z.uuid("Provide a valid execution identifier.");
const comparisonSchema = z
	.object({
		baseExecutionId: executionIdSchema,
		candidateExecutionId: executionIdSchema,
	})
	.strict()
	.superRefine((value, context) => {
		if (value.baseExecutionId === value.candidateExecutionId)
			context.addIssue({ code: "custom", path: ["candidateExecutionId"], message: "Choose two different executions to compare." });
	});

export const parseComparisonInput = (value) => comparisonSchema.parse(value);

export async function getExecutionReceipt(request, response, next) {
	try {
		const executionId = executionIdSchema.parse(request.params.executionId);
		response.json({ data: await executionIntelligenceService.getReceipt(request.profileId, executionId) });
	} catch (error) {
		next(error);
	}
}

export async function compareExecutionRuns(request, response, next) {
	try {
		const input = parseComparisonInput(request.body);
		response.json({
			data: await executionIntelligenceService.compare(
				request.profileId,
				input.baseExecutionId,
				input.candidateExecutionId,
			),
		});
	} catch (error) {
		next(error);
	}
}
