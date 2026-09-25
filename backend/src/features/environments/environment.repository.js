import { Environment } from "./environment.model.js";

const SUMMARY = "_id workspaceId ownerProfileId createdByProfileId updatedByProfileId name revision createdAt updatedAt";

export const environmentRepository = {
	list: (ownerProfileId) => Environment.find({ ownerProfileId }).select(SUMMARY).sort({ name: 1 }).lean(),
	count: (ownerProfileId) => Environment.countDocuments({ ownerProfileId }),
	findById: (id, ownerProfileId) => Environment.findOne({ _id: id, ownerProfileId }).lean(),
	findByNameKey: (nameKey, ownerProfileId, excludedId) =>
		Environment.findOne({ ownerProfileId, nameKey, ...(excludedId ? { _id: { $ne: excludedId } } : {}) }).lean(),

	listByWorkspace: (workspaceId) => Environment.find({ workspaceId }).select(SUMMARY).sort({ name: 1 }).lean(),
	countByWorkspace: (workspaceId) => Environment.countDocuments({ workspaceId }),
	findByIdInWorkspace: (id, workspaceId) => Environment.findOne({ _id: id, workspaceId }).lean(),
	findIdsInWorkspace: (ids, workspaceId) => Environment.find({ workspaceId, _id: { $in: ids } }, { _id: 1 }).lean(),
	findByNameKeyInWorkspace: (nameKey, workspaceId, excludedId) =>
		Environment.findOne({ workspaceId, nameKey, ...(excludedId ? { _id: { $ne: excludedId } } : {}) }).lean(),
	backfillWorkspace: (ownerProfileId, workspaceId) =>
		Environment.updateMany(
			{ ownerProfileId, workspaceId: null },
			{ $set: { workspaceId, createdByProfileId: ownerProfileId, updatedByProfileId: ownerProfileId } },
		),

	create: (input) => Environment.create(input),
	replaceWithRevision: (id, ownerProfileId, expectedRevision, aggregate) =>
		Environment.findOneAndUpdate(
			{ _id: id, ownerProfileId, revision: expectedRevision },
			{ $set: { ...aggregate, revision: expectedRevision + 1 } },
			{ new: true, runValidators: true },
		).lean(),
	replaceWithRevisionInWorkspace: (id, workspaceId, expectedRevision, aggregate) =>
		Environment.findOneAndUpdate(
			{ _id: id, workspaceId, revision: expectedRevision },
			{ $set: { ...aggregate, revision: expectedRevision + 1 } },
			{ new: true, runValidators: true },
		).lean(),
	removeWithRevision: (id, ownerProfileId, expectedRevision) =>
		Environment.findOneAndDelete({ _id: id, ownerProfileId, revision: expectedRevision }).lean(),
	removeWithRevisionInWorkspace: (id, workspaceId, expectedRevision) =>
		Environment.findOneAndDelete({ _id: id, workspaceId, revision: expectedRevision }).lean(),
};
