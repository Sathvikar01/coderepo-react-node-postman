import { ExecutionHistory } from "../../history/history.model.js";

// Data access for the regression timeline. Reads recorded history only; it never dispatches
// traffic. Hidden, expired, and running lineage records are intentionally returned as well so
// the timeline can treat them as evidence gaps instead of silently claiming an adjacent pair.

const WINDOW_FIELDS =
	"executionId ownerProfileId status visible expiresAt outcome startedAt finishedAt response.status snapshot.scriptResults receipt context.source";

function lineageMatch(ownerProfileId, lineage) {
	return {
		ownerProfileId,
		"context.source.type": "collection",
		"context.source.collectionId": lineage.collectionId,
		"context.source.requestId": lineage.requestId,
	};
}

export const regressionRepository = {
	findAnchor: (ownerProfileId, executionId) => ExecutionHistory.findOne({ ownerProfileId, executionId }).lean(),
	// Returns at most `limit` lineage executions ordered before-or-at the anchor key
	// (startedAt, executionId), newest first. The window always contains the anchor itself.
	async findLineageWindow(ownerProfileId, lineage, anchor, limit) {
		const match = {
			...lineageMatch(ownerProfileId, lineage),
			$or: [
				{ startedAt: { $lt: anchor.startedAt } },
				{ startedAt: anchor.startedAt, executionId: { $lte: anchor.executionId } },
			],
		};
		return ExecutionHistory.find(match)
			.sort({ startedAt: -1, executionId: -1 })
			.limit(limit)
			.select(WINDOW_FIELDS)
			.lean();
	},
};
