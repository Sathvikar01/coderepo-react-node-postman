import { MinimizationJob } from "./minimization.model.js";

export const minimizationRepository = {
	create: (entry) => MinimizationJob.create(entry).then((value) => value.toObject()),
	get: (ownerProfileId, jobId) => MinimizationJob.findOne({ ownerProfileId, jobId }).lean(),
	update: (ownerProfileId, jobId, patch) =>
		MinimizationJob.findOneAndUpdate({ ownerProfileId, jobId }, { $set: patch }, { new: true }).lean(),
};
