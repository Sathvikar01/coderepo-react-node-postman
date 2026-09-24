// Phase 46A — the deterministic rehearsal planner.
//
// One public function: `planRehearsal(input)`.
//
// It answers: "given a frozen snapshot, target environment, impact analysis,
// drift analysis, and blast-radius policy, exactly what requests should a
// rehearsal attempt, and in what deterministic order?"
//
// It executes nothing. It persists nothing. It modifies no runner. Every fact it
// uses was handed in by the caller, and every derived fact is reproducible from
// those inputs alone.
//
// The planning algorithm, in order:
//
//   1. Validate identity. Workspace, snapshot, source, and target must be
//      present and consistent. A stale snapshot or a target that contradicts the
//      drift analysis fails closed.
//   2. Determine the impacted set from the change-impact envelope. If the impact
//      analysis is absent, no request is impacted: the candidate set is empty and
//      the plan is EMPTY. Nothing "defaults to impacted".
//   3. Classify each candidate against the impacted set, the blast-radius
//      decision, and its dependencies, assigning exactly one step state.
//   4. Detect cycles among the orderable requests and mark every cyclic request
//      CYCLE. Cyclic requests are never executed.
//   5. Topologically order the remaining orderable requests, tie-breaking by
//      requestId.
//   6. Assemble a stable, immutable-style plan envelope and fingerprint it.
//
// Fail-closed rules that shape the whole file:
//
//   * missing/unknown evidence is never safe
//   * a request not present in the blast-radius envelope is NOT admitted
//   * an UNKNOWN admission state never becomes executable
//   * REQUIRES_CONFIRMATION never becomes executable
//   * a request whose dependency cannot be resolved is not executable
//   * a cyclic request is not executable
//   * no hidden clock, no randomness, no process identity participates

import { AppError } from "../../shared/errors/app-error.js";
import {
	PLAN_REASON_CODES,
	PLAN_STATES,
	STEP_STATES,
	DEPENDENCY_KINDS,
	REHEARSAL_PLANNING_ERROR_CODES,
} from "./reason-codes.js";
import {
	REHEARSAL_PLAN_KIND,
	REHEARSAL_PLAN_SCHEMA_VERSION,
	assertRehearsalPlanResult,
	parseRehearsalPlanInput,
} from "./plan-schema.js";
import { comparePlanStrings, planFingerprintKeyId, planIdentityOf } from "./plan-identity.js";
import {
	buildDependencyMap,
	classifyDependencies,
	detectCycles,
	topologicalOrder,
} from "./dependency-graph.js";
import {
	blastRadiusIdentityMismatch,
	projectBlastRadius,
	projectDrift,
	projectImpact,
} from "./envelope-adapters.js";

// The blast-radius admission states, mirrored as string literals. The planner
// reads the Phase 45 envelope's own values; these constants are only used for
// comparison so the planner never invents its own vocabulary.
const ADMISSION = Object.freeze({
	ADMITTED: "ADMITTED",
	BLOCKED: "BLOCKED",
	REQUIRES_CONFIRMATION: "REQUIRES_CONFIRMATION",
	UNKNOWN: "UNKNOWN",
});

function identityConflict(code, message, details) {
	return new AppError(400, code, message, details);
}

// The set of reason codes that are plan-level concerns. Policy reason codes
// copied from the blast-radius envelope are per-request facts and are not
// promoted into the plan-level summary.
const PLAN_REASON_CODE_SET = new Set(Object.values(PLAN_REASON_CODES));

/**
 * Plan a checkpointed cross-environment rehearsal.
 *
 * @param {object} raw structurally-validated planning input
 * @returns {object} deterministic, immutable-style plan envelope
 */
export function planRehearsal(raw) {
	const input = parseRehearsalPlanInput(raw);

	// -----------------------------------------------------------------------
	// 1. Identity validation (fail closed)
	// -----------------------------------------------------------------------
	const workspaceId = input.workspaceId.trim();
	const snapshotId = input.snapshot.snapshotId ? input.snapshot.snapshotId.trim() : null;
	const snapshotFingerprint = input.snapshot.snapshotFingerprint ? input.snapshot.snapshotFingerprint.trim() : null;

	const source = {
		environmentId: input.source.environmentId.trim(),
		workspaceId: input.source.workspaceId ? input.source.workspaceId.trim() : null,
		snapshotId: input.source.snapshotId ? input.source.snapshotId.trim() : null,
		snapshotFingerprint: input.source.snapshotFingerprint ? input.source.snapshotFingerprint.trim() : null,
	};
	const target = {
		environmentId: input.target.environmentId.trim(),
		workspaceId: input.target.workspaceId ? input.target.workspaceId.trim() : null,
		snapshotId: input.target.snapshotId ? input.target.snapshotId.trim() : null,
		snapshotFingerprint: input.target.snapshotFingerprint ? input.target.snapshotFingerprint.trim() : null,
	};

	const identityReasons = [];

	if (source.workspaceId && source.workspaceId !== workspaceId) {
		throw identityConflict(
			REHEARSAL_PLANNING_ERROR_CODES.MISSING_IDENTITY,
			"The source environment belongs to a different workspace than the plan.",
			{ field: "source.workspaceId", expected: workspaceId, actual: source.workspaceId },
		);
	}
	if (target.workspaceId && target.workspaceId !== workspaceId) {
		throw identityConflict(
			REHEARSAL_PLANNING_ERROR_CODES.MISSING_IDENTITY,
			"The target environment belongs to a different workspace than the plan.",
			{ field: "target.workspaceId", expected: workspaceId, actual: target.workspaceId },
		);
	}

	// The plan is bound to a snapshot. When a side explicitly carries a snapshot
	// fingerprint that disagrees with the plan snapshot, the plan would be built
	// on stale identity, so it fails closed instead of planning.
	const planSnapshotKey = snapshotFingerprint ?? snapshotId ?? null;
	for (const [sideName, side] of [
		["source", source],
		["target", target],
	]) {
		const sideKey = side.snapshotFingerprint ?? side.snapshotId ?? null;
		if (sideKey && planSnapshotKey && sideKey !== planSnapshotKey) {
			throw identityConflict(
				REHEARSAL_PLANNING_ERROR_CODES.SNAPSHOT_STALE,
				`The ${sideName} environment is bound to a different snapshot than the plan snapshot.`,
				{ field: `${sideName}.snapshotFingerprint`, expected: planSnapshotKey, actual: sideKey },
			);
		}
	}

	// -----------------------------------------------------------------------
	// 2. Project consumed envelopes
	// -----------------------------------------------------------------------
	const impact = projectImpact(input.impact);
	const drift = projectDrift(input.drift);
	const blastRadius = projectBlastRadius(input.blastRadius);

	// Drift is required to be present when it is required by the caller's move:
	// a move across environments without drift analysis cannot be planned as
	// proven-safe. When drift is supplied but is "unknown", it stays explicit.
	if (!impact.present) {
		identityReasons.push(PLAN_REASON_CODES.IMPACT_MISSING);
	}
	if (!drift.present) {
		identityReasons.push(PLAN_REASON_CODES.DRIFT_MISSING);
	}
	if (!blastRadius.present) {
		identityReasons.push(PLAN_REASON_CODES.BLAST_RADIUS_MISSING);
	}

	// The drift analysis, when present, must describe the same move the plan
	// describes. A drift result for a different target cannot justify this plan.
	if (drift.present && drift.targetEnvironmentId && drift.targetEnvironmentId !== target.environmentId) {
		throw identityConflict(
			REHEARSAL_PLANNING_ERROR_CODES.TARGET_ENVIRONMENT_MISMATCH,
			"The drift analysis describes a different target environment than the plan target.",
			{ field: "drift.target.environmentId", expected: target.environmentId, actual: drift.targetEnvironmentId },
		);
	}

	const blastMismatches = blastRadiusIdentityMismatch(blastRadius, {
		workspaceId,
		snapshotId,
		snapshotFingerprint,
		targetEnvironmentId: target.environmentId,
	});
	if (blastMismatches.length > 0) {
		// A blast-radius envelope evaluated against different identity cannot
		// admit this plan. Fail closed rather than plan against stale policy.
		throw identityConflict(
			REHEARSAL_PLANNING_ERROR_CODES.MALFORMED_INPUT,
			"The blast-radius envelope was evaluated against a different workspace/snapshot/target than the plan.",
			{ mismatches: blastMismatches },
		);
	}

	// -----------------------------------------------------------------------
	// 3. Candidate normalization (ordering-independent)
	// -----------------------------------------------------------------------
	const candidateById = new Map();
	const duplicateIds = [];
	for (const candidate of input.candidates) {
		const requestId = candidate.requestId.trim();
		if (candidateById.has(requestId)) {
			duplicateIds.push(requestId);
			continue;
		}
		candidateById.set(requestId, {
			requestId,
			collectionId: candidate.collectionId ? candidate.collectionId.trim() : null,
			host: typeof candidate.host === "string" ? candidate.host : null,
			port: Number.isInteger(candidate.port) ? candidate.port : null,
			method: typeof candidate.method === "string" ? candidate.method : null,
		});
	}

	// Duplicate identity is a hard error: the planner cannot know which of the
	// duplicates the caller meant, and admitting both would double-count a budget.
	if (duplicateIds.length > 0) {
		throw new AppError(
			400,
			REHEARSAL_PLANNING_ERROR_CODES.DUPLICATE_REQUEST_ID,
			"Duplicate request identity in the candidate set.",
			{ requestIds: [...new Set(duplicateIds)].sort(comparePlanStrings) },
		);
	}

	const candidateIds = new Set(candidateById.keys());
	const sortedCandidateIds = [...candidateIds].sort(comparePlanStrings);

	// -----------------------------------------------------------------------
	// 4. Impact set. Only impacted requests may enter the executable set.
	// -----------------------------------------------------------------------
	const impactedIds = sortedCandidateIds.filter((id) => impact.byRequest.has(id));

	// -----------------------------------------------------------------------
	// 5. Dependency edges (classified) and cycle detection
	// -----------------------------------------------------------------------
	const dependencyMap = buildDependencyMap(input.candidates, input.dependencies);
	const edgesByRequest = new Map();
	const resolvedEdges = [];
	for (const requestId of sortedCandidateIds) {
		const edges = classifyDependencies(requestId, dependencyMap.get(requestId), candidateIds);
		edgesByRequest.set(requestId, edges);
		for (const edge of edges) {
			if (edge.kind === DEPENDENCY_KINDS.RESOLVED || edge.kind === DEPENDENCY_KINDS.SELF) {
				resolvedEdges.push(edge);
			}
		}
	}

	const cycles = detectCycles(candidateIds, resolvedEdges);
	const cyclicIds = new Set();
	for (const cycle of cycles) for (const id of cycle.requestIds) cyclicIds.add(id);

	// -----------------------------------------------------------------------
	// 6. Decide each candidate's state
	// -----------------------------------------------------------------------
	const decisions = new Map();

	for (const requestId of sortedCandidateIds) {
		const candidate = candidateById.get(requestId);
		const impactRow = impact.byRequest.get(requestId) ?? null;
		const admission = blastRadius.byRequest.get(requestId) ?? null;
		const edges = edgesByRequest.get(requestId) ?? [];

		const reasonCodes = new Set();
		let state;

		// (a) impact gate: unaffected requests can never be executable.
		if (!impactRow) {
			state = STEP_STATES.EXCLUDED;
			reasonCodes.add(PLAN_REASON_CODES.CANDIDATE_NOT_IMPACTED);
			reasonCodes.add(PLAN_REASON_CODES.EXCLUDED_BY_IMPACT);
		} else if (!blastRadius.present) {
			// No policy at all: nothing may run. Explicit, never permissive.
			state = STEP_STATES.UNKNOWN;
			reasonCodes.add(PLAN_REASON_CODES.BLAST_RADIUS_MISSING);
			reasonCodes.add(PLAN_REASON_CODES.UNKNOWN_SAFETY);
		} else if (!admission) {
			// Impacted but absent from the policy envelope: the policy did not
			// decide this request, so it is NOT admitted.
			state = STEP_STATES.UNKNOWN;
			reasonCodes.add(PLAN_REASON_CODES.BLAST_RADIUS_NOT_ADMITTED);
			reasonCodes.add(PLAN_REASON_CODES.UNKNOWN_SAFETY);
		} else if (admission.admission === ADMISSION.BLOCKED) {
			state = STEP_STATES.BLOCKED;
			reasonCodes.add(PLAN_REASON_CODES.BLAST_RADIUS_NOT_ADMITTED);
			for (const code of admission.reasonCodes) reasonCodes.add(code);
		} else if (admission.admission === ADMISSION.UNKNOWN) {
			state = STEP_STATES.UNKNOWN;
			reasonCodes.add(PLAN_REASON_CODES.UNKNOWN_SAFETY);
			for (const code of admission.reasonCodes) reasonCodes.add(code);
		} else if (admission.admission === ADMISSION.REQUIRES_CONFIRMATION) {
			state = STEP_STATES.REQUIRES_CONFIRMATION;
			reasonCodes.add(PLAN_REASON_CODES.REQUIRES_CONFIRMATION);
			for (const code of admission.reasonCodes) reasonCodes.add(code);
		} else {
			// ADMITTED: still gated by dependency resolvability and cycles.
			const hasExternal = edges.some((edge) => edge.kind === DEPENDENCY_KINDS.EXTERNAL);
			const hasDynamic = edges.some((edge) => edge.kind === DEPENDENCY_KINDS.DYNAMIC);
			const hasSelfDependency = edges.some((edge) => edge.kind === DEPENDENCY_KINDS.SELF);

			if (cyclicIds.has(requestId)) {
				state = STEP_STATES.CYCLE;
				reasonCodes.add(PLAN_REASON_CODES.DEPENDENCY_CYCLE);
			} else if (hasSelfDependency) {
				// A self edge is a degenerate cycle even before SCC detection.
				state = STEP_STATES.CYCLE;
				reasonCodes.add(PLAN_REASON_CODES.DEPENDENCY_CYCLE);
			} else if (hasExternal || hasDynamic) {
				// An unresolvable dependency means ordering cannot be proven for
				// this request. It stays explicit and is not executable.
				state = STEP_STATES.DEPENDENCY_UNRESOLVED;
				if (hasExternal) reasonCodes.add(PLAN_REASON_CODES.DEPENDENCY_TARGET_EXTERNAL);
				if (hasDynamic) reasonCodes.add(PLAN_REASON_CODES.DYNAMIC_DEPENDENCY_UNRESOLVED);
			} else {
				state = STEP_STATES.EXECUTABLE;
			}
		}

		decisions.set(requestId, {
			requestId,
			collectionId: candidate.collectionId,
			state,
			impactRow,
			admission,
			edges,
			reasonCodes: [...reasonCodes].sort(comparePlanStrings),
		});
	}

	// -----------------------------------------------------------------------
	// 6b. Dependency satisfiability gate
	// -----------------------------------------------------------------------
	// A request may only be executable if every one of its resolvable dependencies
	// is itself executable. Otherwise its prerequisite will not appear earlier in
	// the run, and ordering a step whose prerequisite is blocked, unknown, or
	// excluded would be a lie. This is computed to a fixpoint so that
	// unsatisfiability propagates transitively: if `c` depends on `b` and `b`
	// depends on a blocked `a`, both `b` and `c` become unresolvable.
	let unsatisfiabilityChanged = true;
	while (unsatisfiabilityChanged) {
		unsatisfiabilityChanged = false;
		for (const requestId of sortedCandidateIds) {
			const decision = decisions.get(requestId);
			if (decision.state !== STEP_STATES.EXECUTABLE) continue;
			const unsatisfied = decision.edges.filter(
				(edge) =>
					edge.kind === DEPENDENCY_KINDS.RESOLVED &&
					decisions.get(edge.target)?.state !== STEP_STATES.EXECUTABLE,
			);
			if (unsatisfied.length === 0) continue;
			decision.state = STEP_STATES.DEPENDENCY_UNRESOLVED;
			decision.reasonCodes = [
				...new Set([...decision.reasonCodes, PLAN_REASON_CODES.DEPENDENCY_TARGET_NOT_EXECUTABLE]),
			].sort(comparePlanStrings);
			unsatisfiabilityChanged = true;
		}
	}

	// -----------------------------------------------------------------------
	// 7. Deterministic executable ordering
	// -----------------------------------------------------------------------
	const orderable = sortedCandidateIds.filter((id) => decisions.get(id).state === STEP_STATES.EXECUTABLE);
	const { order, leftover } = topologicalOrder(orderable, resolvedEdges);

	// `leftover` should be empty because cycles were removed before ordering. If
	// it is not, ordering is untrustworthy and the plan fails closed.
	if (leftover.length > 0) {
		for (const id of leftover) {
			const decision = decisions.get(id);
			decision.state = STEP_STATES.CYCLE;
			decision.reasonCodes = [...new Set([...decision.reasonCodes, PLAN_REASON_CODES.DEPENDENCY_CYCLE])].sort(
				comparePlanStrings,
			);
		}
	}

	const executableIds = order.slice();

	// -----------------------------------------------------------------------
	// 8. Assemble steps and projections
	// -----------------------------------------------------------------------
	const steps = [];
	executableIds.forEach((requestId, ordinal) => {
		const decision = decisions.get(requestId);
		const candidate = candidateById.get(requestId);
		steps.push(buildStep({ decision, candidate, ordinal, edgesByRequest, executableSet: new Set(executableIds) }));
	});

	const excluded = [];
	const blockedIds = [];
	const unknownIds = [];
	const confirmationIds = [];
	const unresolvedIds = [];
	const cycleIds = [];
	for (const requestId of sortedCandidateIds) {
		const decision = decisions.get(requestId);
		switch (decision.state) {
			case STEP_STATES.EXCLUDED:
				excluded.push({ requestId, state: STEP_STATES.EXCLUDED, reasonCodes: decision.reasonCodes });
				break;
			case STEP_STATES.BLOCKED:
				blockedIds.push(requestId);
				excluded.push({ requestId, state: STEP_STATES.BLOCKED, reasonCodes: decision.reasonCodes });
				break;
			case STEP_STATES.UNKNOWN:
				unknownIds.push(requestId);
				excluded.push({ requestId, state: STEP_STATES.UNKNOWN, reasonCodes: decision.reasonCodes });
				break;
			case STEP_STATES.REQUIRES_CONFIRMATION:
				confirmationIds.push(requestId);
				excluded.push({ requestId, state: STEP_STATES.REQUIRES_CONFIRMATION, reasonCodes: decision.reasonCodes });
				break;
			case STEP_STATES.DEPENDENCY_UNRESOLVED:
				unresolvedIds.push(requestId);
				excluded.push({ requestId, state: STEP_STATES.DEPENDENCY_UNRESOLVED, reasonCodes: decision.reasonCodes });
				break;
			case STEP_STATES.CYCLE:
				cycleIds.push(requestId);
				excluded.push({ requestId, state: STEP_STATES.CYCLE, reasonCodes: decision.reasonCodes });
				break;
			default:
				break;
		}
	}

	// Stable dependency edge list (kind-classified), independent of input order.
	const dependencyIds = [];
	for (const requestId of sortedCandidateIds) {
		const edges = [...(edgesByRequest.get(requestId) ?? [])].sort((left, right) => {
			const byTarget = comparePlanStrings(left.target, right.target);
			if (byTarget !== 0) return byTarget;
			return comparePlanStrings(left.kind, right.kind);
		});
		for (const edge of edges) {
			dependencyIds.push({ requestId, dependsOn: edge.target, kind: edge.kind });
		}
	}

	// Excluded request ids in a stable order: everything that is NOT executable.
	const excludedIds = sortedCandidateIds.filter((id) => !executableIds.includes(id));

	// -----------------------------------------------------------------------
	// 9. Plan state
	// -----------------------------------------------------------------------
	const planReasonCodes = new Set(identityReasons);
	// Fold in the per-request reason codes that describe a plan-level concern, so
	// a caller can see why the plan is not simply PLANNED without walking every
	// step. Admission reason codes from the policy (e.g. HOST_NOT_ALLOWED) are
	// intentionally NOT promoted: they are per-request policy facts, already
	// carried verbatim on the step and in `excluded`.
	for (const requestId of sortedCandidateIds) {
		const decision = decisions.get(requestId);
		for (const code of decision.reasonCodes) {
			if (PLAN_REASON_CODE_SET.has(code)) planReasonCodes.add(code);
		}
	}
	const hasOpenEnded = blockedIds.length > 0 || unknownIds.length > 0 || unresolvedIds.length > 0 || cyclicIds.size > 0;
	const hasConfirmation = confirmationIds.length > 0;

	let state;
	if (!impact.present) {
		// No impact analysis: nothing is impacted, so nothing can be planned.
		state = PLAN_STATES.EMPTY;
		planReasonCodes.add(PLAN_REASON_CODES.NO_ADMITTED_REQUESTS);
	} else if (executableIds.length === 0) {
		state = PLAN_STATES.EMPTY;
		planReasonCodes.add(PLAN_REASON_CODES.NO_ADMITTED_REQUESTS);
		if (hasOpenEnded) planReasonCodes.add(PLAN_REASON_CODES.UNRESOLVED_DEPENDENCIES);
	} else if (hasOpenEnded || hasConfirmation || excluded.some((entry) => entry.state === STEP_STATES.EXCLUDED)) {
		state = PLAN_STATES.PARTIAL;
	} else {
		state = PLAN_STATES.PLANNED;
	}
	if (hasConfirmation) planReasonCodes.add(PLAN_REASON_CODES.REQUIRES_CONFIRMATION);
	if (unknownIds.length > 0) planReasonCodes.add(PLAN_REASON_CODES.UNKNOWN_SAFETY);
	if (cyclicIds.size > 0) planReasonCodes.add(PLAN_REASON_CODES.DEPENDENCY_CYCLE);
	if (unresolvedIds.length > 0) planReasonCodes.add(PLAN_REASON_CODES.UNRESOLVED_DEPENDENCIES);
	if (duplicateIds.length > 0) planReasonCodes.add(PLAN_REASON_CODES.DUPLICATE_REQUEST_IDENTITY);

	// -----------------------------------------------------------------------
	// 10. Prerequisites and evidence references
	// -----------------------------------------------------------------------
	const prerequisites = buildPrerequisites({
		impact,
		drift,
		blastRadius,
		blockedIds,
		unknownIds,
		confirmationIds,
		unresolvedIds,
		cycleIds,
		edgesByRequest,
		sortedCandidateIds,
		decisions,
	});

	const evidenceReferences = buildEvidenceReferences({
		impact,
		drift,
		blastRadius,
		workspaceId,
		snapshotId,
		snapshotFingerprint,
		source,
		target,
	});

	// -----------------------------------------------------------------------
	// 11. Identity
	// -----------------------------------------------------------------------
	// The fingerprint commits to the exact relevant inputs, in canonical sorted
	// form, so repeated identical input yields byte-stable output and input order
	// cannot affect the fingerprint.
	const planFingerprint = planIdentityOf({
		workspace: { workspaceId },
		snapshot: { snapshotId, snapshotFingerprint },
		source: { environmentId: source.environmentId, snapshotFingerprint: source.snapshotFingerprint },
		target: { environmentId: target.environmentId, snapshotFingerprint: target.snapshotFingerprint },
		impactedRequestIds: [...impactedIds].sort(comparePlanStrings),
		blastRadiusPolicyIdentity: blastRadius.policyIdentity,
		dependencyStructure: dependencyIds,
		executableRequestIds: [...executableIds].sort(comparePlanStrings),
		excludedRequestIds: [...excludedIds].sort(comparePlanStrings),
	});

	const result = {
		kind: REHEARSAL_PLAN_KIND,
		schemaVersion: REHEARSAL_PLAN_SCHEMA_VERSION,
		state,
		identity: {
			planFingerprint,
			fingerprintKeyId: planFingerprintKeyId(),
		},
		workspace: { workspaceId },
		snapshot: { snapshotId, snapshotFingerprint },
		source: { environmentId: source.environmentId, snapshotFingerprint: source.snapshotFingerprint },
		target: { environmentId: target.environmentId, snapshotFingerprint: target.snapshotFingerprint },
		impactedRequestIds: [...impactedIds].sort(comparePlanStrings),
		executableRequestIds: [...executableIds],
		excludedRequestIds: [...excludedIds],
		blockedRequestIds: [...blockedIds],
		unknownRequestIds: [...unknownIds],
		requiresConfirmationRequestIds: [...confirmationIds],
		unresolvedDependencyRequestIds: [...unresolvedIds],
		cycleRequestIds: [...cycleIds],
		dependencyIds,
		steps,
		excluded,
		cycles,
		blastRadius: {
			policyIdentity: blastRadius.policyIdentity,
			admissionState: blastRadius.admissionState,
		},
		reasonCodes: [...planReasonCodes].sort(comparePlanStrings),
		prerequisites,
		evidenceReferences,
		summary: {
			candidates: sortedCandidateIds.length,
			impacted: impactedIds.length,
			executable: executableIds.length,
			excluded: excluded.length,
			blocked: blockedIds.length,
			unknown: unknownIds.length,
			requiresConfirmation: confirmationIds.length,
			unresolvedDependencies: unresolvedIds.length,
			cycles: cycles.length,
			dependencyEdges: dependencyIds.length,
		},
	};

	return assertRehearsalPlanResult(result);
}

// ---------------------------------------------------------------------------
// Step assembly
// ---------------------------------------------------------------------------

// Build one executable step. A step carries safe display identity only: request
// id, collection id, normalized host identity, method, classification, and the
// blast-radius decision. It never carries a body, URL, query string, header, or
// credential — the planner is never given them.
function buildStep({ decision, candidate, ordinal, edgesByRequest, executableSet }) {
	const admission = decision.admission;
	const edges = edgesByRequest.get(decision.requestId) ?? [];
	const dependencies = edges
		.map((edge) => ({
			requestId: edge.requestId ?? null,
			marker: edge.marker ?? null,
			kind: edge.kind,
		}))
		.sort((left, right) => {
			const byKind = comparePlanStrings(left.kind, right.kind);
			if (byKind !== 0) return byKind;
			return comparePlanStrings(left.requestId ?? left.marker ?? "", right.requestId ?? right.marker ?? "");
		});

	// Dependents: executable requests that declare this request as a dependency.
	const dependents = [];
	for (const [requestId, requestEdges] of edgesByRequest) {
		if (!executableSet.has(requestId)) continue;
		if (requestEdges.some((edge) => edge.kind === DEPENDENCY_KINDS.RESOLVED && edge.target === decision.requestId)) {
			dependents.push(requestId);
		}
	}
	dependents.sort(comparePlanStrings);

	const reasonCodes = new Set(decision.reasonCodes);
	// An executable request whose direct host identity disagrees with the
	// blast-radius decision's host is surfaced, because the policy was evaluated
	// against a different identity. It is not silently rewritten.
	if (admission?.host && candidate.host && admission.host !== candidate.host) {
		reasonCodes.add(PLAN_REASON_CODES.BLAST_RADIUS_TARGET_MISMATCH);
	}

	return {
		stepId: `step:${decision.requestId}`,
		requestId: decision.requestId,
		collectionId: decision.collectionId,
		ordinal,
		state: decision.state,
		admitted: true,
		impact: decision.impactRow?.impact ?? null,
		confidence: decision.impactRow?.confidence ?? null,
		hop: decision.impactRow?.hop ?? null,
		host: admission?.host ?? candidate.host ?? null,
		hostKey: admission?.hostKey ?? null,
		port: admission?.port ?? candidate.port ?? null,
		method: admission?.method ?? candidate.method ?? null,
		mutationClassification: admission?.classification ?? null,
		mutating: admission?.mutating === true,
		blastRadiusAdmission: admission?.admission ?? null,
		dependencies,
		dependents,
		reasonCodes: [...reasonCodes].sort(comparePlanStrings),
	};
}

// ---------------------------------------------------------------------------
// Prerequisites / evidence
// ---------------------------------------------------------------------------

function buildPrerequisites({
	impact,
	drift,
	blastRadius,
	blockedIds,
	unknownIds,
	confirmationIds,
	unresolvedIds,
	cycleIds,
	edgesByRequest,
	sortedCandidateIds,
}) {
	const prerequisites = [];
	const push = (code, requestId, detail) => prerequisites.push({ code, requestId: requestId ?? null, detail: detail ?? null });

	if (!impact.present) push(PLAN_REASON_CODES.IMPACT_MISSING, null, "A change-impact result is required to determine the impacted set.");
	if (!drift.present) push(PLAN_REASON_CODES.DRIFT_MISSING, null, "An environment-drift result is required for a cross-environment plan.");
	if (!blastRadius.present) {
		push(PLAN_REASON_CODES.BLAST_RADIUS_MISSING, null, "A blast-radius envelope is required before anything may be admitted.");
	}
	for (const id of blockedIds) push(PLAN_REASON_CODES.BLAST_RADIUS_NOT_ADMITTED, id, "Blocked by the blast-radius policy.");
	for (const id of unknownIds) push(PLAN_REASON_CODES.UNKNOWN_SAFETY, id, "Safety could not be proven for this request.");
	for (const id of confirmationIds) push(PLAN_REASON_CODES.REQUIRES_CONFIRMATION, id, "Explicit human confirmation is required.");
	for (const id of cycleIds) push(PLAN_REASON_CODES.DEPENDENCY_CYCLE, id, "This request participates in a dependency cycle.");
	for (const id of unresolvedIds) {
		const edges = edgesByRequest.get(id) ?? [];
		const hasDynamic = edges.some((edge) => edge.kind === DEPENDENCY_KINDS.DYNAMIC);
		push(
			hasDynamic ? PLAN_REASON_CODES.DYNAMIC_DEPENDENCY_UNRESOLVED : PLAN_REASON_CODES.DEPENDENCY_TARGET_EXTERNAL,
			id,
			"An unresolved dependency prevents ordering this request.",
		);
	}

	prerequisites.sort((left, right) => {
		const byCode = comparePlanStrings(left.code, right.code);
		if (byCode !== 0) return byCode;
		return comparePlanStrings(left.requestId ?? "", right.requestId ?? "");
	});
	return prerequisites;
}

function buildEvidenceReferences({ impact, drift, blastRadius, workspaceId, snapshotId, snapshotFingerprint, source, target }) {
	const references = [];
	if (impact.present) references.push({ kind: "change-impact", ref: impact.resolved === null ? null : `resolved:${impact.resolved}` });
	if (drift.present) references.push({ kind: "environment-drift", ref: drift.identical === null ? null : `identical:${drift.identical}` });
	if (blastRadius.present) references.push({ kind: "blast-radius-policy", ref: blastRadius.policyIdentity });
	references.push({ kind: "workspace", ref: workspaceId });
	references.push({ kind: "snapshot", ref: snapshotFingerprint ?? snapshotId ?? null });
	references.push({ kind: "source-environment", ref: source.environmentId });
	references.push({ kind: "target-environment", ref: target.environmentId });
	references.sort((left, right) => {
		const byKind = comparePlanStrings(left.kind, right.kind);
		if (byKind !== 0) return byKind;
		return comparePlanStrings(left.ref ?? "", right.ref ?? "");
	});
	return references;
}
