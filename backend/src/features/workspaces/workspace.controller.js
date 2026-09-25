import { z } from "zod";
import { workspaceService } from "./workspace.service.js";

const roleEnum = z.enum(["OWNER", "EDITOR", "VIEWER"]);
const revisionSchema = z.coerce.number().int().min(1);

const createSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const renameSchema = z.object({ expectedRevision: revisionSchema, name: z.string().trim().min(1).max(80) }).strict();
const addMemberSchema = z
	.object({
		expectedRevision: revisionSchema,
		email: z.string().trim().toLowerCase().email().max(254),
		role: roleEnum,
	})
	.strict();
const roleSchema = z.object({ expectedRevision: revisionSchema, role: roleEnum }).strict();
const removeQuerySchema = z.object({ revision: revisionSchema });
const activityQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(50).optional(),
	before: z.string().optional(),
});

export async function listWorkspaces(request, response, next) {
	try {
		response.json({ data: await workspaceService.listForProfile(request.profileId) });
	} catch (error) {
		next(error);
	}
}

export async function createWorkspace(request, response, next) {
	try {
		response.status(201).json({ data: await workspaceService.create(createSchema.parse(request.body), request.profileId) });
	} catch (error) {
		next(error);
	}
}

export async function getWorkspace(request, response, next) {
	try {
		response.json({ data: await workspaceService.get(request.params.workspaceId, request.profileId) });
	} catch (error) {
		next(error);
	}
}

export async function renameWorkspace(request, response, next) {
	try {
		const { name, expectedRevision } = renameSchema.parse(request.body);
		response.json({
			data: await workspaceService.rename(request.params.workspaceId, request.profileId, { name, expectedRevision }),
		});
	} catch (error) {
		next(error);
	}
}

export async function addWorkspaceMember(request, response, next) {
	try {
		const payload = addMemberSchema.parse(request.body);
		response
			.status(201)
			.json({ data: await workspaceService.addMember(request.params.workspaceId, request.profileId, payload) });
	} catch (error) {
		next(error);
	}
}

export async function changeWorkspaceMemberRole(request, response, next) {
	try {
		const { role, expectedRevision } = roleSchema.parse(request.body);
		response.json({
			data: await workspaceService.changeRole(request.params.workspaceId, request.profileId, {
				profileId: request.params.profileId,
				role,
				expectedRevision,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function removeWorkspaceMember(request, response, next) {
	try {
		const { revision } = removeQuerySchema.parse(request.query);
		response.json({
			data: await workspaceService.removeMember(request.params.workspaceId, request.profileId, {
				profileId: request.params.profileId,
				expectedRevision: revision,
			}),
		});
	} catch (error) {
		next(error);
	}
}

export async function listWorkspaceActivity(request, response, next) {
	try {
		const { limit, before } = activityQuerySchema.parse(request.query);
		response.json({
			data: await workspaceService.listActivity(request.params.workspaceId, request.profileId, { limit, before }),
		});
	} catch (error) {
		next(error);
	}
}
