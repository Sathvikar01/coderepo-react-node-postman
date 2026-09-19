import { Profile } from "./profile.model.js";
import { ProfilePreference } from "./preference.model.js";

export const profileRepository = {
	list: () => Profile.find({}).sort({ sortOrder: 1, name: 1 }).lean(),
	findById: (id) => Profile.findById(id).lean(),
	listIds: () => Profile.distinct("_id"),
};

export const preferenceRepository = {
	findByProfile: (ownerProfileId) => ProfilePreference.findOne({ ownerProfileId }).lean(),
	upsert: (ownerProfileId, update) =>
		ProfilePreference.updateOne({ ownerProfileId }, { $set: update }, { runValidators: true, upsert: true }),
};
