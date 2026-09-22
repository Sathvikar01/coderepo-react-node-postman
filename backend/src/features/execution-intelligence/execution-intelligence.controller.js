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
const capsuleExportSchema = z
	.object({ executionId: executionIdSchema, includeResponseBody: z.boolean().default(false) })
	.strict();
const capsuleImportSchema = z.object({ text: z.string().min(1).max(600 * 1024) }).strict();

export const parseCapsuleExportInput = (value) => capsuleExportSchema.parse(value);
export const parseCapsuleImportInput = (value) => capsuleImportSchema.parse(value);

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

export async function exportReproCapsule(request, response, next) {
	try {
		const input = parseCapsuleExportInput(request.body);
		response.json({
			data: await executionIntelligenceService.exportCapsule(request.profileId, input.executionId, {
				includeResponseBody: input.includeResponseBody,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function importReproCapsule(request, response, next) {
	try {
		const input = parseCapsuleImportInput(request.body);
		response.json({ data: executionIntelligenceService.importCapsule(input.text) });
	} catch (error) {
		next(error);
	}
}
