import { REASON_CODES } from "./verification-schema.js";

// Phase 41A — Evidence normalization.
//
// Everything a caller supplies as "proof" passes through here before a rule is
// allowed to look at it. Two jobs:
//
//   1. Binding. An evidence record is admitted only when it is bound to the exact
//      snapshot fingerprint (or snapshot id) and environment identity of the side
//      it claims to verify. Loose matching is refused: "same request name" is not
//      identity, and evidence that cannot prove which version/environment it ran
//      against cannot verify this move.
//
//   2. Deterministic dedupe. Duplicate records collapse to one canonical record,
//      chosen by a stable, documented priority, so the engine's output never
//      depends on input order or on a caller accidentally sending a record twice.
//
// Nothing here reads or executes anything.

// Admissibility of one evidence record against the target side.
export const BINDING = Object.freeze({
	ACCEPTED: "accepted",
	WRONG_SNAPSHOT: "wrong-snapshot",
	WRONG_ENVIRONMENT: "wrong-environment",
	WRONG_WORKSPACE: "wrong-workspace",
	STALE: "stale",
});

function normalizeId(value) {
	if (value === undefined || value === null) return null;
	const text = String(value);
	return text.length > 0 ? text : null;
}

function instantOf(value) {
	if (value === undefined || value === null) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
	const parsed = Date.parse(String(value));
	return Number.isNaN(parsed) ? null : parsed;
}

// The moment an evidence record is considered to describe. Prefers the finish
// time, then the start time, then the observation time. A record with no usable
// timestamp has no age and therefore cannot be judged stale — it is judged by its
// bindings only.
export function evidenceInstant(evidence) {
	return instantOf(evidence.finishedAt) ?? instantOf(evidence.startedAt) ?? instantOf(evidence.observedAt) ?? null;
}

// Canonical, order-independent key for a record. Two records with the same key
// are duplicates.
function evidenceKey(evidence) {
	// The stable identity of a record is its own id plus its request, so distinct
	// records never collapse while a repeated reference to the same record does.
	return [evidence.kind, evidence.id, evidence.requestId].join("\u0000");
}

function toExecutionEvidence(raw) {
	return {
		kind: "execution",
		id: raw.executionId,
		requestId: raw.requestId,
		collectionId: normalizeId(raw.collectionId),
		workspaceId: normalizeId(raw.workspaceId),
		snapshotFingerprint: normalizeId(raw.snapshotFingerprint),
		snapshotId: normalizeId(raw.snapshotId),
		environmentId: normalizeId(raw.environmentId),
		environmentName: normalizeId(raw.environmentName),
		outcome: raw.outcome,
		// A record is complete unless the caller explicitly says otherwise. Only
		// "incomplete" or a non-terminal outcome can make it incomplete.
		complete: raw.complete !== false && raw.outcome !== "incomplete",
		outcomeTerminal: !["incomplete", "running", "pending"].includes(raw.outcome),
		finishedAt: normalizeId(raw.finishedAt ?? null),
		startedAt: normalizeId(raw.startedAt ?? null),
		assertions: raw.assertions ?? null,
		assertionRecordCount: null,
	};
}

function toAssertionEvidence(raw) {
	return {
		kind: "assertion",
		id: raw.assertionId,
		requestId: raw.requestId,
		collectionId: normalizeId(raw.collectionId),
		workspaceId: null,
		snapshotFingerprint: normalizeId(raw.snapshotFingerprint),
		snapshotId: normalizeId(raw.snapshotId),
		environmentId: normalizeId(raw.environmentId),
		environmentName: null,
		status: raw.status,
		required: raw.required !== false,
		observedAt: normalizeId(raw.observedAt ?? null),
		complete: true,
		outcome: raw.status === "passed" ? "response" : "failed",
		outcomeTerminal: true,
		finishedAt: normalizeId(raw.observedAt ?? null),
		startedAt: null,
		assertions: null,
		assertionRecordCount: 1,
	};
}

// Dedupe priority when the same key appears more than once. A record that proves
// more (a failure) must win over one that proves less, because dropping a failure
// would let a duplicate "passed" record silently verify the request.
function evidencePriority(evidence) {
	if (evidence.kind === "assertion") {
		return evidence.status === "failed" ? 3 : evidence.status === "error" ? 2 : 1;
	}
	if (evidence.outcome !== "response") return 3;
	if (evidence.assertions && (evidence.assertions.failed ?? 0) > 0) return 3;
	if (evidence.assertions && (evidence.assertions.errors ?? 0) > 0) return 2;
	return 1;
}

function dedupeSortKey(evidence) {
	return [evidenceKey(evidence), evidence.id, evidence.requestId].join("\u0000");
}

// Collapse duplicates deterministically. When two records share a key, the one
// with the highest priority wins; ties are broken by the canonical sort key so the
// survivor does not depend on input order.
//
// Every record is wrapped once as `{ evidence, raw }` so the engine reads a single
// normalized shape while the original value stays available. `evidence` holds the
// normalized fields; `raw` is the value the caller supplied.
export function dedupeEvidence(records) {
	const byKey = new Map();
	for (const record of records) {
		const key = evidenceKey(record.evidence);
		const current = byKey.get(key);
		if (!current) {
			byKey.set(key, record);
			continue;
		}
		const currentPriority = evidencePriority(current.evidence);
		const nextPriority = evidencePriority(record.evidence);
		if (nextPriority > currentPriority) byKey.set(key, record);
	}
	return [...byKey.values()].sort((left, right) => {
		const leftKey = dedupeSortKey(left.evidence);
		const rightKey = dedupeSortKey(right.evidence);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

// Normalizes caller records into the wrapped shape the rules consume.
export function normalizeEvidence({ executions = [], assertions = [] } = {}) {
	const records = [
		...(executions ?? []).map((raw) => ({ evidence: toExecutionEvidence(raw), raw })),
		...(assertions ?? []).map((raw) => ({ evidence: toAssertionEvidence(raw), raw })),
	];
	return dedupeEvidence(records);
}

// ---------------------------------------------------------------------------
// Binding checks
// ---------------------------------------------------------------------------
//
// Each check is deliberately narrow. A `null` on either side means "the caller
// did not tell us", which is NOT a match — it is an absence of proof, handled as a
// missing binding rather than a passing one.

function sameWhenKnown(left, right) {
	return left !== null && right !== null && left === right;
}

function differsWhenKnown(left, right) {
	return left !== null && right !== null && left !== right;
}

// Snapshot binding. Accepts a fingerprint match OR a snapshot-id match; a record
// that carries a binding that contradicts the target side is rejected outright
// rather than falling through to a weaker match.
export function snapshotBinding(evidence, target) {
	const targetFingerprint = normalizeId(target.snapshotFingerprint);
	const targetId = normalizeId(target.snapshotId);
	const hasTarget = targetFingerprint !== null || targetId !== null;
	if (!hasTarget) return { matched: false, checkable: false };

	if (differsWhenKnown(evidence.snapshotFingerprint, targetFingerprint)) return { matched: false, checkable: true };
	if (differsWhenKnown(evidence.snapshotId, targetId)) return { matched: false, checkable: true };

	if (sameWhenKnown(evidence.snapshotFingerprint, targetFingerprint)) return { matched: true, checkable: true };
	if (sameWhenKnown(evidence.snapshotId, targetId)) return { matched: true, checkable: true };

	return { matched: false, checkable: true };
}

// Environment binding by id, falling back to name only when neither side carries
// an id. Names are weaker, so a name mismatch is only decisive when no ids exist.
export function environmentBinding(evidence, target) {
	const targetId = normalizeId(target.environmentId);
	const targetName = normalizeId(target.environmentName);
	const hasTarget = targetId !== null || targetName !== null;
	if (!hasTarget) return { matched: false, checkable: false };

	if (differsWhenKnown(evidence.environmentId, targetId)) return { matched: false, checkable: true };
	if (sameWhenKnown(evidence.environmentId, targetId)) return { matched: true, checkable: true };

	if (targetId === null && targetName !== null) {
		if (differsWhenKnown(evidence.environmentName, targetName)) return { matched: false, checkable: true };
		if (sameWhenKnown(evidence.environmentName, targetName)) return { matched: true, checkable: true };
	}

	return { matched: false, checkable: true };
}

// Workspace/collection binding. Evidence gathered from a different collection is
// not evidence about this workspace at all.
export function workspaceBinding(evidence, target) {
	const targetCollection = normalizeId(target.collectionId);
	const targetWorkspace = normalizeId(target.workspaceId);
	if (targetCollection === null && targetWorkspace === null) return { matched: false, checkable: false };
	if (differsWhenKnown(evidence.collectionId, targetCollection)) return { matched: false, checkable: true };
	if (differsWhenKnown(evidence.workspaceId, targetWorkspace)) return { matched: false, checkable: true };
	return { matched: true, checkable: true };
}

// Freshness. Returns `stale: true` only when a policy exists AND the record has a
// usable timestamp older than the cutoff. With no policy, or no timestamp, the
// record is never judged stale.
export function freshnessBinding(evidence, policy) {
	if (!policy) return { stale: false, checkable: false };
	const instant = evidenceInstant(evidence);
	if (instant === null) return { stale: false, checkable: false };
	let cutoff = null;
	if (policy.maxAgeMs !== undefined) {
		const now = instantOf(policy.now) ?? Date.now();
		cutoff = now - policy.maxAgeMs;
	}
	if (policy.staleBefore !== undefined) {
		const explicit = instantOf(policy.staleBefore);
		if (explicit !== null) cutoff = cutoff === null ? explicit : Math.max(cutoff, explicit);
	}
	if (cutoff === null) return { stale: false, checkable: false };
	return { stale: instant < cutoff, checkable: true };
}

// Classify one record against the target side. Order matters: identity failures
// outrank staleness, because "wrong snapshot" is a stronger statement than "old".
export function classifyBinding(evidence, target, policy) {
	const workspace = workspaceBinding(evidence, target);
	if (workspace.checkable && !workspace.matched) return { binding: BINDING.WRONG_WORKSPACE, code: REASON_CODES.EVIDENCE_WRONG_WORKSPACE };

	const snapshot = snapshotBinding(evidence, target);
	if (snapshot.checkable && !snapshot.matched) return { binding: BINDING.WRONG_SNAPSHOT, code: REASON_CODES.EVIDENCE_WRONG_SNAPSHOT };

	const environment = environmentBinding(evidence, target);
	if (environment.checkable && !environment.matched) return { binding: BINDING.WRONG_ENVIRONMENT, code: REASON_CODES.EVIDENCE_WRONG_ENVIRONMENT };

	const freshness = freshnessBinding(evidence, policy);
	if (freshness.stale) return { binding: BINDING.STALE, code: REASON_CODES.EVIDENCE_STALE };

	return { binding: BINDING.ACCEPTED, code: null };
}
