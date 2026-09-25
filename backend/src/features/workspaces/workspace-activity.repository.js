import { LIMITS } from "../../shared/utils/limits.js";
import { WorkspaceActivity } from "./workspace-activity.model.js";

// Keep the newest entries and drop the overflow so the feed stays bounded per workspace.
async function prune(workspaceId) {
	const overflow = await WorkspaceActivity.countDocuments({ workspaceId });
	if (overflow <= LIMITS.workspaceActivityRetention) return;
	const stale = await WorkspaceActivity.find({ workspaceId })
		.sort({ createdAt: -1, _id: -1 })
		.skip(LIMITS.workspaceActivityRetention)
		.select({ _id: 1 })
		.lean();
	if (stale.length === 0) return;
	await WorkspaceActivity.deleteMany({ _id: { $in: stale.map((entry) => entry._id) } });
}

export const workspaceActivityRepository = {
	async record(entry) {
		const created = await WorkspaceActivity.create(entry);
		await prune(entry.workspaceId);
		return created.toObject ? created.toObject() : created;
	},
	list: (workspaceId, { limit = LIMITS.workspaceActivityPageMax, before = null } = {}) =>
		WorkspaceActivity.find({
			workspaceId,
			...(before ? { createdAt: { $lt: before } } : {}),
		})
			.sort({ createdAt: -1, _id: -1 })
			.limit(limit)
			.lean(),
	count: (workspaceId) => WorkspaceActivity.countDocuments({ workspaceId }),
	removeAll: (workspaceId) => WorkspaceActivity.deleteMany({ workspaceId }),
};
