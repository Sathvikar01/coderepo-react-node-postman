import { AppError } from "../../shared/errors/app-error.js";
import { parseFreshnessPolicy, parseVerificationInput, REASON_CODES, VERIFICATION_STATE, VERIFICATION_STATES } from "./verification-schema.js";
import { BINDING, classifyBinding, normalizeEvidence } from "./evidence-normalization.js";
import { computeRehearsalSet } from "./rehearsal-set.js";
import {
	REQUEST_VERDICT,
	evaluateDrift,
	evaluateDynamicReferences,
	evaluateIdentity,
	evaluateImpact,
	evaluateRehearsalCoverage,
	evaluateRequestEvidence,
} from "./verification-rules.js";
import { buildVerificationResult, resolveState } from "./verification-result.js";

// Phase 41A — Cross-Environment Verification Core public service.
//
// Pure and synchronous. It answers one question — "is this workspace/version
// sufficiently verified to move from environment A to environment B, and what
// blocks verification?" — from evidence the caller supplies. It performs no I/O,
// mutates nothing, and never sends a request. The engine composes the seam later
// phases will use:
//
//   Snapshot -> Diff -> Impact -> Drift -> Rehearsal Execution -> Verification
//
// This phase stops before execution: everything after "rehearsal execution" is a
// caller's job. The engine evaluates evidence; it does not produce it.

function normalizeSideIdentity(side) {
	const source = side ?? {};
	const nullish = (value) => (value === undefined || value === null ? null : String(value));
	return {
		workspaceId: nullish(source.workspaceId),
		collectionId: nullish(source.collectionId),
		snapshotId: nullish(source.snapshotId),
		snapshotFingerprint: nullish(source.snapshotFingerprint),
		environmentId: nullish(source.environmentId),
		environmentName: nullish(source.environmentName),
		label: nullish(source.label),
	};
}

// A caller can pass a Phase 40 drift result straight through: the drift contract's
// envelope carries the same structural fields this engine reads. This adapter only
// guarantees the shape, it does not reinterpret content.
function normalizeDrift(environmentDrift) {
	if (!environmentDrift) return null;
	return {
		identical: environmentDrift.identical ?? null,
		summary: environmentDrift.summary ? { ...environmentDrift.summary } : undefined,
		drift: Array.isArray(environmentDrift.drift)
			? environmentDrift.drift.map((entry) => ({
					category: String(entry.category),
					path: entry.path === undefined ? undefined : String(entry.path),
					severity: String(entry.severity),
					status: entry.status === undefined ? undefined : String(entry.status),
				}))
			: [],
	};
}

// A caller can pass a Phase 39 impact result straight through. Only the request
// rows and unknown list are read.
function normalizeImpact(changeImpact) {
	if (!changeImpact) return null;
	const rows = (list) =>
		Array.isArray(list)
			? list.map((row) => ({
					requestId: row.requestId === undefined || row.requestId === null ? null : String(row.requestId),
					nodeKind: row.nodeKind === undefined ? undefined : String(row.nodeKind),
					impact: row.impact,
					hop: row.hop,
					confidence: row.confidence,
				}))
			: undefined;
	return {
		resolved: changeImpact.resolved ?? null,
		truncated: changeImpact.truncated ?? false,
		summary: changeImpact.summary ? { ...changeImpact.summary } : undefined,
		requests: changeImpact.requests ? { direct: rows(changeImpact.requests.direct), indirect: rows(changeImpact.requests.indirect) } : undefined,
		unknown: Array.isArray(changeImpact.unknown)
			? changeImpact.unknown.map((reference) => ({
					code: String(reference.code),
					requestId: reference.requestId === undefined || reference.requestId === null ? null : String(reference.requestId),
					collectionId: reference.collectionId === undefined || reference.collectionId === null ? null : String(reference.collectionId),
				}))
			: [],
	};
}

// Profile isolation mirrors the rest of the platform: records owned by another
// profile are refused rather than reasoned about.
function assertProfileScope({ ownerProfileId, executions, assertions }) {
	if (!ownerProfileId) return;
	const expected = String(ownerProfileId);
	for (const record of [...(executions ?? []), ...(assertions ?? [])]) {
		const recordProfile = record.ownerProfileId;
		if (recordProfile !== undefined && recordProfile !== null && String(recordProfile) !== expected) {
			throw new AppError(403, "CROSS_ENV_VERIFICATION_PROFILE_MISMATCH", "Verification input contains evidence owned by another profile.", {
				evidenceId: record.executionId ?? record.assertionId ?? null,
			});
		}
	}
}

export function verifyCrossEnvironment(input) {
	const parsed = parseVerificationInput(input);
	assertProfileScope({
		ownerProfileId: parsed.ownerProfileId ?? null,
		executions: input.executions ?? [],
		assertions: input.assertions ?? [],
	});
	const freshness = parseFreshnessPolicy(parsed.freshness ?? null);

	const source = normalizeSideIdentity(parsed.source);
	const target = normalizeSideIdentity(parsed.target);
	const drift = normalizeDrift(parsed.environmentDrift ?? null);
	const impact = normalizeImpact(parsed.changeImpact ?? null);
	const snapshotDiff = parsed.snapshotDiff ?? null;

	// --- Rule 1: identity and workspace change ------------------------------
	const identityFindings = evaluateIdentity({ source, target, snapshotDiff });
	const identitySufficient = Boolean(target.snapshotId || target.snapshotFingerprint) && Boolean(target.environmentId || target.environmentName);

	// --- Rule 2: environment drift -----------------------------------------
	const driftFindings = evaluateDrift(drift);

	// --- Rule 3/4: impact completeness and dynamic references --------------
	const impactFindings = evaluateImpact(impact);
	const dynamicBlockers = evaluateDynamicReferences(impact);

	// --- Evidence normalization and binding --------------------------------
	const allEvidence = normalizeEvidence({ executions: parsed.executions ?? [], assertions: parsed.assertions ?? [] });
	const acceptedEvidence = [];
	const rejectedFindings = [];
	const acceptedIds = [];
	const rejectedIds = [];
	const staleIds = [];

	for (const record of allEvidence) {
		const classification = classifyBinding(record.evidence, target, freshness);
		if (classification.binding === BINDING.ACCEPTED) {
			acceptedEvidence.push(record);
			acceptedIds.push(record.evidence.id);
			continue;
		}
		rejectedIds.push(record.evidence.id);
		if (classification.binding === BINDING.STALE) staleIds.push(record.evidence.id);
		rejectedFindings.push({
			code: classification.code,
			level: "warning",
			requestId: record.evidence.requestId,
			evidenceId: record.evidence.id,
			detail: rejectionDetail(classification.binding),
		});
	}

	// --- Rule 5: per-request verdicts --------------------------------------
	const evidenceByRequest = new Map();
	for (const record of acceptedEvidence) {
		const requestId = record.evidence.requestId;
		if (!evidenceByRequest.has(requestId)) evidenceByRequest.set(requestId, []);
		evidenceByRequest.get(requestId).push(record);
	}

	const verdicts = new Map();
	const requestFindings = [];
	for (const requestId of [...evidenceByRequest.keys()].sort()) {
		const evaluated = evaluateRequestEvidence({ requestId, records: evidenceByRequest.get(requestId) });
		verdicts.set(requestId, evaluated.verdict);
		requestFindings.push(...evaluated.blockers, ...evaluated.warnings);
	}

	// --- Minimal rehearsal set ---------------------------------------------
	const rehearsal = computeRehearsalSet(impact);

	// A request may be affected but never appear in the impact rows the engine can
	// read; the drift's affected reference ids are not request ids, so they are not
	// promoted here. Only the rehearsal set drives required coverage.
	const coverage = evaluateRehearsalCoverage({ required: rehearsal.required, verdicts });

	// --- Assemble findings --------------------------------------------------
	const blockers = [
		...identityFindings.filter((finding) => finding.level === "blocker"),
		...driftFindings.blockers,
		...impactFindings.blockers,
		...dynamicBlockers,
		...requestFindings.filter((finding) => finding.level === "blocker"),
		...coverage.blockers,
	];

	const warnings = [
		...identityFindings.filter((finding) => finding.level === "warning"),
		...driftFindings.warnings,
		...impactFindings.warnings,
		...rejectedFindings,
		...requestFindings.filter((finding) => finding.level === "warning"),
		...coverage.warnings,
	];

	// A request that is required and verified is reported as verified; everything
	// else that has a verdict is reported only through its findings.
	const verifiedRequestIds = rehearsal.required.filter((requestId) => verdicts.get(requestId) === REQUEST_VERDICT.VERIFIED);

	// A rejection only matters when a policy or binding was actually violated; a
	// rejected record for a request with no other evidence is exactly why the
	// request lands in the rehearsal set.
	const affectedRequestIds = [...new Set([...rehearsal.required, ...rehearsal.optional, ...[...evidenceByRequest.keys()]])].sort();

	const state = resolveState({
		blockers,
		warnings,
		rehearsal,
		verdicts,
		identitySufficient,
	});

	// UNKNOWN is reserved for structurally insufficient input. When the caller
	// supplied no evidence at all and no impact, the state must not accidentally be
	// VERIFIED; the rehearsal logic already prevents that, and this guard makes the
	// intent explicit for an empty input.
	const finalState = state === VERIFICATION_STATE.VERIFIED && !identitySufficient ? VERIFICATION_STATE.UNKNOWN : state;

	return buildVerificationResult({
		state: finalState,
		source,
		target,
		blockers,
		warnings,
		affectedRequestIds,
		requiredRehearsalRequestIds: rehearsal.required,
		verifiedRequestIds,
		acceptedEvidenceIds: acceptedIds,
		rejectedEvidenceIds: rejectedIds,
		staleEvidenceIds: staleIds,
	});
}

function rejectionDetail(binding) {
	switch (binding) {
		case BINDING.WRONG_SNAPSHOT:
			return "The evidence was produced against a different snapshot identity.";
		case BINDING.WRONG_ENVIRONMENT:
			return "The evidence was produced against a different environment.";
		case BINDING.WRONG_WORKSPACE:
			return "The evidence belongs to a different workspace or collection.";
		case BINDING.STALE:
			return "The evidence is older than the supplied freshness cutoff.";
		default:
			return "The evidence could not be bound to the target side.";
	}
}

export { REASON_CODES, VERIFICATION_STATES, VERIFICATION_STATE };
