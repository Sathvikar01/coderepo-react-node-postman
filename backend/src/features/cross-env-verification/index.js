// Phase 41A — Cross-Environment Verification Core.
//
// Public boundary for the deterministic cross-environment verification engine.
// It answers one question and nothing else:
//
//   "Is this workspace/version sufficiently verified to move from environment A
//    to environment B, and what blocks verification?"
//
// It evaluates evidence only. It never executes a request, reads a database, or
// touches the runner, transport, Flight Recorder, snapshots, or UI.
//
// Usage:
//
//   const result = verifyCrossEnvironment({
//     source: { snapshotFingerprint, environmentId, ... },
//     target: { snapshotFingerprint, environmentId, collectionId, ... },
//     snapshotDiff, environmentDrift, changeImpact,
//     executions: [...], assertions: [...],
//     freshness: { now, maxAgeMs },   // optional; omit to disable age rules
//   });

export {
	CROSS_ENV_VERIFICATION_KIND,
	CROSS_ENV_VERIFICATION_SCHEMA_VERSION,
	VERIFICATION_STATES,
	VERIFICATION_STATE,
	REASON_CODES,
	REASON_CODE_VALUES,
	FINDING_LEVELS,
	parseVerificationInput,
	parseFreshnessPolicy,
	assertVerificationResult,
	crossEnvVerificationResultSchema,
	executionEvidenceSchema,
	assertionEvidenceSchema,
	sideIdentitySchema,
} from "./verification-schema.js";

export {
	BINDING,
	normalizeEvidence,
	dedupeEvidence,
	classifyBinding,
	snapshotBinding,
	environmentBinding,
	workspaceBinding,
	freshnessBinding,
	evidenceInstant,
} from "./evidence-normalization.js";

export { computeRehearsalSet, collectImpactRows, REHEARSAL_REASONS } from "./rehearsal-set.js";

export {
	REQUEST_VERDICT,
	evaluateIdentity,
	evaluateDrift,
	evaluateImpact,
	evaluateDynamicReferences,
	evaluateRequestEvidence,
	evaluateRehearsalCoverage,
} from "./verification-rules.js";

export { buildVerificationResult, resolveState, combineStates } from "./verification-result.js";

export { verifyCrossEnvironment } from "./cross-env-verification.service.js";
import { verifyCrossEnvironment } from "./cross-env-verification.service.js";

export { compareStrings, sortedIds, sortFindings } from "./ordering.js";

// ---------------------------------------------------------------------------
// Injectable integration interfaces (Phase 41B)
// ---------------------------------------------------------------------------
//
// Phases 39 (Change Impact) and 40 (Environment Drift) are not merged at the time
// this phase is written, so this core does not import their modules. It accepts
// their *public result envelopes* structurally instead. The two narrow factories
// below define the seam a later integration phase uses, so the adapter can consume
// the real feature modules without any change to the engine:
//
//   const verify = createCrossEnvVerifier({
//     changeImpactSource: (input) => analyzeWorkspaceDiff(input),   // Phase 39
//     environmentDriftSource: (input) => analyzeEnvironmentDrift(input), // Phase 40
//   });
//   const result = verify({ source, target, workspaceDiff, environments, executions });
//
// The verifier calls those sources for their results and then runs the same pure
// engine. No execution, no I/O introduced here.

export function createCrossEnvVerifier({ changeImpactSource = null, environmentDriftSource = null } = {}) {
	return function verify(payload = {}) {
		const { workspaceDiff, environments, ...rest } = payload ?? {};
		let changeImpact = rest.changeImpact ?? null;
		if (!changeImpact && changeImpactSource && workspaceDiff) {
			changeImpact = changeImpactSource(workspaceDiff);
		}
		let environmentDrift = rest.environmentDrift ?? null;
		if (!environmentDrift && environmentDriftSource && environments) {
			environmentDrift = environmentDriftSource(environments);
		}
		if (!changeImpact && !environmentDrift && !changeImpactSource && !environmentDriftSource) {
			throw new Error("createCrossEnvVerifier requires changeImpactSource/environmentDriftSource or explicit results.");
		}
		return verifyCrossEnvironment({ ...rest, changeImpact, environmentDrift });
	};
}

// A structural guard used by integration phases to confirm a Phase 39/40 result
// is the shape this engine consumes, without importing those modules.
export function acceptsChangeImpactShape(value) {
	return Boolean(value) && typeof value === "object" && (value.requests !== undefined || value.summary !== undefined || value.resolved !== undefined);
}

export function acceptsEnvironmentDriftShape(value) {
	return Boolean(value) && typeof value === "object" && (value.drift !== undefined || value.summary !== undefined || value.identical !== undefined);
}
