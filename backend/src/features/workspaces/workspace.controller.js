import { z } from "zod";
import { LIMITS } from "../../shared/utils/limits.js";
import { replayAfter, subscribeWorkspace } from "./workspace-events.js";
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

// Phase 24B — authenticated live workspace event stream. The browser uses
// streaming fetch() with Authorization + profile headers (never EventSource,
// never a token in the URL). Membership is verified before the first byte;
// the payload carries metadata only, never bodies, secrets, or credentials.
export async function streamWorkspaceEvents(request, response, next) {
	try {
		const { workspace } = await workspaceService.resolveContext({
			profileId: request.profileId,
			requestedWorkspaceId: request.params.workspaceId,
		});
		const workspaceId = String(workspace._id);
		const profileId = String(request.profileId);

		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.flushHeaders?.();

		const write = (event) => {
			response.write(`id: ${event.id}\n`);
			response.write(`event: ${event.action}\n`);
			response.write(`data: ${JSON.stringify(event)}\n\n`);
		};

		// Resume after the caller's last seen event; a client that missed events
		// still reloads canonical state, so replay is a convenience, not truth.
		const lastEventId = request.get("Last-Event-ID") || request.query?.lastEventId || null;
		for (const event of replayAfter(workspaceId, lastEventId)) write(event);

		let closed = false;
		const unsubscribe = subscribeWorkspace(workspaceId, profileId, {
			send: (event) => {
				if (!closed) write(event);
			},
			close: () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				try {
					response.end();
				} catch {}
			},
		});
		const heartbeat = setInterval(() => {
			if (closed) return;
			try {
				response.write(": heartbeat\n\n");
			} catch {
				closed = true;
				clearInterval(heartbeat);
				unsubscribe();
			}
		}, LIMITS.workspaceEventHeartbeatMs);

		request.on("close", () => {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			unsubscribe();
		});
	} catch (error) {
		next(error);
	}
}
