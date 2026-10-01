import { z } from "zod";
import { changeSafetyService } from "./change-safety.service.js";

const objectIdLike = z.string().min(1).max(128);
const analysisSchema = z
	.object({
		collectionId: objectIdLike,
		baselineRevision: z.coerce.number().int().min(1),
		sourceEnvironmentId: objectIdLike,
		targetEnvironmentId: objectIdLike,
		changeIndex: z.coerce.number().int().min(0).optional(),
		allowMutating: z.boolean().optional().default(false),
	})
	.strict();

export const parseChangeSafetyRequest = (value) => analysisSchema.parse(value);

export async function analyzeChangeSafety(request, response, next) {
	try {
		const input = parseChangeSafetyRequest(request.body);
		response.json({
			data: await changeSafetyService.analyze(request.profileId, request.workspaceScope, input),
		});
	} catch (error) {
		next(error);
	}
}

export async function runChangeSafety(request, response, next) {
	try {
		const input = parseChangeSafetyRequest(request.body);
		response.status(201).json({
			data: await changeSafetyService.run(request.profileId, request.workspaceScope, input),
		});
	} catch (error) {
		next(error);
	}
}
