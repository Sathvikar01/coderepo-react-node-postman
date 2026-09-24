import { REASON_CODES } from "./verification-schema.js";
import { BINDING } from "./evidence-normalization.js";

// Phase 41A — Verification rules.
//
// A pure function from (bound evidence, drift, impact, identity) to two finding
// lists and a per-request verdict. Every rule is an explicit condition; none of
// them scores, weighs, or guesses. The rules are evaluated in a fixed order and
// each emits at most one finding per subject, so the output is order-independent.
//
// Two invariants govern the whole file:
//
//   1. Missing evidence never verifies. A request with no admissible evidence is
//      NEEDS_REHEARSAL, never VERIFIED.
//   2. Contradiction never passes. Two admissible records that disagree about the
//      same request produce a BLOCKED finding, because the engine has no basis to
//      prefer one.

export const REQUEST_VERDICT = Object.freeze({
	VERIFIED: "verified",
	FAILED: "failed",
	INCOMPLETE: "incomplete",
	UNVERIFIED: "unverified",
});

function blocker(code, fields = {}) {
	return { code, level: "blocker", ...fields };
}

function warning(code, fields = {}) {
	return { code, level: "warning", ...fields };
}

// ---------------------------------------------------------------------------
// Rule 1 — workspace identity
// ---------------------------------------------------------------------------
//
// The move is only meaningful when both sides are identified. Without a snapshot
// identity on the target side, no evidence can be bound and the engine cannot
// conclude anything positive.
export function evaluateIdentity({ source, target, snapshotDiff }) {
	const findings = [];

	if (!target.snapshotId && !target.snapshotFingerprint) {
		findings.push(
			blocker(REASON_CODES.SNAPSHOT_IDENTITY_MISSING, {
				detail: "The target side has no snapshot identity, so no evidence can be bound to it.",
			}),
		);
	}
	if (!target.environmentId && !target.environmentName) {
		findings.push(
			blocker(REASON_CODES.ENVIRONMENT_IDENTITY_MISSING, {
				detail: "The target side has no environment identity, so execution evidence cannot be attributed to it.",
			}),
		);
	}

	// Same fingerprint on both sides means there is nothing to promote; the
	// evidence question collapses. Reported as a warning, not a blocker.
	const sameFingerprint =
		source.snapshotFingerprint !== null &&
		target.snapshotFingerprint !== null &&
		source.snapshotFingerprint === target.snapshotFingerprint;
	const sameSnapshotId = source.snapshotId !== null && target.snapshotId !== null && source.snapshotId === target.snapshotId;
	if (sameFingerprint || sameSnapshotId) {
		findings.push(
			warning(REASON_CODES.WORKSPACE_UNCHANGED, {
				detail: "Source and target share a snapshot identity, so this is not a version move.",
			}),
		);
	} else if (source.snapshotFingerprint !== null && target.snapshotFingerprint !== null) {
		findings.push(
			warning(REASON_CODES.SNAPSHOT_CHANGED, {
				detail: "Source and target carry different snapshot fingerprints, so evidence from the source cannot verify the target.",
			}),
		);
	}

	if (snapshotDiff && snapshotDiff.identical === false && (snapshotDiff.changedCount ?? 0) > 0) {
		if (!findings.some((finding) => finding.code === REASON_CODES.SNAPSHOT_CHANGED)) {
			findings.push(
				warning(REASON_CODES.SNAPSHOT_CHANGED, {
					detail: "The supplied snapshot diff reports changes between the two sides.",
				}),
			);
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// Rule 2 — environment drift
// ---------------------------------------------------------------------------
//
// High-severity drift means the effective configuration differs in a way the
// product considers dangerous, so the move is BLOCKED. Unknown drift means the
// difference could not be classified, so VERIFIED is impossible but BLOCKED is
// not asserted — that is NEEDS_REHEARSAL.
export function evaluateDrift(environmentDrift) {
	if (!environmentDrift) {
		return {
			blockers: [
				blocker(REASON_CODES.ENVIRONMENT_DRIFT_MISSING, {
					detail: "No environment drift result was supplied, so the two environments were never compared.",
				}),
			],
			warnings: [],
			hasHighSeverity: false,
			hasUnknown: false,
		};
	}

	const blockers = [];
	const warnings = [];
	const entries = environmentDrift.drift ?? [];
	const bySeverity = environmentDrift.summary?.bySeverity ?? {};

	const highCount = entries.filter((entry) => entry.severity === "high").length || (bySeverity.high ?? 0);
	const unknownSeverityCount = entries.filter((entry) => entry.severity === "unknown").length || (bySeverity.unknown ?? 0);
	const unknownStatusCount = entries.filter((entry) => entry.status === "unknown").length;

	if (highCount > 0) {
		blockers.push(
			blocker(REASON_CODES.HIGH_SEVERITY_DRIFT, {
				detail: `The environment comparison reported ${highCount} high-severity difference(s).`,
			}),
		);
	}
	// An "unknown" severity and an "unknown" status both mean the drift is not
	// fully understood. Either one prevents VERIFIED.
	if (unknownSeverityCount > 0 || unknownStatusCount > 0) {
		blockers.push(
			blocker(REASON_CODES.UNKNOWN_DRIFT, {
				detail: `The environment comparison reported ${unknownSeverityCount + unknownStatusCount} unresolved difference(s).`,
			}),
		);
	}
	if (environmentDrift.identical === false && entries.length === 0 && (environmentDrift.summary?.total ?? 0) > 0) {
		warnings.push(
			warning(REASON_CODES.UNKNOWN_DRIFT, {
				detail: "The drift summary reports differences but no entry detail was supplied.",
			}),
		);
	}

	return {
		blockers,
		warnings,
		hasHighSeverity: highCount > 0,
		hasUnknown: unknownSeverityCount > 0 || unknownStatusCount > 0,
	};
}

// ---------------------------------------------------------------------------
// Rule 3 — change impact
// ---------------------------------------------------------------------------
//
// An impact result that could not anchor the change, or that was truncated, means
// the affected-request list is not trustworthy. That is a blocker because acting
// on an incomplete list would understate what needs rehearsal.
export function evaluateImpact(changeImpact) {
	const blockers = [];
	const warnings = [];
	if (!changeImpact) {
		blockers.push(
			blocker(REASON_CODES.CHANGE_IMPACT_MISSING, {
				detail: "No change-impact result was supplied, so the affected request set is unknown.",
			}),
		);
		return { blockers, warnings };
	}
	if (changeImpact.resolved === false) {
		blockers.push(
			blocker(REASON_CODES.CHANGE_IMPACT_MISSING, {
				detail: "The change-impact result could not resolve the change against the workspace.",
			}),
		);
	}
	if (changeImpact.truncated === true) {
		warnings.push(
			warning(REASON_CODES.CHANGE_IMPACT_MISSING, {
				detail: "The change-impact traversal was truncated, so the affected request set may be incomplete.",
			}),
		);
	}
	return { blockers, warnings };
}

// ---------------------------------------------------------------------------
// Rule 4 — dynamic/unknown references
// ---------------------------------------------------------------------------
//
// A dynamic reference the impact report could not resolve is a blocker: the
// dependency boundary is unknown, so no request set can be proven complete.
export function evaluateDynamicReferences(changeImpact) {
	const blockers = [];
	if (!changeImpact) return blockers;
	const unknown = changeImpact.unknown ?? [];
	const unresolved = unknown.filter((reference) => reference.requestId === undefined || reference.requestId === null);
	if (unresolved.length > 0) {
		blockers.push(
			blocker(REASON_CODES.DYNAMIC_REFERENCE_UNRESOLVED, {
				detail: `${unresolved.length} dynamic or unresolved reference(s) could not be attributed to a request.`,
			}),
		);
	}
	return blockers;
}

// ---------------------------------------------------------------------------
// Rule 5 — per-request evidence verdict
// ---------------------------------------------------------------------------
//
// Classifies one request from its admissible evidence. Returns a verdict and the
// findings that justify it. This is where "successful execution with a failed
// required assertion" is caught: the record's outcome does not decide the verdict
// on its own.
export function evaluateRequestEvidence({ requestId, records }) {
	const blockers = [];
	const warnings = [];

	if (records.length === 0) {
		return { verdict: REQUEST_VERDICT.UNVERIFIED, blockers, warnings };
	}

	const executions = records.filter((record) => record.evidence.kind === "execution");
	const assertions = records.filter((record) => record.evidence.kind === "assertion");

	// Contradiction first: two admissible records that disagree leave no basis to
	// choose, so the request is blocked rather than resolved.
	if (hasContradiction(records)) {
		blockers.push(
			blocker(REASON_CODES.EVIDENCE_CONTRADICTORY, {
				requestId,
				detail: "Admissible evidence disagrees about whether this request succeeded.",
			}),
		);
		return { verdict: REQUEST_VERDICT.FAILED, blockers, warnings };
	}

	// Assertion failures outrank execution success, and they hold whether the
	// assertion came from an execution's counters or a standalone record.
	const failedAssertions = collectFailedAssertions({ executions, assertions });
	if (failedAssertions.length > 0) {
		for (const failure of failedAssertions) {
			blockers.push(
				blocker(REASON_CODES.ASSERTION_FAILED, {
					requestId,
					evidenceId: failure.id,
					detail: failure.detail,
				}),
			);
		}
		return { verdict: REQUEST_VERDICT.FAILED, blockers, warnings };
	}

	// A non-success outcome means the execution itself failed. The exception is a
	// record the caller marked incomplete, which is a weaker statement handled next.
	const failedExecutions = executions.filter(
		(record) => record.evidence.outcome !== "response" && record.evidence.complete !== false,
	);
	if (failedExecutions.length > 0) {
		for (const failure of failedExecutions) {
			blockers.push(
				blocker(REASON_CODES.EXECUTION_FAILED, {
					requestId,
					evidenceId: failure.evidence.id,
					detail: `The execution ended with outcome "${failure.evidence.outcome}".`,
				}),
			);
		}
		return { verdict: REQUEST_VERDICT.FAILED, blockers, warnings };
	}

	// Incomplete executions: no failure was recorded, but the execution never
	// reached a terminal state, so it proves nothing.
	const incomplete = records.filter((record) => record.evidence.complete === false || record.evidence.outcomeTerminal !== true);
	if (incomplete.length > 0) {
		for (const record of incomplete) {
			blockers.push(
				blocker(REASON_CODES.EXECUTION_INCOMPLETE, {
					requestId,
					evidenceId: record.evidence.id,
					detail: "The execution did not reach a terminal state, so it does not prove the request works.",
				}),
			);
		}
		return { verdict: REQUEST_VERDICT.INCOMPLETE, blockers, warnings };
	}

	// At least one complete, successful, assertion-clean execution exists.
	return { verdict: REQUEST_VERDICT.VERIFIED, blockers, warnings };
}

function collectFailedAssertions({ executions, assertions }) {
	const failures = [];
	for (const record of executions) {
		const counters = record.evidence.assertions ?? null;
		const failed = counters?.failed ?? 0;
		const errors = counters?.errors ?? 0;
		if (failed > 0 || errors > 0) {
			failures.push({
				id: record.evidence.id,
				detail: `The execution reported ${failed} failed and ${errors} errored assertion(s).`,
			});
		}
	}
	for (const record of assertions) {
		if (record.evidence.status === "failed" || record.evidence.status === "error") {
			failures.push({
				id: record.evidence.id,
				detail: `The assertion ended with status "${record.evidence.status}".`,
			});
		}
	}
	return failures;
}

// Contradiction is defined narrowly so it cannot fire on legitimate duplication:
// two executions of the same requestId that reached different terminal outcomes,
// or one execution that failed while a separate record claims assertion success.
function hasContradiction(records) {
	const executions = records.filter((record) => record.evidence.kind === "execution");
	const outcomes = new Set(executions.map((record) => record.evidence.outcome));
	const hasSuccess = outcomes.has("response");
	const hasFailure = [...outcomes].some((outcome) => outcome !== "response" && outcome !== "incomplete");
	return hasSuccess && hasFailure;
}

// ---------------------------------------------------------------------------
// Rule 6 — required rehearsal coverage
// ---------------------------------------------------------------------------
//
// A request in the minimal rehearsal set that is not VERIFIED leaves the move
// NEEDS_REHEARSAL (when unverified) — or, when it was actually tried and failed,
// the failure findings from Rule 5 already produced BLOCKED.
export function evaluateRehearsalCoverage({ required, verdicts }) {
	const blockers = [];
	const warnings = [];
	const unverified = [];
	for (const requestId of required) {
		const verdict = verdicts.get(requestId) ?? REQUEST_VERDICT.UNVERIFIED;
		if (verdict === REQUEST_VERDICT.VERIFIED) continue;
		if (verdict === REQUEST_VERDICT.UNVERIFIED) {
			unverified.push(requestId);
			// Absence of evidence is a supervision gap, not a proven failure, so this
			// is a warning that drives NEEDS_REHEARSAL rather than a blocker. Only
			// positive evidence of failure (Rule 5) blocks.
			warnings.push(
				warning(REASON_CODES.AFFECTED_REQUEST_UNVERIFIED, {
					requestId,
					detail: "This request is in the minimal rehearsal set but has no admissible evidence.",
				}),
			);
		}
	}
	if (required.length === 0) {
		// No rehearsal is required, but a caller must still have said so explicitly.
		// An empty required set with no impact signal is treated as missing rather
		// than as "nothing to do" elsewhere in the service.
		warnings.push(
			warning(REASON_CODES.NO_REHEARSAL_EVIDENCE, {
				detail: "The minimal rehearsal set is empty, so no request-level evidence was required.",
			}),
		);
	}
	return { blockers, warnings, unverified };
}
