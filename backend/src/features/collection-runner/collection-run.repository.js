import { CollectionRun } from "./collection-run.model.js";

// A run only ever has one live writer at a time, and a terminal run has no outgoing
// transition. These are the states a compare-and-set write may start from; the
// repository refuses to leave a terminal state even if a caller asks it to.
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

export const collectionRunRepository = {
	create: (entry) => CollectionRun.create(entry).then((value) => value.toObject()),
	get: (ownerProfileId, runId) => CollectionRun.findOne({ ownerProfileId, runId }).lean(),
	update: (ownerProfileId, runId, patch) =>
		CollectionRun.findOneAndUpdate({ ownerProfileId, runId }, { $set: patch }, { new: true }).lean(),
	// Atomic compare-and-set: the status predicate is part of the same findOneAndUpdate
	// filter, so a lifecycle write only applies when the stored status still matches the
	// expected source state. Returns null when another writer already moved the run (or
	// when the expected source state is itself terminal, which has no outgoing edge).
	transition: (ownerProfileId, runId, expectedStatus, patch) => {
		if (TERMINAL_STATUSES.has(expectedStatus)) return Promise.resolve(null);
		return CollectionRun.findOneAndUpdate(
			{ ownerProfileId, runId, status: expectedStatus },
			{ $set: patch },
			{ new: true },
		).lean();
	},
	list: (ownerProfileId, { collectionId = null, limit = 20 } = {}) =>
		CollectionRun.find({ ownerProfileId, ...(collectionId ? { collectionId } : {}) })
			.sort({ startedAt: -1, _id: -1 })
			.limit(limit)
			.lean(),
};
