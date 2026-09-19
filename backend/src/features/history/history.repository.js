import { ExecutionHistory } from "./history.model.js";
import { escapeRegex } from "../../shared/utils/names.js";

function cursorPredicate(cursor) {
	return { $or: [{ startedAt: { $lt: cursor.startedAt } }, { startedAt: cursor.startedAt, _id: { $lt: cursor.id } }] };
}

export const historyRepository = {
	insertAdmission: (entry) => ExecutionHistory.create(entry),
	findByExecutionId: (ownerProfileId, executionId) => ExecutionHistory.findOne({ ownerProfileId, executionId }).lean(),
	async finalize(ownerProfileId, executionId, update) {
		return ExecutionHistory.findOneAndUpdate(
			{ ownerProfileId, executionId, status: "running" },
			{ $set: update },
			{ new: true },
		).lean();
	},
	async list(ownerProfileId, { limit, method, outcome, q, cursor }) {
		const filter = { ownerProfileId, visible: true, ...(method ? { "request.method": method } : {}), ...(outcome ? { outcome } : {}) };
		if (q) {
			const pattern = escapeRegex(q);
			filter.$and = [
				{
					$or: [
						{ "request.name": { $regex: pattern, $options: "i" } },
						{ "snapshot.displayUrl": { $regex: pattern, $options: "i" } },
					],
				},
			];
		}
		const query = { ...filter, ...(cursor ? cursorPredicate(cursor) : {}) };
		const find = ExecutionHistory.find(query)
			.sort({ startedAt: -1, _id: -1 })
			.limit(limit + 1)
			.select(
				"executionId outcome effectCertainty status request.method request.name snapshot.displayUrl startedAt finishedAt response.status response.timing.totalMs response.size.receivedBodyBytes error",
			)
			.lean();
		return find;
	},
	selectBodyCandidates: (ownerProfileId, limit) =>
		ExecutionHistory.find({ ownerProfileId, visible: true, status: "terminal", "response.body.value": { $ne: "" } })
			.sort({ startedAt: -1, _id: -1 })
			.skip(limit)
			.select("_id")
			.limit(200)
			.lean(),
	trimBodies: (ids) =>
		ExecutionHistory.updateMany(
			{ _id: { $in: ids } },
			{ $set: { "response.body.value": "", "response.body.truncated": true, "response.body.omittedReason": "retention" } },
		),
	// Startup recovery runs before this process accepts traffic, so every running record
	// belongs to a dead process. Horizontal multi-instance deployment is not supported.
	markRunningInterrupted: (expiresAt) =>
		ExecutionHistory.updateMany(
			{ status: "running" },
			{
				$set: {
					status: "terminal",
					outcome: "interrupted",
					effectCertainty: "may_have_reached_target",
					finishedAt: new Date(),
					expiresAt,
					persistence: { state: "saved" },
				},
			},
		),
	markStaleRunningInterrupted: (cutoff, expiresAt) =>
		ExecutionHistory.updateMany(
			{ status: "running", startedAt: { $lte: cutoff } },
			{
				$set: {
					status: "terminal",
					outcome: "interrupted",
					effectCertainty: "may_have_reached_target",
					finishedAt: new Date(),
					expiresAt,
					persistence: { state: "saved" },
				},
			},
		),
	async hide(ownerProfileId, executionId) {
		return ExecutionHistory.findOneAndUpdate(
			{ ownerProfileId, executionId, status: "terminal" },
			{ $set: { visible: false, request: { name: null, method: null }, snapshot: {}, response: null, error: null } },
			{ new: true },
		).lean();
	},
	hideTerminalBefore: (ownerProfileId, cutoff) =>
		ExecutionHistory.updateMany(
			{ ownerProfileId, visible: true, status: "terminal", finishedAt: { $lte: cutoff } },
			{ $set: { visible: false, request: { name: null, method: null }, snapshot: {}, response: null, error: null } },
		),
};
