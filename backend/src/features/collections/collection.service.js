import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";
import { newId } from "../../shared/utils/ids.js";
import { nameKey } from "../../shared/utils/names.js";
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

async function ensureUniqueName(name, ownerProfileId, excludedId) {
	const conflict = await collectionRepository.findByNameKey(nameKey(name), ownerProfileId, excludedId);
	if (conflict) throw new AppError(409, "COLLECTION_NAME_CONFLICT", "A collection with this name already exists in this profile.");
}

function nameConflict() {
	return new AppError(409, "COLLECTION_NAME_CONFLICT", "A collection with this name already exists in this profile.");
}

async function withNameConflictBoundary(operation) {
	try {
		return await operation();
	} catch (error) {
		if (error?.code === 11000) throw nameConflict();
		throw error;
	}
}

export const collectionService = {
	list: (ownerProfileId) => collectionRepository.list(ownerProfileId),
	async get(id, ownerProfileId) {
		assertId(id);
		const collection = await collectionRepository.findById(id, ownerProfileId);
		if (!collection) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
		return collection;
	},
	async create(input, ownerProfileId) {
		const count = await collectionRepository.count(ownerProfileId);
		if (count >= LIMITS.collectionsPerProfile)
			throw new AppError(413, "PROFILE_LIMIT", "This profile has reached the 50 collection limit.", {
				limit: LIMITS.collectionsPerProfile,
				actual: count,
				unit: "collections",
				scope: "profile",
			});
		await ensureUniqueName(input.name, ownerProfileId, null);
		const aggregate = { description: "", variables: [], auth: { mode: "none" }, folders: [], requests: [], ...input };
		ensureAggregateSize(aggregate);
		return withNameConflictBoundary(() =>
			collectionRepository.create({ ...aggregate, nameKey: nameKey(aggregate.name), ownerProfileId, revision: 1 }),
		);
	},
	async replace(id, ownerProfileId, expectedRevision, input) {
		assertId(id);
		const current = await collectionRepository.findById(id, ownerProfileId);
		if (!current) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
		await ensureUniqueName(input.name, ownerProfileId, id);
		ensureAggregateSize(input);
		const updated = await withNameConflictBoundary(() =>
			collectionRepository.replaceWithRevision(id, ownerProfileId, expectedRevision, {
				...input,
				nameKey: nameKey(input.name),
			}),
		);
		if (!updated)
			throw new AppError(
				409,
				"COLLECTION_REVISION_CONFLICT",
				"This collection changed since it was loaded. Reload or save as a new collection.",
			);
		return updated;
	},
	async duplicate(id, ownerProfileId, expectedRevision, name) {
		const current = await collectionService.get(id, ownerProfileId);
		if (current.revision !== expectedRevision)
			throw new AppError(
				409,
				"COLLECTION_REVISION_CONFLICT",
				"This collection changed since it was loaded. Reload or save as a new collection.",
			);
		await ensureUniqueName(name, ownerProfileId, null);
		const count = await collectionRepository.count(ownerProfileId);
		if (count >= LIMITS.collectionsPerProfile)
			throw new AppError(413, "PROFILE_LIMIT", "This profile has reached the 50 collection limit.", {
				limit: LIMITS.collectionsPerProfile,
				actual: count,
				unit: "collections",
				scope: "profile",
			});
		const { newId } = await import("../../shared/utils/ids.js");
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
		return withNameConflictBoundary(() =>
			collectionRepository.create({ ...aggregate, nameKey: nameKey(name), ownerProfileId, revision: 1 }),
		);
	},
	async remove(id, ownerProfileId, expectedRevision) {
		assertId(id);
		const removed = await collectionRepository.removeWithRevision(id, ownerProfileId, expectedRevision);
		if (!removed) {
			const exists = await collectionRepository.findById(id, ownerProfileId);
			if (!exists) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
			throw new AppError(409, "COLLECTION_REVISION_CONFLICT", "This collection changed since it was loaded. Reload before deleting.");
		}
		return removed;
	},
};
