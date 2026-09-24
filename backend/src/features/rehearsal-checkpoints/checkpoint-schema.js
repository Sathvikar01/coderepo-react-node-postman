import { z } from "zod";
import { utf8Bytes } from "../../shared/utils/limits.js";
import { AppError } from "../../shared/errors/app-error.js";
import { RUN_STATE_VALUES, STEP_STATE_VALUES, REASON_CODE_VALUES } from "./reason-codes.js";

// Phase 46B — Rehearsal checkpoint schema.
//
// This module is the only place that knows the accepted shape of a checkpoint run
// or a checkpoint write. Anything it cannot parse throws a typed AppError rather
// than silently degrading, because a checkpoint built on half-understood input is
// worse than no checkpoint.
//
// Two rules shape the whole file:
//
//   1. Everything is bounded. Step count, identifier length, reason identifier
//      length, and total serialized size all have a hard ceiling, so a caller
//      cannot persist a pathological document.
//   2. Nothing sensitive enters. Bodies, credentials, cookies, bearer tokens, and
//      resolved secrets are not part of any accepted shape, and strings that look
//      like a credential are refused outright rather than redacted: a checkpoint
//      is a machine-written progress record, so a secret in one is a bug, not
//      data.

export const REHEARSAL_CHECKPOINT_SCHEMA_VERSION = 1;
export const REHEARSAL_CHECKPOINT_KIND = "tracer.rehearsal-checkpoint";

// Bounds. Kept here (not shared/limits.js) because they are specific to checkpoints
// and Phase 46B must not touch shared files.
export const CHECKPOINT_LIMITS = Object.freeze({
	maxSteps: 5000,
	maxIdentifierBytes: 128,
	maxFingerprintBytes: 128,
	maxReasonBytes: 128,
	maxAttemptsPerStep: 1000,
	maxEvidenceRefsPerStep: 64,
	maxOutcomeFields: 32,
	maxOutcomeValueBytes: 512,
	maxSerializedBytes: 2 * 1024 * 1024,
});

// A string that could carry a credential. Rejected rather than redacted.
const CREDENTIAL_SHAPED = [
	/\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\./,
	/\b(sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_\-]{12,}/,
];

export function isCredentialShaped(value) {
	return CREDENTIAL_SHAPED.some((pattern) => pattern.test(String(value)));
}

function byteLimit(maxBytes, label) {
	return z
		.string()
		.min(1)
		.refine((value) => utf8Bytes(value) <= maxBytes, `${label} is limited to ${maxBytes} bytes.`);
}

// An identifier. Control characters and credential-shaped text are refused so a
// pathological value cannot smuggle a control sequence or a secret into storage.
function identifier(label, maxBytes = CHECKPOINT_LIMITS.maxIdentifierBytes) {
	return byteLimit(maxBytes, label)
		.refine((value) => !/[\u0000-\u001f\u007f]/.test(value), `${label} cannot contain control characters.`)
		.refine((value) => !isCredentialShaped(value), `${label} cannot contain credential-shaped text.`);
}

// A fingerprint. Hex-or-token-shaped, never credential-shaped.
const fingerprint = z
	.string()
	.min(1)
	.max(CHECKPOINT_LIMITS.maxFingerprintBytes)
	.refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value), "A fingerprint cannot contain whitespace or control characters.")
	.refine((value) => !isCredentialShaped(value), "A fingerprint cannot contain credential-shaped text.");

// Any identifier-like value: an ObjectId hex string or a bounded stable token.
const objectIdLike = z
	.string()
	.min(1)
	.refine((value) => /^[a-fA-F0-9]{24}$/.test(value) || /^[A-Za-z0-9._:-]{1,128}$/.test(value), "Provide a valid identifier.");

// ---------------------------------------------------------------------------
// Run identity
// ---------------------------------------------------------------------------
//
// The identity is the immutable binding of a run. A run can never resume under a
// different workspace, snapshot, environment, or plan. Every field is required
// except `policy`, which is optional because not every rehearsal has a policy
// document (see §9.1 of the architecture brief).
//
// `targetEnvironment` is a full structured identity: an id alone is not enough to
// prove "same environment", because an environment can be edited without changing
// its id. The fingerprint is what makes the binding exact.

export const targetEnvironmentSchema = z
	.object({
		environmentId: objectIdLike,
		environmentName: z.string().min(1).max(CHECKPOINT_LIMITS.maxIdentifierBytes).optional(),
		environmentFingerprint: fingerprint,
	})
	.strict();

export const runIdentitySchema = z
	.object({
		workspaceId: objectIdLike,
		// Snapshot identity + the fingerprint that commits to its exact content.
		snapshotId: objectIdLike,
		snapshotFingerprint: fingerprint,
		// Target environment identity + fingerprint.
		targetEnvironment: targetEnvironmentSchema,
		// Plan identity + fingerprint.
		planId: objectIdLike,
		planFingerprint: fingerprint,
		// Optional policy identity. When supplied it is bound immutably; when the
		// caller supplies none, none is stored.
		policyId: objectIdLike.nullish(),
		policyFingerprint: fingerprint.nullish(),
	})
	.strict()
	.superRefine((identity, context) => {
		// A policy id and a policy fingerprint travel together or not at all. A
		// half-supplied policy identity is not "mostly bound", it is unbound.
		const hasId = identity.policyId !== undefined && identity.policyId !== null;
		const hasFingerprint = identity.policyFingerprint !== undefined && identity.policyFingerprint !== null;
		if (hasId !== hasFingerprint)
			context.addIssue({
				code: "custom",
				path: [hasId ? "policyFingerprint" : "policyId"],
				message: "A policy identity requires both an id and a fingerprint.",
			});
	});

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
//
// A plan is an ordered list of step identities. The order is meaningful: it is the
// execution order. Duplicate step ids are refused, because a plan that names the
// same step twice cannot be accounted for exactly once.

export const planStepSchema = z
	.object({
		stepId: identifier("Step identifiers"),
		// Opaque reference to what this step executes (e.g. a request id). Stored as
		// an identity, never as a body.
		refId: identifier("Step reference identifiers").nullish(),
	})
	.strict();

export const planSchema = z
	.object({
		steps: z
			.array(planStepSchema)
			.max(CHECKPOINT_LIMITS.maxSteps, `A plan may declare at most ${CHECKPOINT_LIMITS.maxSteps} steps.`)
			.superRefine((steps, context) => {
				const seen = new Set();
				steps.forEach((step, index) => {
					if (seen.has(step.stepId))
						context.addIssue({ code: "custom", path: [index, "stepId"], message: `Step "${step.stepId}" is declared more than once.` });
					seen.add(step.stepId);
				});
			}),
	})
	.strict();

// ---------------------------------------------------------------------------
// Step attempt metadata & outcome identity
// ---------------------------------------------------------------------------
//
// Attempt metadata is deliberately small: a count, an owner (generation), and
// bounded evidence references. Outcome is an identity/reference, not a payload.

export const attemptMetadataSchema = z
	.object({
		attempts: z.number().int().min(0).max(CHECKPOINT_LIMITS.maxAttemptsPerStep),
		// The generation that owns the current attempt. Null once the step is
		// terminal or before any attempt started.
		ownerGeneration: z.number().int().min(0).nullable(),
		// Bounded opaque references to evidence produced elsewhere (an execution id,
		// a receipt id, an assertion result id). References only — never payloads.
		evidenceRefs: z
			.array(identifier("Evidence reference identifiers"))
			.max(CHECKPOINT_LIMITS.maxEvidenceRefsPerStep, `A step may reference at most ${CHECKPOINT_LIMITS.maxEvidenceRefsPerStep} evidence records.`)
			.default([]),
	})
	.strict();

// ---------------------------------------------------------------------------
// Create input
// ---------------------------------------------------------------------------

export const createRunInputSchema = z
	.object({
		// A caller-supplied run id pins the run's identity across machines. When
		// omitted the service allocates one.
		runId: identifier("Run identifiers").nullish(),
		identity: runIdentitySchema,
		plan: planSchema,
		// Optional bounded, secret-screened label for display.
		label: z
			.string()
			.max(CHECKPOINT_LIMITS.maxIdentifierBytes)
			.refine((value) => !isCredentialShaped(value), "Labels cannot contain credential-shaped text.")
			.nullish(),
	})
	.strict();

// ---------------------------------------------------------------------------
// Operation inputs
// ---------------------------------------------------------------------------

// Every mutating operation names the generation it believes it owns. This is the
// CAS token: a stale worker presents an old generation and is refused.
export const generationInputSchema = z
	.object({
		generation: z.number().int().min(1),
	})
	.strict();

export const claimInputSchema = z
	.object({
		// The worker claiming the run. Bounded, opaque, never a secret.
		owner: identifier("Worker identities"),
		// The generation the caller expects to be current, or null to claim whatever
		// is current (only valid for the very first claim from CREATED).
		expectedGeneration: z.number().int().min(0).nullable(),
	})
	.strict();

export const checkpointStepInputSchema = z
	.object({
		generation: z.number().int().min(1),
		owner: identifier("Worker identities"),
		stepId: identifier("Step identifiers"),
		// Optional identity assertion. When supplied it must match the stored run
		// identity exactly, so a worker that drifted to another snapshot/environment/
		// plan cannot record progress against this run.
		identity: runIdentitySchema.nullish(),
		// The outcome of the step. COMPLETED / SKIPPED / FAILED are the terminal
		// step states a checkpoint write may set.
		state: z.enum([STEP_STATE_VALUES[2], STEP_STATE_VALUES[3], STEP_STATE_VALUES[4]]),
		// An outcome identity/reference. Never a response body.
		outcome: z
			.object({
				outcomeId: identifier("Outcome identifiers"),
				// A bounded, flat map of scalar metadata. No nested payloads.
				metadata: z
					.record(
						z.string().min(1).max(64).refine((value) => !isCredentialShaped(value), "Outcome metadata keys cannot contain credential-shaped text."),
						z
							.union([z.string().max(CHECKPOINT_LIMITS.maxOutcomeValueBytes), z.number(), z.boolean(), z.null()])
							.refine((value) => !(typeof value === "string" && isCredentialShaped(value)), "Outcome metadata cannot contain credential-shaped text."),
					)
					.refine((value) => Object.keys(value).length <= CHECKPOINT_LIMITS.maxOutcomeFields, `Outcome metadata may declare at most ${CHECKPOINT_LIMITS.maxOutcomeFields} fields.`)
					.default({}),
			})
			.strict()
			.nullish(),
		evidenceRefs: z
			.array(identifier("Evidence reference identifiers"))
			.max(CHECKPOINT_LIMITS.maxEvidenceRefsPerStep, `A step may reference at most ${CHECKPOINT_LIMITS.maxEvidenceRefsPerStep} evidence records.`)
			.default([]),
	})
	.strict();

export const abortInputSchema = z
	.object({
		generation: z.number().int().min(1),
		owner: identifier("Worker identities"),
		reasonCode: z.enum(REASON_CODE_VALUES),
		reason: z.string().max(CHECKPOINT_LIMITS.maxReasonBytes).refine((value) => !isCredentialShaped(value), "Abort reasons cannot contain credential-shaped text.").nullish(),
	})
	.strict();

export const failInputSchema = z
	.object({
		generation: z.number().int().min(1),
		owner: identifier("Worker identities"),
		reasonCode: z.enum(REASON_CODE_VALUES),
		reason: z.string().max(CHECKPOINT_LIMITS.maxReasonBytes).refine((value) => !isCredentialShaped(value), "Failure reasons cannot contain credential-shaped text.").nullish(),
	})
	.strict();

export const resumeInputSchema = z
	.object({
		owner: identifier("Worker identities"),
		expectedGeneration: z.number().int().min(1),
		// The identity the caller asserts it is resuming under. Checked against the
		// stored identity field by field; any difference is refused.
		identity: runIdentitySchema,
	})
	.strict();

// ---------------------------------------------------------------------------
// Parsers — fail closed
// ---------------------------------------------------------------------------

function fail(code, message, details) {
	return new AppError(400, code, message, details);
}

function parseWith(value, schema, code, message) {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
		throw fail(code, message, { issues });
	}
	return parsed.data;
}

export function parseCreateRunInput(value) {
	if (value === undefined || value === null)
		throw fail("REHEARSAL_CHECKPOINT_MALFORMED_INPUT", "A run definition is required.");
	return parseWith(value, createRunInputSchema, "REHEARSAL_CHECKPOINT_MALFORMED_INPUT", "The rehearsal run definition is not valid.");
}

export function parseRunIdentity(value) {
	return parseWith(value, runIdentitySchema, "REHEARSAL_CHECKPOINT_MISSING_IDENTITY", "The rehearsal run identity is not valid.");
}

export function parsePlan(value) {
	return parseWith(value, planSchema, "REHEARSAL_CHECKPOINT_MALFORMED_INPUT", "The rehearsal plan is not valid.");
}

export function parseGenerationInput(value) {
	return parseWith(value, generationInputSchema, "REHEARSAL_CHECKPOINT_MALFORMED_INPUT", "A generation is required.");
}

export function parseClaimInput(value) {
	return parseWith(value, claimInputSchema, "REHEARSAL_CHECKPOINT_MALFORMED_INPUT", "The claim request is not valid.");
}

export function parseCheckpointStepInput(value) {
	return parseWith(value, checkpointStepInputSchema, "REHEARSAL_CHECKPOINT_MALFORMED_INPUT", "The step checkpoint is not valid.");
}

export function parseAbortInput(value) {
	return parseWith(value, abortInputSchema, "REHEARSAL_CHECKPOINT_MALFORMED_INPUT", "The abort request is not valid.");
}

export function parseFailInput(value) {
	return parseWith(value, failInputSchema, "REHEARSAL_CHECKPOINT_MALFORMED_INPUT", "The failure request is not valid.");
}

export function parseResumeInput(value) {
	return parseWith(value, resumeInputSchema, "REHEARSAL_CHECKPOINT_MALFORMED_INPUT", "The resume request is not valid.");
}

// A live-document shape used when validating stored checkpoint state. Same
// vocabulary as the write path, so a stored checkpoint can never drift from it.
export const storedRunSchema = z
	.object({
		schemaVersion: z.literal(REHEARSAL_CHECKPOINT_SCHEMA_VERSION),
		kind: z.literal(REHEARSAL_CHECKPOINT_KIND),
		runState: z.enum(RUN_STATE_VALUES),
		generation: z.number().int().min(1),
		owner: z.string().nullable(),
		identity: runIdentitySchema,
		plan: planSchema,
		completedStepIds: z.array(z.string().min(1)),
		stepStates: z.array(z.object({ stepId: z.string().min(1), state: z.enum(STEP_STATE_VALUES) }).strict()),
	})
	.strict();

export function parseStoredRun(value) {
	return parseWith(value, storedRunSchema, "REHEARSAL_CHECKPOINT_MALFORMED_INPUT", "Stored checkpoint state is not valid.");
}

export { fail as checkpointFail };
