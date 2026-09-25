import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { assertScopeCapability, resolveScope } from "../workspaces/workspace-scope.js";
import { Profile } from "../profiles/profile.model.js";
import { collectionRepository } from "../collections/collection.repository.js";
import { environmentRepository } from "../environments/environment.repository.js";
import { buildSafeSnapshot } from "./snapshot.js";
import { fingerprintSnapshot } from "./canonical.js";
import { diffSnapshots } from "./compare.js";
import { versionRepository } from "./version.repository.js";

const WRITE_CAPABILITY = { collection: "writeCollections", environment: "writeEnvironments" };

function assertId(id, code, message) {
	if (!mongoose.isValidObjectId(id)) throw new AppError(404, code, message);
}

function notFound(resourceType) {
	return resourceType === "collection"
		? new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.")
		: new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
}

async function loadResource(resourceType, id, workspaceId) {
	const resource =
		resourceType === "collection"
			? await collectionRepository.findByIdInWorkspace(id, workspaceId)
			: await environmentRepository.findByIdInWorkspace(id, workspaceId);
	if (!resource) throw notFound(resourceType);
	return resource;
}

async function conflictDetails(resourceType, id, workspaceId, expectedRevision) {
	const current = await loadResource(resourceType, id, workspaceId).catch(() => null);
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

async function revisionConflict(resourceType, id, workspaceId, expectedRevision, message) {
	const details = await conflictDetails(resourceType, id, workspaceId, expectedRevision);
	if (!details) throw notFound(resourceType);
	throw new AppError(
		409,
		resourceType === "collection" ? "COLLECTION_REVISION_CONFLICT" : "ENVIRONMENT_REVISION_CONFLICT",
		message,
		details,
	);
}

function aggregateFromSnapshot(resourceType, snapshot) {
	if (resourceType === "collection") {
		return {
			name: snapshot.name,
			description: snapshot.description ?? "",
			variables: snapshot.variables ?? [],
			auth: snapshot.auth ?? { mode: "none" },
			folders: snapshot.folders ?? [],
			requests: snapshot.requests ?? [],
		};
	}
	return { name: snapshot.name, variables: snapshot.variables ?? [] };
}

export const versionsService = {
	// Written AFTER the authoritative CAS mutation succeeds. The saved resource
	// stays the authority; a version-record failure is reported explicitly with a
	// typed code rather than silently claiming complete auditability. Retries are
	// safe: the unique (resourceType, resourceId, revision) key returns the
	// already-recorded row instead of duplicating history.
	async recordVersion({ workspaceId, resourceType, resourceId, revision, actorProfileId, action, aggregate, sourceRevision = null, previousRevision = null }) {
		let snapshot;
		try {
			snapshot = buildSafeSnapshot(resourceType, aggregate);
		} catch (error) {
			throw new AppError(500, "VERSION_SNAPSHOT_FAILED", `The ${resourceType} was saved, but its version snapshot could not be built: ${error.message}`, {
				resourceId: String(resourceId),
				revision,
			});
		}
		try {
			return await versionRepository.record({
				workspaceId,
				resourceType,
				resourceId: String(resourceId),
				revision,
				actorProfileId,
				action,
				fingerprint: fingerprintSnapshot(snapshot),
				snapshot,
				sourceRevision,
				previousRevision,
				createdAt: new Date(),
			});
		} catch (error) {
			throw new AppError(500, "VERSION_RECORD_FAILED", `The ${resourceType} was saved as revision ${revision}, but its version entry was not recorded. Retry the save to complete auditability.`, {
				resourceId: String(resourceId),
				revision,
				cause: error?.code ?? "unknown",
			});
		}
	},

	async list(resourceType, id, scope, { limit } = {}) {
		assertId(id, resourceType === "collection" ? "COLLECTION_NOT_FOUND" : "ENVIRONMENT_NOT_FOUND", "The requested resource does not exist.");
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "read");
		await loadResource(resourceType, id, resolved.workspaceId);
		const rows = await versionRepository.list(resourceType, String(id), { limit });
		return rows.filter((row) => String(row.workspaceId) === String(resolved.workspaceId));
	},

	async get(resourceType, id, revision, scope) {
		assertId(id, resourceType === "collection" ? "COLLECTION_NOT_FOUND" : "ENVIRONMENT_NOT_FOUND", "The requested resource does not exist.");
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, "read");
		await loadResource(resourceType, id, resolved.workspaceId);
		const row = await versionRepository.get(resourceType, String(id), revision);
		if (!row || String(row.workspaceId) !== String(resolved.workspaceId) || String(row.resourceId) !== String(id)) {
			throw new AppError(404, "VERSION_NOT_FOUND", `Version ${revision} of this ${resourceType} does not exist.`);
		}
		return row;
	},

	async compare(resourceType, id, revisionA, revisionB, scope) {
		const [before, after] = await Promise.all([
			versionsService.get(resourceType, id, revisionA, scope),
			versionsService.get(resourceType, id, revisionB, scope),
		]);
		const { changes, truncated } = diffSnapshots(before.snapshot, after.snapshot);
		return {
			resourceType,
			resourceId: String(id),
			before: { revision: before.revision, fingerprint: before.fingerprint, actorProfileId: before.actorProfileId, createdAt: before.createdAt },
			after: { revision: after.revision, fingerprint: after.fingerprint, actorProfileId: after.actorProfileId, createdAt: after.createdAt },
			identical: before.fingerprint === after.fingerprint,
			changes,
			truncated,
		};
	},

	// Restore NEVER rewrites history: the snapshot of `sourceRevision` becomes the
	// content of a brand-new revision via the normal CAS path. A concurrent change
	// after the restore dialog opened returns the attributed 409 — no force
	// overwrite, no silent merge.
	async restore(resourceType, id, scope, { sourceRevision, expectedCurrentRevision }) {
		assertId(id, resourceType === "collection" ? "COLLECTION_NOT_FOUND" : "ENVIRONMENT_NOT_FOUND", "The requested resource does not exist.");
		const resolved = await resolveScope(scope);
		assertScopeCapability(resolved, WRITE_CAPABILITY[resourceType]);
		const current = await loadResource(resourceType, id, resolved.workspaceId);
		const source = await versionRepository.get(resourceType, String(id), sourceRevision);
		if (!source || String(source.workspaceId) !== String(resolved.workspaceId) || String(source.resourceId) !== String(id)) {
			throw new AppError(404, "VERSION_NOT_FOUND", `Version ${sourceRevision} of this ${resourceType} does not exist.`);
		}
		if (current.revision !== expectedCurrentRevision) {
			await revisionConflict(
				resourceType,
				id,
				resolved.workspaceId,
				expectedCurrentRevision,
				`This ${resourceType} changed since the restore view was opened. Reload before restoring.`,
			);
		}
		const aggregate = aggregateFromSnapshot(resourceType, source.snapshot);
		// Dynamic import avoids a require cycle: the resource services call
		// versionsService.recordVersion after their CAS mutations.
		const service =
			resourceType === "collection"
				? (await import("../collections/collection.service.js")).collectionService
				: (await import("../environments/environment.service.js")).environmentService;
		const restored = await service.replace(id, scope, expectedCurrentRevision, aggregate, {
			versionAction: "RESTORED",
			versionSourceRevision: sourceRevision,
			activityAction: resourceType === "collection" ? "collection.restored" : "environment.restored",
			activitySummary: `${resourceType === "collection" ? "Collection" : "Environment"} "${aggregate.name}" restored from v${sourceRevision} as v${expectedCurrentRevision + 1}`,
		});
		const version = await versionRepository.get(resourceType, String(id), restored.revision);
		return { resource: restored, version };
	},
};
