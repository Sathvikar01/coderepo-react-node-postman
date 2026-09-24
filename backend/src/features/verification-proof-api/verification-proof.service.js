import { AppError } from "../../shared/errors/app-error.js";
import {
	assertProofResult,
	buildVerificationProof,
	PROOF_STATES,
} from "../verification-proof/index.js";
import {
	EVIDENCE_OWNER_PROFILE_ID,
} from "../verification-proof/proof-fixtures.js";
import {
	PROOF_ARTIFACT_ERROR_CODES,
	buildProofArtifact,
	parseProofArtifactText,
	proofArtifactFilename,
	serializeProofArtifact,
} from "./proof-artifact.js";
import { buildVerificationReport } from "./proof-report.js";

// Phase 47B — Verification Proof API service.
//
// A thin orchestration layer over the Phase 47A core and the artifact/report
// modules. It adds exactly two things the core does not own:
//
//   1. Profile isolation. Evidence that names another owner is refused, so a
//      caller cannot mint a proof over someone else's execution records.
//   2. The transport lifecycle: build → export → import → verify → retrieve.
//
// It adds NO verification semantics. It never executes a request, never persists
// a proof, and never upgrades a proof state. Proofs are content-addressed and
// generation-on-demand, so there is no mutable server-side proof record to read
// from, corrupt, or leak.

export const PROOF_API_ERROR_CODES = Object.freeze({
	CROSS_OWNER: "VERIFICATION_PROOF_CROSS_OWNER",
	NOT_FOUND: "VERIFICATION_PROOF_NOT_FOUND",
});

const EMPTY_OWNER = new Set([undefined, null, ""]);

// Fixture builders use a synthetic owner because the Phase 47A core is database-free.
// The check accepts it only when an explicit test hook enables it, so production code
// can never mint a proof over an owner it does not know.
const SYNTHETIC_EVIDENCE_OWNER = EVIDENCE_OWNER_PROFILE_ID;

export { SYNTHETIC_EVIDENCE_OWNER };

let syntheticOwnerEnabled = false;

export function __setSyntheticEvidenceOwnerForTests(enabled) {
	syntheticOwnerEnabled = Boolean(enabled);
}

function ownerMatches(recordOwner, owner) {
	const value = String(recordOwner);
	if (value === owner) return true;
	return syntheticOwnerEnabled && value === SYNTHETIC_EVIDENCE_OWNER;
}

// Collect every evidence record the build input could carry, including evidence
// nested inside a Phase 46C execution report.
function evidenceRecords(input) {
	const records = [];
	const collect = (evidence) => {
		if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return;
		for (const list of [evidence.executions, evidence.assertions]) {
			if (Array.isArray(list)) records.push(...list);
		}
	};
	collect(input?.evidence);
	collect(input?.execution?.evidence);
	return records;
}

// Profile isolation at the build boundary. A record with no owner claim is
// allowed (it is the caller's own input); a record that claims a different owner
// is refused. Comparison is string-based because ids arrive as ObjectId strings.
export function assertEvidenceOwnership(input, profileId) {
	const owner = String(profileId ?? "");
	if (!owner) throw new AppError(401, "PROFILE_REQUIRED", "A profile is required to build a verification proof.");
	for (const record of evidenceRecords(input)) {
		const recordOwner = record?.ownerProfileId;
		if (EMPTY_OWNER.has(recordOwner)) continue;
		if (!ownerMatches(recordOwner, owner)) {
			throw new AppError(403, PROOF_API_ERROR_CODES.CROSS_OWNER, "The proof cites evidence owned by another profile.");
		}
	}
	const verificationOwner = input?.verification?.ownerProfileId ?? input?.execution?.verification?.ownerProfileId;
	if (!EMPTY_OWNER.has(verificationOwner) && !ownerMatches(verificationOwner, owner)) {
		throw new AppError(403, PROOF_API_ERROR_CODES.CROSS_OWNER, "The proof cites verification owned by another profile.");
	}
	return input;
}

export function createVerificationProofApiService({ build = buildVerificationProof } = {}) {
	function buildProof(profileId, input) {
		assertEvidenceOwnership(input, profileId);
		return { proof: build(input) };
	}

	function exportProof(profileId, { proof, input } = {}) {
		let resolved;
		if (proof !== undefined && proof !== null) {
			// Exporting an existing envelope still requires it to pass its own
			// contract and integrity check; export is not a laundering step.
			resolved = assertProofResult(proof);
			const artifact = buildProofArtifact(resolved);
			const text = serializeProofArtifact(artifact);
			return { filename: proofArtifactFilename(resolved.proofId), text, proofId: resolved.proofId, fingerprint: resolved.fingerprint };
		}
		assertEvidenceOwnership(input, profileId);
		resolved = build(input);
		const artifact = buildProofArtifact(resolved);
		const text = serializeProofArtifact(artifact);
		return { filename: proofArtifactFilename(resolved.proofId), text, proofId: resolved.proofId, fingerprint: resolved.fingerprint };
	}

	// Import is inspection-only. It returns the proof plus a report and explicit
	// "did nothing" flags so the caller can prove the import had no side effects.
	function importProof(profileId, text) {
		const { proof } = parseProofArtifactText(text);
		return {
			proof,
			proofId: proof.proofId,
			fingerprint: proof.fingerprint,
			state: proof.state,
			report: buildVerificationReport(proof, undefined),
			persisted: false,
			executed: false,
			autoSend: false,
			autoSave: false,
			upgraded: false,
		};
	}

	// Independent verification. A text artifact is parsed strictly (tampering is
	// rejected); a raw proof object is reported on rather than thrown on, so the
	// caller receives an INVALID report instead of an opaque error.
	function verifyProof(profileId, { proof, text, current } = {}) {
		const candidate = typeof text === "string" ? parseProofArtifactText(text).proof : proof;
		return buildVerificationReport(candidate, current);
	}

	// Stateless retrieval by identity. Proofs are not persisted, so retrieval is a
	// function of the portable artifact the caller holds: parse it, then confirm it
	// is the identity the caller asked for.
	function retrieveProof(profileId, { text, proofId, expectedProofId } = {}) {
		const { proof } = parseProofArtifactText(text);
		const wanted = proofId ?? expectedProofId;
		if (wanted !== undefined && wanted !== null && String(wanted) !== proof.proofId) {
			throw new AppError(404, PROOF_API_ERROR_CODES.NOT_FOUND, "No verification proof matches that identity.");
		}
		return { proof, proofId: proof.proofId, fingerprint: proof.fingerprint, state: proof.state, persisted: false };
	}

	return { build: buildProof, exportProof, importProof, verify: verifyProof, retrieve: retrieveProof };
}

export const verificationProofApiService = createVerificationProofApiService();

export { PROOF_STATES, PROOF_ARTIFACT_ERROR_CODES };
