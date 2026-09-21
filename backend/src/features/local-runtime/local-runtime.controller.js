import { z } from "zod";
import { localRuntimeService } from "./local-runtime.service.js";

const targetSchema = z.object({ host: z.string().trim().min(1).max(253) }).strict();
const updateSchema = z
	.object({
		expectedRevision: z.number().int().min(0),
		enabled: z.boolean(),
		targets: z.array(targetSchema).max(20),
	})
	.strict();

export async function getLocalRuntime(request, response, next) {
	try {
		response.json({ data: await localRuntimeService.get(request.profileId) });
	} catch (error) {
		next(error);
	}
}

export async function updateLocalRuntime(request, response, next) {
	try {
		const input = updateSchema.parse(request.body);
		response.json({ data: await localRuntimeService.update(request.profileId, input) });
	} catch (error) {
		next(error);
	}
}
