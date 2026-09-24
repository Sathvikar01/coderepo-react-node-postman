import { AppError } from "../../shared/errors/app-error.js";
import { buildEffectiveEnvironmentState } from "./environment-state.js";
import { compareEnvironmentStates } from "./drift-comparator.js";
import {
	ENVIRONMENT_DRIFT_KIND,
	ENVIRONMENT_DRIFT_SCHEMA_VERSION,
	environmentDriftResultSchema,
	environmentRef,
	summarizeDrift,
} from "./drift-schema.js";

// Phase 40A — Environment Drift Core public service.
//
// Pure and synchronous: it reads a shared collection and two environment states,
// produces a deterministic drift report, and touches no database, network, or
// execution path. It is the reusable seam later phases compose:
//
//   Snapshot -> Environment Drift -> Change Impact -> Cross-environment Verification
//
// Inputs are intentionally plain so callers can pass lean Mongo environment
// documents, canonical snapshot environments, or hand-built states.

function assertSameProfile(source, target, collection) {
	const sourceProfile = source.environment.ownerProfileId;
	const targetProfile = target.environment.ownerProfileId;
	const collectionProfile = collection?.ownerProfileId ? String(collection.ownerProfileId) : null;
	if (sourceProfile && targetProfile && sourceProfile !== targetProfile) {
		throw new AppError(403, "ENVIRONMENT_DRIFT_PROFILE_MISMATCH", "Environments from different profiles cannot be compared.");
	}
	if (collectionProfile && sourceProfile && collectionProfile !== sourceProfile) {
		throw new AppError(403, "ENVIRONMENT_DRIFT_PROFILE_MISMATCH", "The collection and source environment belong to different profiles.");
	}
	if (collectionProfile && targetProfile && collectionProfile !== targetProfile) {
		throw new AppError(403, "ENVIRONMENT_DRIFT_PROFILE_MISMATCH", "The collection and target environment belong to different profiles.");
	}
}

export function analyzeEnvironmentDrift({ collection = null, sourceEnvironment = null, targetEnvironment = null } = {}) {
	const source = buildEffectiveEnvironmentState({ collection, environment: sourceEnvironment, side: "source" });
	const target = buildEffectiveEnvironmentState({ collection, environment: targetEnvironment, side: "target" });
	assertSameProfile(source, target, collection);

	const drift = compareEnvironmentStates(source, target);
	const result = {
		schemaVersion: ENVIRONMENT_DRIFT_SCHEMA_VERSION,
		kind: ENVIRONMENT_DRIFT_KIND,
		source: environmentRef(source.environment),
		target: environmentRef(target.environment),
		identical: drift.length === 0,
		summary: summarizeDrift(drift),
		drift,
	};

	// Validate our own output before returning it. A malformed report is a bug,
	// not data, so it fails loudly rather than leaking an inconsistent shape.
	const parsed = environmentDriftResultSchema.safeParse(result);
	if (!parsed.success) {
		throw new AppError(500, "ENVIRONMENT_DRIFT_INVALID_RESULT", "The drift report failed its own contract check.", {
			issues: parsed.error.issues.slice(0, 5),
		});
	}
	return parsed.data;
}
