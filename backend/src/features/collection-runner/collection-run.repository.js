import { CollectionRun } from "./collection-run.model.js";

export const collectionRunRepository = {
	create: (entry) => CollectionRun.create(entry).then((value) => value.toObject()),
	get: (ownerProfileId, runId) => CollectionRun.findOne({ ownerProfileId, runId }).lean(),
	update: (ownerProfileId, runId, patch) =>
		CollectionRun.findOneAndUpdate({ ownerProfileId, runId }, { $set: patch }, { new: true }).lean(),
	list: (ownerProfileId, { collectionId = null, limit = 20 } = {}) =>
		CollectionRun.find({ ownerProfileId, ...(collectionId ? { collectionId } : {}) })
			.sort({ startedAt: -1, _id: -1 })
			.limit(limit)
			.lean(),
};
