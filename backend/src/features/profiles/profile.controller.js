import { z } from "zod";
import { getConfig } from "../../shared/config/index.js";
import { profileService, preferenceService } from "./profile.service.js";

const preferenceSchema = z
    .object({
        activeEnvironmentId: z.union([z.string().regex(/^[a-f\d]{24}$/i), z.null()]).optional(),
        lastSavedRequest: z.object({ collectionId: z.union([z.string().regex(/^[a-f\d]{24}$/i), z.null()]), requestId: z.union([z.uuid(), z.null()]) }).strict().optional(),
        collectionOrder: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(100).optional(),
        theme: z.enum(["dark", "light"]).optional(),
        sidebarCollapsed: z.boolean().optional(),
        responseView: z.enum(["pretty", "raw"]).optional(),
    })
    .strict();

export function executionPolicy() {
    const { execution } = getConfig();
    return {
        minTimeoutMs: execution.minTimeoutMs,
        maxTimeoutMs: execution.maxTimeoutMs,
        defaultTimeoutMs: execution.defaultTimeoutMs,
        maxConcurrentPerProfile: execution.maxConcurrentPerProfile,
        maxOpenTabs: 10,
    };
}

export async function listProfiles(request, response, next) {
    try {
        response.json({ data: await profileService.list() });
    } catch (error) {
        next(error);
    }
}

export async function getPreferences(request, response, next) {
    try {
        response.json({ data: { preferences: await preferenceService.get(request.profileId), executionPolicy: executionPolicy() } });
    } catch (error) {
        next(error);
    }
}

export async function updatePreferences(request, response, next) {
    try {
        const input = preferenceSchema.parse(request.body);
        response.json({ data: { preferences: await preferenceService.update(request.profileId, input), executionPolicy: executionPolicy() } });
    } catch (error) {
        next(error);
    }
}
