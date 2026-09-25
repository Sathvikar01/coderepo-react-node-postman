import { LIMITS } from "../../shared/utils/limits.js";
import { ResourceVersion } from "./version.model.js";

// Bounded retention: keep the newest N rows per resource, drop the overflow.
async function prune(resourceType, resourceId) {
	const overflow = await ResourceVersion.countDocuments({ resourceType, resourceId });
	if (overflow <= LIMITS.resourceVersionRetention) return;
	const stale = await ResourceVersion.find({ resourceType, resourceId })
		.sort({ revision: -1, _id: -1 })
		.skip(LIMITS.resourceVersionRetention)
		.select({ _id: 1 })
		.lean();
	if (stale.length === 0) return;
	await ResourceVersion.deleteMany({ _id: { $in: stale.map((entry) => entry._id) } });
}

function toJson(version) {
	if (!version) return null;
	const plain = version.toObject ? version.toObject() : version;
	return {
		...plain,
		_id: String(plain._id),
		workspaceId: String(plain.workspaceId),
		actorProfileId: plain.actorProfileId ? String(plain.actorProfileId) : null,
	};
}

export const versionRepository = {
	// Retry-safe: the unique (resourceType, resourceId, revision) key turns a
	// retried write into a read of the already-recorded row instead of a duplicate.
	async record(entry) {
		try {
			const created = await ResourceVersion.create(entry);
			await prune(entry.resourceType, entry.resourceId);
			return toJson(created);
		} catch (error) {
			if (error?.code === 11000) {
				const existing = await ResourceVersion.findOne({
					resourceType: entry.resourceType,
					resourceId: entry.resourceId,
					revision: entry.revision,
				}).lean();
				if (existing) return toJson(existing);
			}
			throw error;
		}
	},
	list: (resourceType, resourceId, { limit = LIMITS.resourceVersionPageMax } = {}) =>
		ResourceVersion.find({ resourceType, resourceId })
			.sort({ revision: -1 })
			.limit(Math.min(Math.max(limit, 1), LIMITS.resourceVersionPageMax))
			.lean()
			.then((rows) => rows.map(toJson)),
	get: (resourceType, resourceId, revision) =>
		ResourceVersion.findOne({ resourceType, resourceId, revision }).lean().then(toJson),
	count: (resourceType, resourceId) => ResourceVersion.countDocuments({ resourceType, resourceId }),
	removeAllForResource: (resourceType, resourceId) => ResourceVersion.deleteMany({ resourceType, resourceId }),
};
