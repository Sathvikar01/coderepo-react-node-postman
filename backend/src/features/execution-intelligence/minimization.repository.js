import { MinimizationJob } from "./minimization.model.js";

export const minimizationRepository = {
	create: (entry) => MinimizationJob.create(entry).then((value) => value.toObject()),
	get: (ownerProfileId, jobId) => MinimizationJob.findOne({ ownerProfileId, jobId }).lean(),
	// Atomic compare-and-set: the status predicate is part of the same findOneAndUpdate
	// filter, so a terminal write only applies when the stored status still matches the
	// expected source state. Returns null when another writer already moved the job.
	transition: (ownerProfileId, jobId, expectedStatus, patch) =>
		MinimizationJob.findOneAndUpdate(
			{ ownerProfileId, jobId, status: expectedStatus },
			{ $set: patch },
			{ new: true },
		).lean(),
};
