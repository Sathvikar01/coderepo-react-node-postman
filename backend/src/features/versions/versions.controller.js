import { z } from "zod";
import { LIMITS } from "../../shared/utils/limits.js";
import { versionsService } from "./versions.service.js";

const revisionSchema = z.coerce.number().int().min(1);
const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(LIMITS.resourceVersionPageMax).optional() }).strict();
const restoreSchema = z.object({ sourceRevision: revisionSchema, expectedCurrentRevision: revisionSchema }).strict();

function resourceType(request) {
	if (request.params.environmentId) return "environment";
	return "collection";
}

function resourceId(request) {
	return request.params.collectionId ?? request.params.environmentId;
}

export async function listVersions(request, response, next) {
	try {
		const { limit } = listQuerySchema.parse(request.query);
		response.json({ data: await versionsService.list(resourceType(request), resourceId(request), request.workspaceScope, { limit }) });
	} catch (error) {
		next(error);
	}
}

export async function getVersion(request, response, next) {
	try {
		const revision = revisionSchema.parse(request.params.revision);
		response.json({ data: await versionsService.get(resourceType(request), resourceId(request), revision, request.workspaceScope) });
	} catch (error) {
		next(error);
	}
}

export async function compareVersions(request, response, next) {
	try {
		const revisionA = revisionSchema.parse(request.params.revisionA);
		const revisionB = revisionSchema.parse(request.params.revisionB);
		response.json({
			data: await versionsService.compare(resourceType(request), resourceId(request), revisionA, revisionB, request.workspaceScope),
		});
	} catch (error) {
		next(error);
	}
}

export async function restoreVersion(request, response, next) {
	try {
		const { sourceRevision, expectedCurrentRevision } = restoreSchema.parse(request.body);
		response.json({
			data: await versionsService.restore(resourceType(request), resourceId(request), request.workspaceScope, {
				sourceRevision,
				expectedCurrentRevision,
			}),
		});
	} catch (error) {
		next(error);
	}
}
