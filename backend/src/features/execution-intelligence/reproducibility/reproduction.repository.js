import { ReproductionSeries } from "./reproduction.model.js";

export const reproductionRepository = {
	create: (entry) => ReproductionSeries.create(entry).then((value) => value.toObject()),
	get: (ownerProfileId, seriesId) => ReproductionSeries.findOne({ ownerProfileId, seriesId }).lean(),
	update: (ownerProfileId, seriesId, patch) =>
		ReproductionSeries.findOneAndUpdate({ ownerProfileId, seriesId }, { $set: patch }, { new: true }).lean(),
};
