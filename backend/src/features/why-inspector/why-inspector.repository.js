// Phase 49 — "Why?" Inspector repository.
//
// Read-only, profile-scoped loads. Every query filters by `ownerProfileId` so a
// caller can never read another profile's evidence. The repository returns raw
// documents; the projection owns all interpretation.
import { historyRepository } from "../history/history.repository.js";
import { collectionRepository } from "../collections/collection.repository.js";
import { environmentRepository } from "../environments/environment.repository.js";
import { Investigation } from "../execution-intelligence/investigation/investigation.model.js";

const MAX_INVESTIGATIONS = 5;

function isValidObjectId(value) {
	return typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
}

export const whyInspectorRepository = {
	findExecution: (ownerProfileId, executionId) => historyRepository.findByExecutionId(ownerProfileId, executionId),

	async findCollection(ownerProfileId, collectionId) {
		if (!isValidObjectId(collectionId)) return null;
		const record = await collectionRepository.findById(collectionId, ownerProfileId);
		if (!record) return null;
		return { id: String(record._id), name: record.name ?? null, revision: record.revision ?? null };
	},

	async findEnvironment(ownerProfileId, environmentId) {
		if (!isValidObjectId(environmentId)) return null;
		const record = await environmentRepository.findById(environmentId, ownerProfileId);
		if (!record) return null;
		return { id: String(record._id), name: record.name ?? null, revision: record.revision ?? null };
	},

	/**
	 * Completed investigations that reference this execution as their failing
	 * execution. Bounded and newest-first. `result` is included because the
	 * projection is the single place that interprets it.
	 */
	findInvestigations: (ownerProfileId, executionId) =>
		Investigation.find({ ownerProfileId, failingExecutionId: executionId, status: "completed" })
			.sort({ startedAt: -1, _id: -1 })
			.limit(MAX_INVESTIGATIONS)
			.select("investigationId status startedAt finishedAt result")
			.lean(),
};
