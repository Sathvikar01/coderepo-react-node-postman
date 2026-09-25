import { describe, expect, test } from "bun:test";
import {
	PROOF_STALENESS,
	PROOF_STATES,
	PROOF_STATUS,
	contractRows,
	countRows,
	driftSummary,
	evidenceRows,
	integrityDetails,
	looksLikeProofArtifact,
	proofErrorMessage,
	proofFromArtifactText,
	reviewPromotionOptions,
	reasonText,
	rehearsalLine,
	reportHeadline,
	reportTone,
	safeFilename,
	stateReasonCodes,
	statusLabel,
	verificationStateBadge,
} from "./proof-view.js";

// Phase 47C — Verification Proof view model.
//
// These tests pin two properties the UI depends on:
//   1. Presentation is derived from backend values, never inferred.
//   2. A STALE or UNKNOWN proof can never render as green VERIFIED evidence.

function report(overrides = {}) {
	return {
		kind: "tracer.verification-proof-report",
		schemaVersion: 1,
		proofId: "proof_abc",
		fingerprint: "a".repeat(64),
		proofState: PROOF_STATES.VERIFIED,
		status: PROOF_STATUS.VALID,
		staleness: PROOF_STALENESS.CURRENT,
		checks: {},
		reasons: ["IDENTITY_CURRENT", "INTEGRITY_OK"],
		expected: null,
		current: null,
		...overrides,
	};
}

describe("Phase 47C proof view model — state semantics", () => {
	test("maps only the four Phase 47A verification states", () => {
		expect(verificationStateBadge(PROOF_STATES.VERIFIED)).toEqual({ tone: "success", label: "Verified" });
		expect(verificationStateBadge(PROOF_STATES.BLOCKED)).toEqual({ tone: "danger", label: "Blocked" });
		expect(verificationStateBadge(PROOF_STATES.NEEDS_REHEARSAL)).toEqual({ tone: "warning", label: "Needs rehearsal" });
		expect(verificationStateBadge(PROOF_STATES.UNKNOWN)).toEqual({ tone: "unknown", label: "Unknown" });
	});

	test("reports an unrecognised state verbatim rather than coercing it", () => {
		const badge = verificationStateBadge("SOMETHING_NEW");
		expect(badge.tone).toBe("unknown");
		expect(badge.label).toBe("SOMETHING_NEW");
	});

	test("an absent state is unknown, never a pass", () => {
		expect(verificationStateBadge(null)).toEqual({ tone: "unknown", label: "Unknown" });
		expect(verificationStateBadge(undefined).tone).toBe("unknown");
	});
});

describe("Phase 47C proof view model — STALE is never green", () => {
	test("a STALE report uses the warning tone, not success", () => {
		const tone = reportTone(report({ status: PROOF_STATUS.STALE, proofState: PROOF_STATES.VERIFIED }));
		expect(tone).toBe("warning");
		expect(tone).not.toBe("success");
	});

	test("a STALE proof reads as previously VERIFIED, not as current evidence", () => {
		const headline = reportHeadline(report({ status: PROOF_STATUS.STALE, proofState: PROOF_STATES.VERIFIED }));
		expect(headline.tone).toBe("warning");
		expect(headline.title).toContain("Stale");
		expect(headline.title).toContain("Verified");
		expect(headline.detail).toMatch(/no longer matches/i);
	});

	test("STALE headline names the snapshot/environment change when the backend says so", () => {
		expect(reasonText("SNAPSHOT_STALE")).toMatch(/snapshot/i);
		expect(reasonText("ENVIRONMENT_STALE")).toMatch(/environment/i);
		const reasons = stateReasonCodes({ stateReasons: ["SNAPSHOT_STALE", "ENVIRONMENT_STALE"] });
		expect(reasons.map((entry) => entry.code)).toEqual(["SNAPSHOT_STALE", "ENVIRONMENT_STALE"]);
	});

	test("INVALID is always danger, even if the state claims VERIFIED", () => {
		const headline = reportHeadline(report({ status: PROOF_STATUS.INVALID, proofState: PROOF_STATES.VERIFIED }));
		expect(headline.tone).toBe("danger");
		expect(headline.title).toMatch(/invalid/i);
		expect(headline.detail).toMatch(/cannot be trusted/i);
	});

	test("MISMATCH is danger and never valid", () => {
		expect(reportTone(report({ status: PROOF_STATUS.MISMATCH }))).toBe("danger");
		expect(reportHeadline(report({ status: PROOF_STATUS.MISMATCH })).title).toMatch(/mismatch/i);
	});

	test("UNKNOWN is not converted into success", () => {
		const headline = reportHeadline(report({ status: PROOF_STATUS.UNKNOWN, proofState: PROOF_STATES.UNKNOWN }));
		expect(headline.tone).toBe("unknown");
		expect(headline.title).toMatch(/unknown/i);
		expect(headline.detail).toMatch(/not a pass|cannot establish/i);
	});

	test("the four states are visually distinct", () => {
		const tones = [
			reportTone(report({ status: PROOF_STATUS.VALID })),
			reportTone(report({ status: PROOF_STATUS.STALE })),
			reportTone(report({ status: PROOF_STATUS.MISMATCH })),
			reportTone(report({ status: PROOF_STATUS.UNKNOWN })),
		];
		// VALID=success, STALE=warning, MISMATCH=danger, UNKNOWN=unknown — all distinct.
		expect(new Set(tones).size).toBe(4);
	});

	test("a missing report is unknown, not valid", () => {
		expect(reportHeadline(null).tone).toBe("unknown");
		expect(statusLabel(undefined)).toBe("Unknown");
	});
});

describe("Phase 47C proof view model — counts and summaries", () => {
	test("counts are exact integers, never percentages", () => {
		const rows = countRows({ impacted: 3, planned: 3, rehearsed: 2, verified: 1, unverified: 2 });
		expect(rows.map((row) => row.value)).toEqual([3, 3, 2, 1, 2]);
		expect(rows.find((row) => row.key === "unverified").tone).toBe("warning");
	});

	test("an unverified count of zero is not flagged", () => {
		expect(countRows({ unverified: 0 }).find((row) => row.key === "unverified").tone).toBe("neutral");
	});

	test("contract rows keep unknown separate from compatible", () => {
		const summary = contractRows({ present: true, compared: 5, compatible: 3, incompatible: 1, unknown: 1 });
		expect(summary.rows.find((row) => row.key === "unknown").value).toBe(1);
		expect(summary.rows.find((row) => row.key === "incompatible").tone).toBe("danger");
	});

	test("an absent contract comparison is labelled, not treated as compatible", () => {
		const summary = contractRows({ present: false });
		expect(summary.present).toBe(false);
		expect(summary.rows).toEqual([]);
	});

	test("blocking drift is surfaced with its count", () => {
		const drift = driftSummary({
			present: true,
			identical: false,
			blockingCount: 2,
			blocking: [
				{ category: "VARIABLE_CHANGED", path: "variables.baseUrl", severity: "high" },
				{ category: "ENDPOINT_ADDED", path: null, severity: "medium" },
			],
		});
		expect(drift.blockingCount).toBe(2);
		expect(drift.label).toContain("2 blocking drift");
	});

	test("no blocking drift is reported honestly", () => {
		const drift = driftSummary({ present: true, identical: true, blockingCount: 0, blocking: [] });
		expect(drift.label).toBe("No blocking drift");
	});

	test("rehearsal line describes the run without leaking internals", () => {
		expect(rehearsalLine({ runState: "COMPLETED", terminated: false, stopReason: null })).toBe("COMPLETED");
		expect(rehearsalLine({ runState: "STOPPED", terminated: true, stopReason: "STEP_FAILED" })).toContain("stopped: step failed");
	});
});

describe("Phase 47C proof view model — evidence rows", () => {
	test("classifies each request by its committed flags", () => {
		const rows = evidenceRows({
			requests: [
				{ requestId: "r1", impacted: true, impactKind: "direct", rehearsed: true, verified: true, evidence: [{ kind: "execution", refId: "e1" }], contract: { compared: true, compatible: true } },
				{ requestId: "r2", impacted: true, impactKind: "indirect", rehearsed: true, verified: false, evidence: [], contract: { compared: true, compatible: false } },
				{ requestId: "r3", impacted: false, impactKind: null, rehearsed: false, verified: false, evidence: [], contract: null },
			],
		});
		expect(rows[0].verificationState).toBe(PROOF_STATES.VERIFIED);
		expect(rows[1].verificationState).toBe(PROOF_STATES.NEEDS_REHEARSAL);
		expect(rows[2].verificationState).toBe(PROOF_STATES.UNKNOWN);
		expect(rows[0].contractState).toBe("Compatible");
		expect(rows[1].contractState).toBe("Incompatible");
		expect(rows[2].contractState).toBe("Not compared");
	});

	test("carries only evidence references, never bodies or secrets", () => {
		const rows = evidenceRows({ requests: [{ requestId: "r1", evidence: [{ kind: "assertion", refId: "a1", status: "PASS" }] }] });
		expect(rows[0].evidenceRefs).toEqual([{ kind: "assertion", refId: "a1", outcome: "PASS" }]);
		expect(JSON.stringify(rows)).not.toMatch(/authorization|bearer|password|secret/i);
	});

	test("an absent proof yields no rows", () => {
		expect(evidenceRows(null)).toEqual([]);
	});
});

describe("Phase 50 polish — direct review promotion options", () => {
	test("offers exact BREAKING, BLOCKED, and proof review actions from committed proof facts", () => {
		const options = reviewPromotionOptions({
			proofId: "proof-50",
			state: PROOF_STATES.BLOCKED,
			identity: { snapshot: { snapshotId: "snap-50" } },
			contracts: { classes: { breaking: 2 } },
		});
		expect(options.map((item) => item.findingType)).toEqual([
			"contract_breaking",
			"verification_blocked",
			"verification_proof",
		]);
		expect(options[0].title).toContain("2 breaking contract findings");
		expect(options[1].findingSummary).toContain("BLOCKED");
	});

	test("never invents a BREAKING action when the proof has no breaking contracts", () => {
		const options = reviewPromotionOptions({
			proofId: "proof-ok",
			state: PROOF_STATES.VERIFIED,
			identity: { snapshot: { snapshotId: "snap-ok" } },
			contracts: { classes: { breaking: 0 } },
		});
		expect(options.map((item) => item.findingType)).toEqual(["verification_proof"]);
	});

	test("UNKNOWN maps to the explicit verification_unknown review type", () => {
		const options = reviewPromotionOptions({
			proofId: "proof-unknown",
			state: PROOF_STATES.UNKNOWN,
			identity: { snapshot: { snapshotId: "snap-unknown" } },
			contracts: { classes: { breaking: 0 } },
		});
		expect(options.map((item) => item.findingType)).toEqual(["verification_unknown", "verification_proof"]);
	});

	test("no proof means no promotion actions", () => {
		expect(reviewPromotionOptions(null)).toEqual([]);
	});
});

describe("Phase 47C proof view model — integrity details", () => {
	test("surfaces the compact integrity fields", () => {
		const details = integrityDetails(
			{
				proofId: "proof_1",
				fingerprint: "f".repeat(64),
				fingerprintKeyId: "key-1",
				schemaVersion: 1,
				integrity: { algorithm: "HMAC-SHA-256", canonicalization: "key-sorted-json-v1" },
				verifiedAt: "2026-09-24T10:00:00.000Z",
				state: "VERIFIED",
				provenance: { sources: [{ source: "change-impact" }, { source: "environment-drift" }] },
			},
			{ integrity: { artifactFingerprint: "b".repeat(64) }, kind: "tracer.verification-proof-artifact", schemaVersion: 1 },
		);
		expect(details.algorithm).toBe("HMAC-SHA-256");
		expect(details.fingerprintKeyId).toBe("key-1");
		expect(details.provenanceCount).toBe(2);
		expect(details.artifactFingerprint).toBe("b".repeat(64));
	});

	test("returns nothing when there is no proof", () => {
		expect(integrityDetails(null, null)).toBeNull();
	});
});

describe("Phase 47C proof view model — import and export safety", () => {
	test("recognises a wrapped artifact and a bare envelope", () => {
		expect(looksLikeProofArtifact(JSON.stringify({ proof: { kind: "tracer.verification-proof" } }))).toBe(true);
		expect(looksLikeProofArtifact(JSON.stringify({ kind: "tracer.verification-proof" }))).toBe(true);
	});

	test("rejects text that is not a proof at all", () => {
		expect(looksLikeProofArtifact("not json")).toBe(false);
		expect(looksLikeProofArtifact(JSON.stringify({ hello: "world" }))).toBe(false);
		expect(looksLikeProofArtifact("")).toBe(false);
	});

	test("parsing never validates, upgrades, or repairs", () => {
		const tampered = { proof: { kind: "tracer.verification-proof", state: "VERIFIED", fingerprint: "x" } };
		// The view model returns the object as-is; only the backend can judge it.
		expect(proofFromArtifactText(JSON.stringify(tampered))).toEqual(tampered.proof);
	});

	test("never fabricates a filename", () => {
		expect(safeFilename("proof_abc.json")).toBe("proof_abc.json");
		expect(safeFilename("../../etc/passwd")).toBe("etcpasswd");
		expect(safeFilename("")).toBe("verification-proof.json");
		expect(safeFilename(null)).toBe("verification-proof.json");
		expect(safeFilename("a/b\\c.json")).toBe("abc.json");
	});
});

describe("Phase 47C proof view model — error surfaces", () => {
	test("maps typed artifact errors to truthful messages", () => {
		expect(proofErrorMessage({ code: "VERIFICATION_PROOF_ARTIFACT_MALFORMED" })).toMatch(/not a verification proof artifact/i);
		expect(proofErrorMessage({ code: "VERIFICATION_PROOF_ARTIFACT_TAMPERED" })).toMatch(/integrity check/i);
		expect(proofErrorMessage({ code: "VERIFICATION_PROOF_ARTIFACT_UNSUPPORTED_VERSION" })).toMatch(/unsupported/i);
		expect(proofErrorMessage({ code: "VERIFICATION_PROOF_EVIDENCE_UPGRADE" })).toMatch(/upgraded/i);
	});

	test("never falls back to a success message", () => {
		for (const code of [
			"VERIFICATION_PROOF_ARTIFACT_MALFORMED",
			"VERIFICATION_PROOF_ARTIFACT_UNSUPPORTED_VERSION",
			"VERIFICATION_PROOF_ARTIFACT_TOO_LARGE",
			"VERIFICATION_PROOF_ARTIFACT_TAMPERED",
			"VERIFICATION_PROOF_ARTIFACT_SECRET_TEXT",
			"VERIFICATION_PROOF_NOT_FOUND",
			"VERIFICATION_PROOF_CROSS_OWNER",
		]) {
			expect(proofErrorMessage({ code })).not.toMatch(/success|valid|verified/i);
		}
	});

	test("a network error surfaces the underlying message", () => {
		expect(proofErrorMessage({ message: "Failed to fetch" })).toBe("Failed to fetch");
	});
});
