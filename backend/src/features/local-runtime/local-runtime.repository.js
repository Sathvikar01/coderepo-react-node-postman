import { LocalRuntimeSetting } from "./local-runtime.model.js";

export const localRuntimeRepository = {
	findByProfile: (ownerProfileId) => LocalRuntimeSetting.findOne({ ownerProfileId }).lean(),
	create: (input) => LocalRuntimeSetting.create(input),
	replace: (ownerProfileId, expectedRevision, update) =>
		LocalRuntimeSetting.findOneAndUpdate(
			{ ownerProfileId, revision: expectedRevision },
			{ $set: { ...update, revision: expectedRevision + 1 } },
			{ new: true, runValidators: true },
		).lean(),
};
