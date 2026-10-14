import { ExecutionHistory } from "./history.model.js";
import { escapeRegex } from "../../shared/utils/names.js";

function cursorPredicate(cursor) {
	return { $or: [{ startedAt: { $lt: cursor.startedAt } }, { startedAt: cursor.startedAt, _id: { $lt: cursor.id } }] };
}

// Upper bound on how many body records a single retention tick may trim. The
// set-based aggregation finds every excess record, but the write stays bounded so
// one maintenance pass cannot run unbounded work; later ticks drain the remainder.
export const RETENTION_BATCH_SIZE = 500;

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
		const filter = {
			ownerProfileId,
			visible: true,
			$or: [{ expiresAt: { $gt: new Date() } }, { expiresAt: null }, { expiresAt: { $exists: false } }],
			...(method ? { "request.method": method } : {}),
			...(outcome ? { outcome } : {}),
		};
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
		const query = cursor
			? { ...filter, $and: [...(filter.$and ?? []), cursorPredicate(cursor)] }
			: filter;
		const find = ExecutionHistory.find(query)
			.sort({ startedAt: -1, _id: -1 })
			.limit(limit + 1)
			.select(
				"executionId outcome effectCertainty status request.method request.name snapshot.displayUrl startedAt finishedAt response.status response.timing.totalMs response.size.receivedBodyBytes error",
			)
			.lean();
		return find;
	},
	// Set-based retention: rank visible terminal body records per profile in a single
	// aggregation and return only the records that fall beyond the newest N for their
	// profile. This never enumerates profiles and never issues one query per profile.
	// "Stored response body" means a non-empty string value, so already-trimmed and
	// body-less (response: null) records are not candidates.
	selectRetentionCandidates: (retainPerProfile, limit = RETENTION_BATCH_SIZE) =>
		ExecutionHistory.aggregate([
			{ $match: { visible: true, status: "terminal", "response.body.value": { $type: "string", $ne: "" } } },
			// $documentNumber only accepts a single sortBy field, so fold the
			// deterministic (startedAt desc, _id desc) order into one composite key.
			{ $set: { retentionSort: { startedAt: "$startedAt", id: "$_id" } } },
			{
				$setWindowFields: {
					partitionBy: "$ownerProfileId",
					sortBy: { retentionSort: -1 },
					output: { retentionRank: { $documentNumber: {} } },
				},
			},
			{ $match: { retentionRank: { $gt: retainPerProfile } } },
			{ $sort: { startedAt: -1, _id: -1 } },
			{ $limit: limit },
			{ $project: { _id: 1 } },
		]).allowDiskUse(true),
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
