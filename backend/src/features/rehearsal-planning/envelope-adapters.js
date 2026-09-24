// Phase 46A — adapters over the consumed result envelopes.
//
// The planner does not re-implement change impact, environment drift, or
// blast-radius admission. It reads the public result envelopes those cores
// already produce and projects them into the few facts planning needs:
//
//   * which requests are impacted, how, and how confidently
//   * whether the drift analysis is present and whether it is decisive
//   * what the blast-radius policy already decided for each request
//
// Every adapter is total over valid envelopes and fails closed on anything it
// cannot read: an unreadable envelope yields "absent", never a permissive
// default. No requests are filtered, resolved, or dispatched here.

import { DEPENDENCY_KINDS } from "./reason-codes.js";
import { comparePlanStrings } from "./plan-identity.js";

function idOf(value) {
	if (value === undefined || value === null) return null;
	const text = String(value).trim();
	return text.length > 0 ? text : null;
}

// ---------------------------------------------------------------------------
// Change impact
// ---------------------------------------------------------------------------

// Project the impact envelope into a per-request impact record. A request appears
// at most once; the strongest claim wins (direct beats indirect, higher confidence
// beats lower). Rows without a requestId are ignored rather than guessed.
export function projectImpact(impact) {
	if (!impact || typeof impact !== "object") {
		return { present: false, resolved: null, truncated: null, byRequest: new Map(), unknownReferences: 0 };
	}

	const byRequest = new Map();
	const record = (row, bucket) => {
		const requestId = idOf(row?.requestId);
		if (!requestId) return;
		const impactKind = row?.impact === "direct" || row?.impact === "indirect" ? row.impact : bucket;
		const confidence =
			row?.confidence === "exact" || row?.confidence === "conditional" || row?.confidence === "unknown"
				? row.confidence
				: "exact";
		const hop = Number.isInteger(row?.hop) ? row.hop : impactKind === "direct" ? 1 : 2;

		const existing = byRequest.get(requestId);
		if (!existing) {
			byRequest.set(requestId, {
				requestId,
				impact: impactKind,
				confidence,
				hop,
				collectionId: idOf(row?.collectionId),
			});
			return;
		}
		// Direct beats indirect.
		if (impactKind === "direct" && existing.impact !== "direct") {
			existing.impact = "direct";
			existing.hop = hop;
		} else if (impactKind === existing.impact) {
			existing.hop = Math.min(existing.hop, hop);
		}
		// Higher confidence wins.
		const rank = { unknown: 0, conditional: 1, exact: 2 };
		if (rank[confidence] > rank[existing.confidence]) existing.confidence = confidence;
		if (!existing.collectionId && idOf(row?.collectionId)) existing.collectionId = idOf(row?.collectionId);
	};

	for (const row of impact?.requests?.direct ?? []) record(row, "direct");
	for (const row of impact?.requests?.indirect ?? []) record(row, "indirect");
	for (const row of impact?.impact?.direct ?? []) record(row, "direct");
	for (const row of impact?.impact?.indirect ?? []) record(row, "indirect");

	const unknownCount = Array.isArray(impact.unknown) ? impact.unknown.length : 0;

	return {
		present: true,
		resolved: typeof impact.resolved === "boolean" ? impact.resolved : null,
		truncated: typeof impact.truncated === "boolean" ? impact.truncated : null,
		byRequest,
		unknownReferences: unknownCount,
	};
}

// ---------------------------------------------------------------------------
// Environment drift
// ---------------------------------------------------------------------------

// Project the drift envelope into a stable, secret-free summary. The planner only
// needs to know whether drift evidence exists and whether it is decisive; it
// never inspects the projected states, which may carry configuration values.
//
// `unknown` drift (an entry whose status is "unknown", or any high-severity entry)
// is NOT treated as safe: it is surfaced so the planner can keep it explicit.
export function projectDrift(drift) {
	if (!drift || typeof drift !== "object") {
		return {
			present: false,
			identical: null,
			total: 0,
			highSeverity: 0,
			unknownStatus: 0,
			decisive: false,
			sourceEnvironmentId: null,
			targetEnvironmentId: null,
		};
	}

	const entries = Array.isArray(drift.drift) ? drift.drift : [];
	let highSeverity = 0;
	let unknownStatus = 0;
	for (const entry of entries) {
		if (entry?.severity === "high") highSeverity += 1;
		if (entry?.status === "unknown") unknownStatus += 1;
	}
	if (!entries.length && drift.summary && typeof drift.summary.bySeverity === "object" && drift.summary.bySeverity) {
		highSeverity = drift.summary.bySeverity.high ?? 0;
	}

	const total = Number.isInteger(drift.summary?.total) ? drift.summary.total : entries.length;
	const identical = typeof drift.identical === "boolean" ? drift.identical : null;

	return {
		present: true,
		identical,
		total,
		highSeverity,
		unknownStatus,
		// "Decisive" means the drift analysis itself reports a difference that
		// cannot be ignored. It does not by itself block planning; it is surfaced.
		decisive: identical === false || highSeverity > 0 || unknownStatus > 0,
		sourceEnvironmentId: idOf(drift.source?.environmentId),
		targetEnvironmentId: idOf(drift.target?.environmentId),
	};
}

// ---------------------------------------------------------------------------
// Blast radius
// ---------------------------------------------------------------------------

// Project the blast-radius envelope into a per-request admission decision. The
// planner copies the Phase 45 admission state and reason codes verbatim; it
// never recomputes or overrides them. Requests absent from the envelope are
// recorded as "no decision", which is NOT "admitted".
export function projectBlastRadius(blastRadius) {
	if (!blastRadius || typeof blastRadius !== "object") {
		return {
			present: false,
			policyIdentity: null,
			admissionState: null,
			workspaceId: null,
			snapshotId: null,
			targetEnvironmentId: null,
			environmentId: null,
			byRequest: new Map(),
		};
	}

	const byRequest = new Map();
	const put = (entry) => {
		const requestId = idOf(entry?.requestId);
		if (!requestId) return;
		byRequest.set(requestId, {
			requestId,
			admission: entry.admission,
			reasonCodes: Array.isArray(entry.reasonCodes) ? [...entry.reasonCodes].sort(comparePlanStrings) : [],
			host: entry.host ?? null,
			hostKey: entry.hostKey ?? null,
			port: Number.isInteger(entry.port) ? entry.port : null,
			method: entry.method ?? null,
			classification: entry.classification ?? null,
			mutating: entry.mutating === true,
		});
	};

	for (const entry of blastRadius.allowedRequests ?? []) put(entry);
	for (const entry of blastRadius.blockedRequests ?? []) put(entry);
	for (const entry of blastRadius.unknownRequests ?? []) put(entry);
	for (const entry of blastRadius.confirmationRequests ?? []) put(entry);
	for (const entry of blastRadius.entries ?? []) put(entry);

	return {
		present: true,
		policyIdentity: idOf(blastRadius.policy?.identity),
		admissionState: idOf(blastRadius.admissionState),
		workspaceId: idOf(blastRadius.workspace?.workspaceId),
		snapshotId: idOf(blastRadius.workspace?.snapshotId),
		environmentId: idOf(blastRadius.environment?.environmentId),
		targetEnvironmentId: idOf(blastRadius.environment?.targetEnvironmentId),
		byRequest,
	};
}

// Cross-check the blast-radius envelope against the plan's own identity. A
// mismatch is surfaced, never silently accepted: admitting a plan against a
// policy evaluated for a different workspace/snapshot/target would be wrong.
export function blastRadiusIdentityMismatch(projected, { workspaceId, snapshotId, snapshotFingerprint, targetEnvironmentId }) {
	const mismatches = [];
	if (!projected.present) return mismatches;

	if (projected.workspaceId && projected.workspaceId !== workspaceId) {
		mismatches.push({ field: "workspaceId", expected: workspaceId, actual: projected.workspaceId });
	}
	const planSnapshot = snapshotId ?? snapshotFingerprint ?? null;
	if (projected.snapshotId && planSnapshot && projected.snapshotId !== planSnapshot) {
		mismatches.push({ field: "snapshotId", expected: planSnapshot, actual: projected.snapshotId });
	}
	if (projected.targetEnvironmentId && targetEnvironmentId && projected.targetEnvironmentId !== targetEnvironmentId) {
		mismatches.push({
			field: "targetEnvironmentId",
			expected: targetEnvironmentId,
			actual: projected.targetEnvironmentId,
		});
	}
	return mismatches;
}

export { DEPENDENCY_KINDS };
