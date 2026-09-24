// Phase 49B — Effective Configuration / "Why?" Inspector: shared vocabulary.
//
// This module is the single source of truth for the read-model's envelope shape,
// bounds, reason codes, link vocabulary, and the verification vocabulary. Nothing
// here executes, verifies, or infers.
//
// Phase 49B changes exactly one thing about the read-model's authority: the
// inspector no longer *decides* a verification state. Phase 41
// (`cross-env-verification`) is the only authority for
// VERIFIED / BLOCKED / NEEDS_REHEARSAL / UNKNOWN, and this read-model may only
// restate a Phase 41 result that is *linked* to the execution by a proven
// identity. Everything else is `UNKNOWN` with an explicit reason, or an
// explicitly non-authoritative observation.
//
// The envelope version is bumped to 2 because the verification basis vocabulary
// lost its two self-derived members (`target_policy`, `recorded_assertions`) and
// the change/evidence sections gained the Phase 39/40/43/46/47 chains. A caller
// that understands version 1 would silently mislabel a version 2 envelope, so the
// two shapes must never be confused.

export const WHY_EXPLANATION_KIND = "tracer.why-explanation";
export const WHY_EXPLANATION_SCHEMA_VERSION = 2;

export const WHY_QUESTION =
	"WHY did this request execute this way, and WHY did Tracer reach this verification result?";

// Canonical section order. The UI renders exactly this order and never derives it.
export const WHY_SECTIONS = Object.freeze([
	"configuration",
	"dependencies",
	"execution",
	"change",
	"verification",
	"evidence",
]);

// The full evidence chain this read-model can project, in causal order. Each node
// names the phase that owns the truth and the section that presents it. The
// inspector own no node: it either links a recorded artifact to the execution or
// reports the node as not recorded.
export const WHY_CHAIN = Object.freeze([
	{ id: "configuration", label: "Configuration", owner: "request compiler", section: "configuration" },
	{ id: "execution", label: "Execution", owner: "execution pipeline", section: "execution" },
	{ id: "impact", label: "Impact", owner: "Phase 39", section: "change" },
	{ id: "drift", label: "Drift", owner: "Phase 40", section: "change" },
	{ id: "rehearsal", label: "Rehearsal", owner: "Phase 46", section: "evidence" },
	{ id: "contract", label: "Contract", owner: "Phase 43", section: "evidence" },
	{ id: "verification", label: "Verification", owner: "Phase 41", section: "verification" },
	{ id: "proof", label: "Proof", owner: "Phase 47", section: "evidence" },
]);

// Availability states a section can report. `recorded` means the projection found
// real evidence; `partial` means some evidence is present and some is missing;
// `not_recorded` means the section fails closed with an explicit reason.
export const SECTION_STATES = Object.freeze(["recorded", "partial", "not_recorded"]);

// The status of a single linked evidence item. `recorded` means the artifact was
// found AND its identity was proven against this execution; a weaker status is
// always accompanied by the exact reason it degraded. The vocabulary is closed so
// a client can branch on it without parsing prose.
export const LINK_STATUS = Object.freeze({
	RECORDED: "recorded",
	PARTIAL: "partial",
	NOT_RECORDED: "not_recorded",
	UNKNOWN: "unknown",
	IDENTITY_MISMATCH: "identity_mismatch",
	STALE: "stale",
	INVALID: "invalid",
});

export const LINK_STATUS_VALUES = Object.freeze(Object.values(LINK_STATUS));

// Which authoritative artifact a link was resolved from. Every value names a phase
// that owns the truth; the inspector is never the source.
export const LINK_SOURCE = Object.freeze({
	PHASE47_PROOF: "phase47_proof",
	PHASE46B_RUN: "phase46b_run",
	PHASE41_VERIFICATION: "phase41_verification",
	PHASE39_IMPACT: "phase39_impact",
	PHASE40_DRIFT: "phase40_drift",
	PHASE43_CONTRACT: "phase43_contract",
});

// Bounds. Every list the projection emits is capped so a large execution cannot
// produce an unbounded response. Truncation is always reported, never silent.
export const WHY_LIMITS = Object.freeze({
	maxConfigurationEntries: 40,
	maxVariables: 100,
	maxReferences: 20,
	maxStages: 12,
	maxEvidence: 40,
	maxChangeComparisons: 10,
	maxChangeItems: 40,
	maxVerifiedCauses: 20,
	maxReasons: 12,
	maxTextBytes: 1024,
	// Phase 49B — linkage bounds.
	maxLinkedRuns: 3,
	maxRunSteps: 12,
	maxDriftBlocking: 40,
	maxRequestIds: 40,
	maxProofFindings: 20,
	maxProofSources: 16,
	maxProofBytes: 2 * 1024 * 1024 + 256 * 1024,
});

// Verification states — borrowed verbatim from Phase 41 `cross-env-verification`.
export const VERIFICATION_STATES = Object.freeze([
	"VERIFIED",
	"BLOCKED",
	"NEEDS_REHEARSAL",
	"UNKNOWN",
]);

// Where a verification state came from. Phase 49B removed `target_policy` and
// `recorded_assertions` from this list on purpose: neither is a Phase 41 result,
// so neither may set the authoritative state. They survive as explicitly
// non-authoritative observations in `verification.observations`.
export const VERIFICATION_STATE_BASIS = Object.freeze(["linked_verification", "none"]);

export const VERIFICATION_BASIS_LABEL = Object.freeze({
	linked_verification: "Linked Phase 41 result",
	none: "No linked Phase 41 result",
});

// Variable scope precedence, lowest to highest — the exact order the request
// compiler applies. The projection labels scopes but never re-orders them.
export const VARIABLE_SCOPE_ORDER = Object.freeze([
	"initial",
	"collection",
	"collection-secret",
	"environment",
	"environment-secret",
	"script",
]);

export const VARIABLE_SCOPE_LABEL = Object.freeze({
	initial: "Initial / run input",
	collection: "Collection variable",
	"collection-secret": "Collection secret reference",
	environment: "Environment variable",
	"environment-secret": "Environment secret reference",
	script: "Script variable",
});

// Canonical execution stages in pipeline order.
export const EXECUTION_STAGES = Object.freeze([
	{ id: "compile", label: "Compile" },
	{ id: "policy", label: "Target policy" },
	{ id: "dns", label: "DNS resolution" },
	{ id: "transport", label: "Transport" },
	{ id: "capture", label: "Response capture" },
	{ id: "normalize", label: "Normalize" },
	{ id: "history", label: "History record" },
]);

// Reason codes. Stable strings so a client can branch on them without parsing
// prose. Every fail-closed branch has one.
export const WHY_REASON = Object.freeze({
	EXECUTION_NOT_RECORDED: "EXECUTION_NOT_RECORDED",
	CONFIGURATION_NOT_RECORDED: "CONFIGURATION_NOT_RECORDED",
	NO_VARIABLE_REFERENCES: "NO_VARIABLE_REFERENCES",
	NO_SOURCE_REFERENCE: "NO_SOURCE_REFERENCE",
	SOURCE_REVISION_CHANGED: "SOURCE_REVISION_CHANGED",
	NO_CHANGE_EVIDENCE: "NO_CHANGE_EVIDENCE",
	CHANGE_EVIDENCE_RECORDED: "CHANGE_EVIDENCE_RECORDED",
	RESPONSE_NOT_RECORDED: "RESPONSE_NOT_RECORDED",
	// Phase 49B — linkage reasons.
	LINKED_PHASE41_STATE: "LINKED_PHASE41_STATE",
	VERIFICATION_NOT_RECORDED: "VERIFICATION_NOT_RECORDED",
	IMPACT_NOT_RECORDED: "IMPACT_NOT_RECORDED",
	DRIFT_NOT_RECORDED: "DRIFT_NOT_RECORDED",
	REHEARSAL_NOT_RECORDED: "REHEARSAL_NOT_RECORDED",
	REHEARSAL_STEP_NOT_EXECUTED: "REHEARSAL_STEP_NOT_EXECUTED",
	CONTRACT_NOT_RECORDED: "CONTRACT_NOT_RECORDED",
	PROOF_NOT_RECORDED: "PROOF_NOT_RECORDED",
	PROOF_RECORDED: "PROOF_RECORDED",
	PROOF_INVALID: "PROOF_INVALID",
	PROOF_STALE: "PROOF_STALE",
	PROOF_IDENTITY_MISMATCH: "PROOF_IDENTITY_MISMATCH",
	PROOF_UNLINKED: "PROOF_UNLINKED",
	IDENTITY_UNPROVEN: "IDENTITY_UNPROVEN",
	OBSERVATION_ONLY: "OBSERVATION_ONLY",
});

// The read-model's standing caveat. It is deliberately blunt: the state is a
// *copy*, so a reader never mistakes it for a fresh judgement.
export const WHY_CAVEAT =
	"Phase 41 is the only authority for a verification state. When a Phase 41 result is linked to this execution its state is restated here verbatim; when it is not, the state is UNKNOWN. Recorded assertions and the target-policy decision are shown as observations and never change the state.";
