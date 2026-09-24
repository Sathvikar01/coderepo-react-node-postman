// Phase 49B — "Why?" Inspector: evidence linkage.
//
// This module answers one question and nothing else:
//
//   "Which recorded artifacts provably describe THIS execution, and what did those
//    artifacts say?"
//
// It owns no truth. Every value that leaves this module is either copied from an
// artifact that another phase already produced, or is an explicit status saying
// that no such artifact is linked. It never re-runs Phase 39/40/41/43/46/47, never
// infers a verification state, never resolves a secret, and never writes state.
//
// Linkage rules, in order of strength:
//
//   recorded           the artifact was found AND its identity was proven against
//                      this execution's recorded identity.
//   partial            the artifact names this execution's request but the step it
//                      names was never executed, so no evidence exists for it.
//   stale              the artifact is intact and identity-related, but the
//                      identity it committed to is not the identity this execution
//                      was recorded against. Phase 47B decides this, not us.
//   identity_mismatch  the artifact is intact but describes a different
//                      environment / request than the execution.
//   invalid            the artifact failed its own integrity contract.
//   not_recorded       no artifact was supplied or found for this execution.
//   unknown            the artifact is present but cannot be adjudicated from the
//                      recorded evidence (e.g. nothing to compare staleness with
//                      for the derived nodes).
//
// The one external verifier this module needs — Phase 47B's independent proof
// report — is imported, never reimplemented.
import {
	isCredentialShaped,
	PROOF_STATE_VALUES,
	verifyProofIntegrity,
} from "../verification-proof/index.js";
import {
	buildVerificationReport,
	parseProofArtifactText,
	PROOF_REPORT_STATUS,
	PROOF_STALENESS,
} from "../verification-proof-api/index.js";
import { LINK_SOURCE, LINK_STATUS, WHY_LIMITS, WHY_REASON } from "./why-schema.js";

export const REDACTED = "[redacted]";

// ---------------------------------------------------------------------------
// Bounded, credential-safe text
// ---------------------------------------------------------------------------

/**
 * Every string this module emits passes through here. `isCredentialShaped` is
 * Phase 47A's own refusal predicate for credential-bearing text — reusing it
 * means the read-model inherits the proof core's definition of "secret-shaped"
 * rather than inventing a weaker one.
 */
export function safeText(value, max = WHY_LIMITS.maxTextBytes) {
	if (typeof value !== "string" || value.length === 0) return null;
	const bounded = value.length > max ? `${value.slice(0, max)}…` : value;
	return isCredentialShaped(bounded) ? REDACTED : bounded;
}

export function safeId(value, max = 128) {
	return safeText(typeof value === "string" ? value : null, max);
}

function boundedIds(values, max = WHY_LIMITS.maxRequestIds) {
	const input = Array.isArray(values) ? values : [];
	const out = [];
	for (const value of input.slice(0, max)) {
		const id = safeId(value);
		if (id) out.push(id);
	}
	return { ids: out, truncated: input.length > max };
}

function link(status, source, reasonCode, reason, extra = {}) {
	return {
		status,
		source,
		identity: extra.identity ?? [],
		reasonCode,
		reason,
		observedAt: extra.observedAt ?? null,
		fingerprint: extra.fingerprint ?? null,
	};
}

function identityToken(label, value) {
	const token = safeId(value);
	return token ? { label, value: token } : null;
}

function compact(tokens) {
	return tokens.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Rehearsal (Phase 46B run, Phase 46C step evidence)
// ---------------------------------------------------------------------------

function stepRequestId(step, run) {
	// The persisted step accounting holds only the step id; the plan holds the request
	// id that step was built for. Both are written once by Phase 46A/46B, so the plan
	// is the authoritative mapping.
	const stepId = typeof step?.stepId === "string" ? step.stepId : "";
	const planSteps = Array.isArray(run?.plan?.steps) ? run.plan.steps : [];
	const planned = planSteps.find((item) => item?.stepId === stepId);
	if (typeof planned?.refId === "string" && planned.refId.length > 0) return planned.refId;
	return stepId.startsWith("step:") ? stepId.slice(5) : stepId || null;
}

function stepEvidenceRefs(step) {
	const refs = step?.attempt?.evidenceRefs;
	return Array.isArray(refs) ? refs : [];
}

function stepOutcome(step) {
	const metadata = step?.completion?.metadata ?? null;
	if (!metadata) return null;
	return {
		outcomeId: safeText(step?.outcome?.outcomeId, 128),
		state: safeText(step?.state, 32),
		outcome: safeText(metadata.outcome, 32),
		httpStatus: Number.isInteger(metadata.httpStatus) ? metadata.httpStatus : null,
		durationMs: Number.isFinite(metadata.durationMs) ? metadata.durationMs : null,
		contractStatus: safeText(metadata.contractStatus, 64),
		compatible: typeof metadata.compatible === "boolean" ? metadata.compatible : null,
		findings: boundedFindings(metadata.findings),
	};
}

function boundedFindings(values) {
	const input = Array.isArray(values) ? values : [];
	return {
		items: input.slice(0, WHY_LIMITS.maxProofFindings).map((finding) => ({
			code: safeText(finding?.code, 128),
			path: safeText(finding?.path, 256),
			severity: safeText(finding?.severity, 64),
		})),
		truncated: input.length > WHY_LIMITS.maxProofFindings,
	};
}

/**
 * Summarize one persisted 46B run without echoing anything unbounded. The run's
 * identity is copied so the projection can show what the run was bound to, and so
 * Phase 47B has a recorded identity to compare a proof against.
 */
function projectRun(run) {
	const identity = run?.identity ?? {};
	const targetEnvironment = identity.targetEnvironment ?? {};
	const steps = (Array.isArray(run?.stepStates) ? run.stepStates : []).slice(0, WHY_LIMITS.maxRunSteps).map((step) => {
		const issues = boundedFindings(step?.completion?.metadata?.findings);
		return {
			stepId: safeId(step?.stepId),
			requestId: safeId(stepRequestId(step, run)),
			state: safeText(step?.state, 32),
			lastReasonCode: safeText(step?.lastReasonCode, 64),
			evidenceRefs: stepEvidenceRefs(step)
				.slice(0, 4)
				.map((ref) => safeId(ref))
				.filter(Boolean),
			outcome: stepOutcome(step),
			findingsTruncated: issues.truncated,
		};
	});

	return {
		runId: safeId(run?.runId),
		runState: safeText(run?.runState, 64),
		generation: Number.isInteger(run?.generation) ? run.generation : null,
		workspaceId: safeId(identity.workspaceId),
		snapshotId: safeId(identity.snapshotId),
		snapshotFingerprint: safeId(identity.snapshotFingerprint),
		targetEnvironment: {
			environmentId: safeId(targetEnvironment.environmentId),
			environmentName: safeText(targetEnvironment.environmentName, 128),
			environmentFingerprint: safeId(targetEnvironment.environmentFingerprint),
		},
		planId: safeId(identity.planId ?? run?.planFingerprint),
		planFingerprint: safeId(run?.planFingerprint ?? identity.planFingerprint),
		policyId: safeId(identity.policyId),
		policyFingerprint: safeId(identity.policyFingerprint),
		identityFingerprint: safeId(run?.identityFingerprint),
		completedStepIds: (Array.isArray(run?.completedStepIds) ? run.completedStepIds : []).slice(0, WHY_LIMITS.maxRunSteps).map((id) => safeId(id)).filter(Boolean),
		currentStepId: safeId(run?.currentStepId),
		nextStepId: safeId(run?.nextStepId),
		stopReason: safeText(run?.terminalReasonCode, 64),
		stopReasonDetail: safeText(run?.terminalReason, 256),
		startedAt: safeText(run?.createdAt instanceof Date ? run.createdAt.toISOString() : run?.createdAt, 64),
		updatedAt: safeText(run?.updatedAt instanceof Date ? run.updatedAt.toISOString() : run?.updatedAt, 64),
		completedAt: safeText(run?.completedAt instanceof Date ? run.completedAt.toISOString() : run?.completedAt, 64),
		label: safeText(run?.label, 128),
		steps,
		stepCount: Array.isArray(run?.stepStates) ? run.stepStates.length : 0,
		stepsTruncated: (run?.stepStates?.length ?? 0) > WHY_LIMITS.maxRunSteps,
	};
}

/**
 * Prove which persisted rehearsal run produced this execution.
 *
 * The matching key is the run's own recorded evidence: Phase 46C writes the
 * execution id into `attempt.evidenceRefs` for the step that produced it, so a
 * run that names this execution *is* the run that produced it. That is a proven
 * identity link, not a heuristic — which is why a run that merely declares the
 * same request id is only `partial`.
 */
export function linkRehearsalRuns({ executionId, requestId, runs }) {
	const candidates = Array.isArray(runs) ? runs.slice(0, WHY_LIMITS.maxLinkedRuns) : [];
	const truncated = Array.isArray(runs) && runs.length > WHY_LIMITS.maxLinkedRuns;

	for (const run of candidates) {
		const steps = Array.isArray(run?.stepStates) ? run.stepStates : [];
		const matchedStep = steps.find((step) => stepEvidenceRefs(step).includes(executionId));
		if (!matchedStep) continue;

		const stepRequestIdValue = stepRequestId(matchedStep, run);
		const projected = projectRun(run);
		const identity = compact([
			identityToken("execution", executionId),
			identityToken("request", stepRequestIdValue),
			identityToken("snapshot", run?.identity?.snapshotFingerprint),
			identityToken("environment", run?.identity?.targetEnvironment?.environmentFingerprint),
			identityToken("plan", run?.planFingerprint),
		]);

		// The run named this execution as evidence for a step. If that step's request
		// is not the request this execution was recorded against, the two records
		// disagree about what was run: fail closed rather than pick one.
		if (requestId && stepRequestIdValue && stepRequestIdValue !== requestId) {
			return {
				link: link(LINK_STATUS.IDENTITY_MISMATCH, LINK_SOURCE.PHASE46B_RUN, WHY_REASON.IDENTITY_UNPROVEN, "The linked rehearsal run records this execution as evidence for a different request.", {
					identity,
					observedAt: safeText(run?.updatedAt, 64),
					fingerprint: safeId(run?.planFingerprint),
				}),
				run: projected,
				runs: [projected],
				step: projected.steps.find((step) => step.stepId === safeId(matchedStep.stepId)) ?? null,
				truncated,
			};
		}

		return {
			link: link(LINK_STATUS.RECORDED, LINK_SOURCE.PHASE46B_RUN, WHY_REASON.LINKED_PHASE41_STATE, "A persisted rehearsal run records this execution as proof for one of its steps.", {
				identity,
				observedAt: safeText(run?.updatedAt ?? run?.createdAt, 64),
				fingerprint: safeId(run?.snapshotFingerprint),
			}),
			run: projected,
			runs: [projected],
			step: projected.steps.find((step) => step.stepId === safeId(matchedStep.stepId)) ?? null,
			truncated,
		};
	}

	// No run named this execution. A run may still declare the same request — that
	// is real, weaker evidence: the request was planned but this step was not
	// executed, so nothing about this execution was rehearsed.
	if (requestId) {
		for (const run of candidates) {
			const steps = Array.isArray(run?.stepStates) ? run.stepStates : [];
			const declared = steps.find((step) => stepRequestId(step, run) === requestId);
			if (!declared) continue;
			const projected = projectRun(run);
			return {
				link: link(LINK_STATUS.PARTIAL, LINK_SOURCE.PHASE46B_RUN, WHY_REASON.REHEARSAL_STEP_NOT_EXECUTED, "A rehearsal run declares this request, but no step produced this execution, so the request was not rehearsed by it.", {
					identity: compact([
						identityToken("request", requestId),
						identityToken("run", run?.runId),
						identityToken("plan", run?.planFingerprint),
					]),
					observedAt: safeText(run?.updatedAt ?? run?.createdAt, 64),
					fingerprint: safeId(run?.planFingerprint),
				}),
				run: projected,
				runs: [projected],
				step: projected.steps.find((step) => step.requestId === safeId(requestId)) ?? null,
				truncated,
			};
		}
	}

	return {
		link: link(LINK_STATUS.NOT_RECORDED, LINK_SOURCE.PHASE46B_RUN, WHY_REASON.REHEARSAL_NOT_RECORDED, "No persisted rehearsal run records this execution or its request."),
		run: null,
		runs: [],
		step: null,
		truncated,
	};
}

// ---------------------------------------------------------------------------
// Proof (Phase 47A artifact, verified by 47B)
// ---------------------------------------------------------------------------

/**
 * Parse a supplied artifact. Returns a discriminated result rather than throwing
 * so a bad import degrades the whole explanation to explicit `invalid` links
 * instead of failing the read.
 */
export function parseSuppliedProof(value) {
	if (value === undefined || value === null) return { supplied: false };
	const text = typeof value === "string" ? value : safeJson(value);
	try {
		const parsed = parseProofArtifactText(text);
		return { supplied: true, proof: parsed.proof, artifactFingerprint: safeId(parsed.artifact?.integrity?.artifactFingerprint) };
	} catch (error) {
		return {
			supplied: true,
			errorCode: safeId(error?.code, 64) ?? "PROOF_ARTIFACT_REJECTED",
			errorMessage: safeText(error?.message, 512) ?? "The supplied proof artifact was refused.",
		};
	}
}

function safeJson(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

/** The identity a proof committed to, shaped for Phase 47B's `current` input. */
function currentIdentityFromRun(run) {
	if (!run) return {};
	const current = {};
	if (run.snapshotId && run.snapshotFingerprint) {
		current.snapshot = { snapshotId: run.snapshotId, snapshotFingerprint: run.snapshotFingerprint };
	}
	const environmentId = run.targetEnvironment?.environmentId;
	const environmentFingerprint = run.targetEnvironment?.environmentFingerprint;
	if (environmentId && environmentFingerprint) {
		current.targetEnvironment = { environmentId, environmentFingerprint };
		if (run.targetEnvironment?.environmentName) {
			current.targetEnvironment.environmentName = run.targetEnvironment.environmentName;
		}
	}
	return current;
}

function boundedBlockers(values) {
	const input = Array.isArray(values) ? values : [];
	return input.slice(0, WHY_LIMITS.maxProofFindings).map((finding) => ({
		code: safeText(finding?.code, 128),
		requestId: safeId(finding?.requestId),
		evidenceId: safeId(finding?.evidenceId),
	}));
}

/**
 * Link the supplied proof to this execution and adjudicate it with Phase 47B.
 *
 * Nothing here decides staleness itself: `buildVerificationReport` owns that, and
 * its verdict is consumed verbatim. The linked run supplies the "current"
 * identity, because the execution record alone carries no snapshot identity — and
 * with no recorded identity to compare against, 47B correctly answers UNKNOWN
 * rather than CURRENT.
 */
export function linkProof({ proof, parseError, artifactFingerprint, receipt, rehearsal }) {
	const environmentId = receipt?.environmentId ?? null;
	const requestId = receipt?.requestId ?? null;
	const run = rehearsal?.run ?? null;

	if (!proof) {
		if (parseError) {
			return {
				link: link(LINK_STATUS.INVALID, LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_INVALID, "The supplied proof artifact was refused before it could be linked.", {
					identity: compact([identityToken("execution", receipt?.executionId), identityToken("request", requestId)]),
				}),
				detail: null,
				report: null,
				parseError,
			};
		}
		return {
			link: link(LINK_STATUS.NOT_RECORDED, LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_NOT_RECORDED, "No verification proof is linked to this execution."),
			detail: null,
			report: null,
			parseError: null,
		};
	}

	const identity = compact([
		identityToken("proof", proof.proofId),
		identityToken("workspace", proof.identity?.workspaceId),
		identityToken("snapshot", proof.identity?.snapshot?.snapshotFingerprint),
		identityToken("environment", proof.identity?.targetEnvironment?.environmentFingerprint),
		identityToken("request", requestId),
	]);
	const observedAt = safeText(proof.verifiedAt, 64);
	const fingerprint = safeId(proof.fingerprint);

	const detail = {
		proofId: safeId(proof.proofId),
		fingerprint,
		fingerprintKeyId: safeId(proof.fingerprintKeyId),
		artifactFingerprint: artifactFingerprint ?? null,
		state: PROOF_STATE_VALUES.includes(proof.state) ? proof.state : null,
		stateReasons: (Array.isArray(proof.stateReasons) ? proof.stateReasons : []).slice(0, WHY_LIMITS.maxReasons).map((reason) => safeText(reason, 64)).filter(Boolean),
		verifiedAt: observedAt,
		identityDetail: {
			workspaceId: safeId(proof.identity?.workspaceId),
			snapshotId: safeId(proof.identity?.snapshot?.snapshotId),
			snapshotFingerprint: safeId(proof.identity?.snapshot?.snapshotFingerprint),
			environmentId: safeId(proof.identity?.targetEnvironment?.environmentId),
			environmentName: safeText(proof.identity?.targetEnvironment?.environmentName, 128),
			environmentFingerprint: safeId(proof.identity?.targetEnvironment?.environmentFingerprint),
			planId: safeId(proof.identity?.planId),
			planFingerprint: safeId(proof.identity?.planFingerprint),
			runId: safeId(proof.identity?.runId),
			runState: safeText(proof.identity?.runState, 64),
		},
		verifier: {
			name: safeText(proof.provenance?.verifier?.name ?? proof.provenance?.verifier?.id, 128),
			version: safeText(proof.provenance?.verifier?.version, 64),
		},
		sources: (Array.isArray(proof.provenance?.sources) ? proof.provenance.sources : [])
			.slice(0, WHY_LIMITS.maxProofSources)
			.map((source) => ({ source: safeText(source?.source, 128), ref: safeId(source?.ref), digest: safeId(source?.digest) })),
		sourcesTruncated: (proof.provenance?.sources?.length ?? 0) > WHY_LIMITS.maxProofSources,
		counts: proof.counts
			? {
					impacted: proof.counts.impacted,
					planned: proof.counts.planned,
					rehearsed: proof.counts.rehearsed,
					verified: proof.counts.verified,
					unverified: proof.counts.unverified,
					executions: proof.counts.executions,
					assertions: proof.counts.assertions,
				}
			: null,
	};

	// Phase 47A owns integrity. A proof that fails it is never read past.
	if (!verifyProofIntegrity(proof)) {
		return {
			link: link(LINK_STATUS.INVALID, LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_INVALID, "The supplied proof failed its integrity check, so nothing inside it is trusted.", {
				identity,
				observedAt,
				fingerprint,
			}),
			detail,
			report: null,
			parseError: null,
		};
	}

	const proofEnvironmentId = proof.identity?.targetEnvironment?.environmentId ?? null;
	if (environmentId && proofEnvironmentId && proofEnvironmentId !== environmentId) {
		return {
			link: link(LINK_STATUS.IDENTITY_MISMATCH, LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_IDENTITY_MISMATCH, "The proof was recorded against a different target environment than this execution.", {
				identity,
				observedAt,
				fingerprint,
			}),
			detail,
			report: null,
			parseError: null,
		};
	}

	const namedRequests = Array.isArray(proof.requests) ? proof.requests.map((entry) => entry?.requestId) : [];
	const requestLinked = requestId ? namedRequests.includes(requestId) : true;

	// Phase 47B decides staleness. Its "current" identity is the identity the linked
	// rehearsal run recorded, because that is the only recorded identity that
	// belongs to this execution.
	const report = buildVerificationReport(proof, currentIdentityFromRun(run));
	detail.report = {
		status: report.status,
		staleness: report.staleness,
		checks: report.checks,
		reasons: (report.reasons ?? []).slice(0, WHY_LIMITS.maxReasons).map((reason) => safeText(reason, 64)).filter(Boolean),
	};

	if (report.status === PROOF_REPORT_STATUS.INVALID) {
		return {
			link: link(LINK_STATUS.INVALID, LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_INVALID, "Phase 47B found the proof internally inconsistent.", { identity, observedAt, fingerprint }),
			detail,
			report,
			parseError: null,
		};
	}

	if (report.staleness === PROOF_STALENESS.STALE) {
		return {
			link: link(LINK_STATUS.STALE, LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_STALE, "The proof is intact, but it was recorded against a different snapshot or environment than the run linked to this execution.", { identity, observedAt, fingerprint }),
			detail,
			report,
			parseError: null,
		};
	}

	if (!requestLinked) {
		return {
			link: link(LINK_STATUS.PARTIAL, LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_UNLINKED, "The proof was recorded for this environment, but it does not name this request.", {
				identity,
				observedAt,
				fingerprint,
			}),
			detail,
			report,
			parseError: null,
		};
	}

	return {
		link: link(LINK_STATUS.RECORDED, LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_RECORDED, "The proof names this request in this environment and passed its integrity check.", {
			identity,
			observedAt,
			fingerprint,
		}),
		detail,
		report,
		parseError: null,
	};
}

// ---------------------------------------------------------------------------
// Derived projections — copied from the linked proof, never recomputed
// ---------------------------------------------------------------------------

/** A derived node is never stronger than the proof it came from. */
function derivedStatus(proofLink) {
	if (proofLink.status === LINK_STATUS.RECORDED) return LINK_STATUS.RECORDED;
	return proofLink.status;
}

function derived(proofLink, reasonCode, reason, detail) {
	return {
		link: link(derivedStatus(proofLink), proofLink.source, reasonCode, reason, {
			identity: proofLink.identity,
			observedAt: proofLink.observedAt,
			fingerprint: proofLink.fingerprint,
		}),
		detail,
	};
}

export function projectImpactFromProof({ proof, proofLink, requestId }) {
	if (!proof || !proof.impact) {
		return derived(proofLink, WHY_REASON.IMPACT_NOT_RECORDED, "No Phase 39 change-impact envelope is linked to this execution.", null);
	}
	const impacted = proof.impact;
	const direct = boundedIds(impacted.directRequestIds);
	const indirect = boundedIds(impacted.indirectRequestIds);
	const entry = requestId ? (proof.requests ?? []).find((item) => item?.requestId === requestId) ?? null : null;
	return derived(
		proofLink,
		impacted.present ? WHY_REASON.LINKED_PHASE41_STATE : WHY_REASON.IMPACT_NOT_RECORDED,
		impacted.present
			? "Phase 39 change impact is linked through the proof; the envelope is copied, not recomputed."
			: "The linked proof carries no Phase 39 change-impact envelope.",
		{
			present: Boolean(impacted.present),
			resolved: typeof impacted.resolved === "boolean" ? impacted.resolved : null,
			truncated: typeof impacted.truncated === "boolean" ? impacted.truncated : null,
			directRequestIds: direct.ids,
			indirectRequestIds: indirect.ids,
			requestIdsTruncated: direct.truncated || indirect.truncated,
			unknownCount: Number.isInteger(impacted.unknownCount) ? impacted.unknownCount : null,
			fingerprint: safeId(impacted.fingerprint),
			request: entry ? { impacted: Boolean(entry.impacted), impactKind: safeText(entry.impactKind, 32) } : null,
		},
	);
}

export function projectDriftFromProof({ proof, proofLink }) {
	if (!proof || !proof.drift) {
		return derived(proofLink, WHY_REASON.DRIFT_NOT_RECORDED, "No Phase 40 environment-drift envelope is linked to this execution.", null);
	}
	const drift = proof.drift;
	const blocking = (Array.isArray(drift.blocking) ? drift.blocking : []).slice(0, WHY_LIMITS.maxDriftBlocking).map((item) => ({
		category: safeText(item?.category, 128),
		path: safeText(item?.path, 256),
		severity: safeText(item?.severity, 64),
		status: safeText(item?.status, 64),
	}));
	return derived(
		proofLink,
		drift.present ? WHY_REASON.LINKED_PHASE41_STATE : WHY_REASON.DRIFT_NOT_RECORDED,
		drift.present
			? "Phase 40 environment drift is linked through the proof; the envelope is copied, not recomputed."
			: "The linked proof carries no Phase 40 environment-drift envelope.",
		{
			present: Boolean(drift.present),
			identical: typeof drift.identical === "boolean" ? drift.identical : null,
			blockingCount: Number.isInteger(drift.blockingCount) ? drift.blockingCount : blocking.length,
			blocking,
			blockingTruncated: (drift.blocking?.length ?? 0) > WHY_LIMITS.maxDriftBlocking,
			fingerprint: safeId(drift.fingerprint),
		},
	);
}

export function projectContractFromProof({ proof, proofLink, requestId, rehearsal }) {
	const entry = proof && requestId ? (proof.requests ?? []).find((item) => item?.requestId === requestId) ?? null : null;
	const contracts = proof?.contracts ?? null;
	const stepContract = rehearsal?.step?.outcome ?? null;

	if (!contracts && !entry?.contract && !stepContract) {
		return derived(proofLink, WHY_REASON.CONTRACT_NOT_RECORDED, "No Phase 43 contract comparison is linked to this execution.", null);
	}

	// Prefer the proof's own contract block for this request; fall back to the
	// contract status the rehearsal step recorded. Both are copies.
	const findings = entry?.contract?.summary
		? {
				total: entry.contract.summary.total,
				breaking: entry.contract.summary.breaking,
				nonBreaking: entry.contract.summary.nonBreaking,
				unknown: entry.contract.summary.unknown,
			}
		: contracts?.classes ?? null;

	return derived(
		proofLink,
		WHY_REASON.LINKED_PHASE41_STATE,
		"Phase 43 contract compatibility is linked through the proof and the rehearsal step metadata; it is copied, not recomputed.",
		{
			present: true,
			compared: contracts ? Number.isInteger(contracts.compared) ? contracts.compared : null : null,
			compatible: contracts ? Number.isInteger(contracts.compatible) ? contracts.compatible : null : null,
			incompatible: contracts ? Number.isInteger(contracts.incompatible) ? contracts.incompatible : null : null,
			unknown: contracts ? Number.isInteger(contracts.unknown) ? contracts.unknown : null : null,
			classes: findings,
			request: entry?.contract
				? {
						compared: Boolean(entry.contract.compared),
						compatible: typeof entry.contract.compatible === "boolean" ? entry.contract.compatible : null,
					}
				: null,
			step: stepContract
				? {
						status: stepContract.contractStatus,
						compatible: stepContract.compatible,
						findings: stepContract.findings,
					}
				: null,
		},
	);
}

/**
 * Project the authoritative verification result.
 *
 * This is the ONLY function in the read-model that can produce a state other than
 * UNKNOWN, and it does so by copying `proof.state` — which Phase 47A itself copied
 * from Phase 41. It never inspects assertions, the policy decision, or the
 * response. A stale or invalid proof yields UNKNOWN, with the Phase 41 state kept
 * only as a clearly-labelled non-authoritative observation.
 */
export function projectVerificationFromProof({ proof, proofLink, requestId }) {
	const verification = proof?.verification ?? null;
	const carriedState = verification && PROOF_STATE_VALUES.includes(verification.state) ? verification.state : null;
	const proofState = proof && PROOF_STATE_VALUES.includes(proof.state) ? proof.state : null;
	const environmentMatches = proofLink.status !== LINK_STATUS.IDENTITY_MISMATCH;

	const detail = {
		state: carriedState,
		proofState,
		fingerprint: safeId(verification?.fingerprint),
		verifiedRequestIds: boundedIds(verification?.verifiedRequestIds).ids,
		affectedRequestIds: boundedIds(verification?.affectedRequestIds).ids,
		requiredRehearsalRequestIds: boundedIds(verification?.requiredRehearsalRequestIds).ids,
		blockers: boundedBlockers(verification?.blockers),
		warnings: boundedBlockers(verification?.warnings),
		summary: verification?.summary ?? null,
		requestVerified: requestId ? Boolean((verification?.verifiedRequestIds ?? []).includes(requestId)) : null,
	};

	if (!proof || !verification || verification.present !== true || !carriedState) {
		return {
			link: link(LINK_STATUS.NOT_RECORDED, LINK_SOURCE.PHASE41_VERIFICATION, WHY_REASON.VERIFICATION_NOT_RECORDED, "No Phase 41 verification result is linked to this execution, so no verification state can be reported."),
			state: "UNKNOWN",
			authoritative: false,
			detail,
		};
	}

	if (proofLink.status === LINK_STATUS.INVALID) {
		return {
			link: link(LINK_STATUS.INVALID, LINK_SOURCE.PHASE41_VERIFICATION, WHY_REASON.PROOF_INVALID, "The proof carrying this Phase 41 result failed its integrity check, so the state is not reported."),
			state: "UNKNOWN",
			authoritative: false,
			detail,
		};
	}

	if (!environmentMatches) {
		return {
			link: link(LINK_STATUS.IDENTITY_MISMATCH, LINK_SOURCE.PHASE41_VERIFICATION, WHY_REASON.PROOF_IDENTITY_MISMATCH, "The Phase 41 result was recorded for a different target environment than this execution, so it is not this execution's result."),
			state: "UNKNOWN",
			authoritative: false,
			detail,
		};
	}

	if (proofLink.status === LINK_STATUS.STALE) {
		return {
			link: link(LINK_STATUS.STALE, LINK_SOURCE.PHASE41_VERIFICATION, WHY_REASON.PROOF_STALE, "The Phase 41 result is intact but was recorded against a different identity than the run linked to this execution, so it is not reported as this execution's state."),
			state: "UNKNOWN",
			authoritative: false,
			detail,
		};
	}

	// Phase 47A's builder refuses to let the two states disagree. If they do, the
	// envelope has been edited since it was signed.
	if (proofState !== carriedState) {
		return {
			link: link(LINK_STATUS.INVALID, LINK_SOURCE.PHASE41_VERIFICATION, WHY_REASON.PROOF_INVALID, "The proof's overall state and its Phase 41 evidence state disagree, so neither is trusted."),
			state: "UNKNOWN",
			authoritative: false,
			detail,
		};
	}

	return {
		link: link(LINK_STATUS.RECORDED, LINK_SOURCE.PHASE41_VERIFICATION, WHY_REASON.LINKED_PHASE41_STATE, `A Phase 41 result is linked through the proof. The state ${carriedState} is restated verbatim.`, {
			identity: proofLink.identity,
			observedAt: proofLink.observedAt,
			fingerprint: detail.fingerprint ?? proofLink.fingerprint,
		}),
		state: carriedState,
		authoritative: true,
		detail,
	};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build every evidence link for one execution.
 *
 * `runs` are persisted Phase 46B runs already filtered (by the repository) to the
 * ones that mention this execution, so no cross-profile or cross-execution data
 * can reach this function. `suppliedProof` is an untrusted artifact text supplied
 * by the caller; it is parsed through Phase 47B's safe importer.
 */
export function buildEvidenceLinks({ executionId, receipt, runs, suppliedProof }) {
	const requestId = receipt?.requestId ?? null;
	const rehearsal = linkRehearsalRuns({ executionId, requestId, runs });

	const parsed = parseSuppliedProof(suppliedProof);
	const proofResult = linkProof({
		proof: parsed.proof ?? null,
		parseError: parsed.errorCode ? { code: parsed.errorCode, message: parsed.errorMessage } : null,
		artifactFingerprint: parsed.artifactFingerprint ?? null,
		receipt: { ...(receipt ?? {}), executionId },
		rehearsal,
	});

	const proof = parsed.proof ?? null;
	const proofLink = proofResult.link;

	return {
		rehearsal: { link: rehearsal.link, run: rehearsal.run, runs: rehearsal.runs, step: rehearsal.step, truncated: rehearsal.truncated },
		proof: { link: proofLink, detail: proofResult.detail, parseError: proofResult.parseError },
		impact: projectImpactFromProof({ proof, proofLink, requestId }),
		drift: projectDriftFromProof({ proof, proofLink }),
		contract: projectContractFromProof({ proof, proofLink, requestId, rehearsal }),
		verification: projectVerificationFromProof({ proof, proofLink, requestId }),
	};
}
