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

// The locked product identity. One sentence, no overselling.
export const PRODUCT_TAGLINE = "API execution, investigation, and change-verification workspace";

export const PRODUCT_ONE_LINER =
	"Tracer helps you execute APIs, investigate failures, understand what configuration changes affect, and verify an affected workflow against another environment before treating a snapshot as known-good.";

// The four-part mental model. Each part maps to real, shipped surfaces so the
// UI never promises a capability that does not exist.
export const PRODUCT_MODEL = Object.freeze([
	{
		id: "execute",
		label: "Execute",
		summary: "Compose, send, and read APIs.",
		detail: "Build requests and collections, attach auth, switch environments, send through the server, and inspect responses.",
		surfaces: ["Workspace", "Collections", "Environments", "History"],
	},
	{
		id: "understand",
		label: "Understand",
		summary: "Investigate why a request stopped working.",
		detail: "Every send records an execution passport. Compare two runs, find the first meaningful divergence, and narrow to the smallest reproducer.",
		surfaces: ["History", "Flight Recorder", "Investigation"],
	},
	{
		id: "compare",
		label: "Compare",
		summary: "See what a change affects.",
		detail: "Freeze a workspace snapshot, then read what a configuration change can reach, how environments drifted apart, and whether response contracts still line up.",
		surfaces: ["Snapshots", "Change impact", "Environment drift", "Contracts"],
	},
	{
		id: "verify",
		label: "Verify",
		summary: "Generate evidence before you trust a snapshot.",
		detail: "Rehearse the affected workflow against another environment, run the contract check, and produce a tamper-evident Verification Proof — or an honest non-pass.",
		surfaces: ["Rehearsal", "Compatibility", "Verification Proof"],
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
	{ id: "proof", label: "Proof", hint: "Export a tamper-evident, secret-free Verification Proof." },
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
		short: "A tamper-evident, secret-free record of what was verified.",
		long: "A proof commits the snapshot identity, environment identity, rehearsal run, counts, contracts, and drift, then signs the content. It contains no request or response bodies.",
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
	flow: "Snapshot → Impact → Drift → Rehearse → Verify → Proof",
	body: "After a change, compare the snapshot against the target environment, rehearse the affected workflow, and produce a Verification Proof that states exactly what was and was not verified.",
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
		body: "Only publicly routable HTTP and HTTPS addresses are permitted. Private, loopback, link-local, multicast, reserved, and NAT64/6to4 addresses are refused before dispatch, and the resolved IP is pinned to close DNS-rebinding gaps.",
	},
	{
		id: "bounded",
		title: "Bounded request and response handling",
		body: "Executions run inside a time budget, capture size limits, redirect policy, and a cancellation path. An overflow is reported as a size-limit outcome rather than truncated silently.",
	},
	{
		id: "secrets",
		title: "Secret-reference handling",
		body: "Secret variables store only an alias. The value resolves on the server at send time, is never returned to the browser, and is redacted from stored bodies and history.",
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
		body: "A Verification Proof references evidence by identity. It contains no request or response bodies, no credentials, and no resolved secret environment values.",
	},
	{
		id: "hmac",
		title: "Integrity for proofs",
		body: "Proof content is canonicalized and signed with a server-held key. A modified artifact fails its integrity check and is reported as invalid.",
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
	{ id: "proofs", label: "Verification Proof artifacts", body: "A signed record of counts, contracts, drift, and evidence references. It carries no bodies and no secret values." },
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
