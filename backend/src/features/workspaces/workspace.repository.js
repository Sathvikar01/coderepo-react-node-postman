import { Workspace } from "./workspace.model.js";

const SUMMARY = "_id ownerProfileId name members personalForProfileId revision createdAt updatedAt";

export const workspaceRepository = {
	// Every workspace the profile can see, oldest first so membership order is stable.
	listForProfile: (profileId) =>
		Workspace.find({ "members.profileId": profileId }).select(SUMMARY).sort({ createdAt: 1, _id: 1 }).lean(),
	findById: (id) => Workspace.findById(id).lean(),
	findByIdForMember: (id, profileId) => Workspace.findOne({ _id: id, "members.profileId": profileId }).lean(),
	findPersonal: (profileId) => Workspace.findOne({ personalForProfileId: profileId }).lean(),
	findOwnedByNameKey: (ownerProfileId, nameKey, excludedId) =>
		Workspace.findOne({ ownerProfileId, nameKey, ...(excludedId ? { _id: { $ne: excludedId } } : {}) }).lean(),
	countForProfile: (profileId) => Workspace.countDocuments({ "members.profileId": profileId }),
	create: (input) => Workspace.create(input),
	// Membership, name, and role changes are revision-checked so two owners editing at
	// the same time cannot silently overwrite each other.
	replaceWithRevision: (id, expectedRevision, update) =>
		Workspace.findOneAndUpdate(
			{ _id: id, revision: expectedRevision },
			{ $set: { ...update, revision: expectedRevision + 1 } },
			{ new: true, runValidators: true },
		).lean(),
};
