import { Collection } from "./collection.model.js";

const SUMMARY = "_id workspaceId ownerProfileId createdByProfileId updatedByProfileId name description revision createdAt updatedAt";

export const collectionRepository = {
	// Ownership-scoped reads are retained for callers outside the collaboration flow
	// (change-impact analysis, the headless CLI, the Why inspector).
	list: (ownerProfileId) => Collection.find({ ownerProfileId }).select(SUMMARY).sort({ name: 1 }).lean(),
	count: (ownerProfileId) => Collection.countDocuments({ ownerProfileId }),
	findById: (id, ownerProfileId) => Collection.findOne({ _id: id, ownerProfileId }).lean(),
	findOwnedIds: (ids, ownerProfileId) => Collection.find({ ownerProfileId, _id: { $in: ids } }, { _id: 1 }).lean(),
	findByNameKey: (nameKey, ownerProfileId, excludedId) =>
		Collection.findOne({ ownerProfileId, nameKey, ...(excludedId ? { _id: { $ne: excludedId } } : {}) }).lean(),

	// Workspace-scoped reads are the collaboration authorization boundary.
	listByWorkspace: (workspaceId) => Collection.find({ workspaceId }).select(SUMMARY).sort({ name: 1 }).lean(),
	countByWorkspace: (workspaceId) => Collection.countDocuments({ workspaceId }),
	findByIdInWorkspace: (id, workspaceId) => Collection.findOne({ _id: id, workspaceId }).lean(),
	findIdsInWorkspace: (ids, workspaceId) => Collection.find({ workspaceId, _id: { $in: ids } }, { _id: 1 }).lean(),
	findByNameKeyInWorkspace: (nameKey, workspaceId, excludedId) =>
		Collection.findOne({ workspaceId, nameKey, ...(excludedId ? { _id: { $ne: excludedId } } : {}) }).lean(),
	backfillWorkspace: (ownerProfileId, workspaceId) =>
		Collection.updateMany(
			{ ownerProfileId, workspaceId: null },
			{ $set: { workspaceId, createdByProfileId: ownerProfileId, updatedByProfileId: ownerProfileId } },
		),

	create: (input) => Collection.create(input),
	replaceWithRevision: (id, ownerProfileId, expectedRevision, aggregate) =>
		Collection.findOneAndUpdate(
			{ _id: id, ownerProfileId, revision: expectedRevision },
			{ $set: { ...aggregate, revision: expectedRevision + 1 } },
			{ new: true, runValidators: true },
		).lean(),
	replaceWithRevisionInWorkspace: (id, workspaceId, expectedRevision, aggregate) =>
		Collection.findOneAndUpdate(
			{ _id: id, workspaceId, revision: expectedRevision },
			{ $set: { ...aggregate, revision: expectedRevision + 1 } },
			{ new: true, runValidators: true },
		).lean(),
	removeWithRevision: (id, ownerProfileId, expectedRevision) =>
		Collection.findOneAndDelete({ _id: id, ownerProfileId, revision: expectedRevision }).lean(),
	removeWithRevisionInWorkspace: (id, workspaceId, expectedRevision) =>
		Collection.findOneAndDelete({ _id: id, workspaceId, revision: expectedRevision }).lean(),
};
