import { z } from "zod";
import { executionIntelligenceService } from "./execution-intelligence.service.js";
import { minimizationService } from "./minimization.service.js";
import { investigationService } from "./investigation/investigation.service.js";
import { parseInvestigationInput } from "./investigation/investigation-model.js";

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
const minimizationPredicateSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("status"), equals: z.number().int().min(100).max(599) }).strict(),
	z.object({ type: z.literal("outcome"), equals: z.string().min(1).max(64) }).strict(),
	z.object({ type: z.literal("assertion"), assertionId: z.string().min(1).max(128) }).strict(),
]);
const minimizationSchema = z
	.object({
		sourceExecutionId: executionIdSchema,
		predicate: minimizationPredicateSchema.optional(),
		targetMode: z.enum(["execution", "mock"]).default("execution"),
		allowUnsafeLocal: z.boolean().default(false),
	})
	.strict();

export const parseCapsuleExportInput = (value) => capsuleExportSchema.parse(value);
export const parseCapsuleImportInput = (value) => capsuleImportSchema.parse(value);
export const parseMinimizationInput = (value) => minimizationSchema.parse(value);

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

export async function startMinimization(request, response, next) {
	try {
		const input = parseMinimizationInput(request.body);
		response.status(202).json({ data: await minimizationService.start(request.profileId, input) });
	} catch (error) {
		next(error);
	}
}

export async function getMinimization(request, response, next) {
	try {
		const jobId = executionIdSchema.parse(request.params.jobId);
		response.json({ data: await minimizationService.status(request.profileId, jobId) });
	} catch (error) {
		next(error);
	}
}

export async function cancelMinimization(request, response, next) {
	try {
		const jobId = executionIdSchema.parse(request.params.jobId);
		response.json({ data: await minimizationService.cancel(request.profileId, jobId) });
	} catch (error) {
		next(error);
	}
}

/* -------------------------------------------------------------------------- */
/* Phase 35 — Investigation Engine (Workflow 5)                                */
/* -------------------------------------------------------------------------- */

export async function startInvestigation(request, response, next) {
	try {
		const input = parseInvestigationInput(request.body);
		response.status(202).json({ data: await investigationService.start(request.profileId, input) });
	} catch (error) {
		next(error);
	}
}

export async function getInvestigation(request, response, next) {
	try {
		const investigationId = executionIdSchema.parse(request.params.investigationId);
		response.json({ data: await investigationService.status(request.profileId, investigationId) });
	} catch (error) {
		next(error);
	}
}

export async function cancelInvestigation(request, response, next) {
	try {
		const investigationId = executionIdSchema.parse(request.params.investigationId);
		response.json({ data: await investigationService.cancel(request.profileId, investigationId) });
	} catch (error) {
		next(error);
	}
}

export async function exportInvestigationCapsule(request, response, next) {
	try {
		const investigationId = executionIdSchema.parse(request.params.investigationId);
		response.json({ data: await investigationService.exportCapsule(request.profileId, investigationId) });
	} catch (error) {
		next(error);
	}
}
