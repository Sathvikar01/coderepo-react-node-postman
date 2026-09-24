import {
	CROSS_ENV_VERIFICATION_KIND,
	CROSS_ENV_VERIFICATION_SCHEMA_VERSION,
	VERIFICATION_STATE,
	assertVerificationResult,
} from "./verification-schema.js";
import { sortFindings, sortedIds } from "./ordering.js";

// Phase 41A — Result construction.
//
// Turns the raw rule output into the stable, machine-readable envelope the phase
// promises. There is no prose here: every entry is an id, a count, or a reason
// code. Ordering is imposed once, at the end, so byte-stability does not depend on
// the order any rule fired.

// State priority when several rules want to speak. BLOCKED outranks
// NEEDS_REHEARSAL because positive evidence of failure is stronger than absence of
// evidence; UNKNOWN is reserved for inputs that were structurally insufficient.
const STATE_PRIORITY = {
	[VERIFICATION_STATE.BLOCKED]: 3,
	[VERIFICATION_STATE.NEEDS_REHEARSAL]: 2,
	[VERIFICATION_STATE.UNKNOWN]: 1,
	[VERIFICATION_STATE.VERIFIED]: 0,
};

function normalizeSide(side) {
	return {
		workspaceId: side.workspaceId ?? null,
		collectionId: side.collectionId ?? null,
		snapshotId: side.snapshotId ?? null,
		snapshotFingerprint: side.snapshotFingerprint ?? null,
		environmentId: side.environmentId ?? null,
		environmentName: side.environmentName ?? null,
		label: side.label ?? null,
	};
}

function dedupeFindings(findings) {
	const byKey = new Map();
	for (const finding of findings) {
		const key = [finding.code, finding.requestId ?? "", finding.evidenceId ?? "", finding.collectionId ?? ""].join("\u0000");
		if (!byKey.has(key)) byKey.set(key, finding);
	}
	return [...byKey.values()];
}

// Resolve the final state from the rule output and the structural completeness of
// the inputs.
export function resolveState({ blockers, warnings, rehearsal, verdicts, identitySufficient }) {
	if (!identitySufficient) return VERIFICATION_STATE.UNKNOWN;
	if (blockers.length > 0) return VERIFICATION_STATE.BLOCKED;

	// No blockers, but the rehearsal set could not be trusted to be complete.
	if (!rehearsal.available || !rehearsal.complete) return VERIFICATION_STATE.UNKNOWN;

	// Every request in the required set must be VERIFIED for a positive result.
	for (const requestId of rehearsal.required) {
		if ((verdicts.get(requestId) ?? "unverified") !== "verified") return VERIFICATION_STATE.NEEDS_REHEARSAL;
	}

	// A drive-by warning about an empty rehearsal set is only informational; it does
	// not demote a state that has no other objection.
	return VERIFICATION_STATE.VERIFIED;
}

export function combineStates(...states) {
	let chosen = VERIFICATION_STATE.VERIFIED;
	for (const state of states) {
		if ((STATE_PRIORITY[state] ?? 0) > (STATE_PRIORITY[chosen] ?? 0)) chosen = state;
	}
	return chosen;
}

export function buildVerificationResult({
	state,
	source,
	target,
	blockers = [],
	warnings = [],
	affectedRequestIds = [],
	requiredRehearsalRequestIds = [],
	verifiedRequestIds = [],
	acceptedEvidenceIds = [],
	rejectedEvidenceIds = [],
	staleEvidenceIds = [],
}) {
	const sortedBlockers = sortFindings(dedupeFindings(blockers));
	const sortedWarnings = sortFindings(dedupeFindings(warnings));
	const affected = sortedIds(affectedRequestIds);
	const required = sortedIds(requiredRehearsalRequestIds);
	const verified = sortedIds(verifiedRequestIds);
	const accepted = sortedIds(acceptedEvidenceIds);
	const rejected = sortedIds(rejectedEvidenceIds);
	const stale = sortedIds(staleEvidenceIds);

	const result = {
		schemaVersion: CROSS_ENV_VERIFICATION_SCHEMA_VERSION,
		kind: CROSS_ENV_VERIFICATION_KIND,
		state,
		source: normalizeSide(source),
		target: normalizeSide(target),
		blockers: sortedBlockers,
		warnings: sortedWarnings,
		affectedRequestIds: affected,
		requiredRehearsalRequestIds: required,
		verifiedRequestIds: verified,
		acceptedEvidenceIds: accepted,
		rejectedEvidenceIds: rejected,
		staleEvidenceIds: stale,
		summary: {
			affectedRequests: affected.length,
			requiredRehearsals: required.length,
			verifiedRequests: verified.length,
			acceptedEvidence: accepted.length,
			rejectedEvidence: rejected.length,
			staleEvidence: stale.length,
			blockers: sortedBlockers.length,
			warnings: sortedWarnings.length,
		},
	};

	// Validate our own output before returning it. A malformed result is a bug, not
	// data, so it fails loudly rather than leaking an inconsistent shape.
	return assertVerificationResult(result);
}
