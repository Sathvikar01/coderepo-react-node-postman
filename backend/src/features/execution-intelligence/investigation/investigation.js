// Pure InvestigationV1 assembly (Workflow 5).
//
// `buildInvestigationV1` is deterministic: identical stage outputs always
// produce an identical InvestigationV1 document. The document carries no
// causal overreach:
//   - `verified_causes` only ever contains deltas whose Phase 31 intervention
//     classification is `causal` AND whose applied/reverted probe evidence is
//     present and satisfies the verification rule. Malformed evidence is
//     rejected (the document is thrown away rather than published).
//   - everything else lands in `unverified_changes` with an explicit label.
//   - every conclusion lists the concrete execution/probe ids it rests on.
import { AppError } from "../../../shared/errors/app-error.js";
import {
	INVESTIGATION_KIND,
	INVESTIGATION_SCHEMA_VERSION,
	INVESTIGATION_STAGE_ORDER,
	VERIFIED_CAUSE_LABEL,
	parseInvestigation,
} from "./investigation-model.js";

const INTERVENTION_LABEL = Object.freeze({
	causal: VERIFIED_CAUSE_LABEL,
	not_causal: "unverified",
	inconclusive: "inconclusive",
	not_replayable: "not_replayable",
});

function uniqueSorted(ids) {
	return [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))].sort();
}

function observation(evidence) {
	if (!evidence) return null;
	return {
		outcome: evidence.outcome ?? null,
		status: typeof evidence.status === "number" ? evidence.status : null,
		predicateMatched: Boolean(evidence.predicateMatched),
	};
}

/**
 * A Phase 31 intervention may only be promoted to `verified_cause` when the
 * experiment is complete and successful: applying the delta to the good run
 * reproduces the failure predicate, and reverting it from the failing run
 * removes the failure. Anything else is rejected as malformed evidence.
 */
function interventionProvesCausality(item) {
	const applied = item.evidence?.applied;
	const reverted = item.evidence?.reverted;
	return Boolean(
		applied?.probeExecutionId &&
			reverted?.probeExecutionId &&
			applied.predicateMatched === true &&
			reverted.predicateMatched === false,
	);
}

function deriveVerifiedCauses(items) {
	const causes = [];
	for (const item of items) {
		if (item.classification !== "causal") continue;
		if (!interventionProvesCausality(item)) {
			throw new AppError(
				422,
				"INVESTIGATION_EVIDENCE_INVALID",
				`A causal classification for delta "${item.delta.id}" is missing successful Phase 31 intervention evidence.`,
			);
		}
		causes.push({
			label: VERIFIED_CAUSE_LABEL,
			delta: { id: item.delta.id, path: item.delta.path, kind: item.delta.kind, before: item.delta.before ?? null, after: item.delta.after ?? null },
			evidence: {
				appliedProbeExecutionId: item.evidence.applied.probeExecutionId,
				revertedProbeExecutionId: item.evidence.reverted.probeExecutionId,
				applied: observation(item.evidence.applied),
				reverted: observation(item.evidence.reverted),
			},
			evidenceSummary:
				`Applying this change to the known-good run reproduced the failure ` +
				`(probe ${item.evidence.applied.probeExecutionId}); reverting it from the failing run removed the failure ` +
				`(probe ${item.evidence.reverted.probeExecutionId}).`,
			executionIds: [item.evidence.applied.probeExecutionId, item.evidence.reverted.probeExecutionId],
		});
	}
	return causes;
}

function deriveUnverifiedChanges({ items, comparison }) {
	const changes = [];
	const provenPaths = new Set();
	for (const item of items) {
		provenPaths.add(item.delta.path);
		if (item.classification === "causal") continue;
		const label = INTERVENTION_LABEL[item.classification] ?? "unverified";
		const ids = [];
		if (item.evidence?.applied?.probeExecutionId) ids.push(item.evidence.applied.probeExecutionId);
		if (item.evidence?.reverted?.probeExecutionId) ids.push(item.evidence.reverted.probeExecutionId);
		changes.push({
			label,
			change: { id: item.delta.id, path: item.delta.path, kind: item.delta.kind, before: item.delta.before ?? null, after: item.delta.after ?? null },
			source: "intervention",
			reason: item.reason ?? (label === "unverified" ? "not_causal_in_counterfactual_probe" : null),
			executionIds: ids,
		});
	}
	if (comparison?.available) {
		for (const change of comparison.changes) {
			// A comparison change already exercised by an intervention keeps its
			// intervention conclusion only; never claim the same change twice.
			if (provenPaths.has(change.path)) continue;
			const isLeading = comparison.firstDivergence && comparison.firstDivergence.path === change.path;
			changes.push({
				label: isLeading ? "leading_divergence" : "correlated_change",
				change: { id: `comparison:${change.path}`, path: change.path, kind: change.category, before: null, after: null },
				source: "comparison",
				reason: isLeading
					? "earliest_correlated_change_not_experimentally_proven"
					: "correlated_change_not_experimentally_proven",
				executionIds: [comparison.baseExecutionId, comparison.candidateExecutionId].filter(Boolean),
			});
		}
	}
	return changes;
}

function buildSummary({ verifiedCauses, unverifiedChanges, interventions, regressionBoundary, minimization, reproducibility }) {
	const parts = [];
	if (regressionBoundary.resolved) {
		const boundary = regressionBoundary.timeline?.boundary;
		parts.push(`Failure begins between ${boundary?.lastKnownGoodExecutionId ?? "an earlier run"} and ${boundary?.firstKnownBadExecutionId ?? "the failing run"}.`);
	} else {
		parts.push(`Start of the failure: unresolved (${regressionBoundary.unresolved?.reason ?? "no good execution"}).`);
	}
	if (verifiedCauses.length > 0) {
		parts.push(`Verified cause(s): ${verifiedCauses.map((cause) => cause.delta.path).join(", ")}.`);
	} else {
		parts.push("No change was experimentally verified as the cause.");
	}
	const leading = unverifiedChanges.find((change) => change.label === "leading_divergence");
	if (leading) parts.push(`Leading divergence (correlated, not proven): ${leading.change.path}.`);
	parts.push(
		`Interventions: ${interventions.items.length} examined` +
			(interventions.reason ? ` (${interventions.reason})` : "") +
			".",
	);
	if (minimization.status === "completed") {
		parts.push(`Smallest reproducer: ${minimization.remainingComponentCount} of ${minimization.originalComponentCount} structural inputs remain (${minimization.minimality}).`);
	} else {
		parts.push(`Minimization: ${minimization.status}${minimization.reason ? ` (${minimization.reason})` : ""}.`);
	}
	if (reproducibility.classification) {
		parts.push(reproducibility.statement ?? `Reproduction: ${reproducibility.classification}.`);
	} else if (reproducibility.status !== "completed") {
		parts.push(`Reproduction: ${reproducibility.status}${reproducibility.reason ? ` (${reproducibility.reason})` : ""}.`);
	}
	return parts.join(" ");
}

function emptyMinimization(reason) {
	return {
		status: "skipped",
		reason,
		minimality: null,
		budgetExhausted: null,
		probesUsed: null,
		probeBudget: null,
		originalComponentCount: null,
		remainingComponentCount: null,
		removed: [],
		probeTrace: [],
		request: null,
		error: null,
		executionIds: [],
	};
}

function emptyReproducibility(reason) {
	return {
		status: "skipped",
		reason,
		appliedTo: null,
		classification: null,
		statement: null,
		plannedProbes: null,
		attempts: 0,
		matches: 0,
		probes: [],
		error: null,
		executionIds: [],
	};
}

/**
 * Build one coherent InvestigationV1 from deterministic stage outputs.
 * Stages that never ran (or could not run) degrade truthfully; the builder
 * never invents causes, timings, or conclusions.
 */
export function buildInvestigationV1(input) {
	const {
		investigationId,
		failingExecutionId,
		goodExecutionId = null,
		predicate,
		targetMode,
		status,
		error = null,
		regression,
		comparison = null,
		counterfactual = null,
		minimization = null,
		reproducibility = null,
		capsule = null,
		stageOutputs = {},
	} = input ?? {};

	if (!investigationId || !failingExecutionId || !predicate || !targetMode) {
		throw new AppError(422, "INVESTIGATION_INPUT_INVALID", "investigationId, failingExecutionId, predicate, and targetMode are required.");
	}
	if (!regression) {
		throw new AppError(422, "INVESTIGATION_INPUT_INVALID", "The regression stage output is required.");
	}

	const regressionBoundary = {
		source: regression.source ?? (goodExecutionId ? "provided" : "none"),
		resolved: Boolean(goodExecutionId),
		goodExecutionId: goodExecutionId ?? null,
		unresolved:
			regression.unresolved ??
			regression.timeline?.unresolved ??
			(goodExecutionId ? null : { reason: "NO_HISTORY", message: "No known-good execution was available as a comparison base." }),
		caveat: regression.timeline?.caveat ?? "",
		timeline: regression.timeline ?? null,
	};

	const comparisonSection = comparison
		? {
				available: true,
				unavailableReason: null,
				baseExecutionId: comparison.baseExecutionId ?? null,
				candidateExecutionId: comparison.candidateExecutionId ?? null,
				firstDivergence: comparison.firstDivergence ?? null,
				changes: (comparison.changes ?? []).map((change) => ({ category: change.category, path: change.path, message: change.message })),
				contract: comparison.contract ?? null,
			}
		: {
				available: false,
				unavailableReason: regression.unavailableReason ?? (goodExecutionId ? "comparison_unavailable" : "no_good_execution"),
				baseExecutionId: null,
				candidateExecutionId: null,
				firstDivergence: null,
				changes: [],
				contract: null,
			};

	const interventions = counterfactual
		? {
				available: true,
				status: counterfactual.status ?? null,
				reason: counterfactual.reason ?? null,
				probeBudget: counterfactual.probeBudget ?? null,
				probesUsed: counterfactual.probesUsed ?? null,
				budgetExhausted: counterfactual.budgetExhausted ?? null,
				items: counterfactual.items ?? [],
			}
		: {
				available: false,
				status: null,
				reason: regression.unavailableReason ?? (goodExecutionId ? "counterfactual_unavailable" : "no_good_execution"),
				probeBudget: null,
				probesUsed: null,
				budgetExhausted: null,
				items: [],
			};

	const verifiedCauses = deriveVerifiedCauses(interventions.items);
	const unverifiedChanges = deriveUnverifiedChanges({ items: interventions.items, comparison: comparisonSection });

	const minimizationSection = minimization
		? {
				status: minimization.status,
				reason: minimization.reason ?? null,
				minimality: minimization.minimality ?? null,
				budgetExhausted: minimization.budgetExhausted ?? null,
				probesUsed: minimization.probesUsed ?? null,
				probeBudget: minimization.probeBudget ?? null,
				originalComponentCount: minimization.originalComponentCount ?? null,
				remainingComponentCount: minimization.remainingComponentCount ?? null,
				removed: minimization.removed ?? [],
				probeTrace: minimization.probeTrace ?? [],
				request: minimization.request ?? null,
				error: minimization.error ?? null,
				executionIds: minimization.executionIds ?? [],
			}
		: emptyMinimization(input.stageOutputs?.interruptedAt ? "not_reached_after_cancellation" : "not_reached");

	const reproducibilitySection = reproducibility
		? {
				status: reproducibility.status,
				reason: reproducibility.reason ?? null,
				appliedTo: reproducibility.appliedTo ?? null,
				classification: reproducibility.classification ?? null,
				statement: reproducibility.statement ?? null,
				plannedProbes: reproducibility.plannedProbes ?? null,
				attempts: reproducibility.attempts ?? 0,
				matches: reproducibility.matches ?? 0,
				probes: reproducibility.probes ?? [],
				error: reproducibility.error ?? null,
				executionIds: reproducibility.executionIds ?? [],
			}
		: emptyReproducibility(input.stageOutputs?.interruptedAt ? "not_reached_after_cancellation" : "not_reached");

	const capsuleSection = {
		available: Boolean(capsule?.text),
		filename: capsule?.filename ?? null,
		requestSource: capsule?.requestSource ?? null,
		requiredInputs: capsule?.requiredInputs ?? [],
		text: capsule?.text ?? null,
	};

	const completedStages = INVESTIGATION_STAGE_ORDER.filter((stage) => (stageOutputs?.completed ?? []).includes(stage));
	const interruptedAt = stageOutputs?.interruptedAt ?? null;

	const conclusions = [
		...verifiedCauses.map((cause) => ({ section: "verifiedCauses", label: cause.label, executionIds: cause.executionIds })),
		...unverifiedChanges.map((change) => ({ section: "unverifiedChanges", label: change.label, executionIds: change.executionIds })),
		{ section: "minimization", label: `minimization:${minimizationSection.status}`, executionIds: minimizationSection.executionIds },
		{ section: "reproducibility", label: `reproducibility:${reproducibilitySection.status}`, executionIds: reproducibilitySection.executionIds },
	];

	const probeExecutionIds = uniqueSorted([
		...(counterfactual?.probeExecutionIds ?? []),
		...minimizationSection.executionIds,
		...reproducibilitySection.executionIds,
	]);

	const summary = buildSummary({
		verifiedCauses,
		unverifiedChanges,
		interventions,
		regressionBoundary,
		minimization: minimizationSection,
		reproducibility: reproducibilitySection,
	});

	return parseInvestigation({
		schemaVersion: INVESTIGATION_SCHEMA_VERSION,
		kind: INVESTIGATION_KIND,
		investigationId,
		status,
		failingExecutionId,
		goodExecutionId: goodExecutionId ?? null,
		predicate,
		targetMode,
		summary: {
			text: summary,
			counts: {
				verifiedCauses: verifiedCauses.length,
				unverifiedChanges: unverifiedChanges.length,
				interventions: interventions.items.length,
				probes: probeExecutionIds.length,
			},
		},
		regressionBoundary,
		comparison: comparisonSection,
		interventions,
		verifiedCauses,
		unverifiedChanges,
		minimization: minimizationSection,
		reproducibility: reproducibilitySection,
		reproductionCapsule: capsuleSection,
		stages: { completed: completedStages, interruptedAt },
		evidence: {
			failingExecutionId,
			goodExecutionId: goodExecutionId ?? null,
			probeExecutionIds,
			conclusions,
		},
		error: error ? { code: error.code, message: error.message } : null,
	});
}

/* -------------------------------------------------------------------------- */
/* Secret scrubbing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Defense in depth for persisted results: strip every known resolved secret
 * (from both source requests) out of any string in the assembled document.
 */
export function scrubSecrets(value, secrets) {
	const list = [...new Set((secrets ?? []).filter((entry) => typeof entry === "string" && entry.length > 3))];
	if (list.length === 0) return value;
	const redact = (entry) => {
		if (typeof entry === "string") {
			let out = entry;
			for (const secret of list) out = out.split(secret).join("[REDACTED]");
			return out;
		}
		if (Array.isArray(entry)) return entry.map(redact);
		if (entry && typeof entry === "object") {
			const out = {};
			for (const key of Object.keys(entry)) out[key] = redact(entry[key]);
			return out;
		}
		return entry;
	};
	return redact(value);
}
