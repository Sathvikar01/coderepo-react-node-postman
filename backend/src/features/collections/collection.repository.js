import { Collection } from "./collection.model.js";

const SUMMARY = "_id ownerProfileId name description revision createdAt updatedAt";

export const collectionRepository = {
    list: (ownerProfileId) => Collection.find({ ownerProfileId }).select(SUMMARY).sort({ name: 1 }).lean(),
    count: (ownerProfileId) => Collection.countDocuments({ ownerProfileId }),
    findById: (id, ownerProfileId) => Collection.findOne({ _id: id, ownerProfileId }).lean(),
    findOwnedIds: (ids, ownerProfileId) => Collection.find({ ownerProfileId, _id: { $in: ids } }, { _id: 1 }).lean(),
    findByNameKey: (nameKey, ownerProfileId, excludedId) => Collection.findOne({ ownerProfileId, nameKey, ...(excludedId ? { _id: { $ne: excludedId } } : {}) }).lean(),
    create: (input) => Collection.create(input),
    replaceWithRevision: (id, ownerProfileId, expectedRevision, aggregate) =>
        Collection.findOneAndUpdate(
            { _id: id, ownerProfileId, revision: expectedRevision },
            { $set: { ...aggregate, revision: expectedRevision + 1 } },
            { new: true, runValidators: true },
        ).lean(),
    removeWithRevision: (id, ownerProfileId, expectedRevision) => Collection.findOneAndDelete({ _id: id, ownerProfileId, revision: expectedRevision }).lean(),
    deleteAll: () => Collection.deleteMany({}),
    insertMany: (items) => Collection.insertMany(items),
};
