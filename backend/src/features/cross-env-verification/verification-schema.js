import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";

// Phase 41A — Cross-Environment Verification Core.
//
// Stable vocabulary and fail-closed input contracts for the verification engine.
// The engine answers a single evidence question: "Is this workspace/version
// sufficiently verified to move from environment A to environment B, and what
// blocks verification?" It never executes a request, reads a database, or
// consults the network; every fact it uses is handed in by the caller.
//
// This module is the only place that knows the accepted input shape. Anything it
// cannot parse throws a typed AppError rather than silently degrading, because a
// verification result built on half-understood evidence is worse than no result.

export const CROSS_ENV_VERIFICATION_KIND = "tracer.cross-env-verification";
export const CROSS_ENV_VERIFICATION_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Verification states
// ---------------------------------------------------------------------------
//
// Four explicit states. They are ordered by "how much confidence the evidence
// justifies", but the engine never interpolates between them: a state is chosen
// by rules, not by a score.
//
//   VERIFIED         every required request has fresh, correctly bound evidence
//                    and nothing blocking was reported.
//   BLOCKED          evidence exists and is decisive: it proves the move is not
//                    safe (failed execution, failed required assertion, severe
//                    environment drift, unknown drift, contradictory evidence).
//   NEEDS_REHEARSAL  the workspace is not proven broken, but the evidence required
//                    to verify it is missing, stale, or bound to the wrong
//                    snapshot/environment. The caller must rehearse and supply
//                    new evidence.
//   UNKNOWN          the inputs were not sufficient to reason at all — required
//                    structural inputs were omitted, so no positive or negative
//                    conclusion is available.
//
// The strict rule that matters most: missing evidence NEVER yields VERIFIED.
export const VERIFICATION_STATES = ["VERIFIED", "BLOCKED", "NEEDS_REHEARSAL", "UNKNOWN"];

// Named accessors for the same values, so callers never index the array by name.
export const VERIFICATION_STATE = Object.freeze({
	VERIFIED: "VERIFIED",
	BLOCKED: "BLOCKED",
	NEEDS_REHEARSAL: "NEEDS_REHEARSAL",
	UNKNOWN: "UNKNOWN",
});

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------
//
// Every blocker and warning carries exactly one machine-readable code. Codes are
// the engine's public contract; callers branch on them. New codes must be added
// here and given a rule in verification-rules.js, otherwise they cannot appear.
export const REASON_CODES = Object.freeze({
	// Structural / identity
	SNAPSHOT_CHANGED: "SNAPSHOT_CHANGED",
	SNAPSHOT_IDENTITY_MISSING: "SNAPSHOT_IDENTITY_MISSING",
	ENVIRONMENT_IDENTITY_MISSING: "ENVIRONMENT_IDENTITY_MISSING",
	WORKSPACE_UNCHANGED: "WORKSPACE_UNCHANGED",

	// Environment drift
	HIGH_SEVERITY_DRIFT: "HIGH_SEVERITY_DRIFT",
	UNKNOWN_DRIFT: "UNKNOWN_DRIFT",
	ENVIRONMENT_DRIFT_MISSING: "ENVIRONMENT_DRIFT_MISSING",

	// Change impact / rehearsal
	AFFECTED_REQUEST_UNVERIFIED: "AFFECTED_REQUEST_UNVERIFIED",
	CHANGE_IMPACT_MISSING: "CHANGE_IMPACT_MISSING",
	NO_REHEARSAL_EVIDENCE: "NO_REHEARSAL_EVIDENCE",
	DYNAMIC_REFERENCE_UNRESOLVED: "DYNAMIC_REFERENCE_UNRESOLVED",

	// Execution evidence
	EXECUTION_FAILED: "EXECUTION_FAILED",
	EXECUTION_INCOMPLETE: "EXECUTION_INCOMPLETE",
	EVIDENCE_MISSING: "EVIDENCE_MISSING",

	// Assertions / contracts
	ASSERTION_FAILED: "ASSERTION_FAILED",

	// Evidence binding
	EVIDENCE_STALE: "EVIDENCE_STALE",
	EVIDENCE_WRONG_ENVIRONMENT: "EVIDENCE_WRONG_ENVIRONMENT",
	EVIDENCE_WRONG_SNAPSHOT: "EVIDENCE_WRONG_SNAPSHOT",
	EVIDENCE_WRONG_WORKSPACE: "EVIDENCE_WRONG_WORKSPACE",
	EVIDENCE_CONTRADICTORY: "EVIDENCE_CONTRADICTORY",
	EVIDENCE_AMBIGUOUS: "EVIDENCE_AMBIGUOUS",
});

export const REASON_CODE_VALUES = Object.freeze(Object.values(REASON_CODES));

// Severity of a finding. Blockers always outrank warnings when the state is
// resolved, so a caller can display them in a stable order without re-ranking.
export const FINDING_LEVELS = ["blocker", "warning"];

// ---------------------------------------------------------------------------
// Evidence binding contract
// ---------------------------------------------------------------------------
//
// Evidence is only accepted when it is bound to the exact identities it claims to
// describe. Loose matching is rejected on purpose: an execution that ran against
// a different snapshot fingerprint or a different environment cannot verify this
// move, even if "the request was the same".

const isoishDate = z.union([z.string().min(1), z.date()]);

// A single request-level execution record supplied by a caller. `executionId` and
// `requestId` are the minimum identity; snapshot/environment/workspace bindings
// are what make the evidence admissible.
export const executionEvidenceSchema = z
	.object({
		executionId: z.string().min(1),
		requestId: z.string().min(1),
		collectionId: z.string().min(1).nullable().optional(),
		workspaceId: z.string().min(1).nullable().optional(),
		// The snapshot the execution actually ran against.
		snapshotFingerprint: z.string().min(1).nullable().optional(),
		snapshotId: z.string().min(1).nullable().optional(),
		// The environment the execution actually ran against.
		environmentId: z.string().min(1).nullable().optional(),
		environmentName: z.string().min(1).nullable().optional(),
		// Terminal outcome of the execution.
		outcome: z.enum([
			"response",
			"timeout",
			"cancelled",
			"size_limit",
			"decode_error",
			"network_error",
			"validation_error",
			"interrupted",
			"failed",
			"incomplete",
		]),
		// Whether the execution reached a terminal state at all.
		complete: z.boolean().optional(),
		// Owning profile, used only to enforce profile isolation.
		ownerProfileId: z.string().min(1).nullable().optional(),
		startedAt: isoishDate.nullable().optional(),
		finishedAt: isoishDate.nullable().optional(),
		// Assertion/verifier outcome for this request, when the caller has it.
		assertions: z
			.object({
				required: z.number().int().min(0).optional(),
				passed: z.number().int().min(0).optional(),
				failed: z.number().int().min(0).optional(),
				errors: z.number().int().min(0).optional(),
			})
			.strict()
			.nullable()
			.optional(),
	})
	.strict();

// A caller-supplied assertion/contract result that is not tied to one execution
// record (for example, a contract check evaluated separately). It is bound to a
// request and, optionally, to a snapshot/environment.
export const assertionEvidenceSchema = z
	.object({
		assertionId: z.string().min(1),
		requestId: z.string().min(1),
		status: z.enum(["passed", "failed", "error"]),
		required: z.boolean().optional(),
		collectionId: z.string().min(1).nullable().optional(),
		snapshotFingerprint: z.string().min(1).nullable().optional(),
		snapshotId: z.string().min(1).nullable().optional(),
		environmentId: z.string().min(1).nullable().optional(),
		ownerProfileId: z.string().min(1).nullable().optional(),
		observedAt: isoishDate.nullable().optional(),
	})
	.strict();

// Identity of one side of the move. A snapshot identity is a fingerprint and/or a
// snapshot id; an environment identity is an id and/or a name. Names alone are
// not enough to bind evidence, but they are accepted as display metadata.
export const sideIdentitySchema = z
	.object({
		workspaceId: z.string().min(1).nullable().optional(),
		collectionId: z.string().min(1).nullable().optional(),
		snapshotId: z.string().min(1).nullable().optional(),
		snapshotFingerprint: z.string().min(1).nullable().optional(),
		environmentId: z.string().min(1).nullable().optional(),
		environmentName: z.string().min(1).nullable().optional(),
		label: z.string().min(1).nullable().optional(),
	})
	.strict();

// A compact, caller-supplied snapshot diff summary. The engine does not diff
// snapshots itself (that is Phase 38's job); it consumes a summary and only cares
// whether the workspace changed and whether the two sides are the same version.
export const snapshotDiffSummarySchema = z
	.object({
		identical: z.boolean().optional(),
		changedCount: z.number().int().min(0).optional(),
		changedRequestIds: z.array(z.string().min(1)).optional(),
		changedPaths: z.array(z.string().min(1)).optional(),
	})
	.strict();

// A caller-supplied environment drift result. Deliberately minimal and structural
// so it accepts whatever Phase 40 produces without importing Phase 40 internals:
// the engine only reads the summary counts, the severity buckets, and per-entry
// severity/status/category.
export const environmentDriftInputSchema = z
	.object({
		identical: z.boolean().optional(),
		summary: z
			.object({
				total: z.number().int().min(0).optional(),
				bySeverity: z.record(z.string(), z.number().int().min(0)).optional(),
				byCategory: z.record(z.string(), z.number().int().min(0)).optional(),
			})
			.strict()
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
					.strict(),
			)
			.optional(),
	})
	.strict();

// A caller-supplied change-impact result. Again structural only: the engine reads
// request impact rows and the unknown-reference list, nothing else.
const impactRowSchema = z
	.object({
		requestId: z.string().min(1).nullable().optional(),
		nodeKind: z.string().min(1).optional(),
		impact: z.enum(["direct", "indirect"]).optional(),
		hop: z.number().int().min(0).optional(),
		confidence: z.enum(["exact", "conditional", "unknown"]).optional(),
	})
	.strict();

export const changeImpactInputSchema = z
	.object({
		resolved: z.boolean().optional(),
		truncated: z.boolean().optional(),
		summary: z
			.object({
				directRequests: z.number().int().min(0).optional(),
				indirectRequests: z.number().int().min(0).optional(),
				unknownReferences: z.number().int().min(0).optional(),
			})
			.strict()
			.optional(),
		requests: z
			.object({
				direct: z.array(impactRowSchema).optional(),
				indirect: z.array(impactRowSchema).optional(),
			})
			.strict()
			.optional(),
		unknown: z
			.array(
				z
					.object({
						code: z.string().min(1),
						requestId: z.string().min(1).nullable().optional(),
						collectionId: z.string().min(1).nullable().optional(),
					})
					.strict(),
			)
			.optional(),
	})
	.strict();

// Freshness is opt-in. If a caller supplies `maxAgeMs`, evidence older than
// `now - maxAgeMs` is stale. If the caller supplies `staleBefore`, evidence older
// than that instant is stale. If neither is supplied the engine applies NO age
// rule at all — it never invents a hidden magic duration.
export const freshnessPolicySchema = z
	.object({
		now: isoishDate.optional(),
		maxAgeMs: z.number().int().min(0).optional(),
		staleBefore: isoishDate.optional(),
	})
	.strict();

export const verificationInputSchema = z
	.object({
		source: sideIdentitySchema.optional(),
		target: sideIdentitySchema.optional(),
		snapshotDiff: snapshotDiffSummarySchema.nullable().optional(),
		environmentDrift: environmentDriftInputSchema.nullable().optional(),
		changeImpact: changeImpactInputSchema.nullable().optional(),
		executions: z.array(executionEvidenceSchema).optional(),
		assertions: z.array(assertionEvidenceSchema).optional(),
		freshness: freshnessPolicySchema.nullable().optional(),
		ownerProfileId: z.string().min(1).nullable().optional(),
	})
	.strict();

function invalid(code, message, details) {
	return new AppError(400, code, message, details);
}

function parseOrThrow(schema, value, code, message) {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw invalid(code, message, { issues: result.error.issues.slice(0, 5) });
	}
	return result.data;
}

// Fail closed: a malformed input is a typed 400, never a best-effort parse.
export function parseVerificationInput(input) {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw invalid("CROSS_ENV_VERIFICATION_INVALID_INPUT", "Verification input must be an object.");
	}
	return parseOrThrow(
		verificationInputSchema,
		input,
		"CROSS_ENV_VERIFICATION_INVALID_INPUT",
		"The verification input is not a valid verification request.",
	);
}

export function parseFreshnessPolicy(freshness) {
	if (freshness === undefined || freshness === null) return null;
	const parsed = parseOrThrow(
		freshnessPolicySchema,
		freshness,
		"CROSS_ENV_VERIFICATION_INVALID_FRESHNESS",
		"The freshness policy is not valid.",
	);
	// A policy with no age bound is the same as no policy: do not invent one.
	if (parsed.maxAgeMs === undefined && parsed.staleBefore === undefined) return null;
	return parsed;
}

// A result that fails its own contract is a bug, not data.
export function assertVerificationResult(result) {
	const parsed = crossEnvVerificationResultSchema.safeParse(result);
	if (!parsed.success) {
		throw new AppError(500, "CROSS_ENV_VERIFICATION_INVALID_RESULT", "The verification result failed its own contract check.", {
			issues: parsed.error.issues.slice(0, 5),
		});
	}
	return parsed.data;
}

const findingSchema = z
	.object({
		code: z.enum(REASON_CODE_VALUES),
		level: z.enum(FINDING_LEVELS),
		requestId: z.string().min(1).nullable().optional(),
		collectionId: z.string().min(1).nullable().optional(),
		evidenceId: z.string().min(1).nullable().optional(),
		detail: z.string().min(1).nullable().optional(),
	})
	.strict();

export const crossEnvVerificationResultSchema = z
	.object({
		schemaVersion: z.literal(CROSS_ENV_VERIFICATION_SCHEMA_VERSION),
		kind: z.literal(CROSS_ENV_VERIFICATION_KIND),
		state: z.enum(VERIFICATION_STATES),
		source: sideIdentitySchema,
		target: sideIdentitySchema,
		blockers: z.array(findingSchema),
		warnings: z.array(findingSchema),
		affectedRequestIds: z.array(z.string()),
		requiredRehearsalRequestIds: z.array(z.string()),
		verifiedRequestIds: z.array(z.string()),
		acceptedEvidenceIds: z.array(z.string()),
		rejectedEvidenceIds: z.array(z.string()),
		staleEvidenceIds: z.array(z.string()),
		summary: z
			.object({
				affectedRequests: z.number().int().min(0),
				requiredRehearsals: z.number().int().min(0),
				verifiedRequests: z.number().int().min(0),
				acceptedEvidence: z.number().int().min(0),
				rejectedEvidence: z.number().int().min(0),
				staleEvidence: z.number().int().min(0),
				blockers: z.number().int().min(0),
				warnings: z.number().int().min(0),
			})
			.strict(),
	})
	.strict();
