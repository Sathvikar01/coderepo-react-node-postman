import { z } from "zod";

// Phase 40A — Environment Drift Core.
//
// Deterministic, machine-readable description of how the *effective* API
// configuration differs between two environment states of the same workspace.
// This module owns only the stable vocabulary (categories, severities, statuses)
// and the result contract. It never resolves a secret and never predicts runtime
// breakage; every entry is evidence produced by explicit rules.

export const ENVIRONMENT_DRIFT_KIND = "tracer.environment-drift";
export const ENVIRONMENT_DRIFT_SCHEMA_VERSION = 1;

// Categories are the closed set the comparator is allowed to emit. New
// categories must be added here and classified in drift-severity.js.
export const DRIFT_CATEGORIES = [
	"VARIABLE_MISSING",
	"VARIABLE_ADDED",
	"VARIABLE_CHANGED",
	"SECRET_REFERENCE_CHANGED",
	"AUTH_CONFIG_CHANGED",
	"BASE_URL_CHANGED",
	"VERSION_CHANGED",
	"HEADER_CONFIG_CHANGED",
	"UNRESOLVED_REFERENCE",
	"ENVIRONMENT_SELECTION_CHANGED",
];

export const DRIFT_SEVERITIES = ["high", "medium", "low", "unknown"];
export const DRIFT_STATUSES = ["confirmed", "unknown"];

const stateSchema = z
	.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
	.nullable();

export const driftEntrySchema = z
	.object({
		category: z.enum(DRIFT_CATEGORIES),
		path: z.string().min(1),
		sourceState: stateSchema,
		targetState: stateSchema,
		affectedReferenceIds: z.array(z.string()),
		severity: z.enum(DRIFT_SEVERITIES),
		status: z.enum(DRIFT_STATUSES),
	})
	.strict();

const environmentRefSchema = z
	.object({
		environmentId: z.string().nullable(),
		name: z.string().nullable(),
		revision: z.number().int().nullable(),
	})
	.strict();

export const environmentDriftResultSchema = z
	.object({
		schemaVersion: z.literal(ENVIRONMENT_DRIFT_SCHEMA_VERSION),
		kind: z.literal(ENVIRONMENT_DRIFT_KIND),
		source: environmentRefSchema,
		target: environmentRefSchema,
		identical: z.boolean(),
		summary: z
			.object({
				total: z.number().int().min(0),
				byCategory: z.record(z.string(), z.number().int().min(0)),
				bySeverity: z.record(z.string(), z.number().int().min(0)),
			})
			.strict(),
		drift: z.array(driftEntrySchema),
	})
	.strict();

// Stable, secret-free projection of one side of the comparison.
export function environmentRef(environment) {
	return {
		environmentId: environment.id ?? null,
		name: environment.name ?? null,
		revision: Number.isInteger(environment.revision) ? environment.revision : null,
	};
}

// Builds the deterministic summary. Categories/severities with a zero count are
// omitted so the shape does not depend on which categories happen to be present,
// and the keys are inserted in the canonical category/severity order.
export function summarizeDrift(drift) {
	const byCategory = {};
	for (const category of DRIFT_CATEGORIES) {
		const count = drift.filter((entry) => entry.category === category).length;
		if (count > 0) byCategory[category] = count;
	}
	const bySeverity = {};
	for (const severity of DRIFT_SEVERITIES) {
		const count = drift.filter((entry) => entry.severity === severity).length;
		if (count > 0) bySeverity[severity] = count;
	}
	return { total: drift.length, byCategory, bySeverity };
}
