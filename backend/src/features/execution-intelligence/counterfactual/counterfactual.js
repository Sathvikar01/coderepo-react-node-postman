/**
 * Phase 31 — counterfactual cause verification engine.
 *
 * Upgrades the Flight Recorder from "these executions differ" to "this
 * specific change was experimentally shown to reproduce or remove the failure".
 *
 * The engine is pure and deterministic:
 *   - it computes material deltas from the two request definitions,
 *   - establishes a stable good/failing baseline,
 *   - for each replayable delta it runs exactly two controlled interventions
 *     (apply the delta to the good request, revert the delta from the failing
 *     request) through the caller-supplied probe,
 *   - classifies each delta as causal / not_causal / inconclusive /
 *     not_replayable based only on observed evidence.
 *
 * A delta is `causal` only when applying it reproduces the failure AND removing
 * it removes the failure. There is no heuristic scoring, no confidence value,
 * and no model inference anywhere in this module.
 */

import { AppError } from "../../../shared/errors/app-error.js";
import { matchesFailurePredicate } from "../failure-minimizer.js";
import {
	COUNTERFACTUAL_INTERVENTION_KIND,
	COUNTERFACTUAL_KIND,
	COUNTERFACTUAL_MAX_PROBES,
	COUNTERFACTUAL_VERSION,
	canonicalJson,
	isSafeMethod,
} from "./counterfactual-model.js";
import { applyCounterfactualDelta, computeCounterfactualDeltas } from "./counterfactual-deltas.js";

function evidence(result, matched) {
	return {
		probeExecutionId: result?.executionId ?? null,
		predicateMatched: matched,
		outcome: result?.outcome ?? null,
		status: result?.response?.status ?? null,
	};
}

function interventionFor(delta, classification, reason, observed) {
	return {
		schemaVersion: COUNTERFACTUAL_VERSION,
		kind: COUNTERFACTUAL_INTERVENTION_KIND,
		delta: {
			id: delta.id,
			path: delta.path,
			kind: delta.kind,
			replayable: classification !== "not_replayable",
			before: delta.displayBefore ?? null,
			after: delta.displayAfter ?? null,
		},
		classification,
		reason: reason ?? null,
		evidence: observed ?? { applied: null, reverted: null },
	};
}

function summarize(interventions) {
	const summary = { total: interventions.length, causal: 0, not_causal: 0, inconclusive: 0, not_replayable: 0 };
	for (const intervention of interventions) {
		if (Object.hasOwn(summary, intervention.classification)) summary[intervention.classification] += 1;
	}
	return summary;
}

function buildResult({
	baseExecutionId,
	candidateExecutionId,
	predicate,
	budget,
	probesUsed,
	budgetExhausted,
	status,
	reason,
	baseline,
	interventions,
}) {
	return {
		schemaVersion: COUNTERFACTUAL_VERSION,
		kind: COUNTERFACTUAL_KIND,
		baseExecutionId: baseExecutionId ?? null,
		candidateExecutionId: candidateExecutionId ?? null,
		predicate: { ...predicate },
		status,
		reason: reason ?? null,
		probeBudget: budget,
		probesUsed,
		budgetExhausted,
		baseline,
		interventions,
		summary: summarize(interventions),
		causalDeltaIds: interventions.filter((intervention) => intervention.classification === "causal").map((intervention) => intervention.delta.id),
	};
}

function inconclusiveInterventions(deltas, reason) {
	return deltas.map((delta) => interventionFor(delta, "inconclusive", reason, null));
}

/**
 * @param {object} input
 * @param {object} input.baseRequest             known-good authored request
 * @param {object} input.candidateRequest        failing authored request
 * @param {object|null} [input.baseReceipt]      known-good execution receipt
 * @param {object|null} [input.candidateReceipt] failing execution receipt
 * @param {object} input.predicate               failure predicate ({ type: "outcome"|"status"|"assertion", ... })
 * @param {(request: object, signal: AbortSignal|null) => Promise<object>} input.probe
 * @param {AbortSignal|null} [input.signal]
 * @param {number} [input.maxProbes]
 * @param {{ mutatingAllowed?: boolean }} [input.safety]
 * @param {Array<object>|null} [input.deltas]    precomputed deltas (test seam)
 * @returns {Promise<object>} versioned, secret-safe counterfactual result
 */
export async function verifyCounterfactual({
	baseRequest,
	candidateRequest,
	baseReceipt = null,
	candidateReceipt = null,
	predicate,
	probe,
	signal = null,
	maxProbes = COUNTERFACTUAL_MAX_PROBES,
	safety = {},
	deltas: providedDeltas = null,
	baseExecutionId = null,
	candidateExecutionId = null,
} = {}) {
	if (typeof probe !== "function") throw new AppError(400, "COUNTERFACTUAL_INPUT", "A probe function is required.");
	if (!predicate || typeof predicate !== "object") throw new AppError(400, "COUNTERFACTUAL_INPUT", "A failure predicate is required.");

	const budget = Math.min(Math.max(Number(maxProbes) || COUNTERFACTUAL_MAX_PROBES, 1), COUNTERFACTUAL_MAX_PROBES);
	const mutatingAllowed = safety?.mutatingAllowed !== false;
	const deltas =
		providedDeltas ?? computeCounterfactualDeltas({ baseRequest, candidateRequest, baseReceipt, candidateReceipt });

	let probesUsed = 0;
	const cache = new Map();

	const cancellation = () => {
		if (signal?.aborted) throw new AppError(409, "COUNTERFACTUAL_CANCELLED", "Counterfactual verification was cancelled.");
	};

	const runProbe = async (request, { fresh = false } = {}) => {
		cancellation();
		const key = canonicalJson(request);
		if (!fresh && cache.has(key)) return cache.get(key);
		if (probesUsed >= budget) throw new AppError(409, "COUNTERFACTUAL_BUDGET", "The counterfactual probe budget is exhausted.");
		probesUsed += 1;
		const result = await probe(structuredClone(request), signal);
		if (!cache.has(key)) cache.set(key, result);
		return result;
	};

	/* ---------------------------------------------------------------- */
	/* Baseline stability                                               */
	/* ---------------------------------------------------------------- */

	const goodProbes = [];
	const failingProbes = [];
	let good1;
	let failing1;
	try {
		good1 = await runProbe(baseRequest);
		goodProbes.push(good1);
		failing1 = await runProbe(candidateRequest);
		failingProbes.push(failing1);
		const good2 = await runProbe(baseRequest, { fresh: true });
		goodProbes.push(good2);
		const failing2 = await runProbe(candidateRequest, { fresh: true });
		failingProbes.push(failing2);
	} catch (error) {
		if (error?.code === "COUNTERFACTUAL_BUDGET") {
			const baseline = {
				stable: false,
				goodMatched: null,
				failingMatched: null,
				probes: {
					good: goodProbes.map((result) => evidence(result, matchesFailurePredicate(result, predicate))),
					failing: failingProbes.map((result) => evidence(result, matchesFailurePredicate(result, predicate))),
				},
				reason: "probe_budget_exhausted",
			};
			return buildResult({
				baseExecutionId,
				candidateExecutionId,
				predicate,
				budget,
				probesUsed,
				budgetExhausted: true,
				status: "budget_exhausted",
				reason: "probe_budget_exhausted",
				baseline,
				interventions: inconclusiveInterventions(deltas, "probe_budget_exhausted"),
			});
		}
		throw error;
	}

	const goodMatches = goodProbes.map((result) => matchesFailurePredicate(result, predicate));
	const failingMatches = failingProbes.map((result) => matchesFailurePredicate(result, predicate));
	const stable = goodMatches[0] === goodMatches[1] && failingMatches[0] === failingMatches[1];
	const baseline = {
		stable,
		goodMatched: goodMatches[0],
		failingMatched: failingMatches[0],
		probes: {
			good: goodProbes.map((result) => evidence(result, matchesFailurePredicate(result, predicate))),
			failing: failingProbes.map((result) => evidence(result, matchesFailurePredicate(result, predicate))),
		},
		reason: null,
	};

	if (!stable) {
		baseline.reason = "baseline_unstable";
		return buildResult({
			baseExecutionId,
			candidateExecutionId,
			predicate,
			budget,
			probesUsed,
			budgetExhausted: false,
			status: "inconclusive",
			reason: "baseline_unstable",
			baseline,
			interventions: inconclusiveInterventions(deltas, "baseline_unstable"),
		});
	}

	if (goodMatches[0]) {
		baseline.reason = "base_predicate_met";
		return buildResult({
			baseExecutionId,
			candidateExecutionId,
			predicate,
			budget,
			probesUsed,
			budgetExhausted: false,
			status: "inconclusive",
			reason: "base_predicate_met",
			baseline,
			interventions: inconclusiveInterventions(deltas, "base_predicate_met"),
		});
	}

	if (!failingMatches[0]) {
		baseline.reason = "failure_not_reproduced";
		return buildResult({
			baseExecutionId,
			candidateExecutionId,
			predicate,
			budget,
			probesUsed,
			budgetExhausted: false,
			status: "inconclusive",
			reason: "failure_not_reproduced",
			baseline,
			interventions: inconclusiveInterventions(deltas, "failure_not_reproduced"),
		});
	}

	/* ---------------------------------------------------------------- */
	/* Single-factor interventions                                      */
	/* ---------------------------------------------------------------- */

	const interventions = [];
	let status = "completed";
	let budgetExhausted = false;

	for (const delta of deltas) {
		cancellation();

		if (!delta.replayable) {
			interventions.push(interventionFor(delta, "not_replayable", delta.reason ?? "not_replayable", null));
			continue;
		}

		if (budgetExhausted || probesUsed >= budget) {
			budgetExhausted = true;
			status = "budget_exhausted";
			interventions.push(interventionFor(delta, "inconclusive", "probe_budget_exhausted", null));
			continue;
		}

		const appliedRequest = applyCounterfactualDelta(baseRequest, delta, "after");
		const revertedRequest = applyCounterfactualDelta(candidateRequest, delta, "before");
		if (!mutatingAllowed && (!isSafeMethod(appliedRequest.method) || !isSafeMethod(revertedRequest.method))) {
			interventions.push(interventionFor(delta, "not_replayable", "mutating_method_not_approved", null));
			continue;
		}

		let appliedResult;
		let revertedResult;
		try {
			appliedResult = await runProbe(appliedRequest);
			revertedResult = await runProbe(revertedRequest);
		} catch (error) {
			if (error?.code === "COUNTERFACTUAL_BUDGET") {
				budgetExhausted = true;
				status = "budget_exhausted";
				interventions.push(interventionFor(delta, "inconclusive", "probe_budget_exhausted", null));
				continue;
			}
			throw error;
		}

		const appliedMatched = matchesFailurePredicate(appliedResult, predicate);
		const revertedMatched = matchesFailurePredicate(revertedResult, predicate);
		let classification;
		let reason = null;
		if (appliedMatched && !revertedMatched) classification = "causal";
		else if (!appliedMatched && revertedMatched) classification = "not_causal";
		else {
			classification = "inconclusive";
			reason = "contradictory_evidence";
		}

		interventions.push(
			interventionFor(delta, classification, reason, {
				applied: evidence(appliedResult, appliedMatched),
				reverted: evidence(revertedResult, revertedMatched),
			}),
		);
	}

	return buildResult({
		baseExecutionId,
		candidateExecutionId,
		predicate,
		budget,
		probesUsed,
		budgetExhausted,
		status,
		reason: null,
		baseline,
		interventions,
	});
}
