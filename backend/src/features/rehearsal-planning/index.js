// Phase 46A — Checkpointed Rehearsal Planning Core.
//
// Public boundary for the deterministic rehearsal planner. It answers exactly
// one question and nothing else:
//
//   "Given a frozen workspace snapshot, target environment, impact analysis,
//    drift analysis, and blast-radius policy, exactly what requests should a
//    rehearsal attempt, and in what deterministic order?"
//
// This phase PLANS ONLY.
//
//   * It never executes an HTTP request.
//   * It never resolves DNS, reads a database, or touches the network.
//   * It persists nothing and modifies no runner, transport, or UI.
//
// Composition seam:
//
//   Workspace Snapshots ─┐
//   Change Impact ───────┤
//   Environment Drift ───┼──> Rehearsal Planner ──> (Phase 46B integration)
//   Blast-Radius Policy ─┘
//
// Usage:
//
//   const plan = planRehearsal({
//     workspaceId,
//     snapshot: { snapshotId, snapshotFingerprint },
//     source: { environmentId, snapshotFingerprint },
//     target: { environmentId, snapshotFingerprint },
//     impact,            // Phase 39 result envelope (structural)
//     drift,             // Phase 40 result envelope (structural)
//     blastRadius,       // Phase 45 envelope
//     candidates: [{ requestId, collectionId, host, port, method, dependsOn }],
//     dependencies: [{ requestId, dependsOn, dynamicDependencies }], // optional
//   });

import { planRehearsal } from "./plan-builder.js";

export { planRehearsal };

export {
	REHEARSAL_PLAN_KIND,
	REHEARSAL_PLAN_SCHEMA_VERSION,
	rehearsalPlanInputSchema,
	rehearsalPlanResultSchema,
	planSideIdentitySchema,
	planSnapshotIdentitySchema,
	planImpactInputSchema,
	planDriftInputSchema,
	planBlastRadiusInputSchema,
	planCandidateRequestSchema,
	planDependencySchema,
	parseRehearsalPlanInput,
	assertRehearsalPlanResult,
} from "./plan-schema.js";

export {
	PLAN_STATES,
	PLAN_STATE_VALUES,
	STEP_STATES,
	STEP_STATE_VALUES,
	DEPENDENCY_KINDS,
	DEPENDENCY_KIND_VALUES,
	CYCLE_KINDS,
	CYCLE_KIND_VALUES,
	PLAN_REASON_CODES,
	PLAN_REASON_CODE_VALUES,
	REHEARSAL_PLANNING_ERROR_CODES,
} from "./reason-codes.js";

export {
	canonicalizePlanValue,
	canonicalPlanJson,
	planIdentityOf,
	planFingerprintKeyId,
	planDisplayDigest,
	comparePlanStrings,
} from "./plan-identity.js";

export {
	buildDependencyMap,
	classifyDependencies,
	detectCycles,
	topologicalOrder,
} from "./dependency-graph.js";

export {
	projectImpact,
	projectDrift,
	projectBlastRadius,
	blastRadiusIdentityMismatch,
} from "./envelope-adapters.js";

// ---------------------------------------------------------------------------
// Injectable integration interface (Phase 46B seam)
// ---------------------------------------------------------------------------
//
// Phases 39/40/45 are consumed structurally, exactly as Phase 41 consumes them.
// A later integration phase can wrap the real feature modules without changing
// the planner:
//
//   const plan = createRehearsalPlanner({
//     impactSource: ({ workspaceDiff }) => analyzeWorkspaceDiff(workspaceDiff),   // Phase 39
//     driftSource:  ({ collection, sourceEnvironment, targetEnvironment }) =>
//                     analyzeEnvironmentDrift({ collection, sourceEnvironment, targetEnvironment }), // Phase 40
//     blastRadiusSource: ({ policy, requests, ...identity }) =>
//                     evaluateBlastRadius({ policy, requests, ...identity }),   // Phase 45
//   });
//   const result = plan({
//     workspaceId, snapshot, source, target, candidates, dependencies,
//     workspaceDiff, collection, sourceEnvironment, targetEnvironment, policy,
//   });
//
// The wrapper calls those sources for their result envelopes and then runs the
// same pure planner. No execution, no persistence, and no I/O is introduced here.

export function createRehearsalPlanner({ impactSource = null, driftSource = null, blastRadiusSource = null } = {}) {
	return function plan(payload = {}) {
		const {
			workspaceDiff,
			collection,
			sourceEnvironment,
			targetEnvironment,
			policy,
			...rest
		} = payload ?? {};

		let impact = rest.impact ?? null;
		if (!impact && impactSource && workspaceDiff) {
			impact = impactSource({ workspaceDiff });
		}

		let drift = rest.drift ?? null;
		if (!drift && driftSource && (collection || sourceEnvironment || targetEnvironment)) {
			drift = driftSource({ collection, sourceEnvironment, targetEnvironment });
		}

		let blastRadius = rest.blastRadius ?? null;
		if (!blastRadius && blastRadiusSource && policy) {
			blastRadius = blastRadiusSource({
				workspaceId: rest.workspaceId,
				snapshotId: rest.snapshot?.snapshotId ?? null,
				environmentId: rest.source?.environmentId ?? null,
				targetEnvironmentId: rest.target?.environmentId ?? null,
				policy,
				requests: (rest.candidates ?? []).map((candidate) => ({
					requestId: candidate.requestId,
					method: candidate.method,
					host: candidate.host === undefined ? null : { host: candidate.host, port: candidate.port ?? null },
					dependsOn: candidate.dependsOn,
				})),
			});
		}

		return planRehearsal({ ...rest, impact, drift, blastRadius });
	};
}

// Structural guards used by integration phases to confirm a consumed result is
// the shape this planner accepts, without importing the source modules.
export function acceptsRehearsalPlanImpactShape(value) {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		(value.requests !== undefined || value.impact !== undefined || value.resolved !== undefined)
	);
}

export function acceptsRehearsalPlanDriftShape(value) {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		(value.drift !== undefined || value.summary !== undefined || value.identical !== undefined)
	);
}

export function acceptsRehearsalPlanBlastRadiusShape(value) {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		(value.policy !== undefined || value.allowedRequests !== undefined || value.admissionState !== undefined)
	);
}
