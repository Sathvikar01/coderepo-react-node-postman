// Phase 48A — Product identity and production UX content model.
//
// This module is pure, framework-free text and structure. It exists so the
// product wording is testable without a DOM and so the React surfaces contain no
// identity reasoning of their own.
//
// Truthfulness rules for everything in this file:
//
//   * It describes only capabilities the repository actually implements. There
//     is no marketing claim, certification, or compliance statement here.
//   * It never asserts that a proof is current. Verification state is always the
//     backend's answer (VERIFIED / BLOCKED / NEEDS_REHEARSAL / UNKNOWN, plus the
//     report status VALID / STALE / MISMATCH / INVALID / UNKNOWN), never text.
//   * "Verify" means producing and checking evidence about a snapshot against a
//     target environment. It does not mean a request succeeded.

// The product identity. Lead with the concrete job Tracer does rather than
// internal feature categories: a developer changes API workspace state, Tracer
// narrows the blast radius, rehearses the affected workflow, verifies the
// evidence, and carries that evidence into human review.
export const PRODUCT_TAGLINE = "API change-safety workspace";

export const PRODUCT_ONE_LINER =
	"Change an API, see what it can affect, rehearse the affected workflow against a target environment, verify the result, and carry the exact evidence into review.";

export const CORE_STORY_FLOW = "Change → Impact → Rehearse → Verify → Review";

// The primary product story maps to shipped surfaces. Investigation and
// collaboration remain important supporting capabilities, but they no longer
// compete with the first-pass explanation of what Tracer is for.
export const PRODUCT_MODEL = Object.freeze([
	{
		id: "change",
		label: "Change",
		summary: "Edit the API workspace you already use.",
		detail: "Change a request, variable, authentication setting, environment, or saved collection while version history preserves the shared state around that edit.",
		surfaces: ["Workspace", "Collections", "Environments", "Versions"],
	},
	{
		id: "impact",
		label: "Impact",
		summary: "See which requests the change can reach.",
		detail: "Trace the changed item through saved references and dependencies so the workflow that needs attention is explicit instead of guessed or manually rediscovered.",
		surfaces: ["Change impact", "Environment drift", "Contracts"],
	},
	{
		id: "rehearse",
		label: "Rehearse",
		summary: "Replay the affected workflow before you trust it.",
		detail: "Run the affected requests against the target environment through the same backend execution path as a normal send, with bounded policy and recorded evidence.",
		surfaces: ["Rehearsal", "Runner", "History"],
	},
	{
		id: "verify",
		label: "Verify",
		summary: "Turn the recorded evidence into an explicit state.",
		detail: "Combine rehearsal, drift, and contract evidence into VERIFIED, BLOCKED, NEEDS_REHEARSAL, or UNKNOWN, then bind that result into a tamper-evident Verification Proof.",
		surfaces: ["Compatibility", "Phase 41 verification", "Verification Proof", "Why?"],
	},
	{
		id: "review",
		label: "Review",
		summary: "Make the human decision beside the machine result.",
		detail: "Promote the exact validated proof into Reviews so assignment, discussion, approval, changes requested, or waiver stay separate from the technical verification state.",
		surfaces: ["Reviews", "Needs Attention", "Verification Proof"],
	},
]);

// The signature change-verification workflow. These are real steps in the
// shipped product, not a wizard; users can enter at any point.
export const VERIFICATION_WORKFLOW = Object.freeze([
	{ id: "edit", label: "Edit", hint: "Change a request, variable, auth, or environment." },
	{ id: "snapshot", label: "Snapshot", hint: "Freeze the workspace state you intend to treat as known-good." },
	{ id: "impact", label: "Impact", hint: "See which requests and references the change can reach." },
	{ id: "drift", label: "Drift", hint: "Compare the snapshot's environment against the target environment." },
	{ id: "rehearse", label: "Rehearse", hint: "Run the affected workflow through the normal execution pipeline." },
	{ id: "contract", label: "Contract Check", hint: "Check that response contracts are still compatible." },
	{ id: "verify", label: "Verify", hint: "Combine the evidence into a verification state." },
	{ id: "proof", label: "Proof", hint: "Export a tamper-evident Verification Proof with bounded, credential-minimized evidence." },
]);

// The investigation workflow, used by the Understand surfaces.
export const INVESTIGATION_WORKFLOW = Object.freeze([
	{ id: "failure", label: "Failure", hint: "A request that used to pass now fails." },
	{ id: "investigate", label: "Investigate", hint: "Tracer resolves a trustworthy last-pass / first-fail boundary." },
	{ id: "compare", label: "Compare", hint: "Read ordered evidence and the first meaningful divergence." },
	{ id: "isolate", label: "Isolate", hint: "Bounded probes reduce the failure to its smallest reproducer." },
	{ id: "reproduce", label: "Reproduce", hint: "Import a redacted capsule as an unsent, unsaved draft." },
]);

// Concise contextual explanations. One or two lines each — these are the
// tooltips, helper text, and empty-state sentences used across the UI.
export const CONCEPTS = Object.freeze({
	snapshot: {
		label: "Workspace Snapshot",
		short: "A frozen, fingerprinted record of requests, variables, auth, and environment state.",
		long: "A snapshot names the exact workspace state a proof is about. If anything it captured changes, any proof built from it is STALE rather than current.",
	},
	impact: {
		label: "Impact Analysis",
		short: "Which requests and references a change can reach.",
		long: "Impact analysis walks the dependency graph from a changed item to the requests it can affect. It reports reachability, not a claim that a request is broken.",
	},
	drift: {
		label: "Environment Drift",
		short: "Where the snapshot's environment and the target environment differ.",
		long: "Drift compares two environments path by path. Blocking findings prevent a clean verification instead of being averaged away.",
	},
	rehearsal: {
		label: "Rehearsal",
		short: "Running an affected workflow through the normal execution pipeline.",
		long: "A rehearsal executes the affected requests against another environment with the same compiler, policy, DNS, transport, capture, and history path as any other send. It changes nothing in your collections.",
	},
	contract: {
		label: "Contract Compatibility",
		short: "Whether a response contract still lines up after a change.",
		long: "Compatibility checks compare a response contract for removed fields, changed types, unexpected statuses, and missing required headers. Unknown is reported as unknown, never as compatible.",
	},
	proof: {
		label: "Verification Proof",
		short: "A tamper-evident record of what was verified.",
		long: "A proof commits the snapshot identity, environment identity, rehearsal run, counts, contracts, and drift, then authenticates the canonical content with an HMAC-SHA256 fingerprint under Tracer\'s server-held fingerprint key. It contains no raw request or response bodies, credentials, cookies, or resolved secret environment values. This is keyed integrity verification, not an asymmetric digital signature.",
	},
	verified: {
		label: "Verified",
		short: "The backend concluded the snapshot state passed verification.",
		long: "Tracer shows Verified only when the verification backend reaches that state. The UI never upgrades a state on its own.",
	},
	stale: {
		label: "STALE",
		short: "The proof was valid when written but no longer matches the current snapshot or environment.",
		long: "STALE is not a pass and not a failure of integrity. The artifact is intact, but the world it describes has moved on, so it must be re-verified.",
	},
	blastRadius: {
		label: "Blast-radius safety",
		short: "Budgets and rules that bound what a rehearsal or probe is allowed to do.",
		long: "Blast-radius controls decide whether a run is admitted, cap its probes and iterations, and restrict automatic mutating probes to approved local or mock targets. They reduce risk; they do not make side effects impossible.",
	},
});

// Getting-started content. Deliberately short: the working UI is not a manual.
export const QUICK_START = Object.freeze([
	{ id: "request", title: "Create or open a request", body: "Start a scratch request, open one from a collection, or import a cURL command." },
	{ id: "environment", title: "Configure an environment", body: "Pick an environment in the header so {{variables}} and secret references resolve." },
	{ id: "send", title: "Send and inspect", body: "Send with Ctrl/Cmd+Enter. Read status, timing, headers, and body in the response pane." },
	{ id: "save", title: "Save into a collection", body: "Save with Ctrl/Cmd+S. Every send is also recorded in History with a redacted passport." },
]);

export const INVESTIGATE_INTRO = {
	title: "Investigate a failure",
	flow: "Failure → Investigate → Compare → Isolate → Reproduce",
	body: "Open History, choose Passport on a failing run, and use Compare to place it against the last passing run. Minimize narrows it; Export Capsule carries a redacted reproducer.",
};

export const VERIFY_INTRO = {
	title: "Verify a change",
	flow: CORE_STORY_FLOW,
	body: "After an API change, identify the affected requests, rehearse that workflow against the target environment, verify the recorded drift and contract evidence, and carry the resulting Verification Proof into review.",
};

// Security & Safety. Every line is a mechanism the repository implements.
export const SECURITY_FACTS = Object.freeze([
	{
		id: "server-side",
		title: "Backend-controlled execution",
		body: "The browser never opens a socket to your target. Every send runs in the Express API, so target policy, secret handling, and evidence capture happen in one place.",
	},
	{
		id: "ssrf",
		title: "Target and address validation",
		body: "By default, Tracer permits publicly routable HTTP and HTTPS targets. Private, loopback, link-local, multicast, reserved, and NAT64/6to4 addresses are refused before dispatch unless an explicit seeded-demo or Local Runtime approval applies; the approved resolved IP is pinned for the transport connection.",
	},
	{
		id: "bounded",
		title: "Bounded request and response handling",
		body: "Executions run inside a time budget, capture size limits, redirect policy, and a cancellation path. An overflow is reported as a size-limit outcome rather than truncated silently.",
	},
	{
		id: "secrets",
		title: "Secret-reference handling",
		body: "Secret variables store only an alias. Resolved secret values are handled server-side at send time and are excluded or redacted from the defined stored evidence surfaces that carry request/auth material, including execution history and exported proof/reproduction artifacts.",
	},
	{
		id: "isolation",
		title: "Authentication and profile isolation",
		body: "Workspace sign-in is separate from the credentials attached to a target request. Collections, environments, history, cookies, examples, and proofs are scoped to one profile.",
	},
	{
		id: "blast",
		title: "Blast-radius controls",
		body: "Rehearsals and probes are admitted through explicit rules and budgets. Automatic mutating probes run only against approved local or mock targets.",
	},
	{
		id: "proofs",
		title: "No secret values in proofs",
		body: "A Verification Proof references evidence by identity and structurally excludes raw request/response bodies, credentials, cookies, and resolved secret environment values.",
	},
	{
		id: "hmac",
		title: "Integrity for proofs",
		body: "Proof content is canonicalized and authenticated with an HMAC-SHA256 fingerprint under a server-held key. A modified artifact fails its integrity check and is reported as invalid; this is not an asymmetric third-party-verifiable signature.",
	},
	{
		id: "failclosed",
		title: "Fail-closed verification",
		body: "Evidence that would upgrade a state, contradict itself, or exceed a bound is refused rather than trimmed. Missing currency information yields UNKNOWN, not a pass.",
	},
]);

export const SECURITY_NOTE =
	"This page describes behavior implemented in this repository. It is not a certification, an audit result, or a compliance statement, and nothing here should be read as one.";

// Data Handling. Describes stored categories and minimization rules.
export const DATA_CATEGORIES = Object.freeze([
	{ id: "requests", label: "Requests and collections", body: "Saved requests, folders, and collection-level variables and auth. Secret references store an alias, not a value." },
	{ id: "environments", label: "Environments", body: "Named environments with plain variables and secret references, stored per profile." },
	{ id: "history", label: "Execution history", body: "One immutable record per accepted send: outcome, timings, a redacted passport, and a trimmed response snapshot." },
	{ id: "snapshots", label: "Workspace snapshots", body: "A fingerprinted record of the workspace state a verification is about. It stores identity and references, not response bodies." },
	{ id: "investigation", label: "Investigation evidence", body: "Execution passports, comparison results, minimization jobs, and redacted reproduction capsules." },
	{ id: "rehearsal", label: "Rehearsal checkpoints", body: "Rehearsal plan and run identity with per-step outcome references so a run is resumable and auditable." },
	{ id: "proofs", label: "Verification Proof artifacts", body: "A keyed, tamper-evident record of counts, contracts, drift, and evidence references. It structurally excludes raw bodies, credentials, cookies, and resolved secret environment values." },
]);

export const DATA_MINIMIZATION = Object.freeze([
	"Verification proofs contain no raw request or response bodies.",
	"Secret references are stored as aliases and resolved only on the server at send time.",
	"Imported proof artifacts are inspection-only: they are never executed, sent, or saved.",
	"Reproduction capsules replace credential values with placeholders before export.",
	"Response bodies in history are trimmed and marked when larger than the stored limit.",
]);

export const DATA_NOTE =
	"Tracer keeps this data in the local MongoDB database used for this workspace. No retention period, residency guarantee, or privacy certification is claimed here beyond what the application actually does.";

// Responsible Use. Plain statements, no fictional legal entity.
export const USAGE_TERMS = Object.freeze([
	{
		id: "authorized",
		title: "Send only to systems you are authorized to access",
		body: "Tracer executes real HTTP requests. Only point it at hosts you have permission to test.",
	},
	{
		id: "side-effects",
		title: "Mutating requests can cause side effects",
		body: "A POST, PUT, PATCH, or DELETE can change data on the target. Cancelling stops the local operation; it cannot undo effects that already reached the target.",
	},
	{
		id: "safety",
		title: "Safety controls reduce risk; they do not remove it",
		body: "Blast-radius rules, probe budgets, and local-target approvals limit what a rehearsal or probe may do. They do not make side effects impossible.",
	},
	{
		id: "validate",
		title: "You validate the target environment",
		body: "Rehearsing against a staging environment is only as safe as that environment. Confirm what you are pointing at before you run.",
	},
	{
		id: "artifacts",
		title: "Treat imported artifacts as untrusted",
		body: "An imported verification proof is inspected, never executed. Check its integrity result before you rely on anything it claims.",
	},
]);

export const USAGE_NOTE =
	"These are practical usage terms for this assessment product. They are not attorney-reviewed terms of service, and no corporate entity is claimed.";

// A compact, ordered index used by the Help surface to link workflows.
export const PRODUCT_SURFACES = Object.freeze([
	{ id: "help", label: "Getting Started", icon: "description" },
	{ id: "about", label: "About Tracer", icon: "info" },
	{ id: "security", label: "Security & Safety", icon: "error_outline" },
	{ id: "data", label: "Data Handling", icon: "folder" },
	{ id: "usage", label: "Responsible Use", icon: "edit" },
]);

// The surface a user lands on when they open the Help menu. "help" is the
// Getting Started surface; "about" is the product identity surface.
export const DEFAULT_PRODUCT_SURFACE = "help";

// All valid surface ids. Used by the menu and the view to stay in sync, and by
// tests to prove every entry in PRODUCT_SURFACES resolves to a real surface.
export const PRODUCT_SURFACE_IDS = Object.freeze(PRODUCT_SURFACES.map((surface) => surface.id));

// Contextual helper accessor. Unknown concepts return null so callers can render
// nothing instead of an empty tooltip.
export function concept(key) {
	return CONCEPTS[key] ?? null;
}

// The step the user is on, given a workflow and a step id. Returns -1 when the
// id is unknown, so a caller never renders a false "step 1 of 8".
export function workflowStepIndex(workflow, stepId) {
	return workflow.findIndex((step) => step.id === stepId);
}

// A truthful label for a verification report status. Reused by the persistence
// and UX tests to prove no status is ever dressed up as success.
export function reportStatusPhrase(status) {
	switch (status) {
		case "VALID":
			return "Valid";
		case "STALE":
			return "Stale";
		case "MISMATCH":
			return "Mismatch";
		case "INVALID":
			return "Invalid";
		case "UNKNOWN":
			return "Unknown";
		default:
			return "Unknown";
	}
}
