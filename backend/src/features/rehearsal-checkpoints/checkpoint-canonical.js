import { fingerprintOf } from "../history/fingerprint.js";
import { REHEARSAL_CHECKPOINT_SCHEMA_VERSION, CHECKPOINT_LIMITS } from "./checkpoint-schema.js";
import { RUN_STATES, STEP_STATES } from "./reason-codes.js";
import { compareStrings } from "./ordering.js";
import { canonicalizeJson, identityBindings } from "./run-identity.js";

// Phase 46B — Deterministic checkpoint serialization.
//
// A checkpoint is the durable state a resume reads. Two checkpoints that describe
// the same progress must serialize to the same bytes even if their authors
// arrived by different routes, and two checkpoints that describe different
// progress must not. The canonical form is what the fingerprint commits to and
// what the crash-reconstruction read path validates.
//
// The canonical checkpoint deliberately excludes everything that is not progress
// or identity: no Mongo `_id`, no `createdAt`/`updatedAt`, no `__v`, no owner
// string. Those are metadata about the row, not about the run.

// The exact structure a checkpoint fingerprint commits to.
export function checkpointCanonicalForm(run) {
	const stepStates = [...(run.stepStates ?? [])]
		// A caller's insertion order must not change the canonical form, so step
		// states are sorted by step id. The plan order — which *is* meaningful — lives
		// in `plan.steps` and participates unchanged.
		.sort((left, right) => compareStrings(left.stepId, right.stepId))
		.map((entry) => ({ stepId: entry.stepId, state: entry.state }));

	const completedStepIds = [...(run.completedStepIds ?? [])].sort(compareStrings);

	return canonicalizeJson({
		schemaVersion: REHEARSAL_CHECKPOINT_SCHEMA_VERSION,
		identity: identityBindings(run.identity),
		plan: {
			steps: (run.plan?.steps ?? []).map((step) => ({ stepId: step.stepId, refId: step.refId ?? null })),
		},
		generation: run.generation,
		runState: run.runState,
		stepStates,
		completedStepIds,
		currentStepId: run.currentStepId ?? null,
		nextStepId: run.nextStepId ?? null,
		terminalReasonCode: run.terminalReasonCode ?? null,
	});
}

export function checkpointFingerprint(run) {
	return fingerprintOf({ kind: "rehearsal-checkpoint", checkpoint: JSON.parse(checkpointCanonicalForm(run)) });
}

// ---------------------------------------------------------------------------
// Step completion identity
// ---------------------------------------------------------------------------
//
// "Exactly-once completion accounting" needs an identity for a completion, so a
// repeated completion can be compared. Two completions of the same step are:
//
//   * identical   — same step, same resulting state, same outcome identity, same
//                   evidence — and the repeat is an idempotent no-op.
//   * contradictory — same step, different state or outcome identity — and the
//                     repeat is rejected, because the two claims cannot both be
//                     true and silently keeping one would lose the disagreement.

export function stepCompletionIdentity(stepId, state, outcome, evidenceRefs) {
	return {
		stepId,
		state,
		outcomeId: outcome?.outcomeId ?? null,
		metadata: outcome?.metadata ?? {},
		evidenceRefs: [...(evidenceRefs ?? [])].sort(compareStrings),
	};
}

// A completion's evidence is a *set*, not a sequence: the same evidence collected
// in a different order describes the same completion. The fingerprint therefore
// normalizes through `stepCompletionIdentity`, which sorts evidence references, so
// callers cannot produce two different fingerprints for one logical completion.
export function stepCompletionFingerprint(completion) {
	const normalized = stepCompletionIdentity(
		completion.stepId,
		completion.state,
		{ outcomeId: completion.outcomeId, metadata: completion.metadata },
		completion.evidenceRefs,
	);
	return fingerprintOf({ kind: "rehearsal-step-completion", completion: canonicalizeValueForFingerprint(normalized) });
}

// Canonicalize just enough for the completion fingerprint: the same key-sorting
// and undefined-dropping rules as the checkpoint, applied to a completion.
function canonicalizeValueForFingerprint(value) {
	if (Array.isArray(value)) return value.map(canonicalizeValueForFingerprint);
	if (value && typeof value === "object") {
		const output = {};
		for (const key of Object.keys(value).sort(compareStrings)) {
			if (value[key] === undefined) continue;
			output[key] = canonicalizeValueForFingerprint(value[key]);
		}
		return output;
	}
	return value;
}

// Compare a stored completion to an incoming one. Returns true when they describe
// the same outcome.
export function completionsAgree(stored, incoming) {
	return stepCompletionFingerprint(stored) === stepCompletionFingerprint(incoming);
}

// ---------------------------------------------------------------------------
// Derived pointers
// ---------------------------------------------------------------------------
//
// `currentStepId` is the step a worker is on (or was last on); `nextStepId` is the
// first unfinished step in plan order. Both are derived from the plan and the step
// states, never set by a caller, which is what keeps "next step" honest after a
// crash.

export function derivedPointers(plan, stepStates) {
	const terminal = new Set(
		stepStates.filter((entry) => entry.state === STEP_STATES.COMPLETED || entry.state === STEP_STATES.SKIPPED).map((entry) => entry.stepId),
	);
	const inProgress = stepStates.find((entry) => entry.state === STEP_STATES.IN_PROGRESS);
	const nextStepId = plan.steps.find((step) => !terminal.has(step.stepId))?.stepId ?? null;
	return {
		currentStepId: inProgress ? inProgress.stepId : null,
		nextStepId,
	};
}

// Build the full persisted step-state list for a fresh run: every plan step
// PENDING, in plan order.
export function initialStepStates(plan) {
	return plan.steps.map((step) => ({ stepId: step.stepId, state: STEP_STATES.PENDING, completion: null }));
}

// Guard the checkpoint's total serialized size. A checkpoint is bounded state, not
// a log, so an oversized one is a caller bug rather than something to truncate.
export function assertCheckpointSize(run) {
	const canonical = checkpointCanonicalForm(run);
	const bytes = Buffer.byteLength(canonical, "utf8");
	if (bytes > CHECKPOINT_LIMITS.maxSerializedBytes)
		throw Object.assign(new Error(`A checkpoint is limited to ${CHECKPOINT_LIMITS.maxSerializedBytes} bytes; this one is ${bytes}.`), {
			code: "REHEARSAL_CHECKPOINT_MALFORMED_INPUT",
			statusCode: 400,
		});
	return bytes;
}

// Whether a run state is terminal. Re-exported from the checkpoint canonical module
// so a reader of the canonical form can see the terminal vocabulary it references.
export function isTerminalCheckpointState(state) {
	return state === RUN_STATES.COMPLETED || state === RUN_STATES.ABORTED || state === RUN_STATES.FAILED;
}
