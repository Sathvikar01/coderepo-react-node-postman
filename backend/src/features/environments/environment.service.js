import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { getConfig } from "../../shared/config/index.js";
import { LIMITS } from "../../shared/utils/limits.js";
import { nameKey } from "../../shared/utils/names.js";
import { Profile } from "../profiles/profile.model.js";
import { versionsService } from "../versions/versions.service.js";
import { versionRepository } from "../versions/version.repository.js";
import { recordWorkspaceActivity } from "../workspaces/workspace-activity.js";
import { assertScopeCapability, resolveScope } from "../workspaces/workspace-scope.js";
import { environmentRepository } from "./environment.repository.js";

function assertId(id) {
	if (!mongoose.isValidObjectId(id)) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
}

async function ensureUniqueName(name, workspaceId, excludedId) {
	const conflict = await environmentRepository.findByNameKeyInWorkspace(nameKey(name), workspaceId, excludedId);
	if (conflict) throw nameConflict();
}

function nameConflict() {
	return new AppError(409, "ENVIRONMENT_NAME_CONFLICT", "An environment with this name already exists in this workspace.");
}

async function withNameConflictBoundary(operation) {
	try {
		return await operation();
	} catch (error) {
		if (error?.code === 11000) throw nameConflict();
		throw error;
	}
}

async function conflictDetails(id, workspaceId, expectedRevision) {
	const current = await environmentRepository.findByIdInWorkspace(id, workspaceId);
	if (!current) return null;
	let lastUpdatedByName = null;
	if (current.updatedByProfileId) {
		const profile = await Profile.findById(current.updatedByProfileId).select("name").lean();
		lastUpdatedByName = profile?.name ?? null;
	}
	return {
		workspaceId: String(workspaceId),
		expectedRevision,
		currentRevision: current.revision,
		lastUpdatedByProfileId: current.updatedByProfileId ? String(current.updatedByProfileId) : null,
		lastUpdatedByName,
		lastUpdatedAt: current.updatedAt,
	};
}

async function revisionConflict(id, workspaceId, expectedRevision, message) {
	const details = await conflictDetails(id, workspaceId, expectedRevision);
	if (!details) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
	throw new AppError(409, "ENVIRONMENT_REVISION_CONFLICT", message, details);
}

export const environmentService = {
	async list(scope) {
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "read");
		if (!resolved.scoped) return environmentRepository.list(resolved.actorProfileId);
		return environmentRepository.listByWorkspace(resolved.workspaceId);
	},
	async get(id, scope) {
		assertId(id);
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "read");
		const environment =
			!resolved.scoped
				? await environmentRepository.findById(id, resolved.actorProfileId)
				: await environmentRepository.findByIdInWorkspace(id, resolved.workspaceId);
		if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
		return environment;
	},
	async create(input, scope) {
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "writeEnvironments");
		const count = await environmentRepository.countByWorkspace(resolved.workspaceId);
		if (count >= LIMITS.environmentsPerProfile)
			throw new AppError(413, "PROFILE_LIMIT", "This workspace has reached the 20 environment limit.", {
				limit: LIMITS.environmentsPerProfile,
				actual: count,
				unit: "environments",
				scope: "workspace",
			});
		await ensureUniqueName(input.name, resolved.workspaceId, null);
		const created = await withNameConflictBoundary(() =>
			environmentRepository.create({
				...input,
				nameKey: nameKey(input.name),
				workspaceId: resolved.workspaceId,
				ownerProfileId: resolved.actorProfileId,
				createdByProfileId: resolved.actorProfileId,
				updatedByProfileId: resolved.actorProfileId,
				revision: 1,
			}),
		);
		const environment = created.toObject ? created.toObject() : created;
		await versionsService.recordVersion({
			workspaceId: resolved.workspaceId,
			resourceType: "environment",
			resourceId: String(environment._id),
			revision: environment.revision,
			actorProfileId: resolved.actorProfileId,
			action: "CREATED",
			aggregate: environment,
		});
		await recordWorkspaceActivity({
			workspaceId: resolved.workspaceId,
			actorProfileId: resolved.actorProfileId,
			action: "environment.created",
			targetType: "environment",
			targetId: String(environment._id),
			targetLabel: environment.name,
			newRevision: environment.revision,
			summary: `Environment "${environment.name}" created`,
		});
		return environment;
	},
	async replace(id, scope, expectedRevision, input, provenance = {}) {
		assertId(id);
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "writeEnvironments");
		const current = await environmentRepository.findByIdInWorkspace(id, resolved.workspaceId);
		if (!current) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
		await ensureUniqueName(input.name, resolved.workspaceId, id);
		const updated = await withNameConflictBoundary(() =>
			environmentRepository.replaceWithRevisionInWorkspace(id, resolved.workspaceId, expectedRevision, {
				...input,
				nameKey: nameKey(input.name),
				updatedByProfileId: resolved.actorProfileId,
			}),
		);
		if (!updated)
			await revisionConflict(
				id,
				resolved.workspaceId,
				expectedRevision,
				"This environment changed since it was loaded. Reload before saving.",
			);
		await versionsService.recordVersion({
			workspaceId: resolved.workspaceId,
			resourceType: "environment",
			resourceId: String(id),
			revision: updated.revision,
			actorProfileId: resolved.actorProfileId,
			action: provenance.versionAction ?? "UPDATED",
			aggregate: updated,
			sourceRevision: provenance.versionSourceRevision ?? null,
			previousRevision: expectedRevision,
		});
		await recordWorkspaceActivity({
			workspaceId: resolved.workspaceId,
			actorProfileId: resolved.actorProfileId,
			action: provenance.activityAction ?? "environment.updated",
			targetType: "environment",
			targetId: String(id),
			targetLabel: updated.name,
			previousRevision: expectedRevision,
			newRevision: updated.revision,
			summary:
				provenance.activitySummary ??
				`Environment "${updated.name}" saved`,
		});
		return updated;
	},
	async remove(id, scope, expectedRevision) {
		assertId(id);
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "writeEnvironments");
		const removed = await environmentRepository.removeWithRevisionInWorkspace(id, resolved.workspaceId, expectedRevision);
		if (!removed) {
			const exists = await environmentRepository.findByIdInWorkspace(id, resolved.workspaceId);
			if (!exists) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
			await revisionConflict(
				id,
				resolved.workspaceId,
				expectedRevision,
				"This environment changed since it was loaded. Reload before deleting.",
			);
		}
		await versionRepository.removeAllForResource("environment", String(id));
		await recordWorkspaceActivity({
			workspaceId: resolved.workspaceId,
			actorProfileId: resolved.actorProfileId,
			action: "environment.deleted",
			targetType: "environment",
			targetId: String(id),
			targetLabel: removed.name,
			previousRevision: removed.revision,
			summary: `Environment "${removed.name}" deleted`,
		});
		return removed;
	},
	// Secret aliases are resolved against the *requesting* profile. A shared environment
	// stores only the alias, so a collaborator who is not authorized for that alias sees
	// it as unconfigured and any send using it fails closed.
	secretAliases(ownerProfileId) {
		return getConfig()
			.secretAliases.filter((entry) => entry.profileIds.length === 0 || entry.profileIds.includes(ownerProfileId))
			.map((entry) => ({ alias: entry.alias, configured: Boolean(entry.value) }));
	},
	resolveSecretAlias(ownerProfileId, alias) {
		const entry = getConfig().secretAliases.find((candidate) => candidate.alias === alias);
		if (!entry) return null;
		if (entry.profileIds.length > 0 && !entry.profileIds.includes(ownerProfileId)) return null;
		return entry.value;
	},
};
