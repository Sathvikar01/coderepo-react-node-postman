import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";
import { newId } from "../../shared/utils/ids.js";
import { nameKey } from "../../shared/utils/names.js";
import { Profile } from "../profiles/profile.model.js";
import { versionsService } from "../versions/versions.service.js";
import { versionRepository } from "../versions/version.repository.js";
import { recordWorkspaceActivity } from "../workspaces/workspace-activity.js";
import { assertScopeCapability, resolveScope } from "../workspaces/workspace-scope.js";
import { collectionRepository } from "./collection.repository.js";

function assertId(id) {
	if (!mongoose.isValidObjectId(id)) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
}

function ensureAggregateSize(aggregate) {
	const jsonBytes = utf8Bytes(JSON.stringify(aggregate));
	if (jsonBytes > LIMITS.collectionJsonBytes) {
		throw new AppError(413, "COLLECTION_LIMIT", "This collection exceeds the 2 MiB canonical size limit.", {
			limit: LIMITS.collectionJsonBytes,
			actual: jsonBytes,
			unit: "bytes",
			scope: "collection-json",
		});
	}
}

async function ensureUniqueName(name, workspaceId, excludedId) {
	const conflict = await collectionRepository.findByNameKeyInWorkspace(nameKey(name), workspaceId, excludedId);
	if (conflict) throw nameConflict();
}

function nameConflict() {
	return new AppError(409, "COLLECTION_NAME_CONFLICT", "A collection with this name already exists in this workspace.");
}

async function withNameConflictBoundary(operation) {
	try {
		return await operation();
	} catch (error) {
		if (error?.code === 11000) throw nameConflict();
		throw error;
	}
}

// A stale save points at who last changed the shared collection so the UI can attribute
// the conflict instead of showing an anonymous "changed" message.
async function conflictDetails(id, workspaceId, expectedRevision) {
	const current = await collectionRepository.findByIdInWorkspace(id, workspaceId);
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
	if (!details) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
	throw new AppError(409, "COLLECTION_REVISION_CONFLICT", message, details);
}

export const collectionService = {
	async list(scope) {
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "read");
		// Legacy profile-scoped callers still see exactly their own collections.
		if (!resolved.scoped) return collectionRepository.list(resolved.actorProfileId);
		return collectionRepository.listByWorkspace(resolved.workspaceId);
	},
	async get(id, scope) {
		assertId(id);
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "read");
		const collection =
			!resolved.scoped
				? await collectionRepository.findById(id, resolved.actorProfileId)
				: await collectionRepository.findByIdInWorkspace(id, resolved.workspaceId);
		if (!collection) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
		return collection;
	},
	async create(input, scope) {
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "writeCollections");
		const count = await collectionRepository.countByWorkspace(resolved.workspaceId);
		if (count >= LIMITS.collectionsPerProfile)
			throw new AppError(413, "PROFILE_LIMIT", "This workspace has reached the 50 collection limit.", {
				limit: LIMITS.collectionsPerProfile,
				actual: count,
				unit: "collections",
				scope: "workspace",
			});
		await ensureUniqueName(input.name, resolved.workspaceId, null);
		const aggregate = { description: "", variables: [], auth: { mode: "none" }, folders: [], requests: [], ...input };
		ensureAggregateSize(aggregate);
		const created = await withNameConflictBoundary(() =>
			collectionRepository.create({
				...aggregate,
				nameKey: nameKey(aggregate.name),
				workspaceId: resolved.workspaceId,
				ownerProfileId: resolved.actorProfileId,
				createdByProfileId: resolved.actorProfileId,
				updatedByProfileId: resolved.actorProfileId,
				revision: 1,
			}),
		);
		const collection = created.toObject ? created.toObject() : created;
		await versionsService.recordVersion({
			workspaceId: resolved.workspaceId,
			resourceType: "collection",
			resourceId: String(collection._id),
			revision: collection.revision,
			actorProfileId: resolved.actorProfileId,
			action: "CREATED",
			aggregate: collection,
		});
		await recordWorkspaceActivity({
			workspaceId: resolved.workspaceId,
			actorProfileId: resolved.actorProfileId,
			action: "collection.created",
			targetType: "collection",
			targetId: String(collection._id),
			targetLabel: collection.name,
			newRevision: collection.revision,
			summary: `Collection "${collection.name}" created`,
		});
		return collection;
	},
	async replace(id, scope, expectedRevision, input, provenance = {}) {
		assertId(id);
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "writeCollections");
		const current = await collectionRepository.findByIdInWorkspace(id, resolved.workspaceId);
		if (!current) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
		await ensureUniqueName(input.name, resolved.workspaceId, id);
		ensureAggregateSize(input);
		const updated = await withNameConflictBoundary(() =>
			collectionRepository.replaceWithRevisionInWorkspace(id, resolved.workspaceId, expectedRevision, {
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
				"This collection changed since it was loaded. Reload or save as a new collection.",
			);
		await versionsService.recordVersion({
			workspaceId: resolved.workspaceId,
			resourceType: "collection",
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
			action: provenance.activityAction ?? "collection.updated",
			targetType: "collection",
			targetId: String(id),
			targetLabel: updated.name,
			previousRevision: expectedRevision,
			newRevision: updated.revision,
			summary:
				provenance.activitySummary ??
				`Collection "${updated.name}" saved`,
		});
		return updated;
	},
	async duplicate(id, scope, expectedRevision, name) {
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "writeCollections");
		const current = await collectionService.get(id, scope);
		if (current.revision !== expectedRevision)
			await revisionConflict(
				id,
				resolved.workspaceId,
				expectedRevision,
				"This collection changed since it was loaded. Reload or save as a new collection.",
			);
		await ensureUniqueName(name, resolved.workspaceId, null);
		const count = await collectionRepository.countByWorkspace(resolved.workspaceId);
		if (count >= LIMITS.collectionsPerProfile)
			throw new AppError(413, "PROFILE_LIMIT", "This workspace has reached the 50 collection limit.", {
				limit: LIMITS.collectionsPerProfile,
				actual: count,
				unit: "collections",
				scope: "workspace",
			});
		const folderMap = new Map(current.folders.map((folder) => [folder.id, newId()]));
		const aggregate = {
			name,
			description: current.description,
			variables: current.variables.map((variable) => ({ ...variable, id: newId() })),
			auth: current.auth,
			folders: current.folders.map((folder) => ({ ...folder, id: folderMap.get(folder.id) })),
			requests: current.requests.map((request) => ({
				...request,
				id: newId(),
				folderId: request.folderId ? (folderMap.get(request.folderId) ?? null) : null,
			})),
		};
		ensureAggregateSize(aggregate);
		const created = await withNameConflictBoundary(() =>
			collectionRepository.create({
				...aggregate,
				nameKey: nameKey(name),
				workspaceId: resolved.workspaceId,
				ownerProfileId: resolved.actorProfileId,
				createdByProfileId: resolved.actorProfileId,
				updatedByProfileId: resolved.actorProfileId,
				revision: 1,
			}),
		);
		const collection = created.toObject ? created.toObject() : created;
		await versionsService.recordVersion({
			workspaceId: resolved.workspaceId,
			resourceType: "collection",
			resourceId: String(collection._id),
			revision: collection.revision,
			actorProfileId: resolved.actorProfileId,
			action: "CREATED",
			aggregate: collection,
		});
		await recordWorkspaceActivity({
			workspaceId: resolved.workspaceId,
			actorProfileId: resolved.actorProfileId,
			action: "collection.created",
			targetType: "collection",
			targetId: String(collection._id),
			targetLabel: collection.name,
			newRevision: collection.revision,
			summary: `Collection "${collection.name}" duplicated from "${current.name}"`,
			metadata: { sourceCollectionId: String(current._id) },
		});
		return collection;
	},
	async remove(id, scope, expectedRevision) {
		assertId(id);
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "writeCollections");
		const removed = await collectionRepository.removeWithRevisionInWorkspace(id, resolved.workspaceId, expectedRevision);
		if (!removed) {
			const exists = await collectionRepository.findByIdInWorkspace(id, resolved.workspaceId);
			if (!exists) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
			await revisionConflict(
				id,
				resolved.workspaceId,
				expectedRevision,
				"This collection changed since it was loaded. Reload before deleting.",
			);
		}
		await versionRepository.removeAllForResource("collection", String(id));
		await recordWorkspaceActivity({
			workspaceId: resolved.workspaceId,
			actorProfileId: resolved.actorProfileId,
			action: "collection.deleted",
			targetType: "collection",
			targetId: String(id),
			targetLabel: removed.name,
			previousRevision: removed.revision,
			summary: `Collection "${removed.name}" deleted`,
		});
		return removed;
	},
};
