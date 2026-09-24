import { scriptCounts, scriptResultsOf } from "../scripts/script-results.js";

// Stage ids match the Phase 35 investigation record (`stage`) exactly.
export const INVESTIGATION_STAGES = [
	{ id: "preparing", label: "Prepare evidence" },
	{ id: "regression_boundary", label: "Find when it started" },
	{ id: "comparison", label: "Compare with the last good run" },
	{ id: "counterfactual", label: "Verify what caused it" },
	{ id: "minimization", label: "Isolate the smallest reproducer" },
	{ id: "reproducibility", label: "Check it reproduces reliably" },
	{ id: "capsule", label: "Package the reproduction capsule" },
];

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
// Outcomes that must never offer an investigation entry point: a cancelled run
// never failed, and a mock result has no execution record/passport at all.
const NON_INVESTIGATABLE_OUTCOMES = new Set(["cancelled", "mock", "mock_miss"]);
const ERROR_OUTCOMES = new Set(["validation_error", "network_error", "timeout", "size_limit", "decode_error", "interrupted"]);

export function isTerminalStatus(status) {
	return TERMINAL_STATUSES.has(status);
}

export function isRunning(job) {
	return Boolean(job) && job.status === "running";
}

export function stageLabel(stageId) {
	return INVESTIGATION_STAGES.find((stage) => stage.id === stageId)?.label ?? "Prepare evidence";
}

export function shortId(value) {
	if (!value) return "—";
	return String(value).slice(0, 8);
}

/**
 * Deterministic truthfulness labels straight from `InvestigationV1` /
 * `ReproCapsuleV1` label vocabulary. Only `verified_cause` may read as a cause;
 * everything else is explicitly correlation, unverified, or inconclusive.
 */
export const CHANGE_LABELS = {
	verified_cause: "Verified cause",
	leading_divergence: "Leading divergence — the earliest correlated change, not experimentally proven",
	correlated_change: "Correlated change — changed alongside the failure, not proven causal",
	unverified: "Unverified — replayed as an experiment, not proven causal",
	not_replayable: "Not replayable — could not be replayed as an experiment",
	inconclusive: "Inconclusive — the experiment ran but proved nothing",
};

export function changeLabel(label) {
	return CHANGE_LABELS[label] ?? "Unverified difference";
}

/**
 * Backend evidence prose is shown faithfully, except that raw model tokens
 * (`correlated_change`, `leading_divergence`, …) are replaced by their human
 * labels so no raw vocabulary reaches the UI. "inconclusive" is left alone:
 * it is ordinary English, not a raw label.
 */
export function sanitizeEvidenceText(text) {
	if (!text) return "";
	let out = String(text);
	for (const [raw, label] of Object.entries(CHANGE_LABELS)) {
		if (raw === "inconclusive") continue;
		if (out.includes(raw)) out = out.split(raw).join(label.split(" — ")[0].toLowerCase());
	}
	if (out.includes("not_causal")) out = out.split("not_causal").join("not proven causal");
	if (out.includes("verificationStatus")) out = out.split("verificationStatus").join("verification status");
	return out;
}

/**
 * Verified causes come straight from `InvestigationV1.verifiedCauses`. Nothing
 * else in the frontend is allowed to compute or infer causality.
 */
export function verifiedCauseItems(result) {
	return result?.verifiedCauses ?? [];
}

/** Unverified differences come straight from `InvestigationV1.unverifiedChanges`. */
export function unverifiedChangeItems(result) {
	return result?.unverifiedChanges ?? [];
}

export function predicateLine(predicate) {
	if (!predicate) return "Failure predicate not available";
	if (predicate.display) return predicate.display;
	if (predicate.type === "assertion") return `Assertion ${predicate.assertionId} fails`;
	if (predicate.type === "status") return `Response status is ${predicate.equals}`;
	return `Execution outcome is ${predicate.equals}`;
}

/**
 * The failure predicate as derivable from a recorded execution receipt.
 * Mirrors the backend `failurePredicateForRecord` order exactly: failing
 * assertions first, then response status, then outcome. The receipt keeps
 * failing tests only as counts plus a fingerprint, so the assertion branch
 * reports that assertions failed without inventing an assertion id. This
 * displays the recorded failure of the source run; it makes no causal claim.
 */
export function failurePredicateForReceipt(receipt) {
	if (!receipt) return null;
	const counts = receipt.tests?.counts ?? {};
	if ((counts.failed ?? 0) > 0 || (counts.error ?? 0) > 0) {
		return { type: "assertion", display: "Request assertions fail" };
	}
	if (typeof receipt.response?.contract?.status === "number") {
		return { type: "status", equals: receipt.response.contract.status };
	}
	return { type: "outcome", equals: receipt.outcome ?? "unknown" };
}

/** Regression boundary (Phase 33 timeline), shown without embellishment. */
export function boundaryLine(boundary) {
	if (!boundary) return "Boundary not determined.";
	if (boundary.unresolved?.message) return sanitizeEvidenceText(boundary.unresolved.message);
	if (boundary.resolved) {
		return `Failure begins between passing run ${shortId(boundary.goodExecutionId)} and failing run ${shortId(boundary.failingExecutionId)}.`;
	}
	return "Boundary not determined.";
}

export function minimizationLine(minimization) {
	if (!minimization) return "Minimization was not run.";
	if (minimization.status === "skipped") {
		const reason = minimization.reason === "unsafe_method" ? "skipped — mutating requests are not replayed" : `skipped — ${sanitizeEvidenceText(minimization.reason) || "not applicable"}`;
		return `Minimization ${reason}.`;
	}
	if (minimization.status === "cancelled") return "Minimization was cancelled.";
	if (minimization.status === "failed") return `Minimization failed — ${sanitizeEvidenceText(minimization.error?.message ?? minimization.reason) || "unknown error"}.`;
	const minimality = { one_minimal: "no smaller reproducer exists", budget_limited: "stopped at the probe budget", inconclusive: "minimality not established" }[minimization.minimality] ?? minimization.minimality;
	return `Removed ${minimization.removed?.length ?? 0} of ${minimization.originalComponentCount ?? 0} structural inputs in ${minimization.probesUsed ?? 0} probes — ${minimality}.`;
}

export function reproducibilityLine(reproducibility) {
	if (!reproducibility) return "Reproducibility was not checked.";
	if (reproducibility.statement) return sanitizeEvidenceText(reproducibility.statement);
	if (reproducibility.status === "skipped") return `Reproducibility check skipped — ${sanitizeEvidenceText(reproducibility.reason) || "not applicable"}.`;
	if (reproducibility.status === "cancelled") return "Reproducibility check was cancelled.";
	if (reproducibility.status === "failed") return `Reproducibility check failed — ${sanitizeEvidenceText(reproducibility.error?.message) || "unknown error"}.`;
	return "Reproducibility was not checked.";
}

export function capsuleLine(capsule) {
	if (capsule?.available && capsule.text) {
		const inputs = capsule.requiredInputs?.length ?? 0;
		return `Available — ${capsule.requestSource ?? "failing"} request, ${inputs} required input${inputs === 1 ? "" : "s"} documented, secrets redacted.`;
	}
	return "No reproduction capsule was produced for this investigation.";
}

export function investigationStatusBanner(job) {
	if (!job) return null;
	if (job.status === "running") return { tone: "info", text: `Investigation running — ${stageLabel(job.stage)}…` };
	if (job.status === "failed") return { tone: "danger", text: job.error?.message || "Investigation failed." };
	if (job.status === "cancelled") return { tone: "warning", text: "Investigation cancelled." };
	const causes = verifiedCauseItems(job.result).length;
	return causes > 0
		? { tone: "success", text: `Investigation complete — ${causes} verified cause${causes === 1 ? "" : "s"} identified.` }
		: { tone: "warning", text: "Investigation complete — no change was verified as the cause." };
}

export function investigationErrorMessage(error) {
	const code = error?.code;
	const messages = {
		INVESTIGATION_TARGET_NOT_FOUND: "The failing run is no longer in history, so there is nothing to investigate.",
		INVESTIGATION_BASELINE_NOT_FOUND: "The chosen good run is no longer in history. Pick another or let the boundary resolver choose.",
		INVESTIGATION_INPUT_INVALID: "The investigation input was not valid.",
		INVESTIGATION_INVALID: "The investigation result failed strict validation and was not accepted.",
		INVESTIGATION_NOT_FOUND: "The investigation is no longer available.",
		INVESTIGATION_INTERRUPTED: "The server restarted before the investigation completed. Start it again.",
		CAPSULE_UNAVAILABLE: "No reproduction capsule is available for this investigation.",
		RECEIPT_UNAVAILABLE: "This run has no execution passport, so it cannot be investigated. Send the request normally to record one.",
		HISTORY_NOT_FOUND: "The failing run is no longer in history, so there is nothing to investigate.",
	};
	if (code && messages[code]) return messages[code];
	return error?.message || "The investigation could not be started.";
}

export function hasFailingTests(result) {
	const summary = scriptCounts(scriptResultsOf(result));
	return summary.failed > 0;
}

export function isFailureResult(result) {
	if (!result || result.mock) return false;
	if (NON_INVESTIGATABLE_OUTCOMES.has(result.outcome)) return false;
	if (typeof result.response?.status === "number" && result.response.status >= 400) return true;
	if (ERROR_OUTCOMES.has(result.outcome)) return true;
	return hasFailingTests(result);
}

/**
 * History rows: only genuine failures. A cancelled row never failed even when a
 * status code was captured before cancelling, and mock results have no
 * execution record, so neither offers the entry point.
 */
export function canInvestigateHistoryItem(item) {
	if (!item || item.status === "running") return false;
	if (NON_INVESTIGATABLE_OUTCOMES.has(item.outcome)) return false;
	if (typeof item.statusCode === "number" && item.statusCode >= 400) return true;
	return ERROR_OUTCOMES.has(item.outcome);
}

/**
 * Collection Runner steps: only failed steps that produced an execution record
 * (with a passport). Admission/validation failures have `executionId === null`
 * and are not investigatable.
 */
export function canInvestigateStep(step) {
	if (!step || step.status !== "failed") return false;
	if (!step.executionId) return false;
	return step.outcome !== "cancelled";
}
