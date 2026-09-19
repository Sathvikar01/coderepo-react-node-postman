import { z } from "zod";
import { METHODS } from "../../shared/utils/schemas.js";
import { historyService } from "./history.service.js";

const listSchema = z
    .object({
        cursor: z.string().max(512).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        method: z.enum(METHODS).optional(),
        outcome: z
            .enum(["response", "validation_error", "network_error", "timeout", "cancelled", "size_limit", "decode_error", "interrupted"])
            .optional(),
        q: z.string().max(120).optional(),
    })
    .strict();

export async function listHistory(request, response, next) {
    try {
        response.json({ data: await historyService.list(request.profileId, listSchema.parse(request.query)) });
    } catch (error) {
        next(error);
    }
}

export async function getHistoryEntry(request, response, next) {
    try {
        const record = await historyService.get(request.profileId, request.params.executionId);
        if (!record || record.expired) {
            throw Object.assign(new Error("The requested history entry does not exist."), { statusCode: 404, code: "HISTORY_NOT_FOUND" });
        }
        response.json({ data: record });
    } catch (error) {
        next(error);
    }
}

export async function deleteHistoryEntry(request, response, next) {
    try {
        await historyService.hide(request.profileId, request.params.executionId);
        response.status(204).send();
    } catch (error) {
        next(error);
    }
}

export async function clearHistory(request, response, next) {
    try {
        const result = await historyService.clear(request.profileId);
        response.json({ data: { cleared: result.modifiedCount ?? 0 } });
    } catch (error) {
        next(error);
    }
}
