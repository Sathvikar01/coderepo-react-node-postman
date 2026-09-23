import { z } from "zod";
import { AppError } from "../../../shared/errors/app-error.js";
import { matchesFailurePredicate } from "../failure-minimizer.js";
import { failurePredicateForRecord } from "../repro-capsule.js";
import { compareReceipts } from "../run-comparison.js";

// RegressionTimelineV1. Pure evidence model for "when did this request start failing?".
// It reads recorded executions only. It never replays a request over the network and it
// never labels a chronological transition as a root cause.

export const REGRESSION_TIMELINE_KIND = "tracer.regression-timeline";
export const REGRESSION_TIMELINE_VERSION = 1;
export const REGRESSION_WINDOW_DEFAULT = 50;
export const REGRESSION_WINDOW_MAX = 100;

export const REGRESSION_UNRESOLVED_REASONS = [
	"AMBIGUOUS_LINEAGE",
	"ANCHOR_NOT_EVALUABLE",
	"ANCHOR_NOT_FAILING",
	"NO_HISTORY",
	"NO_KNOWN_GOOD",
	"BOUNDARY_NOT_ADJACENT",
];

export const REGRESSION_TIMELINE_CAVEAT =
	"The boundary is the earliest observed transition into the current failing streak of the examined window. " +
	"It is chronological evidence from recorded executions, not a proven root cause.";

const SKIP_REASONS = ["hidden", "expired", "not_terminal", "missing_evidence"];

const predicateSchema = z.discriminatedUnion("type", [
	z
		.object({ type: z.literal("assertion"), assertionId: z.string().min(1).max(128), failureFingerprint: z.string().max(256).nullable().optional() })
		.strict(),
	z.object({ type: z.literal("status"), equals: z.number().int().min(100).max(599) }).strict(),
	z.object({ type: z.literal("outcome"), equals: z.string().min(1).max(64) }).strict(),
]);

const markerSchema = z.object({ executionId: z.string().min(1), startedAt: z.string().nullable() }).strict();

const entrySchema = z
	.object({
		executionId: z.string().min(1),
		startedAt: z.string().nullable(),
		finishedAt: z.string().nullable(),
		outcome: z.string().nullable(),
		statusCode: z.number().int().nullable(),
		predicateMatched: z.boolean(),
	})
	.strict();

const regressionTimelineSchema = z
	.object({
		schemaVersion: z.literal(REGRESSION_TIMELINE_VERSION),
		kind: z.literal(REGRESSION_TIMELINE_KIND),
		lineage: z
			.object({ collectionId: z.string().min(1), requestId: z.string().min(1), key: z.string().min(1) })
			.strict()
			.nullable(),
		anchor: markerSchema,
		predicate: z.unknown(),
		window: z.object({ limit: z.number().int().min(1), truncated: z.boolean() }).strict(),
		examinedExecutionIds: z.array(z.string().min(1)),
		examined: z.array(entrySchema),
		skipped: z.array(z.object({ executionId: z.string().min(1), startedAt: z.string().nullable(), reason: z.enum(SKIP_REASONS) }).strict()),
		lastKnownGood: markerSchema.nullable(),
		firstKnownBad: markerSchema.nullable(),
		boundary: z
			.object({
				lastKnownGoodExecutionId: z.string().min(1),
				firstKnownBadExecutionId: z.string().min(1),
				comparison: z.unknown().nullable(),
				comparisonUnavailableReason: z.string().nullable(),
			})
			.strict()
			.nullable(),
		unresolved: z.object({ reason: z.enum(REGRESSION_UNRESOLVED_REASONS), message: z.string().min(1) }).strict().nullable(),
		caveat: z.string().min(1),
	})
	.strict();

function iso(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timeOf(value) {
	if (value == null) return Number.NaN;
	const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isNaN(time) ? Number.NaN : time;
}

function nonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

// The strongest stable lineage identity already recorded is the saved request identity:
// (collectionId, requestId) from the persisted send context. URL similarity is never used
// to group executions. Scratch sends, history replays, and missing identifiers fail closed.
export function lineageOf(record) {
	const source = record?.context?.source;
	if (!source || typeof source !== "object") return { ok: false, reason: "the execution has no recorded request source" };
	if (source.type === "history")
		return { ok: false, reason: "the execution is a history replay without a saved request identity" };
	if (source.type !== "collection")
		return { ok: false, reason: "the execution was not sent from a saved collection request" };
	const collectionId = nonEmptyString(source.collectionId);
	const requestId = nonEmptyString(source.requestId);
	if (!collectionId || !requestId) return { ok: false, reason: "the saved collection or request identifier is missing" };
	return { ok: true, lineage: { collectionId, requestId, key: `${collectionId}:${requestId}` } };
}

export function parseFailurePredicate(value) {
	const parsed = predicateSchema.safeParse(value);
	if (!parsed.success)
		return {
			ok: false,
			issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
		};
	const predicate = parsed.data;
	if (predicate.type === "assertion" && predicate.failureFingerprint === undefined)
		return { ok: true, predicate: { ...predicate, failureFingerprint: null } };
	return { ok: true, predicate };
}

// Reuses the recorded failure evidence of one execution as the default selected predicate
// (same derivation the reproduction capsule uses).
export function selectFailurePredicate(record) {
	return failurePredicateForRecord(record);
}

// Conservative predicate evaluation. A record only counts as evidence when it carries what
// the selected predicate needs; anything else is unevaluable and becomes a gap, never a pass.
export function evaluatePredicate(record, predicate, now = Date.now()) {
	if (record?.visible === false) return { evaluable: false, reason: "hidden" };
	const expiresAt = record?.expiresAt == null ? null : timeOf(record.expiresAt);
	if (expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt <= now) return { evaluable: false, reason: "expired" };
	if (record?.status !== "terminal") return { evaluable: false, reason: "not_terminal" };
	if (predicate.type === "outcome" && record.outcome == null) return { evaluable: false, reason: "missing_evidence" };
	if (predicate.type === "status" && record.response?.status == null) return { evaluable: false, reason: "missing_evidence" };
	if (predicate.type === "assertion") {
		const tests = record.snapshot?.scriptResults?.tests;
		const present = Array.isArray(tests) && tests.some((test) => test?.assertionId === predicate.assertionId);
		if (!present) return { evaluable: false, reason: "missing_evidence" };
	}
	return {
		evaluable: true,
		matched: matchesFailurePredicate(
			{ outcome: record.outcome, response: record.response, scriptResults: record.snapshot?.scriptResults },
			predicate,
		),
	};
}

// Deterministic chronological order: startedAt, then executionId as the tie-breaker.
export function orderRecords(records) {
	return [...records].sort((left, right) => {
		const leftTime = timeOf(left?.startedAt);
		const rightTime = timeOf(right?.startedAt);
		const a = Number.isNaN(leftTime) ? 0 : leftTime;
		const b = Number.isNaN(rightTime) ? 0 : rightTime;
		if (a !== b) return a - b;
		const leftId = String(left?.executionId ?? "");
		const rightId = String(right?.executionId ?? "");
		return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
	});
}

function unresolved(reason, message) {
	return { reason, message };
}

function marker(record) {
	return { executionId: record.executionId, startedAt: iso(record.startedAt) };
}

function buildBoundary(leftRecord, rightRecord) {
	const comparison = leftRecord.receipt && rightRecord.receipt ? compareReceipts(leftRecord.receipt, rightRecord.receipt) : null;
	return {
		lastKnownGoodExecutionId: leftRecord.executionId,
		firstKnownBadExecutionId: rightRecord.executionId,
		comparison,
		comparisonUnavailableReason: comparison ? null : "RECEIPT_UNAVAILABLE",
	};
}

export function buildRegressionTimeline({ anchor, records = [], predicate, window = {}, now = Date.now() }) {
	const parsedPredicate = parseFailurePredicate(predicate);
	if (!parsedPredicate.ok)
		throw new AppError(422, "PREDICATE_INVALID", "The selected failure predicate is not supported.", { issues: parsedPredicate.issues });
	const limit = Math.min(Math.max(Number(window.limit) || REGRESSION_WINDOW_DEFAULT, 1), REGRESSION_WINDOW_MAX);
	const truncated = window.truncated === true;
	const model = {
		schemaVersion: REGRESSION_TIMELINE_VERSION,
		kind: REGRESSION_TIMELINE_KIND,
		lineage: null,
		anchor: marker(anchor),
		predicate: parsedPredicate.predicate,
		window: { limit, truncated },
		examinedExecutionIds: [],
		examined: [],
		skipped: [],
		lastKnownGood: null,
		firstKnownBad: null,
		boundary: null,
		unresolved: null,
		caveat: REGRESSION_TIMELINE_CAVEAT,
	};

	const anchorLineage = lineageOf(anchor);
	if (!anchorLineage.ok) {
		model.unresolved = unresolved(
			"AMBIGUOUS_LINEAGE",
			`A trustworthy request lineage could not be established: ${anchorLineage.reason}. Executions were not grouped and no boundary is reported.`,
		);
		return regressionTimelineSchema.parse(model);
	}
	model.lineage = anchorLineage.lineage;

	// Keep only executions that provably belong to the same saved request lineage.
	const unique = new Map();
	for (const record of [anchor, ...records]) {
		if (!record?.executionId || unique.has(record.executionId)) continue;
		const lineage = lineageOf(record);
		if (!lineage.ok || lineage.lineage.key !== anchorLineage.lineage.key) continue;
		unique.set(record.executionId, record);
	}
	const ordered = orderRecords([...unique.values()]);
	const evaluated = ordered.map((record) => ({ record, result: evaluatePredicate(record, parsedPredicate.predicate, now) }));

	model.skipped = evaluated
		.filter((item) => !item.result.evaluable)
		.map((item) => ({ executionId: item.record.executionId, startedAt: iso(item.record.startedAt), reason: item.result.reason }));
	model.examined = evaluated
		.filter((item) => item.result.evaluable)
		.map((item) => ({
			executionId: item.record.executionId,
			startedAt: iso(item.record.startedAt),
			finishedAt: iso(item.record.finishedAt),
			outcome: item.record.outcome ?? null,
			statusCode: item.record.response?.status ?? null,
			predicateMatched: item.result.matched === true,
		}));
	model.examinedExecutionIds = model.examined.map((entry) => entry.executionId);

	const anchorIndex = model.examined.findIndex((entry) => entry.executionId === anchor.executionId);
	if (anchorIndex < 0) {
		model.unresolved = unresolved(
			"ANCHOR_NOT_EVALUABLE",
			"The selected execution does not carry the evidence the selected failure predicate needs, so no boundary is reported.",
		);
		return regressionTimelineSchema.parse(model);
	}
	if (!model.examined[anchorIndex].predicateMatched) {
		model.unresolved = unresolved(
			"ANCHOR_NOT_FAILING",
			"The selected execution does not exhibit the selected failure, so there is no regression boundary to report.",
		);
		return regressionTimelineSchema.parse(model);
	}

	// The current failing streak is the contiguous run of predicate matches around the anchor.
	let streakStart = anchorIndex;
	while (streakStart > 0 && model.examined[streakStart - 1].predicateMatched) streakStart -= 1;

	const firstBad = ordered.find((record) => record.executionId === model.examined[streakStart].executionId);
	model.firstKnownBad = marker(firstBad);
	const goodEntry = streakStart > 0 ? model.examined[streakStart - 1] : null;

	if (!goodEntry) {
		const anchorIndexInLineage = ordered.findIndex((record) => record.executionId === anchor.executionId);
		if (anchorIndexInLineage <= 0) {
			model.unresolved = unresolved(
				"NO_HISTORY",
				"No earlier execution is recorded for this request lineage, so the start of the failure cannot be located.",
			);
		} else {
			const suffix = truncated
				? ` The examined window is truncated at ${limit} executions, so older history was not examined.`
				: "";
			model.unresolved = unresolved(
				"NO_KNOWN_GOOD",
				"Every earlier lineage execution also exhibits the selected failure or cannot be evaluated, so no passing execution is available to anchor a transition boundary." + suffix,
			);
		}
		return regressionTimelineSchema.parse(model);
	}

	const goodRecord = ordered.find((record) => record.executionId === goodEntry.executionId);
	model.lastKnownGood = marker(goodRecord);
	const goodIndex = ordered.findIndex((record) => record.executionId === goodRecord.executionId);
	const badIndex = ordered.findIndex((record) => record.executionId === firstBad.executionId);
	if (badIndex - goodIndex !== 1) {
		model.unresolved = unresolved(
			"BOUNDARY_NOT_ADJACENT",
			"Lineage executions that cannot be evaluated sit between the last known good and the first known bad execution, " +
				"so the transition cannot be pinned to an adjacent pair.",
		);
		return regressionTimelineSchema.parse(model);
	}

	model.boundary = buildBoundary(goodRecord, firstBad);
	return regressionTimelineSchema.parse(model);
}
