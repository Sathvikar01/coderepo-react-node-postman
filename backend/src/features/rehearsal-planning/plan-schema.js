// Phase 46A — Checkpointed Rehearsal Planning Core (schema layer).
//
// This module defines the closed input and output vocabulary for the planner.
// It answers exactly one question:
//
//   "Given a frozen workspace snapshot, target environment, impact analysis,
//    drift analysis, and blast-radius policy, exactly what requests should a
//    rehearsal attempt, and in what deterministic order?"
//
// It executes nothing, persists nothing, and modifies no runner. Every fact it
// uses is handed in by the caller.
//
// Design notes that later phases depend on:
//
//   * The planner consumes *existing public envelopes* structurally, the same way
//     Phase 41 consumes Phase 39/40 results. It does not import Phase 39/40/45
//     internals and does not copy their logic.
//   * A snapshot identity and a target environment identity are REQUIRED. A plan
//     with no snapshot is not "unverified", it is unplannable: fail closed.
//   * The blast-radius envelope is required for anything to be executable. If it
//     is absent, no step can be admitted; the plan is EMPTY with an explicit
//     reason, never a best-effort runnable plan.

import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import {
	CYCLE_KIND_VALUES,
	DEPENDENCY_KIND_VALUES,
	PLAN_REASON_CODE_VALUES,
	PLAN_STATE_VALUES,
	REHEARSAL_PLANNING_ERROR_CODES,
	STEP_STATE_VALUES,
} from "./reason-codes.js";

export const REHEARSAL_PLAN_KIND = "tracer.rehearsal-plan";
export const REHEARSAL_PLAN_SCHEMA_VERSION = 1;

// Closed vocabularies are declared once, in reason-codes.js, and consumed here.
// Hardcoding the same literals a second time in the schema would let the schema
// and the planner drift apart without any test failing.
const planStateSchema = z.enum(PLAN_STATE_VALUES);
const stepStateSchema = z.enum(STEP_STATE_VALUES);
// An excluded (non-step) entry can never be EXECUTABLE, so the vocabulary is
// narrowed here rather than accepting a nonsensical combination.
const nonExecutableStepStateSchema = z.enum(STEP_STATE_VALUES.filter((state) => state !== "EXECUTABLE"));
const dependencyKindSchema = z.enum(DEPENDENCY_KIND_VALUES);
const cycleKindSchema = z.enum(CYCLE_KIND_VALUES);
const planReasonCodeSchema = z.enum(PLAN_REASON_CODE_VALUES);
const impactKindSchema = z.enum(["direct", "indirect"]);
const confidenceSchema = z.enum(["exact", "conditional", "unknown"]);
const admissionSchema = z.enum(["ADMITTED", "BLOCKED", "REQUIRES_CONFIRMATION", "UNKNOWN"]);

const MAX_REQUESTS = 10_000;
const MAX_ID_LENGTH = 256;

const boundedId = z.string().min(1).max(MAX_ID_LENGTH);
const optionalId = boundedId.nullable().optional();

// ---------------------------------------------------------------------------
// Identity blocks
// ---------------------------------------------------------------------------

// One side of the rehearsal move. Names are accepted as display metadata only;
// identity binding uses ids and fingerprints.
export const planSideIdentitySchema = z
	.object({
		workspaceId: optionalId,
		collectionId: optionalId,
		snapshotId: optionalId,
		snapshotFingerprint: optionalId,
		environmentId: boundedId,
		environmentName: optionalId,
		revision: z.number().int().nullable().optional(),
		label: optionalId,
	})
	.strict();

// The frozen snapshot the plan is bound to. At least one of id/fingerprint is
// required; the planner refuses to plan against an unidentified snapshot.
export const planSnapshotIdentitySchema = z
	.object({
		snapshotId: optionalId,
		snapshotFingerprint: optionalId,
		revision: z.number().int().nullable().optional(),
	})
	.strict()
	.refine((value) => Boolean(value.snapshotId) || Boolean(value.snapshotFingerprint), {
		message: "A snapshot identity requires a snapshotId or a snapshotFingerprint.",
	});

// ---------------------------------------------------------------------------
// Consumed result envelopes (structural, secret-free)
// ---------------------------------------------------------------------------

// Change-impact rows. Mirrors the Phase 39 public result contract closely enough
// to accept it directly, while remaining strict about what the planner reads:
// request identity, impact kind, hop, and confidence. No payloads.
const impactRowSchema = z
	.object({
		requestId: optionalId,
		collectionId: optionalId,
		nodeKind: z.string().min(1).optional(),
		impact: impactKindSchema.optional(),
		hop: z.number().int().min(0).optional(),
		confidence: confidenceSchema.optional(),
	})
	.passthrough();

export const planImpactInputSchema = z
	.object({
		kind: z.string().min(1).optional(),
		resolved: z.boolean().optional(),
		truncated: z.boolean().optional(),
		summary: z
			.object({
				directRequests: z.number().int().min(0).optional(),
				indirectRequests: z.number().int().min(0).optional(),
				unknownReferences: z.number().int().min(0).optional(),
			})
			.passthrough()
			.optional(),
		requests: z
			.object({
				direct: z.array(impactRowSchema).optional(),
				indirect: z.array(impactRowSchema).optional(),
			})
			.passthrough()
			.optional(),
		// Request rows may also be provided flat under `impact`, matching the
		// Phase 39 result which nests request rows under both `requests` and
		// `impact`. Reading either keeps the seam tolerant without loosening
		// which facts are trusted.
		impact: z
			.object({
				direct: z.array(impactRowSchema).optional(),
				indirect: z.array(impactRowSchema).optional(),
			})
			.passthrough()
			.optional(),
		unknown: z
			.array(
				z
					.object({
						code: z.string().min(1),
						requestId: optionalId,
						collectionId: optionalId,
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

// Environment-drift result. The planner reads the summary, the identical flag,
// the per-entry category/severity/status, and the environment references. It
// never reads a value out of the state projections.
export const planDriftInputSchema = z
	.object({
		kind: z.string().min(1).optional(),
		identical: z.boolean().optional(),
		source: z
			.object({ environmentId: optionalId, name: optionalId, revision: z.number().int().nullable().optional() })
			.passthrough()
			.optional(),
		target: z
			.object({ environmentId: optionalId, name: optionalId, revision: z.number().int().nullable().optional() })
			.passthrough()
			.optional(),
		summary: z
			.object({
				total: z.number().int().min(0).optional(),
				byCategory: z.record(z.string(), z.number().int().min(0)).optional(),
				bySeverity: z.record(z.string(), z.number().int().min(0)).optional(),
			})
			.passthrough()
			.optional(),
		drift: z
			.array(
				z
					.object({
						category: z.string().min(1),
						path: z.string().min(1).optional(),
						severity: z.string().min(1),
						status: z.string().min(1).optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

// Blast-radius envelope. The planner trusts the Phase 45 decision verbatim and
// copies its reason codes; it never re-derives admission.
const blastRadiusEntrySchema = z
	.object({
		requestId: boundedId,
		host: z.string().nullable().optional(),
		hostKey: z.string().nullable().optional(),
		port: z.number().int().nullable().optional(),
		method: z.string().nullable().optional(),
		classification: z.string().nullable().optional(),
		mutating: z.boolean().optional(),
		admission: admissionSchema,
		reasonCodes: z.array(z.string().min(1)).optional(),
	})
	.passthrough();

export const planBlastRadiusInputSchema = z
	.object({
		kind: z.string().min(1).optional(),
		version: z.number().int().min(0).optional(),
		policy: z
			.object({
				kind: z.string().min(1).optional(),
				version: z.number().int().min(0).optional(),
				identity: boundedId,
			})
			.passthrough()
			.optional(),
		workspace: z
			.object({ workspaceId: optionalId, snapshotId: optionalId })
			.passthrough()
			.optional(),
		environment: z
			.object({ environmentId: optionalId, targetEnvironmentId: optionalId })
			.passthrough()
			.optional(),
		admissionState: z.string().min(1).optional(),
		requests: z
			.object({
				proposed: z.number().int().min(0).optional(),
				admitted: z.number().int().min(0).optional(),
				blocked: z.number().int().min(0).optional(),
				unknown: z.number().int().min(0).optional(),
				requiresConfirmation: z.number().int().min(0).optional(),
			})
			.passthrough()
			.optional(),
		allowedRequests: z.array(blastRadiusEntrySchema).optional(),
		blockedRequests: z.array(blastRadiusEntrySchema).optional(),
		unknownRequests: z.array(blastRadiusEntrySchema).optional(),
		confirmationRequests: z.array(blastRadiusEntrySchema).optional(),
		// Per-request decisions may alternatively be supplied as one flat list.
		entries: z.array(blastRadiusEntrySchema).optional(),
	})
	.passthrough();

// ---------------------------------------------------------------------------
// Candidate requests and dependency information
// ---------------------------------------------------------------------------

// A dependency edge on a candidate request. `dependsOn` names request ids within
// the candidate set; `dynamicDependencies` carries unresolved/dynamic markers the
// caller could not name statically. Both are preserved, never dropped.
export const planCandidateRequestSchema = z
	.object({
		requestId: boundedId,
		collectionId: optionalId,
		// Normalized host identity and method are used ONLY for safe display on a
		// step and for cross-checking against the blast-radius decision. They are
		// never executed and never resolved here.
		host: z.union([z.string(), z.null()]).optional(),
		port: z.number().int().min(1).max(65535).nullable().optional(),
		method: z.union([z.string(), z.null()]).optional(),
		dependsOn: z.array(boundedId).max(MAX_REQUESTS).optional(),
		// Free-form markers naming a dependency that is not statically resolvable
		// (for example "{{dynamicBaseUrl}}"). Text only; never interpreted.
		dynamicDependencies: z.array(z.string().min(1).max(MAX_ID_LENGTH)).optional(),
	})
	.passthrough();

export const planDependencySchema = z
	.object({
		requestId: boundedId,
		dependsOn: z.array(boundedId).max(MAX_REQUESTS).optional(),
		dynamicDependencies: z.array(z.string().min(1).max(MAX_ID_LENGTH)).optional(),
	})
	.strict();

// ---------------------------------------------------------------------------
// The full planner input
// ---------------------------------------------------------------------------

export const rehearsalPlanInputSchema = z
	.object({
		workspaceId: boundedId,
		snapshot: planSnapshotIdentitySchema,
		source: planSideIdentitySchema,
		target: planSideIdentitySchema,
		impact: planImpactInputSchema.nullable().optional(),
		drift: planDriftInputSchema.nullable().optional(),
		blastRadius: planBlastRadiusInputSchema.nullable().optional(),
		candidates: z.array(planCandidateRequestSchema).min(1).max(MAX_REQUESTS),
		dependencies: z.array(planDependencySchema).max(MAX_REQUESTS).optional(),
	})
	.strict();

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

const planStepSchema = z
	.object({
		stepId: boundedId,
		requestId: boundedId,
		collectionId: optionalId,
		ordinal: z.number().int().min(0),
		state: stepStateSchema,
		admitted: z.boolean(),
		impact: impactKindSchema.nullable(),
		confidence: confidenceSchema.nullable(),
		hop: z.number().int().min(0).nullable(),
		host: z.string().nullable(),
		hostKey: z.string().nullable(),
		port: z.number().int().nullable(),
		method: z.string().nullable(),
		mutationClassification: z.string().nullable(),
		mutating: z.boolean(),
		blastRadiusAdmission: z.string().nullable(),
		dependencies: z.array(
			z
				.object({
					requestId: optionalId,
					marker: optionalId,
					kind: dependencyKindSchema,
				})
				.strict(),
		),
		dependents: z.array(boundedId),
		reasonCodes: z.array(z.string().min(1)),
	})
	.strict();

const excludedRequestSchema = z
	.object({
		requestId: boundedId,
		state: nonExecutableStepStateSchema,
		reasonCodes: z.array(z.string().min(1)),
	})
	.strict();

const cycleSchema = z
	.object({
		kind: cycleKindSchema,
		requestIds: z.array(boundedId),
	})
	.strict();

export const rehearsalPlanResultSchema = z
	.object({
		kind: z.literal(REHEARSAL_PLAN_KIND),
		schemaVersion: z.literal(REHEARSAL_PLAN_SCHEMA_VERSION),
		state: planStateSchema,
		identity: z
			.object({
				planFingerprint: boundedId,
				fingerprintKeyId: boundedId,
			})
			.strict(),
		workspace: z
			.object({ workspaceId: boundedId })
			.strict(),
		snapshot: z
			.object({ snapshotId: optionalId, snapshotFingerprint: optionalId })
			.strict(),
		source: z
			.object({ environmentId: boundedId, snapshotFingerprint: optionalId })
			.strict(),
		target: z
			.object({ environmentId: boundedId, snapshotFingerprint: optionalId })
			.strict(),
		impactedRequestIds: z.array(boundedId),
		executableRequestIds: z.array(boundedId),
		excludedRequestIds: z.array(boundedId),
		blockedRequestIds: z.array(boundedId),
		unknownRequestIds: z.array(boundedId),
		requiresConfirmationRequestIds: z.array(boundedId),
		unresolvedDependencyRequestIds: z.array(boundedId),
		cycleRequestIds: z.array(boundedId),
		dependencyIds: z.array(
			z
				.object({
					requestId: boundedId,
					dependsOn: boundedId,
					kind: dependencyKindSchema,
				})
				.strict(),
		),
		steps: z.array(planStepSchema),
		excluded: z.array(excludedRequestSchema),
		cycles: z.array(cycleSchema),
		blastRadius: z
			.object({
				policyIdentity: optionalId,
				admissionState: optionalId,
			})
			.strict(),
		reasonCodes: z.array(planReasonCodeSchema),
		prerequisites: z.array(
			z
				.object({
					code: z.string().min(1),
					requestId: optionalId,
					detail: optionalId,
				})
				.strict(),
		),
		evidenceReferences: z.array(
			z
				.object({
					kind: z.string().min(1),
					ref: optionalId,
				})
				.strict(),
		),
		summary: z
			.object({
				candidates: z.number().int().min(0),
				impacted: z.number().int().min(0),
				executable: z.number().int().min(0),
				excluded: z.number().int().min(0),
				blocked: z.number().int().min(0),
				unknown: z.number().int().min(0),
				requiresConfirmation: z.number().int().min(0),
				unresolvedDependencies: z.number().int().min(0),
				cycles: z.number().int().min(0),
				dependencyEdges: z.number().int().min(0),
			})
			.strict(),
	})
	.strict();

// ---------------------------------------------------------------------------
// Fail-closed parse helpers
// ---------------------------------------------------------------------------

function invalid(code, message, details) {
	return new AppError(400, code, message, details);
}

function parseOrThrow(schema, value, code, message) {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw invalid(code, message, { issues: result.error.issues.slice(0, 8) });
	}
	return result.data;
}

// Fail closed: a malformed input is a typed 400, never a best-effort parse.
export function parseRehearsalPlanInput(input) {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw invalid(
			REHEARSAL_PLANNING_ERROR_CODES.MALFORMED_INPUT,
			"Rehearsal planning input must be an object.",
		);
	}
	return parseOrThrow(
		rehearsalPlanInputSchema,
		input,
		REHEARSAL_PLANNING_ERROR_CODES.MALFORMED_INPUT,
		"The rehearsal planning input is not a valid planning request.",
	);
}

// A result that fails its own contract is a bug, not data.
export function assertRehearsalPlanResult(result) {
	const parsed = rehearsalPlanResultSchema.safeParse(result);
	if (!parsed.success) {
		throw new AppError(
			500,
			REHEARSAL_PLANNING_ERROR_CODES.INVALID_RESULT,
			"The rehearsal plan result failed its own contract check.",
			{ issues: parsed.error.issues.slice(0, 8) },
		);
	}
	return parsed.data;
}
