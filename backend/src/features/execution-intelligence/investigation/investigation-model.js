// Phase 35 — Investigation Engine (Workflow 5).
//
// InvestigationV1: one coherent, versioned, deterministic regression investigation
// result. It orchestrates the merged Phase 31-34 artifacts and adds NO second
// execution engine and NO AI inference: every conclusion is an evidence-linked
// restatement of deterministic records, and the only `verified_cause` claims
// come from Phase 31 interventions that carry successful probe evidence.
//
// Truthfulness labels are explicit:
//   - verified_cause       — experimentally verified by a Phase 31 intervention
//   - leading_divergence   — earliest correlated change, NOT experimentally proven
//   - correlated_change    — changed alongside the failure, unverified
//   - unverified           — Phase 31 probed it and it was not causal (or nothing was verified)
//   - not_replayable       — could not be replayed as an experiment
//   - inconclusive         — experiment ran but proved nothing
import { z } from "zod";
import { requestDefinitionSchema } from "../../../shared/utils/schemas.js";
import { AppError } from "../../../shared/errors/app-error.js";

export const INVESTIGATION_SCHEMA_VERSION = 1;
export const INVESTIGATION_KIND = "tracer.investigation";
export const INVESTIGATION_PROBE_BUDGET = 24;
export const INVESTIGATION_STAGE_ORDER = Object.freeze([
	"preparing",
	"regression_boundary",
	"comparison",
	"counterfactual",
	"minimization",
	"reproducibility",
	"capsule",
]);

export const VERIFIED_CAUSE_LABEL = "verified_cause";
export const UNVERIFIED_LABELS = Object.freeze([
	"leading_divergence",
	"correlated_change",
	"unverified",
	"not_replayable",
	"inconclusive",
]);
export const CAUSE_LABELS = Object.freeze([VERIFIED_CAUSE_LABEL, ...UNVERIFIED_LABELS]);

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                           */
/* -------------------------------------------------------------------------- */

export const failurePredicateSchema = z.discriminatedUnion("type", [
	z
		.object({ type: z.literal("assertion"), assertionId: z.string().min(1).max(128), failureFingerprint: z.string().max(256).nullable().optional() })
		.strict(),
	z.object({ type: z.literal("status"), equals: z.number().int().min(100).max(599) }).strict(),
	z.object({ type: z.literal("outcome"), equals: z.string().min(1).max(64) }).strict(),
]);

const executionIdSchema = z.string().min(1).max(64);

const deltaRefSchema = z
	.object({
		id: z.string().min(1).max(256),
		path: z.string().min(1).max(512),
		kind: z.string().min(1).max(64),
		before: z.unknown(),
		after: z.unknown(),
	})
	.strict();

const probeObservationSchema = z
	.object({
		outcome: z.string().max(64).nullable(),
		status: z.number().int().nullable(),
		predicateMatched: z.boolean(),
	})
	.strict();

const evidencePairSchema = z
	.object({
		appliedProbeExecutionId: executionIdSchema,
		revertedProbeExecutionId: executionIdSchema,
		applied: probeObservationSchema,
		reverted: probeObservationSchema,
	})
	.strict();

const interventionItemSchema = z
	.object({
		schemaVersion: z.number().int(),
		kind: z.literal("tracer.counterfactual-intervention"),
		delta: z
			.object({
				id: z.string().min(1).max(256),
				path: z.string().min(1).max(512),
				kind: z.string().min(1).max(64),
				replayable: z.boolean(),
				before: z.unknown(),
				after: z.unknown(),
			})
			.strict(),
		classification: z.enum(["causal", "not_causal", "inconclusive", "not_replayable"]),
		reason: z.string().max(500).nullable(),
		evidence: z
			.object({
				applied: z
					.object({ probeExecutionId: executionIdSchema, predicateMatched: z.boolean(), outcome: z.string().max(64).nullable(), status: z.number().int().nullable() })
					.strict()
					.nullable(),
				reverted: z
					.object({ probeExecutionId: executionIdSchema, predicateMatched: z.boolean(), outcome: z.string().max(64).nullable(), status: z.number().int().nullable() })
					.strict()
					.nullable(),
			})
			.strict(),
	})
	.strict();

const comparisonChangeSchema = z
	.object({ category: z.string().min(1).max(64), path: z.string().min(1).max(512), message: z.string().min(1).max(500) })
	.strict();

const contractChangeSchema = z
	.object({
		kind: z.string().min(1).max(64),
		path: z.string().max(512),
		before: z.unknown(),
		after: z.unknown(),
		severity: z.enum(["breaking", "additive"]),
	})
	.passthrough();

const componentRefSchema = z.union([
	z.object({ kind: z.literal("query"), id: z.string().min(1).max(64), key: z.string().max(512) }).strict(),
	z.object({ kind: z.literal("header"), id: z.string().min(1).max(64), key: z.string().max(512) }).strict(),
	z.object({ kind: z.literal("json"), path: z.array(z.union([z.string(), z.number()])).max(24), key: z.string().max(512) }).strict(),
]);

const minimizationRemovalSchema = z
	.object({
		index: z.number().int().min(0),
		phase: z.string().min(1).max(32),
		removals: z.array(componentRefSchema).max(32),
		matched: z.boolean(),
	})
	.strict();

/* -------------------------------------------------------------------------- */
/* InvestigationV1 sections                                                    */
/* -------------------------------------------------------------------------- */

const verifiedCauseSchema = z
	.object({
		label: z.literal(VERIFIED_CAUSE_LABEL),
		delta: deltaRefSchema,
		evidence: evidencePairSchema,
		evidenceSummary: z.string().min(1).max(500),
		executionIds: z.array(executionIdSchema).min(1),
	})
	.strict();

const unverifiedChangeSchema = z
	.object({
		label: z.enum(UNVERIFIED_LABELS),
		change: deltaRefSchema,
		source: z.enum(["intervention", "comparison"]),
		reason: z.string().max(500).nullable(),
		executionIds: z.array(executionIdSchema),
	})
	.strict();

export const investigationSchema = z
	.object({
		schemaVersion: z.literal(INVESTIGATION_SCHEMA_VERSION),
		kind: z.literal(INVESTIGATION_KIND),
		investigationId: z.string().min(1).max(64),
		status: z.enum(["completed", "cancelled", "failed"]),
		failingExecutionId: z.string().min(1).max(64),
		goodExecutionId: z.string().max(64).nullable(),
		predicate: failurePredicateSchema,
		targetMode: z.enum(["execution", "mock"]),
		summary: z
			.object({
				text: z.string().min(1).max(2000),
				counts: z
					.object({ verifiedCauses: z.number().int().min(0), unverifiedChanges: z.number().int().min(0), interventions: z.number().int().min(0), probes: z.number().int().min(0) })
					.strict(),
			})
			.strict(),
		regressionBoundary: z
			.object({
				source: z.enum(["provided", "phase33", "none"]),
				resolved: z.boolean(),
				goodExecutionId: z.string().max(64).nullable(),
				unresolved: z
					.object({ reason: z.string().min(1).max(64), message: z.string().min(1).max(500) })
					.strict()
					.nullable(),
				caveat: z.string().max(500),
				timeline: z.object({ schemaVersion: z.number().int(), kind: z.string().min(1).max(64) }).passthrough().nullable(),
			})
			.strict(),
		comparison: z
			.object({
				available: z.boolean(),
				unavailableReason: z.string().max(200).nullable(),
				baseExecutionId: z.string().max(64).nullable(),
				candidateExecutionId: z.string().max(64).nullable(),
				firstDivergence: comparisonChangeSchema.nullable(),
				changes: z.array(comparisonChangeSchema).max(64),
				contract: z.object({ breaking: z.boolean(), changes: z.array(contractChangeSchema).max(256) }).passthrough().nullable(),
			})
			.strict(),
		interventions: z
			.object({
				available: z.boolean(),
				status: z.string().max(64).nullable(),
				reason: z.string().max(500).nullable(),
				probeBudget: z.number().int().nullable(),
				probesUsed: z.number().int().nullable(),
				budgetExhausted: z.boolean().nullable(),
				items: z.array(interventionItemSchema).max(64),
			})
			.strict(),
		verifiedCauses: z.array(verifiedCauseSchema).max(64),
		unverifiedChanges: z.array(unverifiedChangeSchema).max(128),
		minimization: z
			.object({
				status: z.enum(["completed", "skipped", "failed", "cancelled"]),
				reason: z.string().max(500).nullable(),
				minimality: z.enum(["one_minimal", "budget_limited", "inconclusive"]).nullable(),
				budgetExhausted: z.boolean().nullable(),
				probesUsed: z.number().int().min(0).nullable(),
				probeBudget: z.number().int().min(0).nullable(),
				originalComponentCount: z.number().int().min(0).nullable(),
				remainingComponentCount: z.number().int().min(0).nullable(),
				removed: z.array(componentRefSchema).max(64),
				probeTrace: z.array(minimizationRemovalSchema).max(32),
				request: requestDefinitionSchema.nullable(),
				error: z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(500) }).strict().nullable(),
				executionIds: z.array(executionIdSchema),
			})
			.strict(),
		reproducibility: z
			.object({
				status: z.enum(["completed", "skipped", "failed", "cancelled"]),
				reason: z.string().max(500).nullable(),
				appliedTo: z.enum(["minimized", "failing"]).nullable(),
				classification: z.enum(["reproducible", "flaky", "not_reproduced", "inconclusive"]).nullable(),
				statement: z.string().max(1000).nullable(),
				plannedProbes: z.number().int().min(0).nullable(),
				attempts: z.number().int().min(0),
				matches: z.number().int().min(0),
				probes: z
					.array(
						z
							.object({
								index: z.number().int().min(0),
								probeExecutionId: z.string().max(64).nullable(),
								outcome: z.string().max(64).nullable(),
								responseStatus: z.number().int().nullable(),
								predicateMatched: z.boolean(),
							})
							.strict(),
					)
					.max(16),
				error: z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(500) }).strict().nullable(),
				executionIds: z.array(executionIdSchema),
			})
			.strict(),
		reproductionCapsule: z
			.object({
				available: z.boolean(),
				filename: z.string().max(256).nullable(),
				requestSource: z.enum(["minimized", "failing"]).nullable(),
				requiredInputs: z.array(z.object({ name: z.string().min(1).max(128), source: z.string().min(1).max(64) }).strict()).max(32),
				text: z.string().max(600_000).nullable(),
			})
			.strict(),
		stages: z
			.object({
				completed: z.array(z.enum(INVESTIGATION_STAGE_ORDER)).max(INVESTIGATION_STAGE_ORDER.length),
				interruptedAt: z.enum(INVESTIGATION_STAGE_ORDER).nullable(),
			})
			.strict(),
		evidence: z
			.object({
				failingExecutionId: z.string().min(1).max(64),
				goodExecutionId: z.string().max(64).nullable(),
				probeExecutionIds: z.array(executionIdSchema).max(128),
				conclusions: z
					.array(
						z
							.object({
								section: z.string().min(1).max(64),
								label: z.string().min(1).max(64),
								executionIds: z.array(executionIdSchema),
							})
							.strict(),
					)
					.max(256),
			})
			.strict(),
		error: z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(500) }).strict().nullable(),
	})
	.strict();

export function parseInvestigation(value) {
	const parsed = investigationSchema.safeParse(value);
	if (!parsed.success) {
		throw new AppError(422, "INVESTIGATION_INVALID", "The investigation result failed strict schema validation.");
	}
	return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Start input                                                                 */
/* -------------------------------------------------------------------------- */

export const investigationInputSchema = z
	.object({
		failingExecutionId: z.string().uuid("A failing history record id is required."),
		goodExecutionId: z.string().uuid("Provide a valid history record id.").optional(),
		predicate: failurePredicateSchema.optional(),
		targetMode: z.enum(["execution", "mock"]).default("execution"),
		allowUnsafeLocal: z.boolean().default(false),
		allowUnsafeConfirm: z.boolean().default(false),
		probeBudget: z.number().int().min(2).max(INVESTIGATION_PROBE_BUDGET).optional(),
		minimizationProbes: z.number().int().min(2).max(12).optional(),
		reproductionProbes: z.number().int().min(2).max(5).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.goodExecutionId && value.goodExecutionId === value.failingExecutionId) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["goodExecutionId"], message: "The good and failing executions must differ." });
		}
	});

export function parseInvestigationInput(input) {
	const parsed = investigationInputSchema.safeParse(input);
	if (!parsed.success) {
		throw new AppError(422, "INVESTIGATION_INPUT_INVALID", parsed.error.issues[0]?.message ?? "Invalid investigation input.");
	}
	return parsed.data;
}
