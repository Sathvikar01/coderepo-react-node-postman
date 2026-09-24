import { describe, expect, test } from "bun:test";

// Configuration must be loaded before any module that derives a fingerprint. The
// Phase 47A core keys its digests on `EXECUTION_FINGERPRINT_KEY`, so the service
// suite initializes config exactly as the app bootstrap does.
process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase47b_service_test";
process.env.EXECUTION_FINGERPRINT_KEY =
	process.env.EXECUTION_FINGERPRINT_KEY || "phase47b-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase47b-test-jwt-secret";

const { initConfig } = await import("../../shared/config/index.js");
initConfig();

import { EVIDENCE_OWNER_PROFILE_ID } from "../verification-proof/proof-fixtures.js";
import {
	__setSyntheticEvidenceOwnerForTests,
} from "./verification-proof.service.js";

// The fixtures name a synthetic evidence owner because the Phase 47A core is
// database-free. This suite has no database and no request context, so it enables
// the same hook the route harness uses. Production never calls this.
__setSyntheticEvidenceOwnerForTests(true);

import { buildVerificationProof, canonicalProofJsonOf, PROOF_STATES } from "../verification-proof/index.js";
import {
	assertionEvidence,
	contractResult,
	driftResult,
	executionEvidence,
	proofInput,
	verificationFixture,
	VERIFIED_AT,
} from "../verification-proof/proof-fixtures.js";
import {
	PROOF_ARTIFACT_ERROR_CODES,
	PROOF_ARTIFACT_KIND,
	PROOF_ARTIFACT_MAX_BYTES,
	PROOF_ARTIFACT_SCHEMA_VERSION,
	artifactFingerprintOf,
	buildProofArtifact,
	parseProofArtifactText,
	proofArtifactFilename,
	serializeProofArtifact,
} from "./proof-artifact.js";
import {
	PROOF_CHECK,
	PROOF_REPORT_KIND,
	PROOF_REPORT_SCHEMA_VERSION,
	PROOF_REPORT_STATUS,
	PROOF_STALENESS,
} from "./proof-report.js";
import {
	PROOF_API_ERROR_CODES,
	createVerificationProofApiService,
	verificationProofApiService,
} from "./verification-proof.service.js";

// Phase 47B — service-level contract tests.
//
// These run without HTTP, an app, or a database. The route suite covers the
// transport; this suite covers the guarantees that must hold regardless of how the
// service is called: determinism, no side effects, fail-closed parsing, and the
// staleness vocabularies.

const OWNER = EVIDENCE_OWNER_PROFILE_ID;
const service = createVerificationProofApiService();

const buildOk = (overrides) => service.build(OWNER, proofInput(overrides)).proof;
const exportOk = (proof) => service.exportProof(OWNER, { proof });

describe("Phase 47B service — build", () => {
	test("build delegates to the Phase 47A builder and does not augment the proof", () => {
		const proof = buildOk();
		const direct = buildVerificationProof(proofInput());
		// Byte-for-byte identical: the API layer adds no fields and changes no state.
		expect(canonicalProofJsonOf(proof)).toBe(canonicalProofJsonOf(direct));
		expect(proof.state).toBe(PROOF_STATES.VERIFIED);
		expect(proof.kind).toBe("tracer.verification-proof");
		expect(proof.schemaVersion).toBe(1);
	});

	test("the service never constructs a state itself", () => {
		// A build with no evidence and no verification result must not come back
		// VERIFIED. The API layer has no opinion about state: it forwards to the Phase
		// 47A builder, which derives the state from what it was actually given.
		const unrecorded = service.build(
			OWNER,
			proofInput({ verification: null, evidence: { executions: [], assertions: [] } }),
		).proof;
		expect(unrecorded.state).toBe(PROOF_STATES.UNKNOWN);
		expect(unrecorded.state).not.toBe(PROOF_STATES.VERIFIED);
		expect(unrecorded.verification.present).toBe(false);
	});

	test("evidence owned by another profile is refused at the build boundary", () => {
		expect(() =>
			service.build(OWNER, proofInput({ evidence: { executions: [executionEvidence({ ownerProfileId: "someone-else" })], assertions: [] } })),
		).toThrow(expect.objectContaining({ statusCode: 403, code: PROOF_API_ERROR_CODES.CROSS_OWNER }));
	});

	test("unowned evidence is allowed because it is the caller's own input", () => {
		const proof = service.build(
			OWNER,
			proofInput({ evidence: { executions: [executionEvidence({ ownerProfileId: undefined })], assertions: [assertionEvidence()] } }),
		).proof;
		expect(proof.state).toBe(PROOF_STATES.VERIFIED);
	});
});

describe("Phase 47B service — export determinism", () => {
	test("an exported artifact carries kind, version, fingerprint, key id, and integrity metadata", () => {
		const proof = buildOk();
		const artifact = buildProofArtifact(proof);
		expect(artifact.kind).toBe(PROOF_ARTIFACT_KIND);
		expect(artifact.schemaVersion).toBe(PROOF_ARTIFACT_SCHEMA_VERSION);
		expect(artifact.fingerprint).toBe(proof.fingerprint);
		expect(artifact.fingerprintKeyId).toBe(proof.fingerprintKeyId);
		expect(artifact.integrity.artifactFingerprint).toBe(artifactFingerprintOf(proof));
		expect(artifact.integrity.algorithm).toBe("HMAC-SHA-256");
		expect(artifact.integrity.canonicalization).toBe("key-sorted-json-v1");
	});

	test("repeated export is byte-identical and carries no export clock", () => {
		const proof = buildOk();
		const first = exportOk(proof);
		const second = exportOk(proof);
		expect(second.text).toBe(first.text);
		expect(second.filename).toBe(first.filename);
		// No export timestamp and no generated field: two exports can never differ by
		// when they ran. Times inside the proof come from the proof's own evidence and
		// are part of the recorded fact being exported, not a property of the export.
		const artifact = JSON.parse(first.text);
		expect(artifact.exportedAt).toBeUndefined();
		expect(artifact.exportId).toBeUndefined();
		expect(Object.keys(artifact)).toEqual(["fingerprint", "fingerprintKeyId", "integrity", "kind", "proof", "schemaVersion"]);
		// The only timestamp is the proof's own `verifiedAt`, reproduced verbatim.
		expect(artifact.proof.verifiedAt).toBe(proof.verifiedAt);
	});

	test("exporting from an equivalent input matches exporting the built proof", () => {
		const fromProof = exportOk(buildOk());
		const fromInput = service.exportProof(OWNER, { input: proofInput() });
		expect(fromInput.text).toBe(fromProof.text);
		expect(fromInput.proofId).toBe(fromProof.proofId);
	});

	test("the filename is derived from the proof id and can never carry a path", () => {
		const proof = buildOk();
		const filename = exportOk(proof).filename;
		expect(filename).toBe(`${proof.proofId}.json`);
		expect(filename).not.toContain("/");
		expect(filename).not.toContain("\\");
		expect(filename).not.toContain("..");
		// Caller input is sanitized away rather than interpolated.
		expect(proofArtifactFilename("../../etc/passwd")).not.toContain("/");
		expect(proofArtifactFilename("")).toBe("verification-proof.json");
		expect(proofArtifactFilename(null)).toBe("verification-proof.json");
	});

	test("an artifact is deterministic across many structurally identical proofs", () => {
		const texts = new Set();
		for (let index = 0; index < 5; index += 1) texts.add(exportOk(buildOk()).text);
		expect(texts.size).toBe(1);
	});

	test("export refuses a proof that fails its own contract or integrity", () => {
		const proof = buildOk();
		expect(() => exportOk({ ...proof, fingerprint: "0".repeat(64) })).toThrow();
		expect(() => exportOk({ ...proof, kind: "tracer.something-else" })).toThrow();
	});
});

describe("Phase 47B service — import as untrusted input", () => {
	test("a round trip preserves the proof exactly and reports no side effects", () => {
		const proof = buildOk();
		const text = exportOk(proof).text;
		const imported = service.importProof(OWNER, text);
		expect(canonicalProofJsonOf(imported.proof)).toBe(canonicalProofJsonOf(proof));
		expect(imported.proofId).toBe(proof.proofId);
		expect(imported.fingerprint).toBe(proof.fingerprint);
		expect(imported.state).toBe(proof.state);
		expect(imported.persisted).toBe(false);
		expect(imported.executed).toBe(false);
		expect(imported.autoSend).toBe(false);
		expect(imported.autoSave).toBe(false);
		expect(imported.upgraded).toBe(false);
	});

	test("import attached a report without a current observation, which can only be UNKNOWN", () => {
		const imported = service.importProof(OWNER, exportOk(buildOk()).text);
		expect(imported.report.kind).toBe(PROOF_REPORT_KIND);
		expect(imported.report.schemaVersion).toBe(PROOF_REPORT_SCHEMA_VERSION);
		expect(imported.report.staleness).toBe(PROOF_STALENESS.UNKNOWN);
		expect(imported.report.status).toBe(PROOF_REPORT_STATUS.UNKNOWN);
	});

	test("import is pure: the same text imports to the same result every time", () => {
		const text = exportOk(buildOk()).text;
		const first = service.importProof(OWNER, text);
		const second = service.importProof(OWNER, text);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	test("tampering with the proof payload is refused, not repaired", () => {
		const text = exportOk(buildOk()).text;
		const artifact = JSON.parse(text);
		artifact.proof.counts = { ...artifact.proof.counts, verified: 42 };
		expect(() => service.importProof(OWNER, JSON.stringify(artifact))).toThrow(
			expect.objectContaining({ statusCode: 409 }),
		);
	});

	test("tampering with only the envelope is refused by the artifact fingerprint", () => {
		const text = exportOk(buildOk()).text;
		const artifact = JSON.parse(text);
		artifact.integrity.artifactFingerprint = "f".repeat(64);
		expect(() => service.importProof(OWNER, JSON.stringify(artifact))).toThrow(
			expect.objectContaining({ statusCode: 409, code: PROOF_ARTIFACT_ERROR_CODES.TAMPERED }),
		);
	});

	test("replacing the envelope's claimed fingerprint is refused", () => {
		const text = exportOk(buildOk()).text;
		const artifact = JSON.parse(text);
		artifact.fingerprint = "a".repeat(64);
		expect(() => service.importProof(OWNER, JSON.stringify(artifact))).toThrow(
			expect.objectContaining({ statusCode: 409 }),
		);
	});

	test("malformed input is refused with a typed error rather than thrown raw", () => {
		const malformed = [
			"",
			"{",
			"[]",
			"null",
			JSON.stringify({ kind: "nope" }),
			JSON.stringify({ kind: PROOF_ARTIFACT_KIND }),
			JSON.stringify({ kind: PROOF_ARTIFACT_KIND, schemaVersion: PROOF_ARTIFACT_SCHEMA_VERSION }),
		];
		for (const bad of malformed) {
			let thrown;
			try {
				service.importProof(OWNER, bad);
			} catch (error) {
				thrown = error;
			}
			// Every refusal is an AppError with a stable code and a 4xx status, so a
			// caller never sees a raw TypeError from JSON parsing or a ZodError.
			expect(thrown).toBeDefined();
			expect(thrown.name).not.toBe("ZodError");
			expect(typeof thrown.code).toBe("string");
			expect(thrown.statusCode).toBeGreaterThanOrEqual(400);
			expect(thrown.statusCode).toBeLessThan(500);
			expect(thrown.code).toStartWith("VERIFICATION_PROOF_ARTIFACT_");
		}
	});

	test("an unsupported version is refused and never upgraded", () => {
		const text = exportOk(buildOk()).text;
		const future = JSON.parse(text);
		future.schemaVersion = PROOF_ARTIFACT_SCHEMA_VERSION + 1;
		expect(() => service.importProof(OWNER, JSON.stringify(future))).toThrow(
			expect.objectContaining({ statusCode: 422, code: PROOF_ARTIFACT_ERROR_CODES.UNSUPPORTED_VERSION }),
		);
	});

	test("an oversized artifact is refused before it is parsed", () => {
		const oversized = `{"kind":"${PROOF_ARTIFACT_KIND}","pad":"${"x".repeat(PROOF_ARTIFACT_MAX_BYTES + 1)}"}`;
		expect(() => service.importProof(OWNER, oversized)).toThrow(
			expect.objectContaining({ statusCode: 413, code: PROOF_ARTIFACT_ERROR_CODES.TOO_LARGE }),
		);
	});

	test("reserved keys at any depth are refused without polluting prototypes", () => {
		const text = exportOk(buildOk()).text;
		expect(() => service.importProof(OWNER, `{"__proto__":{"polluted":1},${text.slice(1)}`)).toThrow(
			expect.objectContaining({ code: PROOF_ARTIFACT_ERROR_CODES.MALFORMED }),
		);
		expect(() => service.importProof(OWNER, text.replace('"identity":{', '"identity":{"constructor":{"polluted":1},'))).toThrow(
			expect.objectContaining({ code: PROOF_ARTIFACT_ERROR_CODES.MALFORMED }),
		);
		expect(Object.prototype.polluted).toBeUndefined();
		expect({}.polluted).toBeUndefined();
	});

	test("credential-shaped text is refused rather than carried into a report", () => {
		const text = exportOk(buildOk()).text;
		const withSecret = text.replace('"kind":"tracer.verification-proof"', '"kind":"tracer.verification-proof Bearer abcdefghijklmnopqrst"');
		expect(() => service.importProof(OWNER, withSecret)).toThrow(
			expect.objectContaining({ statusCode: 422, code: PROOF_ARTIFACT_ERROR_CODES.SECRET_TEXT }),
		);
	});
});

describe("Phase 47B service — independent verification", () => {
	const CURRENT = (proof) => ({
		snapshot: proof.identity.snapshot,
		targetEnvironment: {
			environmentId: proof.identity.targetEnvironment.environmentId,
			environmentFingerprint: proof.identity.targetEnvironment.environmentFingerprint,
		},
		verificationState: proof.state,
	});

	test("VALID requires a matching identity, and every check is reported", () => {
		const proof = buildOk();
		const report = service.verify(OWNER, { proof, current: CURRENT(proof) });
		expect(report.status).toBe(PROOF_REPORT_STATUS.VALID);
		expect(report.staleness).toBe(PROOF_STALENESS.CURRENT);
		expect(report.checks.structure).toBe(PROOF_CHECK.PASS);
		expect(report.checks.schemaVersion).toBe(PROOF_CHECK.PASS);
		expect(report.checks.fingerprint).toBe(PROOF_CHECK.PASS);
		expect(report.checks.fixedPoint).toBe(PROOF_CHECK.PASS);
		expect(report.checks.consistency).toBe(PROOF_CHECK.PASS);
		expect(report.checks.snapshotBinding).toBe(PROOF_CHECK.PASS);
		expect(report.checks.environmentBinding).toBe(PROOF_CHECK.PASS);
		expect(report.checks.evidenceConsistency).toBe(PROOF_CHECK.PASS);
	});

	test("INVALID outranks every staleness outcome", () => {
		const proof = buildOk();
		const report = service.verify(OWNER, { proof: { ...proof, fingerprint: "0".repeat(64) }, current: CURRENT(proof) });
		expect(report.status).toBe(PROOF_REPORT_STATUS.INVALID);
		expect(report.checks.fingerprint).toBe(PROOF_CHECK.FAIL);
		// A broken fingerprint makes every downstream claim meaningless, so staleness
		// is not allowed to soften the verdict.
		expect(report.reasons).toContain("FINGERPRINT_MISMATCH");
	});

	test("STALE is reported when the snapshot identity moved on", () => {
		const proof = buildOk();
		const report = service.verify(OWNER, { proof, current: { snapshot: { snapshotId: "snap-47", snapshotFingerprint: "different" } } });
		expect(report.staleness).toBe(PROOF_STALENESS.STALE);
		expect(report.status).toBe(PROOF_REPORT_STATUS.STALE);
		expect(report.reasons).toContain("SNAPSHOT_STALE");
	});

	test("STALE is reported when the target environment fingerprint moved on", () => {
		const proof = buildOk();
		const report = service.verify(OWNER, {
			proof,
			current: { targetEnvironment: { environmentId: "env-staging", environmentFingerprint: "different" } },
		});
		expect(report.staleness).toBe(PROOF_STALENESS.STALE);
		expect(report.reasons).toContain("ENVIRONMENT_STALE");
	});

	test("UNKNOWN is reported when no observation is available, never CURRENT", () => {
		const proof = buildOk();
		const report = service.verify(OWNER, { proof });
		expect(report.staleness).toBe(PROOF_STALENESS.UNKNOWN);
		expect(report.status).toBe(PROOF_REPORT_STATUS.UNKNOWN);
		expect(report.checks.snapshotBinding).toBe(PROOF_CHECK.NOT_PROVIDED);
		expect(report.checks.environmentBinding).toBe(PROOF_CHECK.NOT_PROVIDED);
	});

	test("UNKNOWN is reported for a partial observation that cannot settle staleness", () => {
		const proof = buildOk();
		const report = service.verify(OWNER, { proof, current: { snapshot: proof.identity.snapshot } });
		expect(report.staleness).toBe(PROOF_STALENESS.UNKNOWN);
		expect(report.checks.snapshotBinding).toBe(PROOF_CHECK.PASS);
		expect(report.checks.environmentBinding).toBe(PROOF_CHECK.NOT_PROVIDED);
		expect(report.reasons).toContain("CURRENT_UNKNOWN");
	});

	test("MISMATCH is reported when an observed verification state contradicts the proof", () => {
		const proof = buildOk();
		const report = service.verify(OWNER, { proof, current: { ...CURRENT(proof), verificationState: "BLOCKED" } });
		expect(report.status).toBe(PROOF_REPORT_STATUS.MISMATCH);
		expect(report.staleness).toBe(PROOF_STALENESS.CURRENT);
		expect(report.checks.evidenceConsistency).toBe(PROOF_CHECK.FAIL);
		expect(report.reasons).toContain("EVIDENCE_MISMATCH");
	});

	test("STALE is reported ahead of MISMATCH, because identity drift already explains the contradiction", () => {
		const proof = buildOk();
		const report = service.verify(OWNER, {
			proof,
			current: { snapshot: { snapshotId: "snap-47", snapshotFingerprint: "different" }, verificationState: "BLOCKED" },
		});
		// Both conditions hold. The report records both — the evidence check failed and
		// the identity moved — and resolves the status to STALE, because a proof of a
		// snapshot that no longer exists cannot be a truthful statement about now.
		expect(report.staleness).toBe(PROOF_STALENESS.STALE);
		expect(report.checks.evidenceConsistency).toBe(PROOF_CHECK.FAIL);
		expect(report.status).toBe(PROOF_REPORT_STATUS.STALE);
		expect(report.reasons).toContain("SNAPSHOT_STALE");
		expect(report.reasons).toContain("EVIDENCE_MISMATCH");
	});

	test("MISMATCH outranks UNKNOWN, so a real contradiction is never softened", () => {
		const proof = buildOk();
		const report = service.verify(OWNER, { proof, current: { verificationState: "BLOCKED" } });
		// No identity observation, so staleness is UNKNOWN, but the contradiction is
		// still decisive and must not be hidden behind an absence of information.
		expect(report.staleness).toBe(PROOF_STALENESS.UNKNOWN);
		expect(report.status).toBe(PROOF_REPORT_STATUS.MISMATCH);
	});

	test("a raw proof object is reported on rather than thrown on", () => {
		const proof = buildOk();
		const report = service.verify(OWNER, { proof: { ...proof, state: "NOT_A_STATE" } });
		expect(report.status).toBe(PROOF_REPORT_STATUS.INVALID);
		expect(report.checks.structure).toBe(PROOF_CHECK.FAIL);
	});

	test("a text artifact is parsed strictly, so tampering is refused rather than reported", () => {
		const text = exportOk(buildOk()).text;
		const artifact = JSON.parse(text);
		artifact.proof.counts.verified = 42;
		expect(() => service.verify(OWNER, { text: JSON.stringify(artifact) })).toThrow(
			expect.objectContaining({ statusCode: 409 }),
		);
	});

	test("verifying a text artifact matches verifying the proof it carries", () => {
		const proof = buildOk();
		const text = exportOk(proof).text;
		const fromText = service.verify(OWNER, { text, current: CURRENT(proof) });
		const fromProof = service.verify(OWNER, { proof, current: CURRENT(proof) });
		expect(JSON.stringify(fromText)).toBe(JSON.stringify(fromProof));
	});

	test("verification never mutates the proof it inspects", () => {
		const proof = buildOk();
		const before = canonicalProofJsonOf(proof);
		service.verify(OWNER, { proof, current: CURRENT(proof) });
		service.verify(OWNER, { proof });
		expect(canonicalProofJsonOf(proof)).toBe(before);
	});

	test("the report is deterministic regardless of caller key order", () => {
		const proof = buildOk();
		const current = CURRENT(proof);
		const first = service.verify(OWNER, { proof, current });
		const second = service.verify(OWNER, { proof: Object.fromEntries(Object.entries(proof).reverse()), current: Object.fromEntries(Object.entries(current).reverse()) });
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	test("the report leaks no bodies, headers, cookies, tokens, or resolved secrets", () => {
		const proof = buildOk();
		const serialized = JSON.stringify(service.verify(OWNER, { proof, current: CURRENT(proof) }));
		for (const needle of ["body", "headers", "cookies", "Authorization", "Bearer ", "password", "secret"]) {
			expect(serialized).not.toContain(needle);
		}
	});
});

describe("Phase 47B service — retrieve", () => {
	test("retrieval is a function of the artifact the caller holds, and reports non-persistence", () => {
		const proof = buildOk();
		const text = exportOk(proof).text;
		const found = service.retrieve(OWNER, { text, proofId: proof.proofId });
		expect(found.proofId).toBe(proof.proofId);
		expect(found.fingerprint).toBe(proof.fingerprint);
		expect(found.persisted).toBe(false);
	});

	test("a mismatched identity is a 404 rather than a silent coercion", () => {
		const text = exportOk(buildOk()).text;
		expect(() => service.retrieve(OWNER, { text, proofId: "proof_00000000000000000000000000000000" })).toThrow(
			expect.objectContaining({ statusCode: 404, code: PROOF_API_ERROR_CODES.NOT_FOUND }),
		);
	});

	test("the expectedProofId alias behaves identically to proofId", () => {
		const proof = buildOk();
		const text = exportOk(proof).text;
		expect(service.retrieve(OWNER, { text, expectedProofId: proof.proofId }).proofId).toBe(proof.proofId);
		expect(() => service.retrieve(OWNER, { text, expectedProofId: "nope" })).toThrow(
			expect.objectContaining({ statusCode: 404 }),
		);
	});

	test("a tampered artifact cannot be retrieved", () => {
		const text = exportOk(buildOk()).text;
		const artifact = JSON.parse(text);
		artifact.proof.state = "VERIFIED";
		artifact.proof.stateReasons = [];
		expect(() => service.retrieve(OWNER, { text: JSON.stringify(artifact) })).toThrow();
	});
});

describe("Phase 47B service — module surface", () => {
	test("the exported singleton is usable and shares the factory's behaviour", () => {
		const proof = verificationProofApiService.build(OWNER, proofInput()).proof;
		expect(proof.state).toBe("VERIFIED");
		expect(verificationProofApiService.exportProof(OWNER, { proof }).proofId).toBe(proof.proofId);
	});

	test("the service re-exports the phase vocabularies rather than redefining them", () => {
		expect(PROOF_STATES.VERIFIED).toBe("VERIFIED");
		expect(PROOF_REPORT_STATUS.VALID).toBe("VALID");
		expect(PROOF_STALENESS.CURRENT).toBe("CURRENT");
		expect(PROOF_CHECK.PASS).toBe("PASS");
		expect(Object.isFrozen(PROOF_ARTIFACT_ERROR_CODES)).toBe(true);
	});

	test("the artifact version and ceiling are stable, documented constants", () => {
		expect(PROOF_ARTIFACT_SCHEMA_VERSION).toBe(1);
		expect(PROOF_ARTIFACT_MAX_BYTES).toBeGreaterThan(0);
		expect(PROOF_ARTIFACT_MAX_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024);
	});
});

describe("Phase 47B service — determinism fixtures", () => {
	test("a proof carrying drift and contract results exports deterministically", () => {
		const input = proofInput({ drift: driftResult(), contracts: [contractResult()], verifiedAt: VERIFIED_AT });
		const first = service.exportProof(OWNER, { input });
		const second = service.exportProof(OWNER, { input: proofInput({ drift: driftResult(), contracts: [contractResult()], verifiedAt: VERIFIED_AT }) });
		expect(second.text).toBe(first.text);
		expect(parseProofArtifactText(first.text).proof.proofId).toBe(first.proofId);
	});
});
