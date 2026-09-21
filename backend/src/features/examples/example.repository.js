import { Example } from "./example.model.js";

const SUMMARY = "_id name source match.method match.path response.status response.contentType createdAt updatedAt";

export const exampleRepository = {
	list: (ownerProfileId) => Example.find({ ownerProfileId }).select(SUMMARY).sort({ updatedAt: -1, _id: -1 }).lean(),
	count: (ownerProfileId) => Example.countDocuments({ ownerProfileId }),
	findById: (id, ownerProfileId) => Example.findOne({ _id: id, ownerProfileId }).lean(),
	findByNameKey: (nameKeyValue, ownerProfileId, excludedId) =>
		Example.findOne({ ownerProfileId, nameKey: nameKeyValue, ...(excludedId ? { _id: { $ne: excludedId } } : {}) }).lean(),
	findMatchable: (ownerProfileId, method, path) =>
		Example.find({ ownerProfileId, "match.method": method, "match.path": path }).sort({ createdAt: 1, _id: 1 }).lean(),
	create: (input) => Example.create(input),
	replaceById: (id, ownerProfileId, update) =>
		Example.findOneAndUpdate({ _id: id, ownerProfileId }, { $set: update }, { new: true, runValidators: true }).lean(),
	removeById: (id, ownerProfileId) => Example.findOneAndDelete({ _id: id, ownerProfileId }).lean(),
};
