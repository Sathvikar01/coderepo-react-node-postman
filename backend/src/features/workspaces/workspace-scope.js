import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { hasCapability } from "./workspace-roles.js";
import { workspaceService } from "./workspace.service.js";

// An explicit scope produced by `resolveWorkspaceContext`, as opposed to a bare
// profile id. Keeping the two shapes distinguishable lets every service stay
// backward compatible with single-profile callers and tests.
export function isWorkspaceScope(scope) {
	return Boolean(
		scope &&
			typeof scope === "object" &&
			!(scope instanceof mongoose.Types.ObjectId) &&
			scope.workspaceId &&
			scope.actorProfileId,
	);
}

// Services accept either a bare profile id (legacy single-profile callers and tests) or
// an explicit `{ workspaceId, actorProfileId, role }` scope resolved by middleware. Both
// forms converge on a concrete workspace so authorization is always enforced against
// workspace membership rather than resource ownership. `scoped` records which form was
// used so callers can pick workspace-scoped or owner-scoped repository reads.
export async function resolveScope(scope) {
	if (isWorkspaceScope(scope)) {
		return {
			scoped: true,
			workspaceId: String(scope.workspaceId),
			actorProfileId: String(scope.actorProfileId),
			role: scope.role ?? null,
		};
	}
	if (typeof scope === "string" && scope) {
		const workspace = await workspaceService.ensurePersonalWorkspace(scope);
		return { scoped: false, workspaceId: String(workspace._id), actorProfileId: String(scope), role: "OWNER" };
	}
	if (scope instanceof mongoose.Types.ObjectId || (scope && mongoose.isValidObjectId(scope))) {
		const profileId = String(scope);
		const workspace = await workspaceService.ensurePersonalWorkspace(profileId);
		return { scoped: false, workspaceId: String(workspace._id), actorProfileId: profileId, role: "OWNER" };
	}
	throw new AppError(500, "WORKSPACE_SCOPE_REQUIRED", "A workspace scope is required for this operation.");
}

// Defense in depth: the route middleware already gates capabilities, but a service
// call must fail closed too if it is ever reached by another path.
export function assertScopeCapability(scope, capability) {
	if (!hasCapability(scope.role, capability)) {
		throw new AppError(403, "WORKSPACE_FORBIDDEN", "Your workspace role does not allow this action.", {
			requiredCapability: capability,
			role: scope.role ?? null,
		});
	}
}
