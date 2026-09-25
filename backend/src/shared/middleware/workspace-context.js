import { AppError } from "../errors/app-error.js";
import { hasCapability } from "../../features/workspaces/workspace-roles.js";
import { workspaceService } from "../../features/workspaces/workspace.service.js";

// Layered directly after `resolveProfileContext`. It decides which shared workspace
// the request operates in and records the caller's role and capabilities, so route
// handlers never have to re-derive authorization from resource ownership.
export async function resolveWorkspaceContext(request, response, next) {
	try {
		if (!request.profileId) throw new AppError(401, "PROFILE_REQUIRED", "Select a Tracer profile to continue.");
		const requestedWorkspaceId = request.get("x-workspace-id") || request.query?.workspaceId || null;
		const { workspace, role, capabilities } = await workspaceService.resolveContext({
			profileId: request.profileId,
			requestedWorkspaceId,
		});
		request.workspace = workspace;
		request.workspaceId = String(workspace._id);
		request.workspaceRole = role;
		request.workspaceCapabilities = capabilities;
		request.workspaceScope = { workspaceId: request.workspaceId, actorProfileId: request.profileId, role };
		next();
	} catch (error) {
		next(error);
	}
}

export function requireWorkspaceCapability(capability) {
	return (request, response, next) => {
		if (!hasCapability(request.workspaceRole, capability)) {
			return next(
				new AppError(403, "WORKSPACE_FORBIDDEN", "Your workspace role does not allow this action.", {
					requiredCapability: capability,
					role: request.workspaceRole ?? null,
				}),
			);
		}
		next();
	};
}
