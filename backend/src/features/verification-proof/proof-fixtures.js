// Phase 47A — deterministic fixtures for the verification-proof suite.
//
// Pure data. No clock, no randomness, no database, no network. Every fixture is
// built from the same upstream cores the proof consumes, so the suite exercises
// real envelopes rather than hand-rolled lookalikes.

import { planRehearsal } from "../rehearsal-planning/index.js";
import { identityFingerprint } from "../rehearsal-checkpoints/index.js";
import { buildCompatibilityResult } from "../contract-compatibility/index.js";

export const WORKSPACE_ID = "ws-47";
export const SNAPSHOT_ID = "snap-47";
export const SNAPSHOT_FP = "fp-snapshot-47";
export const SOURCE_ENV = "env-local";
export const TARGET_ENV = "env-staging";
export const ENV_FP = "env-fingerprint-47";
export const POLICY_IDENTITY = "policy-identity-47";
export const VERIFIED_AT = "2026-09-24T10:00:00.000Z";

// The proof core is deliberately database-free, so fixtures name a synthetic owner
// instead of a Mongo ObjectId. The Phase 47B route harness resolves that sentinel to
// the authenticated test profile; the core never reads it.
export const EVIDENCE_OWNER_PROFILE_ID = "__verification-proof-synthetic-e2e__";

export function impactResult({ direct = ["r1"], indirect = [] } = {}) {
	const row = (requestId) => ({ requestId, nodeKind: "request", collectionId: "col-1" });
	return {
		kind: "tracer.change-impact",
		schemaVersion: 1,
		resolved: true,
		truncated: false,
		summary: { directRequests: direct.length, indirectRequests: indirect.length, unknownReferences: 0 },
		requests: {
			direct: direct.map((id) => ({ ...row(id), impact: "direct", hop: 1, confidence: "exact" })),
			indirect: indirect.map((id) => ({ ...row(id), impact: "indirect", hop: 2, confidence: "exact" })),
		},
		unknown: [],
	};
}

export function driftResult({ severity = "medium", status = "confirmed" } = {}) {
	return {
		kind: "tracer.environment-drift",
		schemaVersion: 1,
		source: { environmentId: SOURCE_ENV, name: "local", revision: 1 },
		target: { environmentId: TARGET_ENV, name: "staging", revision: 2 },
		identical: false,
		summary: { total: 1, byCategory: { VARIABLE_CHANGED: 1 }, bySeverity: { [severity]: 1 } },
		drift: [{ category: "VARIABLE_CHANGED", path: "variables.baseUrl", severity, status }],
	};
}

function blastRadiusResult(requestIds) {
	const entries = requestIds.map((requestId) => ({
		requestId,
		host: "api.test",
		hostKey: "api.test",
		port: null,
		method: "GET",
		classification: "NON_MUTATING",
		mutating: false,
		admission: "ADMITTED",
		reasonCodes: [],
	}));
	return {
		kind: "tracer.blast-radius-envelope",
		version: 1,
		policy: { kind: "tracer.blast-radius-policy", version: 1, identity: POLICY_IDENTITY },
		workspace: { workspaceId: WORKSPACE_ID, snapshotId: SNAPSHOT_ID },
		environment: { environmentId: SOURCE_ENV, targetEnvironmentId: TARGET_ENV },
		admissionState: "ADMITTED",
		requests: { proposed: entries.length, admitted: entries.length, blocked: 0, unknown: 0, requiresConfirmation: 0 },
		allowedRequests: entries,
		blockedRequests: [],
		unknownRequests: [],
		confirmationRequests: [],
	};
}

export function buildPlan(requestIds = ["r1"]) {
	const input = {
		workspaceId: WORKSPACE_ID,
		snapshot: { snapshotId: SNAPSHOT_ID, snapshotFingerprint: SNAPSHOT_FP },
		source: { environmentId: SOURCE_ENV, snapshotFingerprint: SNAPSHOT_FP },
		target: { environmentId: TARGET_ENV, snapshotFingerprint: SNAPSHOT_FP },
		impact: impactResult({ direct: requestIds }),
		drift: driftResult(),
		blastRadius: blastRadiusResult(requestIds),
		candidates: requestIds.map((requestId) => ({ requestId, collectionId: "col-1", host: "api.test", method: "GET" })),
	};
	return { plan: planRehearsal(input), blastRadius: input.blastRadius };
}

export function runFixture(plan, { runState = "COMPLETED", runId = "run-47", completedStepIds } = {}) {
	const identity = {
		workspaceId: WORKSPACE_ID,
		snapshotId: SNAPSHOT_ID,
		snapshotFingerprint: SNAPSHOT_FP,
		targetEnvironment: { environmentId: TARGET_ENV, environmentFingerprint: ENV_FP, environmentName: "staging" },
		planId: plan.identity.planFingerprint,
		planFingerprint: plan.identity.planFingerprint,
	};
	return {
		runId,
		runState,
		identity,
		identityFingerprint: identityFingerprint(identity),
		completedStepIds: completedStepIds ?? plan.steps.map((step) => step.stepId),
		pendingStepIds: [],
	};
}

export function executionEvidence(overrides = {}) {
	return {
		executionId: "exec-r1",
		requestId: "r1",
		collectionId: "col-1",
		workspaceId: WORKSPACE_ID,
		snapshotFingerprint: SNAPSHOT_FP,
		snapshotId: SNAPSHOT_ID,
		environmentId: TARGET_ENV,
		environmentName: "staging",
		outcome: "response",
		complete: true,
		ownerProfileId: EVIDENCE_OWNER_PROFILE_ID,
		startedAt: "2026-09-24T09:59:00.000Z",
		finishedAt: "2026-09-24T09:59:01.000Z",
		...overrides,
	};
}

export function assertionEvidence(overrides = {}) {
	return {
		assertionId: "assert-r1",
		requestId: "r1",
		status: "passed",
		required: true,
		collectionId: "col-1",
		snapshotFingerprint: SNAPSHOT_FP,
		snapshotId: SNAPSHOT_ID,
		environmentId: TARGET_ENV,
		...overrides,
	};
}

export function verificationFixture({
	state = "VERIFIED",
	verifiedRequestIds = ["r1"],
	affectedRequestIds = ["r1"],
	requiredRehearsalRequestIds = ["r1"],
	blockers = [],
	warnings = [],
	target = {},
} = {}) {
	return {
		schemaVersion: 1,
		kind: "tracer.cross-env-verification",
		state,
		source: { workspaceId: WORKSPACE_ID, environmentId: SOURCE_ENV },
		target: {
			workspaceId: WORKSPACE_ID,
			snapshotId: SNAPSHOT_ID,
			snapshotFingerprint: SNAPSHOT_FP,
			environmentId: TARGET_ENV,
			...target,
		},
		blockers,
		warnings,
		affectedRequestIds,
		requiredRehearsalRequestIds,
		verifiedRequestIds,
		acceptedEvidenceIds: [],
		rejectedEvidenceIds: [],
		staleEvidenceIds: [],
		summary: {
			affectedRequests: affectedRequestIds.length,
			requiredRehearsals: requiredRehearsalRequestIds.length,
			verifiedRequests: verifiedRequestIds.length,
			acceptedEvidence: 0,
			rejectedEvidence: 0,
			staleEvidence: 0,
			blockers: blockers.length,
			warnings: warnings.length,
		},
	};
}

export function contractResult({ requestId = "r1", status = 200, executionId = "exec-r1" } = {}) {
	return buildCompatibilityResult({
		contract: {
			contractId: `contract-${requestId}`,
			sequence: 1,
			state: "PUBLISHED",
			contentFingerprint: "contract-content-fingerprint-47",
			fingerprintKeyId: "key-47",
			ownerProfileId: EVIDENCE_OWNER_PROFILE_ID,
			requestId,
		},
		observed: { status, identity: { executionId, label: null } },
		findings: [
			{
				code: "STATUS_ALLOWED",
				class: "NON_BREAKING",
				path: "status",
				expected: 200,
				actual: status,
			},
		],
		statusChecked: 1,
		headersChecked: 0,
		bodyStructureChecked: 0,
	});
}

// The canonical valid proof input. Every "fail closed" test starts from this and
// perturbs exactly one thing.
export function proofInput(overrides = {}) {
	const requestIds = overrides.requestIds ?? ["r1"];
	const { plan } = buildPlan(requestIds);
	const run = runFixture(plan, overrides.runOptions ?? {});
	return {
		workspaceId: WORKSPACE_ID,
		snapshot: { snapshotId: SNAPSHOT_ID, snapshotFingerprint: SNAPSHOT_FP },
		targetEnvironment: { environmentId: TARGET_ENV, environmentFingerprint: ENV_FP, environmentName: "staging" },
		plan,
		run,
		evidence: { executions: [executionEvidence()], assertions: [assertionEvidence()] },
		verification: verificationFixture(),
		impact: impactResult(),
		drift: driftResult(),
		contracts: [contractResult()],
		executedStepIds: plan.steps.map((step) => step.stepId),
		stopReason: "COMPLETED",
		terminated: true,
		verifiedAt: VERIFIED_AT,
		...overrides,
	};
}
