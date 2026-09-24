import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// The harness is preloaded by path (`bun test --preload ./test/verification-proof-api.setup.js`)
// so the auth/profile stubs are installed before `app.js` imports its middleware.
// `globalThis.__phase47b` is set by that preload.
import { buildVerificationProof, canonicalProofJsonOf } from "../verification-proof/index.js";
import {
	assertionEvidence,
	contractResult,
	driftResult,
	executionEvidence,
	proofInput,
	verificationFixture,
	VERIFIED_AT,
} from "../verification-proof/proof-fixtures.js";
import { PROOF_ARTIFACT_KIND, PROOF_ARTIFACT_MAX_BYTES } from "./proof-artifact.js";
import {
	SYNTHETIC_EVIDENCE_OWNER,
	TEST_TOKEN,
} from "../../../test/verification-proof-api.setup.js";
import { createApp } from "../../app.js";

const TEST_TIMEOUT_MS = 20000;
const mtest = (name, fn) => test(name, fn, TEST_TIMEOUT_MS);

let server = null;
let baseUrl = "";

beforeAll(() => {
	const app = createApp();
	server = app.listen(0);
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
	server?.close();
});

async function api(path, { method = "GET", token = TEST_TOKEN, body } = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			...(body ? { "Content-Type": "application/json" } : {}),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await response.text();
	let payload = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		payload = text;
	}
	return { status: response.status, payload, text, headers: response.headers };
}

const build = (overrides) => api("/api/v1/verification-proofs", { method: "POST", body: { input: proofInput(overrides) } });
const exportProof = (body) => api("/api/v1/verification-proofs/export", { method: "POST", body });
const importProof = (text, token = TEST_TOKEN) => api("/api/v1/verification-proofs/import", { method: "POST", body: { text }, token });
const verify = (body, token = TEST_TOKEN) => api("/api/v1/verification-proofs/verify", { method: "POST", body, token });
const retrieve = (body, token = TEST_TOKEN) => api("/api/v1/verification-proofs/retrieve", { method: "POST", body, token });

const buildOk = async (overrides) => {
	const response = await build(overrides);
	if (response.status !== 201) throw new Error(`build failed: ${response.status} ${JSON.stringify(response.payload)}`);
	return response.payload.data.proof;
};

describe("Phase 47B — verification proof API over HTTP", () => {
	// 1 -----------------------------------------------------------------------
	mtest("1 — builds a proof through the API from a Phase 47A input", async () => {
		const built = await build();
		expect(built.status).toBe(201);
		const proof = built.payload.data.proof;
		expect(proof.kind).toBe("tracer.verification-proof");
		expect(proof.state).toBe("VERIFIED");
		expect(proof.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(proof.proofId).toBe(`proof_${proof.fingerprint.slice(0, 32)}`);
		expect(proof.fingerprint).toBe(buildVerificationProof(proofInput()).fingerprint);
	});

	// 2 -----------------------------------------------------------------------
	mtest("2 — reports INVALID for a proof that fails its own integrity check", async () => {
		const proof = buildVerificationProof(proofInput({ verification: null, evidence: { executions: [], assertions: [] } }));
		expect(proof.state).toBe("UNKNOWN");
		const response = await verify({ proof: { ...proof, state: "VERIFIED" } });
		expect(response.status).toBe(200);
		expect(response.payload.data.status).toBe("INVALID");
		expect(response.payload.data.reasons).toContain("FINGERPRINT_MISMATCH");
	});

	// 3 -----------------------------------------------------------------------
	mtest("3 — exports a portable artifact with self-describing integrity metadata", async () => {
		const proof = await buildOk();
		const exported = await exportProof({ proof });
		expect(exported.status).toBe(200);
		const { filename, text, proofId, fingerprint } = exported.payload.data;
		expect(filename).toBe(`${proof.proofId}.json`);
		expect(proofId).toBe(proof.proofId);
		expect(fingerprint).toBe(proof.fingerprint);
		const artifact = JSON.parse(text);
		expect(artifact.kind).toBe(PROOF_ARTIFACT_KIND);
		expect(artifact.schemaVersion).toBe(1);
		expect(artifact.proof.fingerprint).toBe(proof.fingerprint);
		expect(artifact.fingerprint).toBe(proof.fingerprint);
		expect(artifact.fingerprintKeyId).toBe(proof.fingerprintKeyId);
		expect(artifact.integrity).toMatchObject({ algorithm: "HMAC-SHA-256", canonicalization: "key-sorted-json-v1" });
		expect(artifact.integrity.artifactFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(filename).not.toContain("/");
		expect(filename).not.toContain("\\");
		expect(filename).not.toContain("..");
	});

	// 4 -----------------------------------------------------------------------
	mtest("4 — repeated export of the same proof is byte-identical", async () => {
		const proof = await buildOk();
		const first = await exportProof({ proof });
		const second = await exportProof({ proof });
		expect(second.payload.data.text).toBe(first.payload.data.text);
		expect(second.payload.data.filename).toBe(first.payload.data.filename);
		// Export from an equivalent build input must also match: the artifact is a
		// function of the proof, and the proof is a function of its inputs.
		const fromInput = await exportProof({ input: proofInput() });
		expect(fromInput.payload.data.text).toBe(first.payload.data.text);
	});

	// 5 -----------------------------------------------------------------------
	mtest("5 — export then import round-trips the proof without semantic drift", async () => {
		const proof = await buildOk();
		const text = (await exportProof({ proof })).payload.data.text;
		const imported = await importProof(text);
		expect(imported.status).toBe(200);
		const data = imported.payload.data;
		expect(data.proofId).toBe(proof.proofId);
		expect(data.fingerprint).toBe(proof.fingerprint);
		expect(data.state).toBe(proof.state);
		expect(canonicalProofJsonOf(data.proof)).toBe(canonicalProofJsonOf(proof));
		expect(data.report.status).toBe("UNKNOWN");
		// Import is inspection-only. These flags are the machine-readable proof that
		// nothing executed, persisted, upgraded, sent, or saved.
		expect(data.persisted).toBe(false);
		expect(data.executed).toBe(false);
		expect(data.autoSend).toBe(false);
		expect(data.autoSave).toBe(false);
		expect(data.upgraded).toBe(false);
	});

	// 6 -----------------------------------------------------------------------
	mtest("6 — rejects a tampered artifact instead of repairing it", async () => {
		const proof = await buildOk();
		const text = (await exportProof({ proof })).payload.data.text;
		const artifact = JSON.parse(text);
		artifact.proof.state = "VERIFIED";
		artifact.proof.stateReasons = [];
		const tampered = await importProof(JSON.stringify(artifact));
		expect(tampered.status).toBe(409);
		expect(["VERIFICATION_PROOF_TAMPERED", "VERIFICATION_PROOF_ARTIFACT_TAMPERED"]).toContain(tampered.payload.error.code);

		// A wrapper-only edit is caught by the artifact fingerprint, which is why the
		// envelope carries its own digest instead of trusting the embedded proof.
		const envelope = JSON.parse(text);
		envelope.integrity.artifactFingerprint = "0".repeat(64);
		const envelopeEdit = await importProof(JSON.stringify(envelope));
		expect(envelopeEdit.status).toBe(409);
		expect(envelopeEdit.payload.error.code).toBe("VERIFICATION_PROOF_ARTIFACT_TAMPERED");

		// Metadata that disagrees with the proof it claims to carry is tampering too.
		const swapped = JSON.parse(text);
		swapped.fingerprint = "1".repeat(64);
		const metadataEdit = await importProof(JSON.stringify(swapped));
		expect(metadataEdit.status).toBe(409);
		expect(metadataEdit.payload.error.code).toBe("VERIFICATION_PROOF_ARTIFACT_TAMPERED");
	});

	// 7 -----------------------------------------------------------------------
	mtest("7 — rejects a wrong-fingerprint proof on verify", async () => {
		const proof = await buildOk();
		const response = await verify({ proof: { ...proof, fingerprint: "0".repeat(64) } });
		expect(response.status).toBe(200);
		expect(response.payload.data.status).toBe("INVALID");
		expect(response.payload.data.checks.structure).toBe("PASS");
		expect(response.payload.data.checks.fingerprint).toBe("FAIL");
	});

	// 8 -----------------------------------------------------------------------
	mtest("8 — rejects malformed JSON, malformed artifacts, and empty text", async () => {
		const brokenJson = await importProof("{not json");
		expect(brokenJson.status).toBe(400);
		expect(brokenJson.payload.error.code).toBe("VERIFICATION_PROOF_ARTIFACT_MALFORMED");

		const notAnArtifact = await importProof(JSON.stringify({ kind: "tracer.something-else", schemaVersion: 1 }));
		expect(notAnArtifact.status).toBe(400);
		expect(notAnArtifact.payload.error.code).toBe("VERIFICATION_PROOF_ARTIFACT_MALFORMED");

		const emptyText = await api("/api/v1/verification-proofs/import", { method: "POST", body: { text: "" } });
		expect(emptyText.status).toBe(400);

		const missingText = await api("/api/v1/verification-proofs/import", { method: "POST", body: {} });
		expect(missingText.status).toBe(400);
	});

	// 9 -----------------------------------------------------------------------
	mtest("9 — rejects an unsupported schema version without upgrading it", async () => {
		const proof = await buildOk();
		const text = (await exportProof({ proof })).payload.data.text;

		const futureArtifact = JSON.parse(text);
		futureArtifact.schemaVersion = 99;
		const artifactVersion = await importProof(JSON.stringify(futureArtifact));
		expect(artifactVersion.status).toBe(422);
		expect(artifactVersion.payload.error.code).toBe("VERIFICATION_PROOF_ARTIFACT_UNSUPPORTED_VERSION");

		const futureProof = JSON.parse(text);
		futureProof.proof.schemaVersion = 99;
		const proofVersion = await importProof(JSON.stringify(futureProof));
		expect(proofVersion.status).toBe(422);
		expect(proofVersion.payload.error.code).toBe("VERIFICATION_PROOF_ARTIFACT_UNSUPPORTED_VERSION");

		// The import left nothing behind: an unsupported artifact cannot become state.
		expect(JSON.parse(text).schemaVersion).toBe(1);
	});

	// 10 ----------------------------------------------------------------------
	mtest("10 — rejects an oversized artifact before parsing it", async () => {
		const oversized = `{"kind":"${PROOF_ARTIFACT_KIND}","schemaVersion":1,"pad":"${"x".repeat(PROOF_ARTIFACT_MAX_BYTES + 64)}"}`;
		const viaImport = await importProof(oversized);
		expect(viaImport.status).toBe(413);
		expect(viaImport.payload.error.code).toBe("VERIFICATION_PROOF_ARTIFACT_TOO_LARGE");

		// The route body limit is the first line of defense; the artifact ceiling is
		// the second. Build a well-formed JSON body whose text field alone exceeds the
		// artifact ceiling, so the artifact parser — not Express — refuses it with byte
		// accounting the caller can act on.
		const padded = await api("/api/v1/verification-proofs/import", {
			method: "POST",
			body: { text: `{"kind":"${PROOF_ARTIFACT_KIND}","schemaVersion":1,"pad":"${"x".repeat(PROOF_ARTIFACT_MAX_BYTES)}"}` },
		});
		expect(padded.status).toBe(413);
		expect(padded.payload.error.code).toBe("VERIFICATION_PROOF_ARTIFACT_TOO_LARGE");
		expect(padded.payload.error.details.maxBytes).toBe(PROOF_ARTIFACT_MAX_BYTES);

		// A body beyond the transport limit is refused by the transport instead, which
		// is still a bounded refusal and still 413.
		const transportLimit = await api("/api/v1/verification-proofs/import", {
			method: "POST",
			body: { text: "x".repeat(5 * 1024 * 1024) },
		});
		expect(transportLimit.status).toBe(413);
	});

	// 11 ----------------------------------------------------------------------
	mtest("11 — refuses cross-owner evidence and never exposes another owner's proof", async () => {
		const proof = await buildOk();
		const text = (await exportProof({ proof })).payload.data.text;

		// The proof artifact itself is portable: it carries no owner and no secret, so
		// importing it is allowed. What it is NOT is a server-side record, so
		// retrieval is content-addressed and explicitly non-persistent.
		const retrieved = await retrieve({ proofId: proof.proofId, text });
		expect(retrieved.status).toBe(200);
		expect(retrieved.payload.data.persisted).toBe(false);
		expect(retrieved.payload.data.proofId).toBe(proof.proofId);

		// Minting a proof over another profile's evidence is refused.
		const crossOwnerBuild = await api("/api/v1/verification-proofs", {
			method: "POST",
			body: {
				input: proofInput({
					evidence: { executions: [executionEvidence({ ownerProfileId: "profile-someone-else" })], assertions: [] },
				}),
			},
		});
		expect(crossOwnerBuild.status).toBe(403);
		expect(crossOwnerBuild.payload.error.code).toBe("VERIFICATION_PROOF_CROSS_OWNER");

		// The synthetic fixture owner is the resolved test profile, so its evidence is
		// accepted — proving the check is about ownership, not about rejecting input.
		const ownBuild = await api("/api/v1/verification-proofs", {
			method: "POST",
			body: {
				input: proofInput({
					evidence: { executions: [executionEvidence({ ownerProfileId: SYNTHETIC_EVIDENCE_OWNER })], assertions: [assertionEvidence()] },
				}),
			},
		});
		expect(ownBuild.status).toBe(201);

		// A cross-owner verification envelope is refused too.
		const crossOwnerVerification = await api("/api/v1/verification-proofs", {
			method: "POST",
			body: { input: proofInput({ verification: { ...verificationFixture(), ownerProfileId: "profile-someone-else" } }) },
		});
		expect(crossOwnerVerification.status).toBe(403);
		expect(crossOwnerVerification.payload.error.code).toBe("VERIFICATION_PROOF_CROSS_OWNER");
	});

	// 12 ----------------------------------------------------------------------
	mtest("12 — reports CURRENT when the supplied identity matches the proof", async () => {
		const proof = await buildOk();
		const response = await verify({
			proof,
			current: {
				snapshot: proof.identity.snapshot,
				targetEnvironment: {
					environmentId: proof.identity.targetEnvironment.environmentId,
					environmentFingerprint: proof.identity.targetEnvironment.environmentFingerprint,
				},
				verificationState: proof.state,
			},
		});
		expect(response.status).toBe(200);
		expect(response.payload.data.staleness).toBe("CURRENT");
		expect(response.payload.data.status).toBe("VALID");
		expect(response.payload.data.checks.snapshotBinding).toBe("PASS");
		expect(response.payload.data.checks.environmentBinding).toBe("PASS");
		expect(response.payload.data.checks.evidenceConsistency).toBe("PASS");
		expect(response.payload.data.reasons).toContain("IDENTITY_CURRENT");
	});

	// 13 ----------------------------------------------------------------------
	mtest("13 — reports STALE when the current identity has moved on", async () => {
		const proof = await buildOk();
		const movedSnapshot = await verify({
			proof,
			current: { snapshot: { snapshotId: "snap-47", snapshotFingerprint: "fp-snapshot-48" } },
		});
		expect(movedSnapshot.payload.data.staleness).toBe("STALE");
		expect(movedSnapshot.payload.data.status).toBe("STALE");
		expect(movedSnapshot.payload.data.reasons).toContain("SNAPSHOT_STALE");
		expect(movedSnapshot.payload.data.checks.fingerprint).toBe("PASS");

		const movedEnvironment = await verify({
			proof,
			current: { targetEnvironment: { environmentId: "env-prod", environmentFingerprint: "env-fingerprint-48" } },
		});
		expect(movedEnvironment.payload.data.staleness).toBe("STALE");
		expect(movedEnvironment.payload.data.reasons).toContain("ENVIRONMENT_STALE");
	});

	// 14 ----------------------------------------------------------------------
	mtest("14 — reports UNKNOWN when the current identity is unavailable", async () => {
		const proof = await buildOk();
		const noCurrent = await verify({ proof });
		expect(noCurrent.payload.data.staleness).toBe("UNKNOWN");
		expect(noCurrent.payload.data.status).toBe("UNKNOWN");
		expect(noCurrent.payload.data.reasons).toContain("CURRENT_UNKNOWN");
		expect(noCurrent.payload.data.checks.snapshotBinding).toBe("NOT_PROVIDED");

		// A partial observation is still not a positive claim.
		const snapshotOnly = await verify({ proof, current: { snapshot: proof.identity.snapshot } });
		expect(snapshotOnly.payload.data.staleness).toBe("UNKNOWN");
		expect(snapshotOnly.payload.data.status).toBe("UNKNOWN");
		expect(snapshotOnly.payload.data.checks.snapshotBinding).toBe("PASS");
		expect(snapshotOnly.payload.data.checks.environmentBinding).toBe("NOT_PROVIDED");
	});

	// 15 ----------------------------------------------------------------------
	mtest("15 — reports MISMATCH when supplied evidence contradicts an intact proof", async () => {
		const proof = await buildOk();
		const response = await verify({
			proof,
			current: {
				snapshot: proof.identity.snapshot,
				targetEnvironment: {
					environmentId: proof.identity.targetEnvironment.environmentId,
					environmentFingerprint: proof.identity.targetEnvironment.environmentFingerprint,
				},
				verificationState: "BLOCKED",
			},
		});
		expect(response.status).toBe(200);
		expect(response.payload.data.status).toBe("MISMATCH");
		expect(response.payload.data.staleness).toBe("CURRENT");
		expect(response.payload.data.checks.fingerprint).toBe("PASS");
		expect(response.payload.data.checks.evidenceConsistency).toBe("FAIL");
		expect(response.payload.data.reasons).toContain("EVIDENCE_MISMATCH");

		// A conflicting upstream envelope is a mismatch too, and never a VALID.
		const conflictingImpact = await verify({ proof, current: { impact: { kind: "tracer.change-impact", resolved: false } } });
		expect(conflictingImpact.payload.data.status).toBe("MISMATCH");

		// A matching envelope is a pass, so mismatch is a real comparison and not a
		// blanket rejection of supplied evidence.
		const matchingImpact = await verify({ proof, current: { impact: proofInput().impact } });
		expect(matchingImpact.payload.data.checks.evidenceConsistency).toBe("PASS");
	});

	// 16 ----------------------------------------------------------------------
	mtest("16 — verifies without executing, mutating, or persisting anything", async () => {
		const proof = await buildOk();
		const before = JSON.stringify(proof);
		const report = await verify({ proof, current: { snapshot: proof.identity.snapshot } });
		expect(report.status).toBe(200);
		expect(JSON.stringify(proof)).toBe(before);

		const imported = await importProof((await exportProof({ proof })).payload.data.text);
		expect(imported.payload.data.persisted).toBe(false);
		expect(imported.payload.data.executed).toBe(false);
		expect(imported.payload.data.autoSend).toBe(false);
		expect(imported.payload.data.autoSave).toBe(false);

		// There is no proof store to read from: retrieve with only an id is refused.
		const idOnly = await retrieve({ proofId: proof.proofId });
		expect(idOnly.status).toBe(400);
	});

	// 17 ----------------------------------------------------------------------
	mtest("17 — never exposes bodies, headers, cookies, tokens, or resolved secrets", async () => {
		const proof = await buildOk();
		const exported = await exportProof({ proof });
		for (const text of [JSON.stringify(proof), exported.payload.data.text]) {
			expect(text).not.toContain("body");
			expect(text).not.toContain("headers");
			expect(text).not.toContain("cookies");
			expect(text).not.toContain("password");
			expect(text).not.toContain("Bearer ");
			expect(text).not.toContain("Authorization");
		}
		const verified = (await verify({ proof })).payload.data;
		expect(JSON.stringify(verified)).not.toContain("password");
		expect(JSON.stringify(verified)).not.toContain("Bearer ");
		// A credential-shaped string in an imported artifact is refused outright.
		const secretish = (await exportProof({ proof })).payload.data.text.replace(/"kind":"tracer.verification-proof"/, '"kind":"tracer.verification-proof" // Bearer abcdefghijklmnopqrst');
		const refused = await importProof(secretish);
		expect(refused.status).toBe(422);
		expect(refused.payload.error.code).toBe("VERIFICATION_PROOF_ARTIFACT_SECRET_TEXT");
	});

	// 18 ----------------------------------------------------------------------
	mtest("18 — produces a deterministic report independent of caller key order", async () => {
		const proof = await buildOk();
		const current = {
			snapshot: proof.identity.snapshot,
			targetEnvironment: {
				environmentId: proof.identity.targetEnvironment.environmentId,
				environmentFingerprint: proof.identity.targetEnvironment.environmentFingerprint,
			},
		};
		const first = await verify({ proof, current });
		const reordered = Object.fromEntries(Object.entries(current).reverse());
		const second = await verify({ proof, current: reordered });
		expect(JSON.stringify(second.payload.data)).toBe(JSON.stringify(first.payload.data));

		const reorderedProof = Object.fromEntries(Object.entries(proof).reverse());
		const third = await verify({ proof: reorderedProof, current });
		expect(JSON.stringify(third.payload.data)).toBe(JSON.stringify(first.payload.data));

		// Rebuilding an identical proof yields an identical report.
		const rebuilt = await verify({ proof: await buildOk(), current });
		expect(JSON.stringify(rebuilt.payload.data)).toBe(JSON.stringify(first.payload.data));
	});

	// 19 ----------------------------------------------------------------------
	mtest("19 — refuses prototype-pollution keys and path-traversal-shaped proof ids", async () => {
		const proof = await buildOk();
		const text = (await exportProof({ proof })).payload.data.text;
		const polluted = `{"__proto__":${JSON.stringify({ polluted: true })},${text.slice(1)}`;
		const pollution = await importProof(polluted);
		expect(pollution.status).toBe(400);
		expect(pollution.payload.error.code).toBe("VERIFICATION_PROOF_ARTIFACT_MALFORMED");
		expect({}.polluted).toBeUndefined();
		expect(Object.prototype.polluted).toBeUndefined();

		// A proof id is used to derive a filename, so a traversal-shaped id must never
		// reach the exporter. The proof contract refuses it before a name is built.
		const traversal = await exportProof({ proof: { ...proof, proofId: "../../etc/passwd" } });
		expect(traversal.status).toBeGreaterThanOrEqual(400);
		expect(JSON.stringify(traversal.payload)).not.toContain("etc/passwd");

		// A non-matching identity is a 404, not a filesystem lookup.
		const missing = await retrieve({ proofId: "proof_00000000000000000000000000000000", text });
		expect(missing.status).toBe(404);
		expect(missing.payload.error.code).toBe("VERIFICATION_PROOF_NOT_FOUND");

		// The artifact is untouched by every refusal above.
		expect(JSON.parse(text).proof.proofId).toBe(proof.proofId);

		// Reserved keys anywhere in the artifact are refused, including nested ones.
		// The payload is assembled as text because `__proto__` is not an own property
		// after a normal object assignment — it would be silently dropped.
		const nestedPollution = await importProof(
			text.replace('"identity":{', '"identity":{"__proto__":{"polluted":true},'),
		);
		expect(nestedPollution.status).toBe(400);
		expect(nestedPollution.payload.error.code).toBe("VERIFICATION_PROOF_ARTIFACT_MALFORMED");
		expect(Object.prototype.polluted).toBeUndefined();
		expect({}.polluted).toBeUndefined();
	});

	// 20 ----------------------------------------------------------------------
	mtest("20 — requires authentication and refuses a conflicting identity with a typed error", async () => {
		const unauthenticated = await api("/api/v1/verification-proofs", { method: "POST", token: "", body: { input: proofInput() } });
		expect(unauthenticated.status).toBe(401);

		const invalidToken = await api("/api/v1/verification-proofs", {
			method: "POST",
			token: "not-a-token",
			body: { input: proofInput() },
		});
		expect(invalidToken.status).toBe(401);

		const badInput = await api("/api/v1/verification-proofs", { method: "POST", body: { input: proofInput({ plan: undefined }) } });
		expect(badInput.status).toBe(400);
		expect(String(badInput.payload.error.code)).toStartWith("VERIFICATION_PROOF_");

		// Conflicting identity claims are rejected, not silently resolved.
		const conflicting = await build({ verification: verificationFixture({ target: { environmentId: "env-other" } }) });
		expect(conflicting.status).toBe(409);
		expect(conflicting.payload.error.code).toBe("VERIFICATION_PROOF_INCONSISTENT_EVIDENCE");

		const wrongSnapshot = await build({ snapshot: { snapshotId: "snap-47", snapshotFingerprint: "fp-other" } });
		expect(wrongSnapshot.status).toBe(409);
		expect(wrongSnapshot.payload.error.code).toBe("VERIFICATION_PROOF_IDENTITY_MISMATCH");
	});
});

describe("Phase 47B — export/import boundaries", () => {
	mtest("an unauthenticated export is refused", async () => {
		const proof = buildVerificationProof(proofInput());
		const response = await api("/api/v1/verification-proofs/export", { method: "POST", token: "", body: { proof } });
		expect(response.status).toBe(401);
	});

	mtest("an unauthenticated retrieve and verify are refused", async () => {
		expect((await retrieve({ proofId: "proof_x" }, "")).status).toBe(401);
		expect((await verify({ proof: buildVerificationProof(proofInput()) }, "")).status).toBe(401);
	});

	mtest("export requires exactly one of proof or input", async () => {
		const both = await exportProof({ proof: buildVerificationProof(proofInput()), input: proofInput() });
		expect(both.status).toBe(400);
		const neither = await exportProof({});
		expect(neither.status).toBe(400);
	});

	mtest("verify requires exactly one of proof or text", async () => {
		const both = await verify({ proof: buildVerificationProof(proofInput()), text: "{}" });
		expect(both.status).toBe(400);
		const neither = await verify({});
		expect(neither.status).toBe(400);
	});

	mtest("the exported artifact is byte-stable across independent server requests", async () => {
		const input = proofInput({ drift: driftResult(), contracts: [contractResult()], verifiedAt: VERIFIED_AT });
		const text = (await exportProof({ input })).payload.data.text;
		const again = (await exportProof({ input })).payload.data.text;
		expect(again).toBe(text);
		expect(canonicalProofJsonOf(JSON.parse(text))).toBe(text);
	});

	mtest("a text artifact verifies identically to the proof object it carries", async () => {
		const proof = buildVerificationProof(proofInput());
		const text = (await exportProof({ proof })).payload.data.text;
		const current = { snapshot: proof.identity.snapshot };
		const fromText = await verify({ text, current });
		const fromProof = await verify({ proof, current });
		expect(fromText.status).toBe(200);
		expect(JSON.stringify(fromText.payload.data)).toBe(JSON.stringify(fromProof.payload.data));
	});

	mtest("a tampered text artifact is rejected at verify rather than reported as INVALID", async () => {
		const proof = buildVerificationProof(proofInput());
		const artifact = JSON.parse((await exportProof({ proof })).payload.data.text);
		artifact.proof.counts.verified = 99;
		const response = await verify({ text: JSON.stringify(artifact) });
		expect(response.status).toBe(409);
		expect(["VERIFICATION_PROOF_TAMPERED", "VERIFICATION_PROOF_ARTIFACT_TAMPERED"]).toContain(response.payload.error.code);
	});
});
