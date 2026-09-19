import { Environment } from "./environment.model.js";

const SUMMARY = "_id ownerProfileId name revision createdAt updatedAt";

export const environmentRepository = {
    list: (ownerProfileId) => Environment.find({ ownerProfileId }).select(SUMMARY).sort({ name: 1 }).lean(),
    count: (ownerProfileId) => Environment.countDocuments({ ownerProfileId }),
    findById: (id, ownerProfileId) => Environment.findOne({ _id: id, ownerProfileId }).lean(),
    findByNameKey: (nameKey, ownerProfileId, excludedId) => Environment.findOne({ ownerProfileId, nameKey, ...(excludedId ? { _id: { $ne: excludedId } } : {}) }).lean(),
    create: (input) => Environment.create(input),
    replaceWithRevision: (id, ownerProfileId, expectedRevision, aggregate) =>
        Environment.findOneAndUpdate(
            { _id: id, ownerProfileId, revision: expectedRevision },
            { $set: { ...aggregate, revision: expectedRevision + 1 } },
            { new: true, runValidators: true },
        ).lean(),
    removeWithRevision: (id, ownerProfileId, expectedRevision) => Environment.findOneAndDelete({ _id: id, ownerProfileId, revision: expectedRevision }).lean(),
};
