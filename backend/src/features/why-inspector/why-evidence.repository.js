// Phase 49B — "Why?" Inspector evidence repository.
//
// Read-only, profile-scoped loads of the persisted artifacts the linkage layer
// needs. Two rules govern everything here:
//
//   1. Every query is filtered by `ownerProfileId`. A caller can never observe
//      another profile's evidence.
//   2. Only the identifiers the projection already recorded are used as query
//      inputs. There is no free-text search, no cross-execution scan, and no way
//      to ask for "recent evidence" — a link must be provable from the execution
//      record itself.
//
// Phase 49B adds exactly one query: the persisted Phase 46B rehearsal runs that
// either produced this execution (46C wrote the execution id into the step's
// evidence refs) or declare this execution's request in their plan.
import { RehearsalCheckpoint } from "../rehearsal-checkpoints/checkpoint.model.js";

const MAX_RUNS = 3;

function isValidExecutionId(value) {
	// Execution ids are UUIDs in this repository, not ObjectIds.
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export const whyEvidenceRepository = {
	/**
	 * Persisted rehearsal runs that can be proven to describe this execution, or
	 * that at least declare its request.
	 *
	 * The projection is the whole document on purpose: the plan holds the
	 * step → request mapping and the step accounting holds the execution evidence
	 * refs, and both are needed to prove the link. The result is bounded and the
	 * newest run wins.
	 */
	async findLinkedRehearsalRuns(ownerProfileId, executionId, requestId) {
		if (!ownerProfileId) return [];
		const filters = [];
		if (isValidExecutionId(executionId)) filters.push({ "stepStates.attempt.evidenceRefs": executionId });
		if (typeof requestId === "string" && requestId.length > 0) filters.push({ "plan.steps.refId": requestId });
		if (filters.length === 0) return [];

		return RehearsalCheckpoint.find({
			ownerProfileId,
			...(filters.length === 1 ? filters[0] : { $or: filters }),
		})
			.sort({ createdAt: -1, _id: -1 })
			.limit(MAX_RUNS)
			.lean();
	},
};
