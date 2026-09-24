// Phase 49B — "Why?" Inspector service.
//
// Thin orchestration: load the profile-scoped evidence the projection needs, link
// it to this execution, then hand it to the pure projection. No interpretation
// lives here.
//
// Phase 49B adds one input and no new truth: a caller may supply a Phase 47
// verification proof artifact, which is the only portable carrier of the Phase
// 39/40/41/43 results. The service never mints, upgrades, or persists one.
import { historyService } from "../history/history.service.js";
import { buildEvidenceLinks } from "./why-evidence.js";
import { whyEvidenceRepository } from "./why-evidence.repository.js";
import { buildWhyExplanation } from "./why-projection.js";
import { whyInspectorRepository } from "./why-inspector.repository.js";

export const whyInspectorService = {
	/**
	 * Explain one execution. Returns `null` when the execution is unknown, expired,
	 * or hidden — the controller turns that into a 404 so a caller cannot
	 * distinguish "never existed" from "not visible to this profile".
	 *
	 * `suppliedProof` is untrusted caller input: either the Phase 47B artifact JSON
	 * as text, or the parsed artifact object. It is parsed through Phase 47B's safe
	 * importer inside the linkage layer, so a hostile or malformed artifact
	 * degrades individual links instead of failing the read.
	 */
	async explain(ownerProfileId, executionId, { suppliedProof = null } = {}) {
		const record = await historyService.get(ownerProfileId, executionId);
		if (!record || record.expired || record.visible === false) return null;

		const source = record.receipt?.source ?? {};
		const [collection, environment, investigations, runs] = await Promise.all([
			source.collectionId ? whyInspectorRepository.findCollection(ownerProfileId, source.collectionId) : Promise.resolve(null),
			source.environmentId ? whyInspectorRepository.findEnvironment(ownerProfileId, source.environmentId) : Promise.resolve(null),
			whyInspectorRepository.findInvestigations(ownerProfileId, executionId).catch(() => []),
			// A linkage lookup failing must never take the whole explanation down: the
			// affected sections simply report `not_recorded`.
			whyEvidenceRepository
				.findLinkedRehearsalRuns(ownerProfileId, executionId, source.requestId ?? null)
				.catch(() => []),
		]);

		const links = buildEvidenceLinks({
			executionId,
			receipt: source,
			runs,
			suppliedProof,
		});

		return buildWhyExplanation({
			record,
			related: { collection, environment, investigations, links },
		});
	},
};
