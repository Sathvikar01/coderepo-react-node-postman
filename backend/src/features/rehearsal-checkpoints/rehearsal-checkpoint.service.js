import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import {
	REHEARSAL_CHECKPOINT_KIND,
	REHEARSAL_CHECKPOINT_SCHEMA_VERSION,
	CHECKPOINT_LIMITS,
	parseCreateRunInput,
	parseRunIdentity,
	parsePlan,
	parseClaimInput,
	parseCheckpointStepInput,
	parseStepClaimInput,
	parseAbortInput,
	parseFailInput,
	parseResumeInput,
	parseStoredRun,
	isCredentialShaped,
} from "./checkpoint-schema.js";
import { RUN_STATES, STEP_STATES, TERMINAL_RUN_STATES, REASON_CODES, CHECKPOINT_ERROR_CODES as CODES } from "./reason-codes.js";
import { assertTransition, isTerminalRunState, pendingSteps } from "./run-lifecycle.js";
import {
	identityDifferences,
	identityFingerprint,
	identityFingerprintKeyId,
	canonicalizeJson,
} from "./run-identity.js";
import {
	checkpointCanonicalForm,
	checkpointFingerprint,
	stepCompletionIdentity,
	stepCompletionFingerprint,
	completionsAgree,
	initialStepStates,
} from "./checkpoint-canonical.js";
import { checkpointRepository } from "./checkpoint.repository.js";

// Phase 46B — Rehearsal checkpoint service.
//
// Owns the semantics: identity binding, lifecycle transitions, generation/lease
// ownership, exactly-once step accounting, and crash-safe resume. The repository
// owns persistence and the CAS filters; the schema owns validation.
//
// The service is written against an injected repository so its behaviour can be
// exercised without a database, which is what makes the concurrency and
// idempotency rules testable in isolation and against real Mongo with the same
// code path.
//
// What this service deliberately does NOT do: execute HTTP, integrate with the
// Collection Runner, check contracts, or verify anything. It records and protects
// rehearsal progress.

function assertProfileId(ownerProfileId) {
	if (!ownerProfileId) throw new AppError(401, CODES.PROFILE_REQUIRED, "A profile is required to manage rehearsal checkpoints.");
	return String(ownerProfileId);
}

function newRunId() {
	return `run_${new mongoose.Types.ObjectId().toHexString()}`;
}

function resolveRunId(requested) {
	if (requested === undefined || requested === null) return newRunId();
	const value = String(requested).trim();
	if (!value) throw new AppError(400, CODES.MALFORMED_INPUT, "A run identifier cannot be empty.");
	return value;
}

// ---------------------------------------------------------------------------
// Persisted-state normalization
// ---------------------------------------------------------------------------
//
// The service reads and writes the same shape. These helpers convert between the
// lean Mongo document and the canonical run the rest of the service reasons about,
// so nothing downstream has to know about `_id` or Mongoose internals.

function normalizeStepStates(stepStates) {
	// A Mongoose lean read can hand back Mongoose subdocument wrappers for nested
	// arrays; normalize to plain objects so fingerprinting is byte-stable.
	return (stepStates ?? []).map((entry) => ({
		stepId: String(entry.stepId),
		state: String(entry.state),
		completion: entry.completion
			? {
					outcomeId: String(entry.completion.outcomeId),
					completionFingerprint: String(entry.completion.completionFingerprint),
					ownerGeneration: Number(entry.completion.ownerGeneration),
					metadata: entry.completion.metadata ?? {},
				}
			: null,
		attempt: {
			attempts: Number(entry.attempt?.attempts ?? 0),
			ownerGeneration: entry.attempt?.ownerGeneration ?? null,
			evidenceRefs: [...(entry.attempt?.evidenceRefs ?? [])].map(String),
		},
		lastReasonCode: entry.lastReasonCode ?? null,
	}));
}

function normalizeRun(document) {
	if (!document) return null;
	const stepStates = normalizeStepStates(document.stepStates);
	return {
		id: String(document._id ?? document.id),
		ownerProfileId: String(document.ownerProfileId),
		runId: String(document.runId),
		schemaVersion: document.schemaVersion ?? REHEARSAL_CHECKPOINT_SCHEMA_VERSION,
		kind: document.kind ?? REHEARSAL_CHECKPOINT_KIND,
		identity: {
			workspaceId: String(document.identity.workspaceId),
			snapshotId: String(document.identity.snapshotId),
			snapshotFingerprint: String(document.identity.snapshotFingerprint),
			targetEnvironment: {
				environmentId: String(document.identity.targetEnvironment.environmentId),
				environmentName: document.identity.targetEnvironment.environmentName ?? null,
				environmentFingerprint: String(document.identity.targetEnvironment.environmentFingerprint),
			},
			planId: String(document.identity.planId),
			planFingerprint: String(document.identity.planFingerprint),
			policyId: document.identity.policyId ?? null,
			policyFingerprint: document.identity.policyFingerprint ?? null,
		},
		identityFingerprint: String(document.identityFingerprint),
		plan: { steps: (document.plan?.steps ?? []).map((step) => ({ stepId: String(step.stepId), refId: step.refId ?? null })) },
		planFingerprint: String(document.planFingerprint),
		runState: String(document.runState),
		generation: Number(document.generation),
		owner: document.owner ?? null,
		lastOwnerGeneration: Number(document.lastOwnerGeneration ?? document.generation ?? 1),
		stepStates,
		completedStepIds: [...(document.completedStepIds ?? [])].map(String),
		currentStepId: document.currentStepId ?? null,
		nextStepId: document.nextStepId ?? null,
		terminalReasonCode: document.terminalReasonCode ?? null,
		terminalReason: document.terminalReason ?? null,
		label: document.label ?? null,
		createdAt: document.createdAt ?? null,
		updatedAt: document.updatedAt ?? null,
	};
}

// A compact, presentation-safe projection. Identity fingerprints are included
// because they are identities, not secrets; owner generation metadata is included
// so a caller can reason about leases without reading the whole step list.
export function presentRun(run) {
	if (!run) return null;
	return {
		runId: run.runId,
		kind: run.kind,
		schemaVersion: run.schemaVersion,
		runState: run.runState,
		generation: run.generation,
		owner: run.owner,
		lastOwnerGeneration: run.lastOwnerGeneration,
		identity: {
			workspaceId: run.identity.workspaceId,
			snapshotId: run.identity.snapshotId,
			snapshotFingerprint: run.identity.snapshotFingerprint,
			environmentId: run.identity.targetEnvironment.environmentId,
			environmentFingerprint: run.identity.targetEnvironment.environmentFingerprint,
			planId: run.identity.planId,
			planFingerprint: run.identity.planFingerprint,
			policyId: run.identity.policyId,
			policyFingerprint: run.identity.policyFingerprint,
		},
		identityFingerprint: run.identityFingerprint,
		stepCount: run.plan.steps.length,
		completedStepIds: [...run.completedStepIds].sort(),
		pendingStepIds: pendingSteps(run.plan, run.stepStates),
		currentStepId: run.currentStepId,
		nextStepId: run.nextStepId,
		terminalReasonCode: run.terminalReasonCode,
		terminalReason: run.terminalReason,
		checkpointFingerprint: checkpointFingerprint(run),
		label: run.label,
	};
}

// ---------------------------------------------------------------------------
// Typed error helpers
// ---------------------------------------------------------------------------

function specError(statusCode, code, message, details) {
	return new AppError(statusCode, code, message, details);
}

function isDuplicateKeyError(error) {
	return Boolean(error) && (error.code === 11000 || error.code === 11001);
}

export function createRehearsalCheckpointService({ repository = checkpointRepository, now = () => new Date() } = {}) {
	// -----------------------------------------------------------------------
	// Read
	// -----------------------------------------------------------------------
	async function requireRun(profileId, runId) {
		const stored = await repository.findByRunId(profileId, runId);
		if (!stored) throw specError(404, CODES.NOT_FOUND, `Rehearsal run "${runId}" does not exist.`, { runId });
		return normalizeRun(stored);
	}

	async function getRun(ownerProfileId, runId) {
		const profileId = assertProfileId(ownerProfileId);
		return normalizeRun(await repository.findByRunId(profileId, runId));
	}

	async function listRuns(ownerProfileId, options = {}) {
		const profileId = assertProfileId(ownerProfileId);
		return (await repository.listForProfile(profileId, options)).map(normalizeRun);
	}

	async function listResumable(ownerProfileId) {
		const profileId = assertProfileId(ownerProfileId);
		return (await repository.listResumable(profileId)).map(normalizeRun);
	}

	// -----------------------------------------------------------------------
	// Create
	// -----------------------------------------------------------------------
	async function createRun(ownerProfileId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseCreateRunInput(input);

		const runId = resolveRunId(parsed.runId);
		const identity = parsed.identity;
		const plan = parsed.plan;

		const identityFp = identityFingerprint(identity);
		// The persisted plan fingerprint is the identity's declared plan fingerprint. The
		// step list is the caller's claim about that plan's contents and is checked for
		// structural consistency with the identity below; there is no second,
		// independently invented fingerprint here that could disagree with the identity.
		const planFp = identity.planFingerprint;

		const document = {
			ownerProfileId: profileId,
			runId,
			schemaVersion: REHEARSAL_CHECKPOINT_SCHEMA_VERSION,
			kind: REHEARSAL_CHECKPOINT_KIND,
			identity: {
				workspaceId: identity.workspaceId,
				snapshotId: identity.snapshotId,
				snapshotFingerprint: identity.snapshotFingerprint,
				targetEnvironment: {
					environmentId: identity.targetEnvironment.environmentId,
					environmentName: identity.targetEnvironment.environmentName ?? null,
					environmentFingerprint: identity.targetEnvironment.environmentFingerprint,
				},
				planId: identity.planId,
				planFingerprint: identity.planFingerprint,
				policyId: identity.policyId ?? null,
				policyFingerprint: identity.policyFingerprint ?? null,
			},
			identityFingerprint: identityFp,
			identityFingerprintKeyId: identityFingerprintKeyId(),
			plan: { steps: plan.steps.map((step) => ({ stepId: step.stepId, refId: step.refId ?? null })) },
			// The persisted plan fingerprint is the identity's plan fingerprint: the
			// plan identity is the caller's claim, and the step list is validated to be
			// consistent with it below.
			planFingerprint: planFp,
			runState: RUN_STATES.CREATED,
			generation: 1,
			owner: null,
			lastOwnerGeneration: 1,
			stepStates: initialStepStates(plan),
			completedStepIds: [],
			currentStepId: null,
			nextStepId: plan.steps[0]?.stepId ?? null,
			terminalReasonCode: null,
			terminalReason: null,
			label: parsed.label ?? null,
		};

		try {
			const created = await repository.insertRun(document);
			return normalizeRun(created.toObject ? created.toObject() : created);
		} catch (error) {
			// A duplicate (profile, runId) is a "this run already exists" conflict, not a
			// database failure. Deterministic typed error so a caller can branch on it.
			if (isDuplicateKeyError(error))
				throw specError(409, CODES.DUPLICATE_RUN, `Rehearsal run "${runId}" already exists.`, { runId });
			throw error;
		}
	}

	// Idempotent create: an existing run with the *same identity and plan* is
	// returned rather than duplicated, and a run with a different identity under the
	// same id is refused. This is what makes a retried create safe.
	async function ensureRun(ownerProfileId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseCreateRunInput(input);
		const runId = resolveRunId(parsed.runId);
		const existing = await repository.findByRunId(profileId, runId);
		if (!existing) return { created: true, run: await createRun(profileId, { ...input, runId }) };

		const current = normalizeRun(existing);
		const differences = identityDifferences(current.identity, parsed.identity);
		if (differences.length > 0)
			throw specError(409, CODES.IDENTITY_CONFLICT, `Rehearsal run "${runId}" already exists with a different identity.`, {
				runId,
				differences,
			});
		const storedSteps = current.plan.steps.map((step) => step.stepId);
		const requestedSteps = parsed.plan.steps.map((step) => step.stepId);
		if (canonicalizeJson(storedSteps) !== canonicalizeJson(requestedSteps))
			throw specError(409, CODES.IDENTITY_CONFLICT, `Rehearsal run "${runId}" already exists with a different plan.`, {
				runId,
				differences: ["plan.steps"],
			});
		return { created: false, run: current };
	}

	// -----------------------------------------------------------------------
	// Claim / start
	// -----------------------------------------------------------------------
	//
	// Claiming advances the generation. It is the ONLY way ownership changes, and it
	// is the operation that makes a stale worker stale.
	async function claimRun(ownerProfileId, runId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseClaimInput(input);
		const current = await requireRun(profileId, runId);

		if (isTerminalRunState(current.runState))
			throw specError(409, CODES.TERMINAL_STATE, `A ${current.runState} run cannot be claimed.`, { runId, runState: current.runState });

		// The expected generation is the caller's CAS token. `null` means "the first
		// claim", which is only honoured from CREATED, so an unowned expectation cannot
		// steal a run that already has an owner.
		//
		// The stored generation in CREATED is already `1`, so the first claim presents
		// the *current* generation and the atomic write advances it to `2`. A `null`
		// expectation from any other state is a refusal — never a synthesized `0`, which
		// could never match and would make the retry case unrecoverable.
		const firstClaim = parsed.expectedGeneration === null;
		if (firstClaim && current.runState !== RUN_STATES.CREATED)
			throw specError(409, CODES.STALE_GENERATION, `Rehearsal run "${runId}" is already owned; claim it with its current generation.`, {
				runId,
				generation: current.generation,
			});
		const from = firstClaim ? current.generation : parsed.expectedGeneration;

		const toState = RUN_STATES.RUNNING;
		const claimed = await repository.claim(profileId, runId, { from, owner: parsed.owner, toState });
		if (!claimed)
			throw specError(409, CODES.STALE_GENERATION, `Rehearsal run "${runId}" could not be claimed: the expected generation is not current.`, {
				runId,
				expectedGeneration: from,
			});
		return normalizeRun(claimed);
	}

	// `startRun` is `claimRun` with the intent made explicit and the expected
	// generation defaulted from a fresh read, so a caller in the normal
	// single-worker case does not have to track it by hand.
	async function startRun(ownerProfileId, runId, { owner }) {
		const profileId = assertProfileId(ownerProfileId);
		const current = await requireRun(profileId, runId);
		if (current.runState === RUN_STATES.RUNNING) return current;
		return claimRun(profileId, runId, { owner, expectedGeneration: current.generation });
	}

	// -----------------------------------------------------------------------
	// Checkpoint a step — exactly-once accounting
	// -----------------------------------------------------------------------
	//
	// The rules, in order:
	//
	//   1. Identity and generation are checked first. A stale generation is refused
	//      before any step logic runs, so a stale worker cannot even observe a
	//      step's state transition.
	//   2. If the step is already COMPLETED/SKIPPED with the *same* completion
	//      identity, the write is an idempotent no-op and the repeat is reported.
	//   3. If the step is already terminal with a *different* completion identity,
	//      the write is refused as contradictory.
	//   4. If the step is still PENDING or IN_PROGRESS, the write advances it via a
	//      single atomic, per-step-CAS update.
	async function checkpointStep(ownerProfileId, runId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseCheckpointStepInput(input);
		const current = await requireRun(profileId, runId);

		// (1) generation guard
		assertGeneration(current, parsed.generation, runId);
		assertOwned(current, parsed.owner, runId);
		if (isTerminalRunState(current.runState))
			throw specError(409, CODES.TERMINAL_STATE, `A ${current.runState} run cannot accept step checkpoints.`, {
				runId,
				runState: current.runState,
			});

		// Identity binding is re-verified on every write: a caller must not be able to
		// checkpoint progress against a run it no longer matches.
		assertIdentityBinding(current, input.identity);

		const step = current.stepStates.find((entry) => entry.stepId === parsed.stepId);
		if (!step) throw specError(404, CODES.STEP_NOT_FOUND, `Step "${parsed.stepId}" is not part of this run's plan.`, { runId, stepId: parsed.stepId });

		const incomingCompletion = stepCompletionIdentity(parsed.stepId, parsed.state, parsed.outcome, parsed.evidenceRefs);
		const incomingFingerprint = stepCompletionFingerprint(incomingCompletion);

		// (2) idempotent identical repeat
		if (step.completion && (step.state === STEP_STATES.COMPLETED || step.state === STEP_STATES.SKIPPED)) {
			const stored = {
				stepId: step.stepId,
				state: step.state,
				outcomeId: step.completion.outcomeId,
				metadata: step.completion.metadata ?? {},
				evidenceRefs: step.attempt.evidenceRefs ?? [],
			};
			if (completionsAgree(stored, incomingCompletion)) {
				return { run: current, idempotent: true, stepId: parsed.stepId, completionFingerprint: incomingFingerprint };
			}
			// (3) contradictory repeat
			throw specError(409, CODES.STEP_CONTRADICTORY, `Step "${parsed.stepId}" was already completed with a different outcome.`, {
				runId,
				stepId: parsed.stepId,
				storedOutcomeId: step.completion.outcomeId,
				incomingOutcomeId: parsed.outcome?.outcomeId ?? null,
				storedState: step.state,
				incomingState: parsed.state,
			});
		}

		// A step that already FAILED is terminal for the step; a later "completion"
		// cannot silently overwrite a recorded failure.
		if (step.state === STEP_STATES.FAILED)
			throw specError(409, CODES.STEP_CONTRADICTORY, `Step "${parsed.stepId}" already failed and cannot be completed.`, {
				runId,
				stepId: parsed.stepId,
				storedState: step.state,
				incomingState: parsed.state,
			});

		// (4) Advance the step. The per-step CAS requires the step to still be in the
		// state this caller observed, so two workers checkpointing the same step race on
		// the database and exactly one wins.
		//
		// The derived fields (`completedStepIds`, `currentStepId`, `nextStepId`) are NOT
		// computed here. They are derived inside the atomic write from the step array
		// *after* the change, so a concurrent checkpoint of a different step cannot have
		// its progress erased by a list computed from this caller's stale read.
		const updated = await repository.checkpointStep(profileId, runId, {
			generation: parsed.generation,
			owner: parsed.owner,
			stepId: parsed.stepId,
			fromStepStates: [STEP_STATES.PENDING, STEP_STATES.IN_PROGRESS],
			changes: {
				stepState: parsed.state,
				completion: {
					outcomeId: parsed.outcome?.outcomeId ?? `${parsed.stepId}:${parsed.state.toLowerCase()}`,
					completionFingerprint: incomingFingerprint,
					ownerGeneration: parsed.generation,
					metadata: parsed.outcome?.metadata ?? {},
				},
				attempt: {
					attempts: step.attempt.attempts + 1,
					ownerGeneration: parsed.generation,
					evidenceRefs: [...parsed.evidenceRefs],
				},
				lastReasonCode: null,
			},
		});

		if (!updated)
			throw specError(409, CODES.STEP_NOT_PENDING, `Step "${parsed.stepId}" is not in a state that can be checkpointed.`, {
				runId,
				stepId: parsed.stepId,
			});

		return { run: normalizeRun(updated), idempotent: false, stepId: parsed.stepId, completionFingerprint: incomingFingerprint };
	}

	// -----------------------------------------------------------------------
	// Step claim / release
	// -----------------------------------------------------------------------
	//
	// These are the in-flight markers a rehearsal executor uses around a dispatch.
	// `beginStep` records "a worker is about to send this request" before the send;
	// `releaseStep` clears it when the worker aborts the send (cancel/deadline) so no
	// ambiguous side effect is implied. A step left IN_PROGRESS by a crashed worker
	// is detectable on resume, which is what stops a mutating request from being
	// blindly replayed.
	async function beginStep(ownerProfileId, runId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseStepClaimInput(input);
		const current = await requireRun(profileId, runId);

		assertGeneration(current, parsed.generation, runId);
		assertOwned(current, parsed.owner, runId);
		if (isTerminalRunState(current.runState))
			throw specError(409, CODES.TERMINAL_STATE, `A ${current.runState} run cannot accept step claims.`, {
				runId,
				runState: current.runState,
			});
		assertIdentityBinding(current, parsed.identity);

		const step = current.stepStates.find((entry) => entry.stepId === parsed.stepId);
		if (!step) throw specError(404, CODES.STEP_NOT_FOUND, `Step "${parsed.stepId}" is not part of this run's plan.`, { runId, stepId: parsed.stepId });

		// Idempotent re-claim by the same owner/generation (e.g. a retried call inside
		// one generation) is a no-op; any other non-PENDING state is a hard conflict.
		if (step.state === STEP_STATES.IN_PROGRESS && step.attempt.ownerGeneration === parsed.generation) {
			return { run: current, idempotent: true, stepId: parsed.stepId };
		}
		if (step.state !== STEP_STATES.PENDING)
			throw specError(409, CODES.STEP_NOT_PENDING, `Step "${parsed.stepId}" is ${step.state} and cannot be claimed.`, {
				runId,
				stepId: parsed.stepId,
				storedState: step.state,
			});

		const updated = await repository.beginStep(profileId, runId, {
			generation: parsed.generation,
			owner: parsed.owner,
			stepId: parsed.stepId,
			fromStepStates: [STEP_STATES.PENDING],
		});
		if (!updated)
			throw specError(409, CODES.STEP_NOT_PENDING, `Step "${parsed.stepId}" is no longer claimable.`, { runId, stepId: parsed.stepId });

		return { run: normalizeRun(updated), idempotent: false, stepId: parsed.stepId };
	}

	async function releaseStep(ownerProfileId, runId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseStepClaimInput(input);
		const current = await requireRun(profileId, runId);

		assertGeneration(current, parsed.generation, runId);
		assertOwned(current, parsed.owner, runId);
		if (isTerminalRunState(current.runState))
			throw specError(409, CODES.TERMINAL_STATE, `A ${current.runState} run cannot accept step releases.`, {
				runId,
				runState: current.runState,
			});
		assertIdentityBinding(current, parsed.identity);

		const step = current.stepStates.find((entry) => entry.stepId === parsed.stepId);
		if (!step) throw specError(404, CODES.STEP_NOT_FOUND, `Step "${parsed.stepId}" is not part of this run's plan.`, { runId, stepId: parsed.stepId });

		// Releasing an already-PENDING step is an idempotent no-op; releasing a
		// terminal step is a conflict (its outcome is already recorded).
		if (step.state === STEP_STATES.PENDING) return { run: current, idempotent: true, stepId: parsed.stepId };
		if (step.state !== STEP_STATES.IN_PROGRESS)
			throw specError(409, CODES.STEP_NOT_PENDING, `Step "${parsed.stepId}" is ${step.state} and cannot be released.`, {
				runId,
				stepId: parsed.stepId,
				storedState: step.state,
			});

		const updated = await repository.releaseStep(profileId, runId, {
			generation: parsed.generation,
			owner: parsed.owner,
			stepId: parsed.stepId,
			fromStepStates: [STEP_STATES.IN_PROGRESS],
		});
		if (!updated)
			throw specError(409, CODES.STEP_NOT_PENDING, `Step "${parsed.stepId}" is no longer in progress.`, { runId, stepId: parsed.stepId });

		return { run: normalizeRun(updated), idempotent: false, stepId: parsed.stepId };
	}

	// -----------------------------------------------------------------------
	// Pause
	// -----------------------------------------------------------------------
	async function pauseRun(ownerProfileId, runId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseResumeInput(input);
		const current = await requireRun(profileId, runId);
		assertGeneration(current, parsed.expectedGeneration, runId);
		assertOwned(current, parsed.owner, runId);
		assertTransition(current.runState, RUN_STATES.PAUSED);
		assertIdentityBinding(current, parsed.identity);

		const paused = await repository.pause(profileId, runId, { generation: parsed.expectedGeneration, owner: parsed.owner });
		if (!paused)
			throw specError(409, CODES.STALE_GENERATION, `Rehearsal run "${runId}" could not be paused: ownership changed.`, {
				runId,
				generation: parsed.expectedGeneration,
			});
		return normalizeRun(paused);
	}

	// -----------------------------------------------------------------------
	// Resume — crash-safe, binding-checked
	// -----------------------------------------------------------------------
	//
	// Resume is the operation the whole phase exists for. It performs, in order:
	//
	//   1. Terminal-state check. A terminal run cannot resume.
	//   2. Identity binding check, field by field. Snapshot/environment/plan/policy
	//      mismatches are refused with the exact differing fields.
	//   3. Generation check via the atomic claim. A resume that assumed a stale
	//      generation loses to a concurrent resume.
	//   4. Pending-work computation. Completed steps are excluded from what is
	//      returned as work, so a caller cannot re-schedule finished work by accident.
	async function resumeRun(ownerProfileId, runId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseResumeInput(input);
		const current = await requireRun(profileId, runId);

		if (isTerminalRunState(current.runState))
			throw specError(409, CODES.TERMINAL_STATE, `A ${current.runState} run cannot be resumed.`, {
				runId,
				runState: current.runState,
			});

		assertIdentityBinding(current, parsed.identity);

		if (current.runState === RUN_STATES.RUNNING && current.owner === parsed.owner && current.generation === parsed.expectedGeneration) {
			// Re-entrant resume by the current owner: no generation change, but the
			// caller still gets an accurate pending-work view.
			return { run: current, resumed: false, pendingStepIds: pendingSteps(current.plan, current.stepStates) };
		}

		assertTransition(current.runState, RUN_STATES.RUNNING);

		const claimed = await repository.claim(profileId, runId, {
			from: parsed.expectedGeneration,
			owner: parsed.owner,
			toState: RUN_STATES.RUNNING,
		});
		if (!claimed)
			throw specError(409, CODES.STALE_GENERATION, `Rehearsal run "${runId}" could not be resumed: the expected generation is not current.`, {
				runId,
				expectedGeneration: parsed.expectedGeneration,
			});

		const resumed = normalizeRun(claimed);
		return { run: resumed, resumed: true, pendingStepIds: pendingSteps(resumed.plan, resumed.stepStates) };
	}

	// -----------------------------------------------------------------------
	// Terminal transitions
	// -----------------------------------------------------------------------
	async function completeRun(ownerProfileId, runId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseResumeInput(input);
		const current = await requireRun(profileId, runId);
		// Terminal protection comes first: a finished run is finished regardless of how
		// much of its work was completed.
		if (isTerminalRunState(current.runState))
			throw specError(409, CODES.TERMINAL_STATE, `A ${current.runState} run cannot be completed again.`, {
				runId,
				runState: current.runState,
			});
		assertGeneration(current, parsed.expectedGeneration, runId);
		assertOwned(current, parsed.owner, runId);
		assertIdentityBinding(current, parsed.identity);

		// A run may only complete when every step has reached a terminal step state.
		// Reporting "completed" over unfinished work would make resume lie.
		const unfinished = pendingSteps(current.plan, current.stepStates);
		if (unfinished.length > 0)
			throw specError(409, CODES.INVALID_TRANSITION, `Rehearsal run "${runId}" still has ${unfinished.length} unfinished step(s).`, {
				runId,
				pendingStepIds: unfinished,
			});
		assertTransition(current.runState, RUN_STATES.COMPLETED);

		const completed = await repository.markTerminal(profileId, runId, {
			generation: parsed.expectedGeneration,
			owner: parsed.owner,
			fromStates: [RUN_STATES.CREATED, RUN_STATES.RUNNING, RUN_STATES.PAUSED],
			toState: RUN_STATES.COMPLETED,
			fields: { completedAt: now(), terminalReasonCode: REASON_CODES.OPERATOR_REQUESTED, terminalReason: null, nextStepId: null, currentStepId: null },
		});
		if (!completed)
			throw specError(409, CODES.STALE_GENERATION, `Rehearsal run "${runId}" could not be completed: ownership changed.`, {
				runId,
				generation: parsed.expectedGeneration,
			});
		return normalizeRun(completed);
	}

	async function abortRun(ownerProfileId, runId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseAbortInput(input);
		const current = await requireRun(profileId, runId);
		assertGeneration(current, parsed.generation, runId);
		assertOwned(current, parsed.owner, runId);
		assertTransition(current.runState, RUN_STATES.ABORTED);

		const aborted = await repository.markTerminal(profileId, runId, {
			generation: parsed.generation,
			owner: parsed.owner,
			fromStates: [RUN_STATES.CREATED, RUN_STATES.RUNNING, RUN_STATES.PAUSED],
			toState: RUN_STATES.ABORTED,
			fields: {
				abortedAt: now(),
				terminalReasonCode: parsed.reasonCode,
				terminalReason: parsed.reason ?? null,
				nextStepId: null,
				currentStepId: null,
			},
		});
		if (!aborted)
			throw specError(409, CODES.STALE_GENERATION, `Rehearsal run "${runId}" could not be aborted: ownership changed.`, {
				runId,
				generation: parsed.generation,
			});
		return normalizeRun(aborted);
	}

	async function failRun(ownerProfileId, runId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseFailInput(input);
		const current = await requireRun(profileId, runId);
		assertGeneration(current, parsed.generation, runId);
		assertOwned(current, parsed.owner, runId);
		assertTransition(current.runState, RUN_STATES.FAILED);

		const failed = await repository.markTerminal(profileId, runId, {
			generation: parsed.generation,
			owner: parsed.owner,
			fromStates: [RUN_STATES.CREATED, RUN_STATES.RUNNING, RUN_STATES.PAUSED],
			toState: RUN_STATES.FAILED,
			fields: {
				failedAt: now(),
				terminalReasonCode: parsed.reasonCode,
				terminalReason: parsed.reason ?? null,
				nextStepId: null,
				currentStepId: null,
			},
		});
		if (!failed)
			throw specError(409, CODES.STALE_GENERATION, `Rehearsal run "${runId}" could not be failed: ownership changed.`, {
				runId,
				generation: parsed.generation,
			});
		return normalizeRun(failed);
	}

	// -----------------------------------------------------------------------
	// Crash-style reconstruction
	// -----------------------------------------------------------------------
	//
	// Rebuild the exact state a restart must act on, purely from persisted state.
	// This deliberately re-reads the document rather than trusting an in-memory
	// value, so a caller that just came back from a crash gets the truth.
	async function reconstruct(ownerProfileId, runId) {
		const profileId = assertProfileId(ownerProfileId);
		const stored = await repository.findByRunId(profileId, runId);
		if (!stored) throw specError(404, CODES.NOT_FOUND, `Rehearsal run "${runId}" does not exist.`, { runId });
		const run = normalizeRun(stored);

		// Validate that what was persisted is internally consistent before handing it
		// back. A checkpoint the read path cannot vouch for must fail closed.
		const validation = validateReconstructed(run);
		if (!validation.valid)
			throw specError(500, CODES.MALFORMED_INPUT, `Persisted checkpoint for run "${runId}" is inconsistent.`, {
				runId,
				problems: validation.problems,
			});

		return {
			run,
			canonical: checkpointCanonicalForm(run),
			fingerprint: checkpointFingerprint(run),
			terminal: isTerminalRunState(run.runState),
			pendingStepIds: pendingSteps(run.plan, run.stepStates),
			completedStepIds: run.completedStepIds,
		};
	}

	// Verify a reconstructed run against its own invariants. This is the "did the
	// crash leave us something coherent" check.
	function validateReconstructed(run) {
		const problems = [];

		if (run.completedStepIds.length !== new Set(run.completedStepIds).size)
			problems.push("completedStepIds contains duplicates");

		const stepIds = run.plan.steps.map((step) => step.stepId);
		if (new Set(stepIds).size !== stepIds.length) problems.push("plan contains duplicate step ids");

		const known = new Set(stepIds);
		for (const entry of run.stepStates) {
			if (!known.has(entry.stepId)) problems.push(`stepStates references unknown step "${entry.stepId}"`);
		}
		// Every plan step must have exactly one accounting entry.
		const accounted = new Set(run.stepStates.map((entry) => entry.stepId));
		for (const stepId of stepIds) {
			if (!accounted.has(stepId)) problems.push(`plan step "${stepId}" has no accounting entry`);
		}
		// A COMPLETED step must carry a completion identity, and every completed step
		// id must correspond to a COMPLETED/SKIPPED step state.
		for (const entry of run.stepStates) {
			if ((entry.state === STEP_STATES.COMPLETED || entry.state === STEP_STATES.SKIPPED) && !entry.completion)
				problems.push(`step "${entry.stepId}" is ${entry.state} without a completion record`);
		}
		for (const stepId of run.completedStepIds) {
			const entry = run.stepStates.find((candidate) => candidate.stepId === stepId);
			if (!entry) problems.push(`completedStepIds references unknown step "${stepId}"`);
			else if (entry.state !== STEP_STATES.COMPLETED && entry.state !== STEP_STATES.SKIPPED)
				problems.push(`completedStepIds lists "${stepId}" but its state is ${entry.state}`);
		}
		// A terminal run must carry a terminal reason code.
		if (isTerminalRunState(run.runState) && !run.terminalReasonCode) problems.push(`terminal run ${run.runState} has no reason code`);
		// Generation must be a positive integer.
		if (!Number.isInteger(run.generation) || run.generation < 1) problems.push("generation is not a positive integer");

		return { valid: problems.length === 0, problems };
	}

	// -----------------------------------------------------------------------
	// Maintenance
	// -----------------------------------------------------------------------
	async function deleteRun(ownerProfileId, runId) {
		const profileId = assertProfileId(ownerProfileId);
		const deleted = await repository.deleteRun(profileId, runId);
		return normalizeRun(deleted);
	}

	async function cleanupTerminal(ownerProfileId, { olderThanMs = 24 * 60 * 60 * 1000 } = {}) {
		const profileId = assertProfileId(ownerProfileId);
		const cutoff = new Date(now().getTime() - olderThanMs);
		const result = await repository.deleteTerminalBefore(profileId, cutoff);
		return { deletedCount: result.deletedCount ?? result?.deletedCount ?? 0, cutoff };
	}

	return {
		createRun,
		ensureRun,
		getRun,
		listRuns,
		listResumable,
		claimRun,
		startRun,
		beginStep,
		releaseStep,
		checkpointStep,
		pauseRun,
		resumeRun,
		completeRun,
		abortRun,
		failRun,
		reconstruct,
		deleteRun,
		cleanupTerminal,
		// exposed for tests and for a future rehearsal executor that must compute the
		// same derived view without a round trip
		presentRun,
	};
}

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

function assertGeneration(run, generation, runId) {
	if (run.generation !== generation)
		throw new AppError(409, CODES.STALE_GENERATION, `Rehearsal run "${runId}" is owned by generation ${run.generation}, not ${generation}.`, {
			runId,
			storedGeneration: run.generation,
			presentedGeneration: generation,
		});
}

function assertOwned(run, owner, runId) {
	if (run.owner !== owner)
		throw new AppError(409, CODES.LEASE_NOT_HELD, `Rehearsal run "${runId}" is owned by "${run.owner ?? "(none)"}", not "${owner}".`, {
			runId,
			storedOwner: run.owner,
			presentedOwner: owner,
		});
}

// Check that an identity supplied with a mutating call matches the stored identity.
// A call that does not carry an identity is fine — the generation guard already
// proves the caller is the current owner. A call that *does* carry one must be
// right, because a caller asserting an identity it does not match is a bug.
function assertIdentityBinding(run, identity) {
	if (!identity) return;
	const parsed = parseRunIdentity(identity);
	const differences = identityDifferences(run.identity, parsed);
	if (differences.length > 0)
		throw new AppError(409, CODES.IDENTITY_CONFLICT, "The supplied run identity does not match the stored run identity.", {
			runId: run.runId,
			differences,
		});
}

// Re-export a couple of internals used by the focused unit tests without a
// database, so the unit tests and the persistence tests share one implementation.
export const __internal = {
	normalizeRun,
	normalizeStepStates,
	assertGeneration,
	assertOwned,
	assertIdentityBinding,
	pendingSteps,
	identityDifferences,
	isCredentialShaped,
	CHECKPOINT_LIMITS,
};
