import { describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";

// The linkage layer reuses the Phase 47 proof core, which fingerprints through the
// history HMAC key, so the suite initializes config exactly like the 47A/47B
// suites. No database and no network: proof minting is pure.
process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase49b_evidence_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase49b-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase49b-test-jwt-secret";
initConfig();

import { buildVerificationProof } from "../verification-proof/index.js";
import {
	ENV_FP,
	SNAPSHOT_FP,
	SNAPSHOT_ID,
	TARGET_ENV,
	WORKSPACE_ID,
	proofInput,
	verificationFixture,
} from "../verification-proof/proof-fixtures.js";
import { buildProofArtifact, serializeProofArtifact } from "../verification-proof-api/index.js";
import {
	buildEvidenceLinks,
	linkProof,
	linkRehearsalRuns,
	parseSuppliedProof,
	projectContractFromProof,
	projectDriftFromProof,
	projectImpactFromProof,
	projectVerificationFromProof,
	safeText,
} from "./why-evidence.js";
import { LINK_SOURCE, LINK_STATUS, WHY_REASON } from "./why-schema.js";

const EXECUTION_ID = "11111111-2222-4333-8444-555555555555";
const REQUEST_ID = "r1";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function artifactText(proof) {
	return serializeProofArtifact(buildProofArtifact(proof));
}

function validProof() {
	return buildVerificationProof(proofInput());
}

function rehearsalRun({
	executionId = EXECUTION_ID,
	requestId = REQUEST_ID,
	runId = "run-1",
	snapshotId = SNAPSHOT_ID,
	snapshotFingerprint = SNAPSHOT_FP,
	environmentId = TARGET_ENV,
	environmentFingerprint = ENV_FP,
	withEvidence = true,
	declaresRequest = true,
} = {}) {
	return {
		runId,
		runState: "COMPLETED",
		generation: 1,
		identity: {
			workspaceId: WORKSPACE_ID,
			snapshotId,
			snapshotFingerprint,
			targetEnvironment: { environmentId, environmentFingerprint, environmentName: "staging" },
			planId: "plan-1",
			planFingerprint: "plan-fingerprint-49b",
		},
		identityFingerprint: "identity-fingerprint-49b",
		planFingerprint: "plan-fingerprint-49b",
		plan: { steps: declaresRequest ? [{ stepId: `step:${requestId}`, refId: requestId }] : [] },
		stepStates: [
			{
				stepId: `step:${requestId}`,
				state: "COMPLETED",
				completion: {
					metadata: {
						outcome: "response",
						httpStatus: 200,
						durationMs: 12,
						contractStatus: "COMPATIBLE",
						compatible: true,
						findings: [],
						breaking: 0,
						nonBreaking: 1,
						unknown: 0,
					},
				},
				attempt: { attempts: 1, ownerGeneration: 1, evidenceRefs: withEvidence ? [executionId] : [] },
			},
		],
		completedStepIds: [`step:${requestId}`],
		terminalReasonCode: "COMPLETED",
		createdAt: new Date("2026-09-24T09:59:00.000Z"),
		updatedAt: new Date("2026-09-24T09:59:30.000Z"),
	};
}

const RECEIPT = { executionId: EXECUTION_ID, requestId: REQUEST_ID, environmentId: TARGET_ENV };

/* -------------------------------------------------------------------------- */

describe("Phase 49B — safeText", () => {
	test("1 — redacts credential-shaped text using Phase 47A's predicate", () => {
		expect(safeText("Bearer abcdefghijklmnopqrstuvwx")).toBe("[redacted]");
		expect(safeText("a normal reason")).toBe("a normal reason");
	});

	test("2 — truncates over-long text and returns null for non-strings", () => {
		const long = "x".repeat(5000);
		expect(safeText(long, 100).length).toBe(101);
		expect(safeText(null)).toBeNull();
		expect(safeText(42)).toBeNull();
	});
});

describe("Phase 49B — parseSuppliedProof", () => {
	test("3 — reports nothing supplied for null/undefined", () => {
		expect(parseSuppliedProof(null)).toEqual({ supplied: false });
		expect(parseSuppliedProof(undefined)).toEqual({ supplied: false });
	});

	test("4 — accepts a serialized artifact and exposes the artifact fingerprint", () => {
		const parsed = parseSuppliedProof(artifactText(validProof()));
		expect(parsed.supplied).toBe(true);
		expect(parsed.proof.kind).toBe("tracer.verification-proof");
		expect(parsed.artifactFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(parsed.errorCode).toBeUndefined();
	});

	test("5 — refuses malformed input without throwing", () => {
		const parsed = parseSuppliedProof("this is not json");
		expect(parsed.supplied).toBe(true);
		expect(parsed.proof).toBeUndefined();
		expect(typeof parsed.errorCode).toBe("string");
	});

	test("6 — refuses a tampered artifact without throwing", () => {
		const text = artifactText(validProof());
		const parsed = JSON.parse(text);
		parsed.proof.state = "VERIFIED";
		parsed.proof.verification.state = "BLOCKED";
		const result = parseSuppliedProof(JSON.stringify(parsed));
		expect(result.proof).toBeUndefined();
		expect(result.errorCode).toBeTruthy();
	});
});

describe("Phase 49B — rehearsal linkage", () => {
	test("7 — fails closed when no run is supplied", () => {
		const result = linkRehearsalRuns({ executionId: EXECUTION_ID, requestId: REQUEST_ID, runs: [] });
		expect(result.link.status).toBe(LINK_STATUS.NOT_RECORDED);
		expect(result.link.reasonCode).toBe(WHY_REASON.REHEARSAL_NOT_RECORDED);
		expect(result.run).toBeNull();
	});

	test("8 — proves the run that produced this execution through its evidence refs", () => {
		const result = linkRehearsalRuns({ executionId: EXECUTION_ID, requestId: REQUEST_ID, runs: [rehearsalRun()] });
		expect(result.link.status).toBe(LINK_STATUS.RECORDED);
		expect(result.link.source).toBe(LINK_SOURCE.PHASE46B_RUN);
		expect(result.run.runId).toBe("run-1");
		expect(result.run.snapshotFingerprint).toBe(SNAPSHOT_FP);
		expect(result.link.identity.map((token) => token.label)).toContain("execution");
	});

	test("9 — never trusts raw ids blindly: identity tokens carry the recorded values", () => {
		const result = linkRehearsalRuns({ executionId: EXECUTION_ID, requestId: REQUEST_ID, runs: [rehearsalRun()] });
		const requestToken = result.link.identity.find((token) => token.label === "request");
		expect(requestToken.value).toBe(REQUEST_ID);
	});

	test("10 — fails closed with identity_mismatch when the run's step names another request", () => {
		const result = linkRehearsalRuns({
			executionId: EXECUTION_ID,
			requestId: REQUEST_ID,
			runs: [rehearsalRun({ requestId: "r2" })],
		});
		expect(result.link.status).toBe(LINK_STATUS.IDENTITY_MISMATCH);
		expect(result.link.reasonCode).toBe(WHY_REASON.IDENTITY_UNPROVEN);
	});

	test("11 — reports partial when the run only planned the request", () => {
		const result = linkRehearsalRuns({
			executionId: EXECUTION_ID,
			requestId: REQUEST_ID,
			runs: [rehearsalRun({ withEvidence: false })],
		});
		expect(result.link.status).toBe(LINK_STATUS.PARTIAL);
		expect(result.link.reasonCode).toBe(WHY_REASON.REHEARSAL_STEP_NOT_EXECUTED);
	});

	test("12 — bounds the number of linked runs and reports truncation", () => {
		const runs = Array.from({ length: 5 }, (_, index) =>
			rehearsalRun({ executionId: "22222222-2222-4222-8222-222222222222", runId: `run-${index}` }),
		);
		const result = linkRehearsalRuns({ executionId: EXECUTION_ID, requestId: REQUEST_ID, runs });
		// None of the runs names this execution, but every run declares the same
		// request, so the honest link is the weaker partial evidence — and the
		// bound (maxLinkedRuns: 3) is reported via truncated, never silent.
		expect(result.link.status).toBe(LINK_STATUS.PARTIAL);
		expect(result.link.reasonCode).toBe(WHY_REASON.REHEARSAL_STEP_NOT_EXECUTED);
		expect(result.truncated).toBe(true);
	});

	test("13 — copies the step outcome metadata for a linked step", () => {
		const result = linkRehearsalRuns({ executionId: EXECUTION_ID, requestId: REQUEST_ID, runs: [rehearsalRun()] });
		expect(result.step.outcome.httpStatus).toBe(200);
		expect(result.step.outcome.compatible).toBe(true);
		expect(result.step.requestId).toBe(REQUEST_ID);
	});
});

describe("Phase 49B — proof linkage", () => {
	test("14 — reports not_recorded when nothing was supplied", () => {
		const result = linkProof({ proof: null, receipt: RECEIPT });
		expect(result.link.status).toBe(LINK_STATUS.NOT_RECORDED);
		expect(result.link.reasonCode).toBe(WHY_REASON.PROOF_NOT_RECORDED);
		expect(result.detail).toBeNull();
	});

	test("15 — reports invalid when the importer refused the artifact", () => {
		const result = linkProof({ proof: null, parseError: { code: "MALFORMED", message: "bad" }, receipt: RECEIPT });
		expect(result.link.status).toBe(LINK_STATUS.INVALID);
		expect(result.link.reasonCode).toBe(WHY_REASON.PROOF_INVALID);
		expect(result.parseError.code).toBe("MALFORMED");
	});

	test("16 — reports invalid when the proof fails its own integrity check", () => {
		const proof = { ...validProof(), fingerprint: "0".repeat(64) };
		const result = linkProof({ proof, receipt: RECEIPT });
		expect(result.link.status).toBe(LINK_STATUS.INVALID);
		expect(result.link.reasonCode).toBe(WHY_REASON.PROOF_INVALID);
	});

	test("17 — reports identity_mismatch for a different target environment", () => {
		const result = linkProof({ proof: validProof(), receipt: { ...RECEIPT, environmentId: "env-other" } });
		expect(result.link.status).toBe(LINK_STATUS.IDENTITY_MISMATCH);
		expect(result.link.reasonCode).toBe(WHY_REASON.PROOF_IDENTITY_MISMATCH);
	});

	test("18 — reports partial when the proof does not name this request", () => {
		const result = linkProof({ proof: validProof(), receipt: { ...RECEIPT, requestId: "r-absent" } });
		expect(result.link.status).toBe(LINK_STATUS.PARTIAL);
		expect(result.link.reasonCode).toBe(WHY_REASON.PROOF_UNLINKED);
	});

	test("19 — records a proof that names this request in this environment", () => {
		const result = linkProof({ proof: validProof(), receipt: RECEIPT });
		expect(result.link.status).toBe(LINK_STATUS.RECORDED);
		expect(result.link.reasonCode).toBe(WHY_REASON.PROOF_RECORDED);
		expect(result.link.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(result.detail.state).toBe("VERIFIED");
		expect(result.detail.fingerprintKeyId).toBeTruthy();
	});

	test("20 — never reports CURRENT without a recorded identity to compare against", () => {
		const result = linkProof({ proof: validProof(), receipt: RECEIPT, rehearsal: { run: null } });
		// Execution records carry no snapshot identity, so Phase 47B answers UNKNOWN.
		expect(result.link.status).toBe(LINK_STATUS.RECORDED);
		expect(result.detail.report.staleness).toBe("UNKNOWN");
	});

	test("21 — delegates staleness to Phase 47B and reports stale when the run's snapshot moved", () => {
		const run = rehearsalRun({ snapshotFingerprint: "fp-moved" }).identity;
		const result = linkProof({
			proof: validProof(),
			receipt: RECEIPT,
			rehearsal: { run: { snapshotId: run.snapshotId, snapshotFingerprint: run.snapshotFingerprint, targetEnvironment: run.targetEnvironment } },
		});
		expect(result.detail.report.staleness).toBe("STALE");
		expect(result.link.status).toBe(LINK_STATUS.STALE);
		expect(result.link.reasonCode).toBe(WHY_REASON.PROOF_STALE);
	});

	test("22 — reports CURRENT when the linked run matches the proof identity", () => {
		const run = rehearsalRun().identity;
		const result = linkProof({
			proof: validProof(),
			receipt: RECEIPT,
			rehearsal: { run: { snapshotId: run.snapshotId, snapshotFingerprint: run.snapshotFingerprint, targetEnvironment: run.targetEnvironment } },
		});
		expect(result.detail.report.staleness).toBe("CURRENT");
		expect(result.link.status).toBe(LINK_STATUS.RECORDED);
	});
});

describe("Phase 49B — derived projections copy, never recompute", () => {
	test("23 — copies the Phase 41 state verbatim when the link is recorded", () => {
		const proof = validProof();
		const projection = projectVerificationFromProof({ proof, proofLink: { status: LINK_STATUS.RECORDED, identity: [], observedAt: null, fingerprint: proof.fingerprint }, requestId: REQUEST_ID });
		expect(projection.state).toBe("VERIFIED");
		expect(projection.authoritative).toBe(true);
		expect(projection.detail.requestVerified).toBe(true);
		expect(projection.detail.verifiedRequestIds).toContain(REQUEST_ID);
	});

	test("24 — reports UNKNOWN when the proof carries no Phase 41 result", () => {
		const proof = buildVerificationProof(proofInput({ verification: null, evidence: { executions: [], assertions: [] } }));
		const projection = projectVerificationFromProof({ proof, proofLink: { status: LINK_STATUS.RECORDED, identity: [], observedAt: null, fingerprint: null }, requestId: REQUEST_ID });
		expect(projection.state).toBe("UNKNOWN");
		expect(projection.authoritative).toBe(false);
		expect(projection.link.reasonCode).toBe(WHY_REASON.VERIFICATION_NOT_RECORDED);
	});

	test("25 — reports UNKNOWN and preserves the observation when the proof is invalid", () => {
		const proof = validProof();
		const projection = projectVerificationFromProof({ proof, proofLink: { status: LINK_STATUS.INVALID, identity: [], observedAt: null, fingerprint: null }, requestId: REQUEST_ID });
		expect(projection.state).toBe("UNKNOWN");
		expect(projection.authoritative).toBe(false);
		expect(projection.link.status).toBe(LINK_STATUS.INVALID);
		expect(projection.detail.state).toBe("VERIFIED");
	});

	test("26 — reports UNKNOWN for a stale proof", () => {
		const proof = validProof();
		const projection = projectVerificationFromProof({ proof, proofLink: { status: LINK_STATUS.STALE, identity: [], observedAt: null, fingerprint: null }, requestId: REQUEST_ID });
		expect(projection.state).toBe("UNKNOWN");
		expect(projection.link.reasonCode).toBe(WHY_REASON.PROOF_STALE);
	});

	test("27 — rejects an envelope whose overall and Phase 41 states disagree", () => {
		const proof = { ...validProof(), state: "BLOCKED" };
		const projection = projectVerificationFromProof({ proof, proofLink: { status: LINK_STATUS.RECORDED, identity: [], observedAt: null, fingerprint: null }, requestId: REQUEST_ID });
		expect(projection.state).toBe("UNKNOWN");
		expect(projection.link.status).toBe(LINK_STATUS.INVALID);
	});

	test("28 — copies the Phase 39 impact envelope without inferring membership", () => {
		const proof = validProof();
		const projection = projectImpactFromProof({ proof, proofLink: { status: LINK_STATUS.RECORDED, identity: [], observedAt: null, fingerprint: null }, requestId: REQUEST_ID });
		expect(projection.link.status).toBe(LINK_STATUS.RECORDED);
		expect(projection.detail.directRequestIds).toContain(REQUEST_ID);
		expect(projection.detail.request.impacted).toBe(true);
	});

	test("29 — copies the Phase 40 drift envelope without inferring blocking", () => {
		const proof = validProof();
		const projection = projectDriftFromProof({ proof, proofLink: { status: LINK_STATUS.RECORDED, identity: [], observedAt: null, fingerprint: null } });
		expect(projection.link.status).toBe(LINK_STATUS.RECORDED);
		expect(projection.detail.present).toBe(true);
		expect(projection.detail.fingerprint).toBe(proof.drift.fingerprint);
	});

	test("30 — reports impact/drift not recorded when the proof carries neither", () => {
		// A VERIFIED proof refuses to build without the impact/drift inputs it
		// rests on, so this projection test mints an UNKNOWN proof that carries
		// neither envelope.
		const proof = buildVerificationProof(proofInput({ verification: verificationFixture({ state: "UNKNOWN", verifiedRequestIds: [] }), impact: null, drift: null }));
		const impact = projectImpactFromProof({ proof, proofLink: { status: LINK_STATUS.RECORDED, identity: [], observedAt: null, fingerprint: null }, requestId: REQUEST_ID });
		const drift = projectDriftFromProof({ proof, proofLink: { status: LINK_STATUS.RECORDED, identity: [], observedAt: null, fingerprint: null } });
		expect(impact.detail === null || impact.detail.present === false).toBe(true);
		expect(drift.detail === null || drift.detail.present === false).toBe(true);
	});

	test("31 — copies the Phase 43 contract block and the rehearsal step metadata", () => {
		const proof = validProof();
		const step = rehearsalRun().stepStates[0];
		const projection = projectContractFromProof({
			proof,
			proofLink: { status: LINK_STATUS.RECORDED, identity: [], observedAt: null, fingerprint: null },
			requestId: REQUEST_ID,
			rehearsal: { step: { outcome: step.completion.metadata } },
		});
		expect(projection.link.status).toBe(LINK_STATUS.RECORDED);
		expect(projection.detail.present).toBe(true);
	});

	test("32 — reports contract not recorded when nothing carries a comparison", () => {
		const projection = projectContractFromProof({ proof: null, proofLink: { status: LINK_STATUS.NOT_RECORDED, identity: [], observedAt: null, fingerprint: null }, requestId: REQUEST_ID, rehearsal: null });
		expect(projection.link.status).toBe(LINK_STATUS.NOT_RECORDED);
		expect(projection.link.reasonCode).toBe(WHY_REASON.CONTRACT_NOT_RECORDED);
	});
});

describe("Phase 49B — buildEvidenceLinks", () => {
	test("33 — links a supplied artifact end to end and keeps every derived node consistent", () => {
		const links = buildEvidenceLinks({
			executionId: EXECUTION_ID,
			receipt: RECEIPT,
			runs: [],
			suppliedProof: artifactText(validProof()),
		});
		expect(links.proof.link.status).toBe(LINK_STATUS.RECORDED);
		expect(links.verification.state).toBe("VERIFIED");
		expect(links.verification.authoritative).toBe(true);
		expect(links.impact.link.status).toBe(LINK_STATUS.RECORDED);
		expect(links.drift.link.status).toBe(LINK_STATUS.RECORDED);
		expect(links.contract.link.status).toBe(LINK_STATUS.RECORDED);
		expect(links.rehearsal.link.status).toBe(LINK_STATUS.NOT_RECORDED);
	});

	test("34 — degrades the entire chain when the artifact is refused", () => {
		const links = buildEvidenceLinks({ executionId: EXECUTION_ID, receipt: RECEIPT, runs: [], suppliedProof: "{ broken" });
		expect(links.proof.link.status).toBe(LINK_STATUS.INVALID);
		expect(links.verification.state).toBe("UNKNOWN");
		expect(links.impact.link.status).not.toBe(LINK_STATUS.RECORDED);
		expect(links.drift.link.status).not.toBe(LINK_STATUS.RECORDED);
	});

	test("35 — links a rehearsal run without requiring a proof", () => {
		const links = buildEvidenceLinks({ executionId: EXECUTION_ID, receipt: RECEIPT, runs: [rehearsalRun()], suppliedProof: null });
		expect(links.rehearsal.link.status).toBe(LINK_STATUS.RECORDED);
		expect(links.proof.link.status).toBe(LINK_STATUS.NOT_RECORDED);
		expect(links.verification.state).toBe("UNKNOWN");
	});

	test("36 — never emits a credential-shaped string", () => {
		const proof = validProof();
		const links = buildEvidenceLinks({ executionId: EXECUTION_ID, receipt: RECEIPT, runs: [rehearsalRun()], suppliedProof: artifactText(proof) });
		const serialized = JSON.stringify(links);
		expect(serialized).not.toContain("Bearer ");
		expect(serialized).not.toContain("Basic ");
		expect(serialized).not.toContain("-----BEGIN");
	});

	test("37 — reports stale for a rehearsal identity that moved past the proof", () => {
		const moved = rehearsalRun({ snapshotFingerprint: "fp-moved", runId: "run-2" });
		const links = buildEvidenceLinks({ executionId: EXECUTION_ID, receipt: RECEIPT, runs: [moved], suppliedProof: artifactText(validProof()) });
		expect(links.rehearsal.link.status).toBe(LINK_STATUS.RECORDED);
		expect(links.proof.link.status).toBe(LINK_STATUS.STALE);
		expect(links.verification.state).toBe("UNKNOWN");
		expect(links.verification.authoritative).toBe(false);
	});
});
