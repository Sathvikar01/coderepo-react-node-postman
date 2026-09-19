import { z } from "zod";
import { authSchema, requestDefinitionSchema } from "../../shared/utils/schemas.js";
import { executionService } from "./execution.service.js";

const concreteAuth = z.discriminatedUnion("mode", authSchema.options.filter((option) => option.shape.mode._def.values[0] !== "inherit"));
const sendSchema = z
    .object({
        executionId: z.uuid("Provide a valid execution identifier."),
        tabId: z.string().min(1).max(64),
        draftVersion: z.number().int().min(0),
        request: requestDefinitionSchema,
        context: z
            .object({
                collectionId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
                requestId: z.uuid().optional(),
                collectionRevision: z.number().int().min(1).optional(),
                replayHistoryId: z.uuid().optional(),
                environmentId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
                environmentRevision: z.number().int().min(1).optional(),
            })
            .strict()
            .default({}),
        authOverride: concreteAuth.optional(),
    })
    .strict();

export async function sendExecution(request, response, next) {
    try {
        const input = sendSchema.parse(request.body);
        response.json({ data: await executionService.send(request.profileId, input) });
    } catch (error) {
        next(error);
    }
}

export async function getExecution(request, response, next) {
    try {
        response.json({ data: await executionService.status(request.profileId, request.params.executionId) });
    } catch (error) {
        next(error);
    }
}

export async function cancelExecution(request, response, next) {
    try {
        response.json({ data: await executionService.cancel(request.profileId, request.params.executionId) });
    } catch (error) {
        next(error);
    }
}
