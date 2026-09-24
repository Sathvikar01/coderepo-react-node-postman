// Phase 44 — Branch Reconciliation + Core Integration.
//
// Public boundary for the thin integration seam between the three independent
// backend cores that were merged into `main` by this phase:
//
//   Phase 39 — Change Impact            (backend/src/features/change-impact)
//   Phase 40 — Environment Drift        (backend/src/features/environment-drift)
//   Phase 41 — Cross-Environment Verif. (backend/src/features/cross-env-verification)
//
// It exists for exactly one reason and adds exactly one thing.
//
// Phase 41 was authored before 39/40 merged, so it consumes their *public result
// envelopes structurally* through `createCrossEnvVerifier`, but its own input
// contract is a `.strict()` Zod schema: the extra envelope fields Phase 39 and 40
// emit (`kind`, `schemaVersion`, `change`, `impact`, `collections`, `folders`,
// `assertions`, `source`, `target`) are rejected. Handing a raw Phase 39/40 result
// straight to `verifyCrossEnvironment` therefore fails closed with
// `CROSS_ENV_VERIFICATION_INVALID_INPUT`.
//
// This module is a *projection* adapter, not a re-implementation:
//
//   * it does not move any logic out of Phase 39/40 or Phase 41;
//   * it does not compute impact or drift itself;
//   * it does not relax Phase 41's fail-closed validation;
//   * it converts a missing/malformed core result into the exact "absent" value
//     Phase 41 already treats as a blocker, so `missing/unknown evidence` can never
//     become `VERIFIED`.
//
// The projection is deliberately lossy in the same way Phase 41's own internal
// `normalizeImpact` / `normalizeDrift` are: only the fields the engine reads
// survive. That keeps the two cores free to evolve their full envelopes without
// breaking verification.

import { analyzeWorkspaceDiff } from "../change-impact/index.js";
import { analyzeEnvironmentDrift } from "../environment-drift/index.js";
import { verifyCrossEnvironment } from "../cross-env-verification/index.js";

export const CORE_INTEGRATION_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Shape guards
// ---------------------------------------------------------------------------
//
// The guards answer a single question: "did a real Phase 39/40 core produce this,
// or is this something else?" A result that fails the guard is treated as missing,
// which Phase 41 already converts into a blocker. They are intentionally the same
// predicates Phase 41 exports, re-used rather than re-derived, so the two sides
// cannot drift apart.

function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasImpactEnvelope(value) {
	return (
		isObject(value) &&
		value.kind === "tracer.change-impact" &&
		isObject(value.requests) &&
		Array.isArray(value.requests.direct) &&
		Array.isArray(value.requests.indirect)
	);
}

function hasDiffEnvelope(value) {
	return (
		isObject(value) &&
		value.kind === "tracer.change-impact.diff" &&
		Array.isArray(value.changes) &&
		value.changes.length > 0 &&
		value.changes.every(hasImpactEnvelope)
	);
}

function hasDriftEnvelope(value) {
	return (
		isObject(value) &&
		value.kind === "tracer.environment-drift" &&
		typeof value.identical === "boolean" &&
		isObject(value.summary) &&
		Array.isArray(value.drift)
	);
}

// ---------------------------------------------------------------------------
// Projections into the Phase 41 input contract
// ---------------------------------------------------------------------------

// Project a Phase 39 impact result (or the first resolved impact inside a
// workspace-diff envelope) into the exact subset Phase 41 reads. Returns `null`
// when no valid result was produced, so Phase 41 reports CHANGE_IMPACT_MISSING
// instead of silently verifying against an empty affected set.
export function projectChangeImpact(changeImpact) {
	const source = hasDiffEnvelope(changeImpact) ? changeImpact.changes[0] : changeImpact;
	if (!hasImpactEnvelope(source)) return null;
	const rows = (list) =>
		(Array.isArray(list) ? list : []).map((row) => ({
			requestId: row?.requestId === undefined || row?.requestId === null ? null : String(row.requestId),
			nodeKind: row?.nodeKind === undefined ? undefined : String(row.nodeKind),
			impact: row?.impact,
			hop: row?.hop,
			confidence: row?.confidence,
		}));
	return {
		resolved: source.resolved ?? null,
		truncated: source.truncated === true,
		// Phase 41 reads only these three summary counts; Phase 39's envelope carries
		// five more. Projecting the subset keeps the two contracts independent.
		summary: source.summary
			? {
					directRequests: source.summary.directRequests,
					indirectRequests: source.summary.indirectRequests,
					unknownReferences: source.summary.unknownReferences,
				}
			: undefined,
		requests: {
			direct: rows(source.requests.direct),
			indirect: rows(source.requests.indirect),
		},
		unknown: (Array.isArray(source.unknown) ? source.unknown : []).map((reference) => ({
			code: String(reference?.code ?? "unknown"),
			requestId: reference?.requestId === undefined || reference?.requestId === null ? null : String(reference.requestId),
			collectionId:
				reference?.collectionId === undefined || reference?.collectionId === null ? null : String(reference.collectionId),
		})),
	};
}

// Project a Phase 40 drift result into the subset Phase 41 reads. Returns `null`
// when no valid result was produced, which Phase 41 treats as a missing
// comparison and therefore a blocker.
export function projectEnvironmentDrift(environmentDrift) {
	if (!hasDriftEnvelope(environmentDrift)) return null;
	return {
		identical: environmentDrift.identical,
		summary: environmentDrift.summary ? { ...environmentDrift.summary } : undefined,
		drift: environmentDrift.drift.map((entry) => ({
			category: String(entry.category),
			path: entry.path === undefined ? undefined : String(entry.path),
			severity: String(entry.severity),
			status: entry.status === undefined ? undefined : String(entry.status),
		})),
	};
}

// ---------------------------------------------------------------------------
// Composition source
// ---------------------------------------------------------------------------
//
// A pair of factories in the shape `createCrossEnvVerifier` expects. Each one
// runs a real Phase 39/40 analysis and then projects the envelope, so the seam
// consumes the shipped cores through their public services only.

// input: { before, after, changes?, environmentId?, maxDepth? }  -> Phase 39 result
export function changeImpactFromWorkspaceDiff(input) {
	return projectChangeImpact(analyzeWorkspaceDiff(input ?? {}));
}

// input: { collection, sourceEnvironment, targetEnvironment }     -> Phase 40 result
export function environmentDriftFromEnvironments(input) {
	return projectEnvironmentDrift(analyzeEnvironmentDrift(input ?? {}));
}

// ---------------------------------------------------------------------------
// The integrated verifier
// ---------------------------------------------------------------------------
//
// `verifyMove` is the Phase 44 entry point: hand it a workspace diff and two
// environment states, plus evidence, and it runs Snapshot/Diff -> Change Impact ->
// Environment Drift -> Cross-Environment Verification through the public services
// of each core. Explicit `changeImpact` / `environmentDrift` results, if supplied,
// win, so callers can pass pre-computed cores without re-running them.
//
// A caller may also pass raw Phase 39/40 envelopes directly; they are projected
// here. This is the behaviour the raw pass-through lacks.

export function verifyMove(payload = {}) {
	const { workspaceDiff, environments, changeImpact, environmentDrift, ...rest } = payload ?? {};

	let projectedImpact;
	if (changeImpact !== undefined && changeImpact !== null) {
		projectedImpact = projectChangeImpact(changeImpact);
		// A supplied-but-unusable result stays unusable: never fall back to running
		// the cores, because that would hide a caller error behind fresh analysis.
		if (projectedImpact === null) {
			throw new TypeError("verifyMove received a changeImpact value that is not a Phase 39 result.");
		}
	} else if (workspaceDiff) {
		projectedImpact = changeImpactFromWorkspaceDiff(workspaceDiff);
	} else {
		projectedImpact = null;
	}

	let projectedDrift;
	if (environmentDrift !== undefined && environmentDrift !== null) {
		projectedDrift = projectEnvironmentDrift(environmentDrift);
		if (projectedDrift === null) {
			throw new TypeError("verifyMove received an environmentDrift value that is not a Phase 40 result.");
		}
	} else if (environments) {
		projectedDrift = environmentDriftFromEnvironments(environments);
	} else {
		projectedDrift = null;
	}

	// Call the pure engine directly rather than `createCrossEnvVerifier`. The seam
	// throws when both results are absent because it exists to wire sources; here
	// an absent core result must reach the engine as "missing", which the engine
	// already turns into a blocker. That keeps `missing evidence != VERIFIED`.
	return verifyCrossEnvironment({ ...rest, changeImpact: projectedImpact, environmentDrift: projectedDrift });
}

export { hasImpactEnvelope, hasDiffEnvelope, hasDriftEnvelope };
