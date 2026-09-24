import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initConfig } from "../../shared/config/index.js";

// The proof core reuses the history fingerprint HMAC key, so the suite initializes
// config once, exactly like the 46A/46C suites. No database, no network.
process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase47_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase47-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase47-test-jwt-secret";
initConfig();

import {
	PROOF_ERROR_CODES,
	PROOF_LIMITS,
	PROOF_REASON_CODES,
	PROOF_STATES,
	PROOF_STATE_PRIORITY,
	VERIFICATION_PROOF_KIND,
	VERIFICATION_PROOF_SCHEMA_VERSION,
	assertNoEvidenceUpgrade,
	assertProofIntegrity,
	assertProofResult,
	assertProofSize,
	buildVerificationProof,
	canonicalProofJsonOf,
	canonicalizeProofValue,
	digestOf,
	fingerprintsEqual,
	parseProofInput,
	proofFingerprintOf,
	proofIdOf,
	proofIdentityOf,
	verifyProofIntegrity,
	verifyProofMatchesEvidence,
} from "./index.js";
import { assertionEvidence, contractResult, driftResult, executionEvidence, proofInput, runFixture, verificationFixture, buildPlan } from "./proof-fixtures.js";

function expectCode(fn, code) {
	let thrown = null;
	try {
		fn();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).not.toBeNull();
	expect(thrown.code).toBe(code);
	return thrown;
}

// ---------------------------------------------------------------------------
// Vocabulary and schema
// ---------------------------------------------------------------------------

describe("Phase 47A — vocabulary", () => {
	it("reuses the Phase 41 evidence vocabulary verbatim", () => {
		expect(PROOF_STATES.VERIFIED).toBe("VERIFIED");
		expect(PROOF_STATES.BLOCKED).toBe("BLOCKED");
		expect(PROOF_STATES.NEEDS_REHEARSAL).toBe("NEEDS_REHEARSAL");
		expect(PROOF_STATES.UNKNOWN).toBe("UNKNOWN");
		expect(Object.keys(PROOF_STATE_PRIORITY)).toHaveLength(4);
	});

	it("orders states so that upgrading evidence means a lower priority", () => {
		expect(PROOF_STATE_PRIORITY.VERIFIED).toBeLessThan(PROOF_STATE_PRIORITY.UNKNOWN);
		expect(PROOF_STATE_PRIORITY.UNKNOWN).toBeLessThan(PROOF_STATE_PRIORITY.NEEDS_REHEARSAL);
		expect(PROOF_STATE_PRIORITY.NEEDS_REHEARSAL).toBeLessThan(PROOF_STATE_PRIORITY.BLOCKED);
	});

	it("exposes a closed, versioned envelope identity", () => {
		expect(VERIFICATION_PROOF_KIND).toBe("tracer.verification-proof");
		expect(VERIFICATION_PROOF_SCHEMA_VERSION).toBe(1);
	});

	it("rejects a missing plan with a typed MISSING_IDENTITY error", () => {
		expectCode(() => parseProofInput(proofInput({ plan: undefined })), PROOF_ERROR_CODES.MISSING_IDENTITY);
	});

	it("rejects an unknown top-level input field", () => {
		expectCode(() => parseProofInput(proofInput({ surprise: true })), PROOF_ERROR_CODES.MALFORMED_INPUT);
	});

	it("rejects a credential-shaped identifier", () => {
		expectCode(
			() => parseProofInput(proofInput({ workspaceId: "Bearer abcdefghijklmnopqrst" })),
			PROOF_ERROR_CODES.MALFORMED_INPUT,
		);
	});

	it("rejects a proof result that fails its own contract", () => {
		expectCode(() => assertProofResult({ kind: VERIFICATION_PROOF_KIND }), PROOF_ERROR_CODES.INVALID_RESULT);
	});
});

// ---------------------------------------------------------------------------
// Canonicalization and fingerprint primitives
// ---------------------------------------------------------------------------

describe("Phase 47A — identity primitives", () => {
	it("sorts keys, drops undefined, and preserves array order", () => {
		expect(canonicalizeProofValue({ b: 1, a: { d: 2, c: 3 }, e: undefined })).toEqual({ a: { c: 3, d: 2 }, b: 1 });
		expect(canonicalizeProofValue({ list: [3, 1, 2] })).toEqual({ list: [3, 1, 2] });
	});

	it("is stable across key insertion order and returns a 64-hex fingerprint", () => {
		const left = proofIdentityOf({ a: 1, b: 2 });
		const right = proofIdentityOf({ b: 2, a: 1 });
		expect(left).toBe(right);
		expect(left).toMatch(/^[0-9a-f]{64}$/);
	});

	it("derives a stable display id from a fingerprint", () => {
		const fingerprint = proofIdentityOf({ a: 1 });
		expect(proofIdOf(fingerprint)).toBe(`proof_${fingerprint.slice(0, 32)}`);
	});

	it("digests deterministically and returns null for absent input", () => {
		expect(digestOf("source", { a: 1 })).toBe(digestOf("source", { a: 1 }));
		expect(digestOf("source", null)).toBeNull();
		expect(digestOf("source", undefined)).toBeNull();
	});

	it("compares fingerprints of different lengths without throwing", () => {
		expect(fingerprintsEqual("a", "a")).toBe(true);
		expect(fingerprintsEqual("a", "bb")).toBe(false);
		expect(fingerprintsEqual("", "a")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Builder — happy paths
// ---------------------------------------------------------------------------

describe("Phase 47A — builder", () => {
	it("builds a VERIFIED proof for a fully rehearsed, verified run", () => {
		const proof = buildVerificationProof(proofInput());
		expect(proof.state).toBe(PROOF_STATES.VERIFIED);
		expect(proof.verification.present).toBe(true);
		expect(proof.verification.state).toBe(PROOF_STATES.VERIFIED);
		expect(proof.counts.verified).toBe(1);
		expect(proof.counts.rehearsed).toBe(1);
		expect(verifyProofIntegrity(proof)).toBe(true);
	});

	it("copies the Phase 41 state for a BLOCKED run", () => {
		const proof = buildVerificationProof(
			proofInput({
				drift: driftResult({ severity: "high" }),
				verification: verificationFixture({
					state: "BLOCKED",
					verifiedRequestIds: [],
					blockers: [{ code: "HIGH_SEVERITY_DRIFT", level: "blocker" }],
				}),
			}),
		);
		expect(proof.state).toBe(PROOF_STATES.BLOCKED);
		expect(proof.stateReasons).toContain(PROOF_REASON_CODES.BLOCKING_DRIFT_PRESENT);
		expect(proof.drift.blockingCount).toBe(1);
	});

	it("copies the Phase 41 state for a NEEDS_REHEARSAL run", () => {
		const proof = buildVerificationProof(
			proofInput({
				verification: verificationFixture({
					state: "NEEDS_REHEARSAL",
					verifiedRequestIds: [],
					warnings: [{ code: "NO_REHEARSAL_EVIDENCE", level: "warning", requestId: "r1" }],
				}),
			}),
		);
		expect(proof.state).toBe(PROOF_STATES.NEEDS_REHEARSAL);
		expect(proof.verification.warnings).toHaveLength(1);
	});

	it("is UNKNOWN with VERIFICATION_MISSING when no verification was supplied", () => {
		const proof = buildVerificationProof(
			proofInput({ verification: null, evidence: { executions: [], assertions: [] } }),
		);
		expect(proof.state).toBe(PROOF_STATES.UNKNOWN);
		expect(proof.verification.present).toBe(false);
		expect(proof.verification.state).toBeNull();
		expect(proof.stateReasons).toContain(PROOF_REASON_CODES.VERIFICATION_MISSING);
		expect(proof.stateReasons).toContain(PROOF_REASON_CODES.EVIDENCE_MISSING);
	});

	it("records impacted / planned / rehearsed / verified flags per request", () => {
		const proof = buildVerificationProof(proofInput());
		expect(proof.requests).toHaveLength(1);
		const entry = proof.requests[0];
		expect(entry.requestId).toBe("r1");
		expect(entry.impacted).toBe(true);
		expect(entry.impactKind).toBe("direct");
		expect(entry.planned).toBe(true);
		expect(entry.rehearsed).toBe(true);
		expect(entry.verified).toBe(true);
		expect(entry.evidence.map((ref) => ref.kind).sort()).toEqual(["assertion", "execution"]);
	});

	it("projects blocking drift from the Phase 40 closed vocabulary", () => {
		const proof = buildVerificationProof(
			proofInput({
				drift: driftResult({ severity: "unknown", status: "unknown" }),
				verification: verificationFixture({ state: "BLOCKED", verifiedRequestIds: [] }),
			}),
		);
		expect(proof.drift.blockingCount).toBe(1);
		expect(proof.drift.blocking[0]).toMatchObject({ category: "VARIABLE_CHANGED", severity: "unknown", status: "unknown" });
	});

	it("summarizes contract compatibility per request and in aggregate", () => {
		const proof = buildVerificationProof(proofInput({ contracts: [contractResult(), contractResult({ status: 200 })] }));
		expect(proof.contracts.present).toBe(true);
		expect(proof.contracts.compared).toBe(2);
		expect(proof.contracts.compatible).toBe(2);
		expect(proof.contracts.incompatible).toBe(0);
		expect(proof.requests[0].contract.compared).toBe(true);
		expect(proof.requests[0].contract.summary.total).toBe(2);
	});

	it("carries an explicit timestamp inside the fingerprinted content", () => {
		const proof = buildVerificationProof(proofInput({ verifiedAt: "2026-09-24T10:00:00.000Z" }));
		expect(proof.verifiedAt).toBe("2026-09-24T10:00:00.000Z");
		const moved = buildVerificationProof(proofInput({ verifiedAt: "2026-09-24T10:00:01.000Z" }));
		expect(moved.fingerprint).not.toBe(proof.fingerprint);
	});

	it("accepts a Date timestamp and canonicalizes it to ISO-8601", () => {
		const proof = buildVerificationProof(proofInput({ verifiedAt: new Date("2026-09-24T10:00:00Z") }));
		expect(proof.verifiedAt).toBe("2026-09-24T10:00:00.000Z");
	});
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("Phase 47A — determinism", () => {
	it("produces byte-identical canonical JSON and the same fingerprint for identical inputs", () => {
		const left = buildVerificationProof(proofInput());
		const right = buildVerificationProof(proofInput());
		expect(left.fingerprint).toBe(right.fingerprint);
		expect(canonicalProofJsonOf(left)).toBe(canonicalProofJsonOf(right));
	});

	it("refuses a snapshot override that disagrees with the plan it cites", () => {
		// A different snapshot is a different run: the identity check fails closed
		// rather than minting a proof against mismatched evidence.
		expectCode(
			() => buildVerificationProof(proofInput({ snapshot: { snapshotId: "snap-47", snapshotFingerprint: "fp-other" } })),
			PROOF_ERROR_CODES.IDENTITY_MISMATCH,
		);
	});

	it("is a fixed point of proofFingerprintOf", () => {
		const proof = buildVerificationProof(proofInput());
		expect(proofFingerprintOf(proof)).toBe(proof.fingerprint);
	});

	it("keeps the fingerprint independent of field insertion order", () => {
		const proof = buildVerificationProof(proofInput());
		const reordered = Object.fromEntries(Object.entries(proof).reverse());
		expect(proofFingerprintOf(reordered)).toBe(proof.fingerprint);
	});
});

// ---------------------------------------------------------------------------
// Tamper evidence
// ---------------------------------------------------------------------------

describe("Phase 47A — tamper evidence", () => {
	it("accepts an untouched proof", () => {
		expect(verifyProofIntegrity(buildVerificationProof(proofInput()))).toBe(true);
	});

	it("detects a state upgrade", () => {
		const proof = buildVerificationProof(proofInput({ verification: null, evidence: { executions: [], assertions: [] } }));
		expect(proof.state).toBe(PROOF_STATES.UNKNOWN);
		const tampered = { ...proof, state: PROOF_STATES.VERIFIED };
		expect(verifyProofIntegrity(tampered)).toBe(false);
	});

	it("detects an added verified request", () => {
		const proof = buildVerificationProof(proofInput());
		const tampered = {
			...proof,
			requests: [
				...proof.requests,
				{ requestId: "r2", collectionId: null, impacted: true, impactKind: "direct", planned: false, rehearsed: false, verified: true, evidence: [], contract: null },
			],
		};
		expect(verifyProofIntegrity(tampered)).toBe(false);
	});

	it("detects a swapped snapshot", () => {
		const proof = buildVerificationProof(proofInput());
		const tampered = { ...proof, identity: { ...proof.identity, snapshot: { ...proof.identity.snapshot, snapshotFingerprint: "fp-other" } } };
		expect(verifyProofIntegrity(tampered)).toBe(false);
	});

	it("throws a typed TAMPERED error from the strict wrapper", () => {
		const proof = buildVerificationProof(proofInput());
		expectCode(() => assertProofIntegrity({ ...proof, state: PROOF_STATES.BLOCKED }), PROOF_ERROR_CODES.TAMPERED);
	});

	it("proves a proof corresponds to its evidence by rebuilding it", () => {
		const input = proofInput();
		const proof = buildVerificationProof(input);
		expect(verifyProofMatchesEvidence(proof, buildVerificationProof, input).matches).toBe(true);
		expect(verifyProofMatchesEvidence({ ...proof, fingerprint: "0".repeat(64) }, buildVerificationProof, input).matches).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Fail-closed rules
// ---------------------------------------------------------------------------

describe("Phase 47A — fail closed", () => {
	it("refuses to upgrade UNKNOWN evidence to a VERIFIED proof", () => {
		expectCode(() => assertNoEvidenceUpgrade(PROOF_STATES.UNKNOWN, PROOF_STATES.VERIFIED), PROOF_ERROR_CODES.EVIDENCE_UPGRADE);
	});

	it("permits equality and a downgrade", () => {
		expect(assertNoEvidenceUpgrade(PROOF_STATES.VERIFIED, PROOF_STATES.VERIFIED)).toBe(PROOF_STATES.VERIFIED);
		expect(assertNoEvidenceUpgrade(PROOF_STATES.VERIFIED, PROOF_STATES.BLOCKED)).toBe(PROOF_STATES.BLOCKED);
	});

	it("rejects a run whose snapshot disagrees with the proof snapshot", () => {
		const input = proofInput();
		input.run.identity.snapshotFingerprint = "fp-other";
		expectCode(() => buildVerificationProof(input), PROOF_ERROR_CODES.IDENTITY_MISMATCH);
	});

	it("rejects a run whose plan fingerprint disagrees with the plan", () => {
		const input = proofInput();
		input.run.identity.planFingerprint = "plan-other";
		input.run.identity.planId = "plan-other";
		expectCode(() => buildVerificationProof(input), PROOF_ERROR_CODES.IDENTITY_MISMATCH);
	});

	it("rejects a tampered run identity fingerprint", () => {
		const input = proofInput();
		input.run.identityFingerprint = "0".repeat(64);
		const error = expectCode(() => buildVerificationProof(input), PROOF_ERROR_CODES.INCONSISTENT_EVIDENCE);
		expect(error.details.rule).toBe("run-identity-fingerprint");
	});

	it("rejects blocking drift paired with a non-BLOCKED verification", () => {
		const error = expectCode(
			() => buildVerificationProof(proofInput({ drift: driftResult({ severity: "high" }) })),
			PROOF_ERROR_CODES.INCONSISTENT_EVIDENCE,
		);
		expect(error.details.rule).toBe("blocking-drift");
	});

	it("rejects a VERIFIED conclusion without change impact", () => {
		const error = expectCode(() => buildVerificationProof(proofInput({ impact: null })), PROOF_ERROR_CODES.INCONSISTENT_EVIDENCE);
		expect(error.details.rule).toBe("verified-without-impact");
	});

	it("rejects a VERIFIED conclusion without environment drift", () => {
		const error = expectCode(() => buildVerificationProof(proofInput({ drift: null })), PROOF_ERROR_CODES.INCONSISTENT_EVIDENCE);
		expect(error.details.rule).toBe("verified-without-drift");
	});

	it("rejects a verified request with no evidence reference", () => {
		const error = expectCode(
			() => buildVerificationProof(proofInput({ evidence: { executions: [], assertions: [] } })),
			PROOF_ERROR_CODES.INCONSISTENT_EVIDENCE,
		);
		expect(error.details.rule).toBe("verified-without-evidence");
	});

	it("rejects evidence for a verified request that ran against another snapshot", () => {
		const error = expectCode(
			() => buildVerificationProof(proofInput({ evidence: { executions: [executionEvidence({ snapshotFingerprint: "fp-other" })], assertions: [] } })),
			PROOF_ERROR_CODES.INCONSISTENT_EVIDENCE,
		);
		expect(error.details.rule).toBe("verified-evidence-wrong-snapshot");
	});

	it("rejects a verification computed against a different target", () => {
		const error = expectCode(
			() => buildVerificationProof(proofInput({ verification: verificationFixture({ target: { environmentId: "env-other" } }) })),
			PROOF_ERROR_CODES.INCONSISTENT_EVIDENCE,
		);
		expect(error.details.rule).toBe("verification-target");
	});

	it("rejects an unparseable upstream plan with a typed MALFORMED_INPUT error", () => {
		expectCode(() => buildVerificationProof(proofInput({ plan: { kind: "not-a-plan" } })), PROOF_ERROR_CODES.MALFORMED_INPUT);
	});

	it("rejects an unparseable explicit timestamp", () => {
		expectCode(() => buildVerificationProof(proofInput({ verifiedAt: "not-a-date" })), PROOF_ERROR_CODES.MISSING_TIMESTAMP);
	});

	it("rejects a missing explicit timestamp at the input contract", () => {
		expectCode(() => buildVerificationProof(proofInput({ verifiedAt: undefined })), PROOF_ERROR_CODES.MALFORMED_INPUT);
	});

	it("rejects an unrecognized run state", () => {
		const input = proofInput();
		input.run.runState = "SOMETHING_ELSE";
		expectCode(() => buildVerificationProof(input), PROOF_ERROR_CODES.MALFORMED_INPUT);
	});
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe("Phase 47A — bounds", () => {
	it("refuses more contract comparisons than the limit", () => {
		const contracts = new Array(PROOF_LIMITS.maxContracts + 1).fill(null);
		expectCode(() => buildVerificationProof(proofInput({ contracts })), PROOF_ERROR_CODES.LIMIT_EXCEEDED);
	});

	it("refuses more evidence references than a request allows", () => {
		const executions = Array.from({ length: PROOF_LIMITS.maxEvidenceRefsPerRequest + 1 }, (_, index) =>
			executionEvidence({ executionId: `exec-${index}` }),
		);
		expectCode(
			() => buildVerificationProof(proofInput({ evidence: { executions, assertions: [] } })),
			PROOF_ERROR_CODES.LIMIT_EXCEEDED,
		);
	});

	it("refuses a proof whose serialized size exceeds the ceiling", () => {
		const oversized = { payload: "x".repeat(PROOF_LIMITS.maxSerializedBytes + 1) };
		expectCode(() => assertProofSize(oversized), PROOF_ERROR_CODES.LIMIT_EXCEEDED);
	});

	it("keeps the serialized proof within the size ceiling", () => {
		const proof = buildVerificationProof(proofInput());
		expect(assertProofSize(proof)).toBeLessThanOrEqual(PROOF_LIMITS.maxSerializedBytes);
	});
});

// ---------------------------------------------------------------------------
// Data minimization
// ---------------------------------------------------------------------------

describe("Phase 47A — data minimization", () => {
	it("never carries request bodies, headers, or resolved secrets", () => {
		const proof = buildVerificationProof(proofInput());
		const serialized = canonicalProofJsonOf(proof);
		expect(serialized).not.toContain("body");
		expect(serialized).not.toContain("headers");
		expect(serialized).not.toContain("password");
		expect(serialized).not.toContain("Bearer ");
	});

	it("records one-way digests for provenance instead of artifact contents", () => {
		const proof = buildVerificationProof(proofInput());
		expect(proof.provenance.sources).toHaveLength(7);
		for (const source of proof.provenance.sources) {
			if (source.digest !== null) expect(source.digest).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});

// ---------------------------------------------------------------------------
// Cross-process determinism
// ---------------------------------------------------------------------------

describe("Phase 47A — cross-process determinism", () => {
	it(
		"a spawned process produces the identical fingerprint and canonical JSON",
		() => {
			const scriptPath = fileURLToPath(new URL("./cross-process-check.js", import.meta.url));
			const backendRoot = fileURLToPath(new URL("../../../", import.meta.url));
			const child = spawnSync(process.execPath, ["run", scriptPath], {
				cwd: backendRoot,
				encoding: "utf8",
				env: { ...process.env },
			});
			expect(child.status).toBe(0);
			const output = JSON.parse(child.stdout.trim());
			const inProcess = buildVerificationProof(proofInput());
			expect(output.fingerprint).toBe(inProcess.fingerprint);
			expect(output.proofId).toBe(inProcess.proofId);
			expect(output.canonical).toBe(canonicalProofJsonOf(inProcess));
		},
		30000,
	);
});

// ---------------------------------------------------------------------------
// Integration with the plan fixture
// ---------------------------------------------------------------------------

describe("Phase 47A — plan integration", () => {
	it("binds the proof to the exact Phase 46A plan fingerprint", () => {
		const { plan } = buildPlan(["r1"]);
		const proof = buildVerificationProof(proofInput());
		expect(proof.identity.planFingerprint).toBe(plan.identity.planFingerprint);
		expect(proof.identity.planId).toBe(plan.identity.planFingerprint);
	});

	it("records the completed step ids from the run", () => {
		const input = proofInput();
		const proof = buildVerificationProof(input);
		expect(proof.rehearsal.completedStepIds).toEqual(input.plan.steps.map((step) => step.stepId).sort());
	});

	it("does not require an assertion record to reach VERIFIED when execution evidence exists", () => {
		const proof = buildVerificationProof(proofInput({ evidence: { executions: [executionEvidence()], assertions: [] } }));
		expect(proof.state).toBe(PROOF_STATES.VERIFIED);
		expect(proof.requests[0].evidence).toHaveLength(1);
	});
});
