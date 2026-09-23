import { Investigation } from "./investigation.model.js";

export const investigationRepository = {
	create: (entry) => Investigation.create(entry).then((value) => value.toObject()),
	get: (ownerProfileId, investigationId) => Investigation.findOne({ ownerProfileId, investigationId }).lean(),
	update: (ownerProfileId, investigationId, patch) =>
		Investigation.findOneAndUpdate({ ownerProfileId, investigationId }, { $set: patch }, { new: true }).lean(),
};
