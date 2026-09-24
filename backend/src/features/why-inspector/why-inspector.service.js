// Phase 49 — "Why?" Inspector service.
//
// Thin orchestration: load the profile-scoped evidence the projection needs, then
// hand it to the pure projection. No interpretation lives here.
import { historyService } from "../history/history.service.js";
import { buildWhyExplanation } from "./why-projection.js";
import { whyInspectorRepository } from "./why-inspector.repository.js";

export const whyInspectorService = {
	/**
	 * Explain one execution. Returns `null` when the execution is unknown, expired,
	 * or hidden — the controller turns that into a 404 so a caller cannot
	 * distinguish "never existed" from "not visible to this profile".
	 */
	async explain(ownerProfileId, executionId) {
		const record = await historyService.get(ownerProfileId, executionId);
		if (!record || record.expired || record.visible === false) return null;

		const source = record.receipt?.source ?? {};
		const [collection, environment, investigations] = await Promise.all([
			source.collectionId ? whyInspectorRepository.findCollection(ownerProfileId, source.collectionId) : Promise.resolve(null),
			source.environmentId ? whyInspectorRepository.findEnvironment(ownerProfileId, source.environmentId) : Promise.resolve(null),
			whyInspectorRepository.findInvestigations(ownerProfileId, executionId).catch(() => []),
		]);

		return buildWhyExplanation({
			record,
			related: {
				collection,
				environment,
				investigations,
				// Extension point: no persisted per-execution verification artifact
				// exists in this repository today, so the projection fails closed to
				// the recorded target policy or recorded assertions. A future
				// persisted artifact can be surfaced here without touching the
				// projection's contract.
				verification: null,
			},
		});
	},
};
