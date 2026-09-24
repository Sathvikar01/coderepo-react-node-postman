// Phase 49 — Effective Configuration / "Why?" Inspector: shared vocabulary.
//
// This module is the single source of truth for the read-model's envelope shape,
// bounds, reason codes, and the verification vocabulary. Nothing here executes,
// verifies, or infers: the inspector is a *projection* over evidence that already
// exists (the execution receipt, the compile trace, the persisted history record,
// and persisted investigations). It answers two questions:
//
//   WHY did this request execute this way?
//   WHY did Tracer reach this verification result?
//
// The verification vocabulary is borrowed verbatim from Phase 41
// (`cross-env-verification`) so the app never invents a second ladder.

export const WHY_EXPLANATION_KIND = "tracer.why-explanation";
export const WHY_EXPLANATION_SCHEMA_VERSION = 1;

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

// Availability states a section can report. `recorded` means the projection found
// real evidence; `partial` means some evidence is present and some is missing;
// `not_recorded` means the section fails closed with an explicit reason.
export const SECTION_STATES = Object.freeze(["recorded", "partial", "not_recorded"]);

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
});

// Verification states — borrowed verbatim from Phase 41 `cross-env-verification`.
export const VERIFICATION_STATES = Object.freeze([
	"VERIFIED",
	"BLOCKED",
	"NEEDS_REHEARSAL",
	"UNKNOWN",
]);

// Where a verification state came from. Exposed so a caller can always see that a
// state is a restatement of recorded facts rather than a cross-environment proof.
export const VERIFICATION_STATE_BASIS = Object.freeze([
	"linked_verification",
	"target_policy",
	"recorded_assertions",
	"none",
]);

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
	TARGET_POLICY_BLOCKED: "TARGET_POLICY_BLOCKED",
	RECORDED_ASSERTIONS_PASSED: "RECORDED_ASSERTIONS_PASSED",
	RECORDED_ASSERTIONS_FAILED: "RECORDED_ASSERTIONS_FAILED",
	NO_VERIFICATION_EVIDENCE: "NO_VERIFICATION_EVIDENCE",
	LINKED_VERIFICATION_STATE: "LINKED_VERIFICATION_STATE",
	RESPONSE_NOT_RECORDED: "RESPONSE_NOT_RECORDED",
});

export const WHY_CAVEAT =
	"The verification state restates evidence recorded for this single execution. It is not a cross-environment verification proof.";
