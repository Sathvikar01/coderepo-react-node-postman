import {
	PLAN_STATES,
	STEP_STATES,
	assertRehearsalPlanResult,
	blastRadiusIdentityMismatch,
	projectBlastRadius,
} from "../rehearsal-planning/index.js";
import { ADMISSION_STATES } from "../blast-radius-policy/index.js";
import { EXECUTOR_ERROR_CODES, executorError, parseSnapshotOverride } from "./executor-schema.js";

// Phase 46C — plan -> run binding derivation.
//
// Pure. It answers one question: "given the exact Phase 46A plan, the Phase 45A
// safety envelope it was built against, and the target environment identity, what
// immutable Phase 46B run identity and step plan describe this rehearsal?"
//
// Every identity field is either read from an upstream core or supplied by the
// caller. Nothing is invented: when a required identity token is missing, or two
// sources disagree, the derivation fails closed instead of guessing.

function identityError(code, message, details) {
	return executorError(409, code, message, details);
}

// Cross-check the executable steps against the plan's own claimed executable set.
// A plan whose `steps` and `executableRequestIds` disagree is internally
// inconsistent and cannot be executed safely.
function assertPlanInternallyConsistent(plan) {
	const steps = plan.steps ?? [];
	const excluded = plan.excluded ?? [];

	for (const step of steps) {
		if (step.state !== STEP_STATES.EXECUTABLE) {
			throw executorError(400, EXECUTOR_ERROR_CODES.PLAN_NOT_EXECUTABLE, "Every step in a plan's step list must be EXECUTABLE.", {
				stepId: step.stepId ?? null,
				state: step.state ?? null,
			});
		}
	}
	for (const entry of excluded) {
		if (entry.state === STEP_STATES.EXECUTABLE) {
			throw executorError(400, EXECUTOR_ERROR_CODES.PLAN_NOT_EXECUTABLE, "A plan cannot list an EXECUTABLE entry in its excluded set.", {
				requestId: entry.requestId ?? null,
			});
		}
	}

	const stepRequestIds = steps.map((step) => step.requestId);
	if (new Set(stepRequestIds).size !== stepRequestIds.length) {
		throw executorError(400, EXECUTOR_ERROR_CODES.PLAN_NOT_EXECUTABLE, "A plan cannot declare the same request as two steps.", {
			requestIds: stepRequestIds,
		});
	}

	const declared = [...(plan.executableRequestIds ?? [])].sort();
	const actual = [...stepRequestIds].sort();
	if (declared.length !== actual.length || declared.some((value, index) => value !== actual[index])) {
		throw executorError(400, EXECUTOR_ERROR_CODES.PLAN_NOT_EXECUTABLE, "A plan's executable request set does not match its step list.", {
			declared,
			actual,
		});
	}
}

// Resolve the snapshot identity from the plan plus an optional caller override.
// The override may complete a half-specified plan snapshot; it may never
// contradict one. Both fields are required by the 46B identity contract.
function resolveSnapshot(plan, override) {
	let snapshotId = plan.snapshot?.snapshotId ?? null;
	let snapshotFingerprint = plan.snapshot?.snapshotFingerprint ?? null;

	if (override) {
		if (override.snapshotId) {
			if (snapshotId && snapshotId !== override.snapshotId) {
				throw identityError(EXECUTOR_ERROR_CODES.IDENTITY_MISMATCH, "The supplied snapshot id contradicts the plan snapshot.", {
					field: "snapshot.snapshotId",
					plan: snapshotId,
					supplied: override.snapshotId,
				});
			}
			snapshotId = override.snapshotId;
		}
		if (override.snapshotFingerprint) {
			if (snapshotFingerprint && snapshotFingerprint !== override.snapshotFingerprint) {
				throw identityError(EXECUTOR_ERROR_CODES.IDENTITY_MISMATCH, "The supplied snapshot fingerprint contradicts the plan snapshot.", {
					field: "snapshot.snapshotFingerprint",
					plan: snapshotFingerprint,
					supplied: override.snapshotFingerprint,
				});
			}
			snapshotFingerprint = override.snapshotFingerprint;
		}
	}

	if (!snapshotId || !snapshotFingerprint) {
		throw executorError(
			409,
			EXECUTOR_ERROR_CODES.MISSING_IDENTITY,
			"A checkpointed rehearsal requires both a snapshot id and a snapshot fingerprint; the plan did not carry both and no override supplied the remainder.",
			{ snapshotId, snapshotFingerprint },
		);
	}
	return { snapshotId, snapshotFingerprint };
}

export function deriveRunBinding({ plan, blastRadius, environment, snapshot = null }) {
	// 46A owns the plan shape. A plan that does not pass its own contract check is
	// rejected by the core, so the executor never re-implements that validation.
	const parsedPlan = assertRehearsalPlanResult(plan);

	if (parsedPlan.state === PLAN_STATES.UNRESOLVED) {
		throw executorError(400, EXECUTOR_ERROR_CODES.PLAN_NOT_EXECUTABLE, "An UNRESOLVED plan cannot be executed.", {
			state: parsedPlan.state,
		});
	}

	const workspaceId = parsedPlan.workspace?.workspaceId ?? null;
	if (!workspaceId) {
		throw executorError(409, EXECUTOR_ERROR_CODES.MISSING_IDENTITY, "The plan does not carry a workspace identity.", {
			field: "workspace.workspaceId",
		});
	}

	const targetEnvironmentId = parsedPlan.target?.environmentId ?? null;
	if (!targetEnvironmentId) {
		throw executorError(409, EXECUTOR_ERROR_CODES.MISSING_IDENTITY, "The plan does not carry a target environment identity.", {
			field: "target.environmentId",
		});
	}

	// The caller's environment identity must describe the plan's target. A
	// mismatch means the caller is trying to rehearse a different environment
	// than the plan was built for.
	if (environment.environmentId !== targetEnvironmentId) {
		throw identityError(EXECUTOR_ERROR_CODES.IDENTITY_MISMATCH, "The supplied environment id is not the plan's target environment.", {
			field: "environment.environmentId",
			plan: targetEnvironmentId,
			supplied: environment.environmentId,
		});
	}

	const { snapshotId, snapshotFingerprint } = resolveSnapshot(parsedPlan, parseSnapshotOverride(snapshot));

	// A target side that carries its own snapshot fingerprint must agree with the
	// snapshot the run is bound to; otherwise the plan describes a different
	// version than the run would record.
	if (parsedPlan.target?.snapshotFingerprint && parsedPlan.target.snapshotFingerprint !== snapshotFingerprint) {
		throw identityError(EXECUTOR_ERROR_CODES.IDENTITY_MISMATCH, "The plan target's snapshot fingerprint disagrees with the resolved snapshot.", {
			field: "target.snapshotFingerprint",
			plan: parsedPlan.target.snapshotFingerprint,
			resolved: snapshotFingerprint,
		});
	}

	assertPlanInternallyConsistent(parsedPlan);

	const executableSteps = parsedPlan.steps ?? [];
	if (executableSteps.length === 0) {
		throw executorError(400, EXECUTOR_ERROR_CODES.PLAN_NOT_EXECUTABLE, "The plan admitted zero executable steps; there is nothing to rehearse.", {
			state: parsedPlan.state,
		});
	}
	if (executableSteps.length > 5000) {
		throw executorError(400, EXECUTOR_ERROR_CODES.PLAN_NOT_EXECUTABLE, "The plan exceeds the maximum executable step count.", {
			steps: executableSteps.length,
		});
	}

	// 45A owns the envelope shape. Its projection is the same adapter 46A used when
	// it built the plan, so the executor and the planner reason about one envelope.
	const projected = projectBlastRadius(blastRadius);
	if (!projected.present) {
		throw executorError(409, EXECUTOR_ERROR_CODES.BLAST_RADIUS_MISSING, "The supplied blast-radius envelope is not a recognizable Phase 45A result.", {
			field: "blastRadius",
		});
	}

	const mismatches = blastRadiusIdentityMismatch(projected, {
		workspaceId,
		snapshotId,
		snapshotFingerprint,
		targetEnvironmentId,
	});
	if (mismatches.length > 0) {
		throw identityError(EXECUTOR_ERROR_CODES.BLAST_RADIUS_MISMATCH, "The blast-radius envelope was evaluated against a different identity than the run.", {
			mismatches,
		});
	}

	const planPolicyIdentity = parsedPlan.blastRadius?.policyIdentity ?? null;
	if (planPolicyIdentity && projected.policyIdentity && planPolicyIdentity !== projected.policyIdentity) {
		throw identityError(EXECUTOR_ERROR_CODES.BLAST_RADIUS_MISMATCH, "The blast-radius policy identity disagrees with the plan's recorded policy identity.", {
			field: "policyIdentity",
			plan: planPolicyIdentity,
			envelope: projected.policyIdentity,
		});
	}

	// Defense in depth: every executable step must still be an ADMITTED request in
	// the envelope. A plan step that is not admitted (or is unknown / requires
	// confirmation) is never executed, regardless of what the plan claims.
	for (const step of executableSteps) {
		const entry = projected.byRequest.get(step.requestId) ?? null;
		if (!entry) {
			throw executorError(409, EXECUTOR_ERROR_CODES.STEP_NOT_ADMITTED, "An executable step is absent from the blast-radius envelope.", {
				stepId: step.stepId,
				requestId: step.requestId,
			});
		}
		if (entry.admission !== ADMISSION_STATES.ADMITTED) {
			throw executorError(409, EXECUTOR_ERROR_CODES.STEP_NOT_ADMITTED, "An executable step is not ADMITTED by the blast-radius envelope.", {
				stepId: step.stepId,
				requestId: step.requestId,
				admission: entry.admission,
			});
		}
	}

	const policyIdentity = planPolicyIdentity ?? projected.policyIdentity ?? null;

	// The plan fingerprint is the only plan identity the 46A core produces. It is
	// reused verbatim as both the run's plan id and its plan fingerprint; the
	// executor never mints a second, competing identity.
	const planFingerprint = parsedPlan.identity?.planFingerprint ?? null;
	if (!planFingerprint) {
		throw executorError(409, EXECUTOR_ERROR_CODES.MISSING_IDENTITY, "The plan does not carry a plan fingerprint.", {
			field: "identity.planFingerprint",
		});
	}

	const targetEnvironment = {
		environmentId: targetEnvironmentId,
		environmentFingerprint: environment.environmentFingerprint,
	};
	if (environment.environmentName) targetEnvironment.environmentName = environment.environmentName;

	const identity = {
		workspaceId,
		snapshotId,
		snapshotFingerprint,
		targetEnvironment,
		planId: planFingerprint,
		planFingerprint,
	};
	if (policyIdentity) {
		identity.policyId = policyIdentity;
		identity.policyFingerprint = policyIdentity;
	}

	// The 46B step list is the executable plan in execution order. Completed steps
	// are excluded from re-execution by 46B itself, not by re-deriving a shorter
	// plan here.
	const checkpointPlan = {
		steps: executableSteps.map((step) => ({ stepId: step.stepId, refId: step.requestId })),
	};

	return {
		plan: parsedPlan,
		identity,
		checkpointPlan,
		planFingerprint,
		policyIdentity,
		workspaceId,
		snapshotId,
		snapshotFingerprint,
		targetEnvironmentId,
		executableSteps,
		projected,
	};
}

// Look up an executable step by request id in the plan order. Returns null when
// the request is not part of this run.
export function stepByRequestId(binding, requestId) {
	return binding.executableSteps.find((step) => step.requestId === requestId) ?? null;
}
