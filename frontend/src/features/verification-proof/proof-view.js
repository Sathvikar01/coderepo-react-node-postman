// Phase 47C — Verification Proof view model.
//
// Pure, framework-free presentation logic for the Verification Proof dialog. It
// exists so the truth rules are testable without a DOM and so the React component
// contains no verification reasoning.
//
// The single most important rule in this file:
//
//   The frontend never infers proof validity. Every state, status, staleness
//   value, and reason code rendered by the UI is copied from a Phase 47B response.
//   This module maps values to presentation; it does not derive them.
//
// A second rule with equal weight:
//
//   STALE must never look like current green VERIFIED evidence. A previously
//   VERIFIED proof whose snapshot or environment moved on is rendered as STALE
//   with a warning tone, never as success.

// Phase 47A verification states (copied, never invented).
export const PROOF_STATES = Object.freeze({
	VERIFIED: "VERIFIED",
	BLOCKED: "BLOCKED",
	NEEDS_REHEARSAL: "NEEDS_REHEARSAL",
	UNKNOWN: "UNKNOWN",
});

// Phase 47B report statuses.
export const PROOF_STATUS = Object.freeze({
	VALID: "VALID",
	INVALID: "INVALID",
	STALE: "STALE",
	MISMATCH: "MISMATCH",
	UNKNOWN: "UNKNOWN",
});

// Phase 47B staleness verdicts.
export const PROOF_STALENESS = Object.freeze({
	CURRENT: "CURRENT",
	STALE: "STALE",
	UNKNOWN: "UNKNOWN",
});

const STATE_LABELS = Object.freeze({
	[PROOF_STATES.VERIFIED]: "Verified",
	[PROOF_STATES.BLOCKED]: "Blocked",
	[PROOF_STATES.NEEDS_REHEARSAL]: "Needs rehearsal",
	[PROOF_STATES.UNKNOWN]: "Unknown",
});

const STATUS_LABELS = Object.freeze({
	[PROOF_STATUS.VALID]: "Valid",
	[PROOF_STATUS.INVALID]: "Invalid",
	[PROOF_STATUS.STALE]: "Stale",
	[PROOF_STATUS.MISMATCH]: "Mismatch",
	[PROOF_STATUS.UNKNOWN]: "Unknown",
});

// Human explanations for the Phase 47B reason codes. These describe *why* the
// backend reached a verdict; they never soften or upgrade it. SNAPSHOT_STALE and
// ENVIRONMENT_STALE are the two that turn a previously VERIFIED proof into STALE.
const REASON_TEXT = Object.freeze({
	STRUCTURE_INVALID: "The artifact does not have the shape of a verification proof.",
	SCHEMA_VERSION_UNSUPPORTED: "The artifact was written by an unsupported proof schema version.",
	FINGERPRINT_MISMATCH: "The proof fingerprint does not match its own content. The artifact was modified after it was written.",
	FIXED_POINT_MISMATCH: "Recomputing the fingerprint from the proof content produced a different value.",
	INTERNAL_INCONSISTENT: "The proof's own internal invariants do not agree with each other.",
	SNAPSHOT_STALE: "The workspace snapshot this proof was built from is not the current snapshot.",
	ENVIRONMENT_STALE: "The target environment this proof was built against is not the current environment.",
	EVIDENCE_MISMATCH: "The evidence supplied now contradicts the evidence committed in the proof.",
	IDENTITY_CURRENT: "The proof's snapshot and target environment match the current identity.",
	CURRENT_UNKNOWN: "No current snapshot and environment were supplied, so currency cannot be established.",
	INTEGRITY_OK: "The proof fingerprint and integrity check passed.",
});

export function stateLabel(state) {
	return STATE_LABELS[state] ?? (state ? String(state) : "Unknown");
}

export function statusLabel(status) {
	return STATUS_LABELS[status] ?? (status ? String(status) : "Unknown");
}

export function reasonText(code) {
	return REASON_TEXT[code] ?? String(code ?? "").replaceAll("_", " ").toLowerCase();
}

export function reasonTexts(codes) {
	return (codes ?? []).map((code) => ({ code, text: reasonText(code) }));
}

// The reported `status` is authoritative. When it is STALE the tone must be a
// warning, even though the proof is intact: the evidence is no longer about the
// world the user is looking at. INVALID (tampered) is always danger.
export function reportTone(report) {
	switch (report?.status) {
		case PROOF_STATUS.VALID:
			return "success";
		case PROOF_STATUS.STALE:
			return "warning";
		case PROOF_STATUS.MISMATCH:
			return "danger";
		case PROOF_STATUS.INVALID:
			return "danger";
		case PROOF_STATUS.UNKNOWN:
			return "unknown";
		default:
			return "unknown";
	}
}

// The headline the dialog shows. It pairs the report status with the underlying
// Phase 47A verification state so a STALE proof is never read as fresh VERIFIED
// evidence.
export function reportHeadline(report) {
	if (!report) return { tone: "unknown", title: "No proof", detail: "No verification proof has been loaded yet." };
	const tone = reportTone(report);
	const status = statusLabel(report.status);
	const state = report.proofState ? stateLabel(report.proofState) : null;
	if (report.status === PROOF_STATUS.STALE) {
		return {
			tone,
			title: `Stale — previously ${state ?? "unknown"}`,
			detail: "This proof was valid when it was written, but it no longer matches the current snapshot or environment.",
		};
	}
	if (report.status === PROOF_STATUS.INVALID) {
		return { tone, title: "Invalid — integrity check failed", detail: "This artifact cannot be trusted. Do not act on its claims." };
	}
	if (report.status === PROOF_STATUS.MISMATCH) {
		return { tone, title: "Mismatch", detail: "The current evidence contradicts what this proof committed to." };
	}
	if (report.status === PROOF_STATUS.UNKNOWN) {
		return {
			tone,
			title: `Unknown${state ? ` — proof state ${state}` : ""}`,
			detail: "Tracer cannot establish whether this proof is current. Absence of evidence is not a pass.",
		};
	}
	return { tone, title: `Valid — ${state ?? "unknown"}`, detail: "The proof is intact and matches the current snapshot and environment." };
}

// Percentages are never invented. Counts are shown as exact integers, and an
// unknown count is labelled rather than folded into a success rate.
export function countRows(counts) {
	if (!counts) return [];
	return [
		{ key: "impacted", label: "Impacted", value: counts.impacted ?? 0 },
		{ key: "planned", label: "Planned", value: counts.planned ?? 0 },
		{ key: "rehearsed", label: "Rehearsed", value: counts.rehearsed ?? 0 },
		{ key: "verified", label: "Verified", value: counts.verified ?? 0 },
		{ key: "unverified", label: "Unverified", value: counts.unverified ?? 0, tone: (counts.unverified ?? 0) > 0 ? "warning" : "neutral" },
	];
}

// Contract compatibility as the backend reports it. `unknown` is shown as its own
// row so it can never be mistaken for a compatible comparison.
export function contractRows(contracts) {
	if (!contracts || contracts.present !== true) {
		return { present: false, rows: [], note: "No contract comparison is committed in this proof." };
	}
	return {
		present: true,
		rows: [
			{ key: "compared", label: "Compared", value: contracts.compared ?? 0 },
			{ key: "compatible", label: "Compatible", value: contracts.compatible ?? 0, tone: "success" },
			{ key: "incompatible", label: "Incompatible", value: contracts.incompatible ?? 0, tone: (contracts.incompatible ?? 0) > 0 ? "danger" : "neutral" },
			{ key: "unknown", label: "Unknown", value: contracts.unknown ?? 0, tone: (contracts.unknown ?? 0) > 0 ? "warning" : "neutral" },
		],
		note: "",
	};
}


// Phase 50 polish — deterministic review entry points from an already-loaded
// Verification Proof. This helper never decides technical truth: it only exposes
// review finding types that are explicitly present in the backend proof.
export function reviewPromotionOptions(proof) {
	if (!proof) return [];
	const proofId = proof.proofId ?? "verification proof";
	const snapshotId = proof.identity?.snapshot?.snapshotId ?? "the recorded snapshot";
	const options = [];

	const breaking = proof.contracts?.classes?.breaking ?? 0;
	if (breaking > 0) {
		options.push({
			findingType: "contract_breaking",
			label: "Promote BREAKING contract",
			title: `Review ${breaking} breaking contract finding${breaking === 1 ? "" : "s"}`,
			findingSummary: `Verification Proof ${proofId} records ${breaking} breaking contract compatibility finding${breaking === 1 ? "" : "s"} for ${snapshotId}.`,
		});
	}

	if (proof.state === PROOF_STATES.BLOCKED) {
		options.push({
			findingType: "verification_blocked",
			label: "Promote BLOCKED verification",
			title: "Review BLOCKED verification",
			findingSummary: `Phase 41 verification is BLOCKED in Verification Proof ${proofId} for ${snapshotId}.`,
		});
	} else if (proof.state === PROOF_STATES.UNKNOWN) {
		options.push({
			findingType: "verification_unknown",
			label: "Promote UNKNOWN verification",
			title: "Review UNKNOWN verification",
			findingSummary: `Phase 41 verification is UNKNOWN in Verification Proof ${proofId} for ${snapshotId}.`,
		});
	}

	options.push({
		findingType: "verification_proof",
		label: "Promote proof",
		title: `Review Verification Proof ${proofId}`,
		findingSummary: `Review the exact evidence committed by Verification Proof ${proofId} for ${snapshotId}. Technical state: ${proof.state ?? "UNKNOWN"}.`,
	});

	return options;
}

export function driftSummary(drift) {
	if (!drift || drift.present !== true) {
		return { present: false, blocking: [], blockingCount: 0, identical: null, label: "No environment drift comparison is committed in this proof." };
	}
	const blocking = drift.blocking ?? [];
	const blockingCount = drift.blockingCount ?? blocking.length;
	return {
		present: true,
		blocking,
		blockingCount,
		identical: drift.identical ?? null,
		label: blockingCount > 0 ? `${blockingCount} blocking drift finding${blockingCount === 1 ? "" : "s"}` : "No blocking drift",
	};
}

// A short human label for the rehearsal run so the proof is traceable without
// exposing internals.
export function rehearsalLine(rehearsal) {
	if (!rehearsal) return "No rehearsal run is committed in this proof.";
	const parts = [rehearsal.runState ?? "unknown state"];
	if (rehearsal.terminated) parts.push("terminated");
	if (rehearsal.stopReason) parts.push(`stopped: ${String(rehearsal.stopReason).replaceAll("_", " ").toLowerCase()}`);
	return parts.join(" · ");
}

// Per-request evidence rows. Names are only shown when the backend supplies them;
// the UI never invents a request name. No bodies, credentials, or resolved secret
// environment values are ever part of the proof, so none can be rendered.
export function evidenceRows(proof) {
	return (proof?.requests ?? []).map((entry) => ({
		requestId: entry.requestId,
		contractState: contractStateLabel(entry.contract),
		verificationState: entry.verified ? PROOF_STATES.VERIFIED : entry.rehearsed ? PROOF_STATES.NEEDS_REHEARSAL : PROOF_STATES.UNKNOWN,
		impacted: Boolean(entry.impacted),
		impactKind: entry.impactKind ?? null,
		rehearsed: Boolean(entry.rehearsed),
		verified: Boolean(entry.verified),
		evidenceCount: (entry.evidence ?? []).length,
		evidenceRefs: (entry.evidence ?? []).map((ref) => ({ kind: ref.kind, refId: ref.refId, outcome: ref.outcome ?? ref.status ?? null })),
	}));
}

export function contractStateLabel(contract) {
	if (!contract || contract.compared !== true) return "Not compared";
	if (contract.compatible === true) return "Compatible";
	if (contract.compatible === false) return "Incompatible";
	return "Unknown";
}

// Integrity metadata for the compact, secondary expandable section. Everything
// here is read straight from the proof/artifact.
export function integrityDetails(proof, artifact) {
	if (!proof) return null;
	return {
		proofId: proof.proofId ?? null,
		fingerprint: proof.fingerprint ?? null,
		fingerprintKeyId: proof.fingerprintKeyId ?? null,
		schemaVersion: proof.schemaVersion ?? null,
		algorithm: proof.integrity?.algorithm ?? null,
		canonicalization: proof.integrity?.canonicalization ?? null,
		verifiedAt: proof.verifiedAt ?? null,
		state: proof.state ?? null,
		provenanceCount: (proof.provenance?.sources ?? []).length,
		artifactFingerprint: artifact?.integrity?.artifactFingerprint ?? null,
		artifactKind: artifact?.kind ?? null,
		artifactSchemaVersion: artifact?.schemaVersion ?? null,
	};
}

// Only the four Phase 47A verification states are surfaced. Anything else is
// reported verbatim rather than coerced into a known state.
export function verificationStateBadge(state) {
	if (!state) return { tone: "unknown", label: "Unknown" };
	switch (state) {
		case PROOF_STATES.VERIFIED:
			return { tone: "success", label: "Verified" };
		case PROOF_STATES.BLOCKED:
			return { tone: "danger", label: "Blocked" };
		case PROOF_STATES.NEEDS_REHEARSAL:
			return { tone: "warning", label: "Needs rehearsal" };
		case PROOF_STATES.UNKNOWN:
			return { tone: "unknown", label: "Unknown" };
		default:
			return { tone: "unknown", label: String(state) };
	}
}

export function stateReasonCodes(proof) {
	return (proof?.stateReasons ?? []).map((code) => ({ code, text: reasonText(code) }));
}

// ---------------------------------------------------------------------------
// Error surfaces
// ---------------------------------------------------------------------------
//
// Every failure mode the dialog can hit has a truthful, non-green message. None
// of these default to success.
export function proofErrorMessage(error) {
	const code = error?.code;
	switch (code) {
		case "VERIFICATION_PROOF_ARTIFACT_MALFORMED":
			return "That file is not a verification proof artifact. Nothing was imported.";
		case "VERIFICATION_PROOF_ARTIFACT_UNSUPPORTED_VERSION":
			return "That artifact was written by an unsupported proof schema version.";
		case "VERIFICATION_PROOF_ARTIFACT_TOO_LARGE":
			return "That artifact is larger than the maximum accepted proof size.";
		case "VERIFICATION_PROOF_ARTIFACT_TAMPERED":
			return "That artifact failed its integrity check. It may have been modified.";
		case "VERIFICATION_PROOF_ARTIFACT_SECRET_TEXT":
			return "That artifact contains credential-shaped text and was refused.";
		case "VERIFICATION_PROOF_CROSS_OWNER":
			return "That evidence belongs to another profile.";
		case "VERIFICATION_PROOF_NOT_FOUND":
			return "No verification proof matches that identity.";
		case "VERIFICATION_PROOF_MISSING_IDENTITY":
			return "The proof input is missing required snapshot or rehearsal identity.";
		case "VERIFICATION_PROOF_MISSING_TIMESTAMP":
			return "The proof input is missing an explicit verification timestamp.";
		case "VERIFICATION_PROOF_EVIDENCE_UPGRADE":
			return "The evidence would have upgraded a proof state, so the proof was refused.";
		case "VERIFICATION_PROOF_INCONSISTENT_EVIDENCE":
			return "The supplied evidence contradicts itself, so no proof was produced.";
		case "AUTH_REQUIRED":
		case "INVALID_TOKEN":
			return "Your session expired. Sign in again to work with verification proofs.";
		default:
			return error?.message || "Tracer could not complete the verification proof request.";
	}
}

// A deterministic filename is produced by the backend. If it is ever missing we
// fall back to a safe literal rather than fabricating an identity.
export function safeFilename(filename, fallback = "verification-proof.json") {
	const value = String(filename ?? "").trim();
	if (!value) return fallback;
	// Strip any path separators or traversal so a filename can never escape.
	const cleaned = value.replace(/[\\/]/g, "").replace(/\.\./g, "").slice(0, 128);
	return cleaned || fallback;
}

// Parse an artifact's embedded proof without trusting it. This is only used to
// decide whether the dialog has *something* to send to the backend; it never
// validates, upgrades, or repairs the artifact. The backend is the sole authority
// and will answer INVALID/STALE/MISMATCH/UNKNOWN for anything it refuses.
export function proofFromArtifactText(text) {
	if (typeof text !== "string" || !text.trim()) return null;
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && parsed.proof && typeof parsed.proof === "object") return parsed.proof;
		if (parsed && typeof parsed === "object" && parsed.kind === "tracer.verification-proof") return parsed;
		return null;
	} catch {
		return null;
	}
}

// Does this text look like a proof artifact or envelope at all? Used only to
// enable the Verify button and to show a malformed-input warning early; the
// backend still re-decides everything.
export function looksLikeProofArtifact(text) {
	return proofFromArtifactText(text) !== null;
}
