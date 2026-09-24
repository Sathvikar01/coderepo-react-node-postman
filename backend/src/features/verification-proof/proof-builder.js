import {
	VERIFICATION_STATE,
	assertVerificationResult,
	assertionEvidenceSchema,
	executionEvidenceSchema,
} from "../cross-env-verification/index.js";
import { assertRehearsalPlanResult } from "../rehearsal-planning/index.js";
import { RUN_STATE_VALUES, identityFingerprint, parseRunIdentity } from "../rehearsal-checkpoints/index.js";
import { assertCompatibilityResult } from "../contract-compatibility/index.js";
import {
	PROOF_ERROR_CODES,
	PROOF_LIMITS,
	PROOF_REASON_CODES,
	PROOF_STATES,
	PROOF_STATE_PRIORITY,
	VERIFICATION_PROOF_ALGORITHM,
	VERIFICATION_PROOF_CANONICALIZATION,
	VERIFICATION_PROOF_KIND,
	VERIFICATION_PROOF_SCHEMA_VERSION,
	assertProofResult,
	assertProofSize,
	parseProofInput,
	proofError,
} from "./proof-schema.js";
import {
	canonicalProofJson,
	compareProofStrings,
	digestOf,
	fingerprintsEqual,
	proofFingerprintKeyId,
	proofIdOf,
	proofIdentityOf,
} from "./proof-identity.js";

// Phase 47A — Deterministic Verification Proof builder.
//
// One pure function: `buildVerificationProof(input) -> VerificationProofV1`.
//
// It consumes the public envelopes of Phases 39/40/41/43/46A/46B/46C and emits a
// tamper-evident record of exactly what was verified. It never executes a request,
// reads a database, touches the network, or writes state.
//
// Truthfulness rules, all fail-closed:
//
//   * The proof state is the Phase 41 state, copied — never recomputed, never
//     upgraded. A proof may not claim more than the evidence it cites.
//   * A run identity that disagrees with the plan, snapshot, or target environment
//     is not "mostly right"; it is a different run, and no proof is produced.
//   * Blocking drift (high/unknown severity, or unknown status) is a contradiction
//     unless Phase 41 also concluded BLOCKED.
//   * VERIFIED requires the impact and drift inputs the Phase 41 conclusion rests
//     on, and an evidence reference for every request it calls verified.
//   * Every bound is enforced; overflow refuses rather than truncates.

function proofErrorOf(statusCode, code, message, details) {
	return proofError(statusCode, code, message, details);
}

function identityMismatch(message, details) {
	return proofErrorOf(409, PROOF_ERROR_CODES.IDENTITY_MISMATCH, message, details);
}

function inconsistent(rule, message, details = {}) {
	return proofErrorOf(409, PROOF_ERROR_CODES.INCONSISTENT_EVIDENCE, message, { rule, ...details });
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function uniqueSorted(values) {
	return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort(compareProofStrings);
}

function parseRecord(value, schema, message) {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MALFORMED_INPUT, message, {
			issues: parsed.error.issues.slice(0, 5),
		});
	}
	return parsed.data;
}

// ---------------------------------------------------------------------------
// Explicit timestamp
// ---------------------------------------------------------------------------

// The instant the proof was minted. It is caller-supplied and part of the
// fingerprinted content, which is what makes byte-identical determinism possible:
// a proof is a function of its inputs, including the clock reading the caller
// chose to assert.
function canonicalInstant(value) {
	if (value === undefined || value === null || value === "") {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MISSING_TIMESTAMP, "An explicit verification timestamp is required.");
	}
	const millis = value instanceof Date ? value.getTime() : Date.parse(String(value));
	if (!Number.isFinite(millis)) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MISSING_TIMESTAMP, "The verification timestamp is not a valid instant.", {
			verifiedAt: String(value),
		});
	}
	return new Date(millis).toISOString();
}

// ---------------------------------------------------------------------------
// Upstream parsing (delegated to the owning core)
// ---------------------------------------------------------------------------

function parsePlan(value) {
	try {
		return assertRehearsalPlanResult(value);
	} catch (error) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MALFORMED_INPUT, "The supplied plan is not a valid Phase 46A rehearsal plan.", {
			upstreamCode: error?.code ?? null,
		});
	}
}

function parseRun(value) {
	if (value === undefined || value === null || typeof value !== "object") {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MISSING_IDENTITY, "A Phase 46B rehearsal run is required.", { field: "run" });
	}
	if (!RUN_STATE_VALUES.includes(value.runState)) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MALFORMED_INPUT, "The rehearsal run state is not recognized.", {
			runState: value.runState ?? null,
		});
	}
	if (typeof value.runId !== "string" || value.runId.length === 0) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MISSING_IDENTITY, "The rehearsal run does not carry a run id.", { field: "run.runId" });
	}
	let identity;
	try {
		identity = parseRunIdentity(value.identity);
	} catch (error) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MISSING_IDENTITY, "The rehearsal run identity is not a valid Phase 46B identity.", {
			upstreamCode: error?.code ?? null,
		});
	}
	if (typeof value.identityFingerprint !== "string" || value.identityFingerprint.length === 0) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MISSING_IDENTITY, "The rehearsal run does not carry an identity fingerprint.", {
			field: "run.identityFingerprint",
		});
	}
	return {
		runId: value.runId,
		runState: value.runState,
		identity,
		identityFingerprint: value.identityFingerprint,
		completedStepIds: asArray(value.completedStepIds).map(String),
		pendingStepIds: asArray(value.pendingStepIds).map(String),
	};
}

function parseVerification(value) {
	if (value === undefined || value === null) return null;
	try {
		return assertVerificationResult(value);
	} catch (error) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MALFORMED_INPUT, "The supplied verification result is not a valid Phase 41 result.", {
			upstreamCode: error?.code ?? null,
		});
	}
}

function parseEvidence(value) {
	const executions = asArray(value?.executions).map((record) =>
		parseRecord(record, executionEvidenceSchema, "An execution evidence record is not valid."),
	);
	const assertions = asArray(value?.assertions).map((record) =>
		parseRecord(record, assertionEvidenceSchema, "An assertion evidence record is not valid."),
	);
	return { executions, assertions };
}

// ---------------------------------------------------------------------------
// Projections of upstream artifacts
// ---------------------------------------------------------------------------

function projectImpact(value) {
	if (value === undefined || value === null) {
		return { present: false, resolved: null, truncated: null, directRequestIds: [], indirectRequestIds: [], unknownCount: 0, fingerprint: null, byRequest: new Map() };
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MALFORMED_INPUT, "The supplied change-impact envelope is not a Phase 39 result.");
	}
	const byRequest = new Map();
	const directRequestIds = [];
	const indirectRequestIds = [];
	for (const [bucket, impactKind] of [
		["direct", "direct"],
		["indirect", "indirect"],
	]) {
		for (const row of asArray(value.requests?.[bucket])) {
			if (!row || typeof row.requestId !== "string" || row.requestId.length === 0) continue;
			if (byRequest.has(row.requestId)) continue;
			byRequest.set(row.requestId, { impactKind, collectionId: typeof row.collectionId === "string" ? row.collectionId : null });
			if (impactKind === "direct") directRequestIds.push(row.requestId);
			else indirectRequestIds.push(row.requestId);
		}
	}
	return {
		present: true,
		resolved: typeof value.resolved === "boolean" ? value.resolved : null,
		truncated: typeof value.truncated === "boolean" ? value.truncated : null,
		directRequestIds: directRequestIds.sort(compareProofStrings),
		indirectRequestIds: indirectRequestIds.sort(compareProofStrings),
		unknownCount: asArray(value.unknown).length,
		fingerprint: digestOf("change-impact", value),
		byRequest,
	};
}

// Blocking drift is a pure projection of the Phase 40 closed vocabulary:
// high or unknown severity, or an unknown status. It is not a new judgement.
function isBlockingDrift(entry) {
	if (!entry || typeof entry !== "object") return false;
	return entry.severity === "high" || entry.severity === "unknown" || entry.status === "unknown";
}

function projectDrift(value) {
	if (value === undefined || value === null) {
		return { present: false, identical: null, blocking: [], blockingCount: 0, fingerprint: null };
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MALFORMED_INPUT, "The supplied environment-drift envelope is not a Phase 40 result.");
	}
	const blocking = asArray(value.drift)
		.filter(isBlockingDrift)
		.map((entry) => ({
			category: String(entry.category),
			path: typeof entry.path === "string" ? entry.path : null,
			severity: String(entry.severity),
			status: entry.status === undefined ? null : String(entry.status),
		}))
		.sort((left, right) =>
			compareProofStrings(left.category, right.category) ||
			compareProofStrings(left.path ?? "", right.path ?? "") ||
			compareProofStrings(left.severity, right.severity) ||
			compareProofStrings(left.status ?? "", right.status ?? ""),
		);
	return {
		present: true,
		identical: typeof value.identical === "boolean" ? value.identical : null,
		blocking,
		blockingCount: blocking.length,
		fingerprint: digestOf("environment-drift", value),
	};
}

function parseContracts(value) {
	if (value === undefined || value === null) return [];
	const list = Array.isArray(value) ? value : Array.isArray(value.results) ? value.results : null;
	if (!list) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MALFORMED_INPUT, "Contracts must be supplied as an array of Phase 43 results.");
	}
	if (list.length > PROOF_LIMITS.maxContracts) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.LIMIT_EXCEEDED, "Too many contract comparisons were supplied.", {
			count: list.length,
			max: PROOF_LIMITS.maxContracts,
		});
	}
	return list.map((result) => {
		try {
			return assertCompatibilityResult(result);
		} catch (error) {
			throw proofErrorOf(400, PROOF_ERROR_CODES.MALFORMED_INPUT, "A supplied contract result is not a valid Phase 43 result.", {
				upstreamCode: error?.code ?? null,
			});
		}
	});
}

function projectContracts(results) {
	if (results.length === 0) {
		return {
			present: false,
			compared: 0,
			compatible: 0,
			incompatible: 0,
			unknown: 0,
			classes: { total: 0, breaking: 0, nonBreaking: 0, unknown: 0 },
			fingerprint: null,
			byRequest: new Map(),
		};
	}
	const byRequest = new Map();
	const classes = { total: 0, breaking: 0, nonBreaking: 0, unknown: 0 };
	let compatibleCount = 0;
	let unknownCount = 0;
	for (const result of results) {
		classes.total += result.summary.total;
		classes.breaking += result.summary.breaking;
		classes.nonBreaking += result.summary.nonBreaking;
		classes.unknown += result.summary.unknown;
		if (result.compatible) compatibleCount += 1;
		if (result.summary.unknown > 0) unknownCount += 1;
		const requestId = result.contract.requestId;
		if (!byRequest.has(requestId)) byRequest.set(requestId, []);
		byRequest.get(requestId).push(result);
	}
	return {
		present: true,
		compared: results.length,
		compatible: compatibleCount,
		incompatible: results.length - compatibleCount,
		unknown: unknownCount,
		classes,
		fingerprint: digestOf("contract-compatibility", results),
		byRequest,
	};
}

function aggregateContract(entries) {
	if (!entries || entries.length === 0) return null;
	const summary = { total: 0, breaking: 0, nonBreaking: 0, unknown: 0 };
	for (const entry of entries) {
		summary.total += entry.summary.total;
		summary.breaking += entry.summary.breaking;
		summary.nonBreaking += entry.summary.nonBreaking;
		summary.unknown += entry.summary.unknown;
	}
	return { compared: true, compatible: entries.every((entry) => entry.compatible), summary };
}

// ---------------------------------------------------------------------------
// Identity and consistency
// ---------------------------------------------------------------------------

function assertBindings({ workspaceId, snapshot, targetEnvironment, plan, run }) {
	const mismatches = [];
	const check = (field, expected, actual) => {
		if (expected !== actual) mismatches.push({ field, expected: expected ?? null, actual: actual ?? null });
	};

	check("plan.workspace.workspaceId", workspaceId, plan.workspace?.workspaceId ?? null);
	check("plan.target.environmentId", targetEnvironment.environmentId, plan.target?.environmentId ?? null);
	if (plan.snapshot?.snapshotId) check("plan.snapshot.snapshotId", snapshot.snapshotId, plan.snapshot.snapshotId);
	if (plan.snapshot?.snapshotFingerprint) check("plan.snapshot.snapshotFingerprint", snapshot.snapshotFingerprint, plan.snapshot.snapshotFingerprint);
	if (plan.target?.snapshotFingerprint) check("plan.target.snapshotFingerprint", snapshot.snapshotFingerprint, plan.target.snapshotFingerprint);

	check("run.identity.workspaceId", workspaceId, run.identity.workspaceId);
	check("run.identity.snapshotId", snapshot.snapshotId, run.identity.snapshotId);
	check("run.identity.snapshotFingerprint", snapshot.snapshotFingerprint, run.identity.snapshotFingerprint);
	check("run.identity.targetEnvironment.environmentId", targetEnvironment.environmentId, run.identity.targetEnvironment.environmentId);
	check("run.identity.targetEnvironment.environmentFingerprint", targetEnvironment.environmentFingerprint, run.identity.targetEnvironment.environmentFingerprint);

	check("run.identity.planFingerprint", plan.identity?.planFingerprint ?? null, run.identity.planFingerprint);
	check("run.identity.planId", plan.identity?.planFingerprint ?? null, run.identity.planId);

	if (mismatches.length > 0) {
		throw identityMismatch("The proof identity does not match the plan and run it cites.", { mismatches });
	}

	// Defense in depth: the run's stored identity fingerprint must recompute from
	// its own identity. A stored fingerprint that does not recompute is corrupted.
	const recomputed = identityFingerprint(run.identity);
	if (!fingerprintsEqual(recomputed, run.identityFingerprint)) {
		throw inconsistent("run-identity-fingerprint", "The rehearsal run identity fingerprint does not recompute from its own identity.", {
			runId: run.runId,
		});
	}
}

function assertConsistency({ verification, impact, drift, evidence, snapshot, targetEnvironment, workspaceId }) {
	if (!verification) return;

	// The verification target must be the environment and snapshot this proof binds.
	const target = verification.target ?? {};
	const mismatches = [];
	const check = (field, expected, actual) => {
		if (actual !== null && actual !== undefined && actual !== expected) mismatches.push({ field, expected, actual });
	};
	check("verification.target.workspaceId", workspaceId, target.workspaceId);
	check("verification.target.environmentId", targetEnvironment.environmentId, target.environmentId);
	check("verification.target.snapshotId", snapshot.snapshotId, target.snapshotId);
	check("verification.target.snapshotFingerprint", snapshot.snapshotFingerprint, target.snapshotFingerprint);
	if (mismatches.length > 0) {
		throw inconsistent("verification-target", "The verification result was computed against a different identity than this proof.", { mismatches });
	}

	// Blocking drift forces BLOCKED. Any other state is a contradiction.
	if (drift.present && drift.blockingCount > 0 && verification.state !== PROOF_STATES.BLOCKED) {
		throw inconsistent("blocking-drift", "Blocking environment drift is present but the verification did not conclude BLOCKED.", {
			driftBlockingCount: drift.blockingCount,
			verificationState: verification.state,
		});
	}

	// A positive verification rests on impact and drift. Without them the positive
	// conclusion is not reproducible, so the proof refuses rather than assert it.
	if (verification.state === VERIFICATION_STATE.VERIFIED) {
		if (!impact.present) throw inconsistent("verified-without-impact", "A VERIFIED conclusion requires the change-impact input it rests on.");
		if (!drift.present) throw inconsistent("verified-without-drift", "A VERIFIED conclusion requires the environment-drift input it rests on.");
	}

	// Every request the verification calls verified must have at least one evidence
	// reference in this proof, and no cited evidence may contradict the snapshot.
	const verifiedIds = asArray(verification.verifiedRequestIds);
	if (verifiedIds.length > 0) {
		const evidenceByRequest = new Set([...evidence.executions, ...evidence.assertions].map((record) => record.requestId));
		const missing = verifiedIds.filter((requestId) => !evidenceByRequest.has(requestId));
		if (missing.length > 0) {
			throw inconsistent("verified-without-evidence", "A verified request has no evidence reference in this proof.", {
				requestIds: missing.slice(0, 8),
				missing: missing.length,
			});
		}
		for (const record of evidence.executions) {
			if (!verifiedIds.includes(record.requestId)) continue;
			if (record.snapshotFingerprint && record.snapshotFingerprint !== snapshot.snapshotFingerprint) {
				throw inconsistent("verified-evidence-wrong-snapshot", "Evidence cited for a verified request ran against a different snapshot.", {
					requestId: record.requestId,
				});
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Request table
// ---------------------------------------------------------------------------

function buildRequests({ plan, run, executedStepIds, evidence, verification, impact, contracts }) {
	const stepByRequest = new Map();
	for (const step of asArray(plan.steps)) {
		stepByRequest.set(step.requestId, step);
	}
	const completed = new Set(run.completedStepIds);
	const executed = new Set(executedStepIds);

	const evidenceByRequest = new Map();
	for (const record of evidence.executions) {
		if (!evidenceByRequest.has(record.requestId)) evidenceByRequest.set(record.requestId, []);
		evidenceByRequest.get(record.requestId).push({
			kind: "execution",
			refId: record.executionId,
			outcome: record.outcome ?? null,
			status: null,
			complete: record.complete ?? null,
		});
	}
	for (const record of evidence.assertions) {
		if (!evidenceByRequest.has(record.requestId)) evidenceByRequest.set(record.requestId, []);
		evidenceByRequest.get(record.requestId).push({
			kind: "assertion",
			refId: record.assertionId,
			outcome: null,
			status: record.status ?? null,
			complete: null,
		});
	}

	const verifiedIds = new Set(asArray(verification?.verifiedRequestIds));

	const requestIds = uniqueSorted([
		...impact.byRequest.keys(),
		...stepByRequest.keys(),
		...evidenceByRequest.keys(),
		...verifiedIds,
		...asArray(verification?.affectedRequestIds),
		...asArray(verification?.requiredRehearsalRequestIds),
		...contracts.byRequest.keys(),
	]);
	if (requestIds.length > PROOF_LIMITS.maxRequests) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.LIMIT_EXCEEDED, "The proof exceeds the maximum request count.", {
			requests: requestIds.length,
			max: PROOF_LIMITS.maxRequests,
		});
	}

	const requests = requestIds.map((requestId) => {
		const impactRow = impact.byRequest.get(requestId) ?? null;
		const step = stepByRequest.get(requestId) ?? null;
		const refs = (evidenceByRequest.get(requestId) ?? []).sort(
			(left, right) => compareProofStrings(left.kind, right.kind) || compareProofStrings(left.refId, right.refId),
		);
		if (refs.length > PROOF_LIMITS.maxEvidenceRefsPerRequest) {
			throw proofErrorOf(400, PROOF_ERROR_CODES.LIMIT_EXCEEDED, "A request carries more evidence references than the proof allows.", {
				requestId,
				refs: refs.length,
				max: PROOF_LIMITS.maxEvidenceRefsPerRequest,
			});
		}
		const rehearsed = Boolean(
			(step && (executed.has(step.stepId) || completed.has(step.stepId))) || refs.length > 0,
		);
		return {
			requestId,
			collectionId: impactRow?.collectionId ?? step?.collectionId ?? null,
			impacted: Boolean(impactRow),
			impactKind: impactRow?.impactKind ?? null,
			planned: Boolean(step),
			rehearsed,
			verified: verifiedIds.has(requestId),
			evidence: refs,
			contract: aggregateContract(contracts.byRequest.get(requestId) ?? null),
		};
	});

	return requests;
}

// ---------------------------------------------------------------------------
// State and reasons
// ---------------------------------------------------------------------------

// The proof state is exactly the evidence state. Never recomputed, never upgraded.
export function assertNoEvidenceUpgrade(evidenceState, proofState) {
	const from = PROOF_STATE_PRIORITY[evidenceState];
	const to = PROOF_STATE_PRIORITY[proofState];
	if (from === undefined || to === undefined) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.MALFORMED_INPUT, "An unknown proof state was supplied.", { evidenceState, proofState });
	}
	if (to < from) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.EVIDENCE_UPGRADE, "A verification proof may never claim a stronger state than the evidence it cites.", {
			evidenceState,
			proofState,
		});
	}
	return proofState;
}

function stateReasons({ verification, evidence, impact, drift, counts }) {
	const reasons = [];
	reasons.push(verification ? PROOF_REASON_CODES.VERIFICATION_PRESENT : PROOF_REASON_CODES.VERIFICATION_MISSING);
	reasons.push(evidence.executions.length + evidence.assertions.length > 0 ? PROOF_REASON_CODES.EVIDENCE_PRESENT : PROOF_REASON_CODES.EVIDENCE_MISSING);
	reasons.push(impact.present ? PROOF_REASON_CODES.IMPACT_PRESENT : PROOF_REASON_CODES.IMPACT_MISSING);
	reasons.push(drift.present ? PROOF_REASON_CODES.DRIFT_PRESENT : PROOF_REASON_CODES.DRIFT_MISSING);
	if (drift.blockingCount > 0) reasons.push(PROOF_REASON_CODES.BLOCKING_DRIFT_PRESENT);
	if (counts.impacted === 0) reasons.push(PROOF_REASON_CODES.NO_IMPACTED_REQUESTS);
	if (counts.rehearsed === 0) reasons.push(PROOF_REASON_CODES.NO_REHEARSED_REQUESTS);
	if (counts.verified > 0) reasons.push(PROOF_REASON_CODES.VERIFIED_REQUESTS_PRESENT);
	return reasons;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function resolveExecution(input) {
	const report = input.execution && typeof input.execution === "object" ? input.execution : null;
	return {
		run: input.run ?? report?.run ?? null,
		evidence: input.evidence ?? report?.evidence ?? null,
		verification: input.verification ?? report?.verification ?? null,
		executedStepIds: input.executedStepIds ?? report?.executedStepIds ?? [],
		stopReason: input.stopReason !== undefined ? input.stopReason : report?.stopReason ?? null,
		terminated: input.terminated !== undefined ? input.terminated : Boolean(report?.terminated ?? false),
	};
}

export function buildVerificationProof(rawInput) {
	const input = parseProofInput(rawInput);
	const verifiedAt = canonicalInstant(input.verifiedAt);

	// (1) Upstream artifacts, each validated by its owning core.
	const plan = parsePlan(input.plan);
	const execution = resolveExecution(input);
	const run = parseRun(execution.run);
	const verification = parseVerification(execution.verification);
	const evidence = parseEvidence(execution.evidence);
	const impact = projectImpact(input.impact);
	const drift = projectDrift(input.drift);
	const contractResults = parseContracts(input.contracts);
	const contracts = projectContracts(contractResults);
	const executedStepIds = uniqueSorted(asArray(execution.executedStepIds));

	// (2) Identity binding: proof ↔ plan ↔ run. Fail closed on any disagreement.
	const workspaceId = input.workspaceId;
	const snapshot = { snapshotId: input.snapshot.snapshotId, snapshotFingerprint: input.snapshot.snapshotFingerprint };
	const targetEnvironment = {
		environmentId: input.targetEnvironment.environmentId,
		environmentFingerprint: input.targetEnvironment.environmentFingerprint,
		environmentName: input.targetEnvironment.environmentName ?? null,
	};
	assertBindings({ workspaceId, snapshot, targetEnvironment, plan, run });

	// (3) Cross-artifact consistency. Contradictions never pass.
	assertConsistency({ verification, impact, drift, evidence, snapshot, targetEnvironment, workspaceId });

	// (4) The request table and its counts.
	const requests = buildRequests({ plan, run, executedStepIds, evidence, verification, impact, contracts });
	const counts = {
		impacted: requests.filter((request) => request.impacted).length,
		planned: requests.filter((request) => request.planned).length,
		rehearsed: requests.filter((request) => request.rehearsed).length,
		verified: requests.filter((request) => request.verified).length,
		unverified: requests.filter((request) => !request.verified).length,
		evidenceRefs: requests.reduce((total, request) => total + request.evidence.length, 0),
		executions: evidence.executions.length,
		assertions: evidence.assertions.length,
	};

	// (5) State: copied from Phase 41, or UNKNOWN when no verification was supplied.
	const underlyingState = verification ? verification.state : VERIFICATION_STATE.UNKNOWN;
	const state = assertNoEvidenceUpgrade(underlyingState, underlyingState);

	// (6) Verification projection.
	const verificationBlock = verification
		? {
				present: true,
				state: verification.state,
				fingerprint: digestOf("cross-env-verification", verification),
				affectedRequestIds: uniqueSorted(asArray(verification.affectedRequestIds)),
				requiredRehearsalRequestIds: uniqueSorted(asArray(verification.requiredRehearsalRequestIds)),
				verifiedRequestIds: uniqueSorted(asArray(verification.verifiedRequestIds)),
				blockers: verification.blockers.map((finding) => ({
					code: String(finding.code),
					requestId: finding.requestId ?? null,
					evidenceId: finding.evidenceId ?? null,
				})),
				warnings: verification.warnings.map((finding) => ({
					code: String(finding.code),
					requestId: finding.requestId ?? null,
					evidenceId: finding.evidenceId ?? null,
				})),
				summary: {
					affectedRequests: verification.summary.affectedRequests,
					requiredRehearsals: verification.summary.requiredRehearsals,
					verifiedRequests: verification.summary.verifiedRequests,
					blockers: verification.blockers.length,
					warnings: verification.warnings.length,
				},
			}
		: {
				present: false,
				state: null,
				fingerprint: null,
				affectedRequestIds: [],
				requiredRehearsalRequestIds: [],
				verifiedRequestIds: [],
				blockers: [],
				warnings: [],
				summary: null,
			};
	if (verificationBlock.blockers.length > PROOF_LIMITS.maxFindings || verificationBlock.warnings.length > PROOF_LIMITS.maxFindings) {
		throw proofErrorOf(400, PROOF_ERROR_CODES.LIMIT_EXCEEDED, "The verification carries more findings than the proof allows.", {
			blockers: verificationBlock.blockers.length,
			warnings: verificationBlock.warnings.length,
			max: PROOF_LIMITS.maxFindings,
		});
	}

	// (7) Provenance: one-way digests of the exact artifacts consumed.
	const provenance = {
		verifier: {
			id: input.verifier?.id ?? "phase47.verification-proof",
			version: input.verifier?.version ?? String(VERIFICATION_PROOF_SCHEMA_VERSION),
		},
		sources: [
			{ source: "rehearsal-plan", ref: plan.identity.planFingerprint, digest: digestOf("rehearsal-plan", plan) },
			{ source: "rehearsal-run", ref: run.identityFingerprint, digest: digestOf("rehearsal-run", run) },
			{ source: "cross-env-verification", ref: verification?.state ?? null, digest: verificationBlock.fingerprint },
			{ source: "change-impact", ref: impact.fingerprint, digest: impact.fingerprint },
			{ source: "environment-drift", ref: drift.fingerprint, digest: drift.fingerprint },
			{ source: "contract-compatibility", ref: contracts.fingerprint, digest: contracts.fingerprint },
			{
				source: "evidence",
				ref: null,
				digest: digestOf("evidence", { executions: evidence.executions, assertions: evidence.assertions }),
			},
		],
	};

	// (8) Assemble the fingerprinted body, then derive the id and fingerprint.
	const body = {
		kind: VERIFICATION_PROOF_KIND,
		schemaVersion: VERIFICATION_PROOF_SCHEMA_VERSION,
		verifiedAt,
		state,
		stateReasons: stateReasons({ verification, evidence, impact, drift, counts }),
		identity: {
			workspaceId,
			snapshot,
			targetEnvironment,
			planFingerprint: plan.identity.planFingerprint,
			planId: run.identity.planId,
			runId: run.runId,
			runIdentityFingerprint: run.identityFingerprint,
			runState: run.runState,
		},
		verification: verificationBlock,
		rehearsal: {
			planFingerprint: plan.identity.planFingerprint,
			runId: run.runId,
			identityFingerprint: run.identityFingerprint,
			runState: run.runState,
			completedStepIds: uniqueSorted(run.completedStepIds),
			pendingStepIds: uniqueSorted(run.pendingStepIds),
			executedStepIds,
			stopReason: execution.stopReason ?? null,
			terminated: execution.terminated,
		},
		impact: {
			present: impact.present,
			resolved: impact.resolved,
			truncated: impact.truncated,
			directRequestIds: impact.directRequestIds,
			indirectRequestIds: impact.indirectRequestIds,
			unknownCount: impact.unknownCount,
			fingerprint: impact.fingerprint,
		},
		drift: {
			present: drift.present,
			identical: drift.identical,
			blockingCount: drift.blockingCount,
			blocking: drift.blocking,
			fingerprint: drift.fingerprint,
		},
		contracts: {
			present: contracts.present,
			compared: contracts.compared,
			compatible: contracts.compatible,
			incompatible: contracts.incompatible,
			unknown: contracts.unknown,
			classes: contracts.classes,
		},
		requests,
		counts,
		provenance,
	};

	const fingerprint = proofIdentityOf(body);
	const result = {
		...body,
		proofId: proofIdOf(fingerprint),
		fingerprint,
		fingerprintKeyId: proofFingerprintKeyId(),
		integrity: {
			algorithm: VERIFICATION_PROOF_ALGORITHM,
			canonicalization: VERIFICATION_PROOF_CANONICALIZATION,
		},
	};

	assertProofSize(result);
	return assertProofResult(result);
}

// A canonical, byte-stable JSON view of a proof. Used for determinism checks and
// for storing/transporting the proof without depending on key insertion order.
export function canonicalProofJsonOf(proof) {
	return canonicalProofJson(proof);
}
