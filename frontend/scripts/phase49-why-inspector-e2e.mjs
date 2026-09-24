// Phase 49B — "Why?" Inspector evidence-chain browser verification.
//
// Drives the real Tracer app through the Chrome DevTools Protocol against a
// local, seeded instance and proves the properties Phase 49B exists to
// guarantee:
//
//   * A real execution exposes a "Why?" action on its history row.
//   * The dialog consumes the v2 envelope only (`tracer.why-explanation`
//     schemaVersion 2); anything else fails closed.
//   * With no linked proof the dialog reports the v2 not_recorded / UNKNOWN
//     chain exactly as returned: Impact, Drift, Rehearsal, Contract,
//     Verification, and Proof are all present and explicit.
//   * Attaching a real, backend-minted Phase 47 proof artifact links the
//     chain for that read only: Impact, Drift, Contract, the Phase 41 state,
//     and the Proof state become visible with recorded evidence.
//   * A stale proof stays STALE (warning tone, never success green); a
//     tampered proof is INVALID; a wrong-environment proof is an explicit
//     identity mismatch; a malformed artifact is refused with an alert.
//   * The read-model never resolves a secret: a `{{orders_token}}` reference
//     is reported as a reference while no credential value appears anywhere.
//   * The dialog is read-only: nothing sends, saves, persists a proof, or
//     mutates.
//   * Keyboard-only usage works, and the layout holds at 375 / 768 / 1024 /
//     1440 in both themes with zero console errors and zero overflow.
//
// Proofs are HMAC-signed with EXECUTION_FINGERPRINT_KEY from backend/.env,
// which setup.sh generates randomly per checkout/CI. No committed artifact can
// verify everywhere, so the script mints real proofs live against the backend
// under test (fixture input -> build -> export through the real Phase 47B
// endpoints), then attaches them through the real dialog textarea. The
// STALE case additionally seeds one rehearsal checkpoint through the real
// Phase 46B service so a recorded run identity exists to disagree with.
//
// It talks only to a local, seeded instance and never contacts the network.

import { readFileSync } from "node:fs";

const CDP = process.env.TRACER_CDP_URL || "http://127.0.0.1:9222";
const APP = process.env.TRACER_APP_URL || "http://127.0.0.1:3000";
const API = process.env.TRACER_API_URL || "http://127.0.0.1:8000";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- backend access for proof minting and run seeding --------------------
// Same pattern as the Phase 47C E2E: read the live backend env, init config,
// and reuse the backend's own fixture builders so every minted proof is a real
// Phase 47A envelope, never hand-rolled.
const repoRootUrl = process.env.TRACER_REPO_ROOT
	? new URL("file://" + process.env.TRACER_REPO_ROOT + "/")
	: new URL("../../", import.meta.url);
const backendEnvUrl = process.env.TRACER_BACKEND_ENV
	? new URL("file://" + process.env.TRACER_BACKEND_ENV)
	: new URL("backend/.env", repoRootUrl);
const backendEnvText = readFileSync(backendEnvUrl, "utf8");
function readBackendEnv(key) {
	const line = backendEnvText.split("\n").find((l) => l.startsWith(key + "="));
	if (!line) throw new Error("backend/.env has no " + key + "; run setup.sh --seed first");
	return line.slice(key.length + 1).trim();
}

process.env.MONGODB_URI ??= readBackendEnv("MONGODB_URI");
process.env.EXECUTION_FINGERPRINT_KEY ??= readBackendEnv("EXECUTION_FINGERPRINT_KEY");
process.env.JWT_SECRET ??= readBackendEnv("JWT_SECRET");
const { initConfig } = await import(new URL("backend/src/shared/config/index.js", repoRootUrl).href);
initConfig();
const { proofInput, impactResult, contractResult, verificationFixture, executionEvidence, assertionEvidence } = await import(
	new URL("backend/src/features/verification-proof/proof-fixtures.js", repoRootUrl).href
);
const { identityFingerprint } = await import(new URL("backend/src/features/rehearsal-checkpoints/index.js", repoRootUrl).href);

async function retry(fn, label, timeout = 20000) {
	const end = Date.now() + timeout;
	let last = null;
	while (Date.now() < end) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (error) {
			last = error;
		}
		await sleep(120);
	}
	throw new Error(label + " timed out" + (last ? ": " + last.message : ""));
}

await retry(async () => (await fetch(CDP + "/json/version")).ok, "Chrome CDP");
const targetResponse = await fetch(CDP + "/json/new?" + encodeURIComponent(APP), { method: "PUT" });
if (!targetResponse.ok) throw new Error("Could not create Chrome target: " + targetResponse.status);
const target = await targetResponse.json();

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve, { once: true });
	socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const runtimeErrors = [];
socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id) {
		const waiter = pending.get(message.id);
		if (!waiter) return;
		pending.delete(message.id);
		if (message.error) waiter.reject(new Error(message.error.message));
		else waiter.resolve(message.result);
		return;
	}
	if (message.method === "Runtime.exceptionThrown") {
		runtimeErrors.push(message.params?.exceptionDetails?.text || "Unhandled browser exception");
	}
});

function call(method, params = {}) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		socket.send(JSON.stringify({ id, method, params }));
	});
}

async function evaluate(expression) {
	const result = await call("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
		userGesture: true,
	});
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
	}
	return result.result?.value;
}

async function waitFor(expression, label, timeout = 20000) {
	return retry(() => evaluate(expression), label, timeout);
}

async function click(selector, label = selector) {
	const expression =
		"(() => { const node = document.querySelector(" +
		JSON.stringify(selector) +
		"); if (!node || node.disabled || node.getClientRects().length === 0) return false; node.click(); return true; })()";
	if (!(await evaluate(expression))) throw new Error("Could not click " + label);
}

async function clickText(selector, text, label) {
	const expression =
		"(() => { const target = " +
		JSON.stringify(text) +
		"; const node = [...document.querySelectorAll(" +
		JSON.stringify(selector) +
		")].find((n) => !n.disabled && n.getClientRects().length > 0 && n.textContent.trim().includes(target)); if (!node) return false; node.click(); return true; })()";
	if (!(await evaluate(expression))) throw new Error("Could not click " + (label || text));
}

async function setInput(selector, value) {
	const expression =
		"(() => { const node = document.querySelector(" +
		JSON.stringify(selector) +
		"); if (!node) return false; const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (!setter) return false; setter.call(node, " +
		JSON.stringify(value) +
		"); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()";
	if (!(await evaluate(expression))) throw new Error("Could not set " + selector);
}

async function pressKey(key, code, virtualKeyCode) {
	await call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKeyCode });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKeyCode });
	await sleep(120);
}

const pressEscape = () => pressKey("Escape", "Escape", 27);

async function viewport(width, height = 900) {
	await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
	await sleep(150);
}

// Runs a request through the app's own authenticated API client (the page's
// origin and profile token), so the script never handles a credential itself.
async function api(method, path, body) {
	const payload = await evaluate(
		"(async () => { const token = localStorage.getItem('request-desk-profile-token') || localStorage.getItem('request-desk-session-token'); const response = await fetch('/api/v1" +
			path +
			"', { method: " +
			JSON.stringify(method) +
			", headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }" +
			(body === undefined ? "" : ", body: " + JSON.stringify(JSON.stringify(body))) +
			" }); return { status: response.status, body: await response.json() }; })()",
	);
	return payload;
}

const checks = [];
function pass(name) {
	checks.push(name);
	process.stdout.write("PASS " + name + "\n");
}

async function ensureCollectionsPanel() {
	const visible = await evaluate("(() => [...document.querySelectorAll('.tree-label')].some((label) => label.getClientRects().length > 0))()");
	if (!visible) await click('[aria-label="Open collections"]', "Collections rail");
	await retry(
		() => evaluate("document.querySelector('.sidebar-tab[aria-selected=true]')?.textContent.includes('Collections')"),
		"Collections tab",
	);
}

async function openRequestFromCollections(collectionName, requestName) {
	await ensureCollectionsPanel();
	await retry(
		() =>
			evaluate(
				"(() => { const label = [...document.querySelectorAll('.tree-label')].find((n) => n.textContent.trim().includes(" +
					JSON.stringify(collectionName) +
					") && n.getClientRects().length > 0); if (!label) return false; label.click(); return true; })()",
			),
		"collection row " + collectionName,
	);
	await retry(
		() =>
			evaluate(
				"(() => { const node = [...document.querySelectorAll('.tree-label, .request-tree-item, button')].find((n) => n.textContent.trim().includes(" +
					JSON.stringify(requestName) +
					") && n.getClientRects().length > 0); if (!node) return false; node.click(); return true; })()",
			),
		"request row " + requestName,
	);
	await waitFor('document.querySelector(".request-builder") !== null', "request builder");
}

await call("Page.enable");
await call("Runtime.enable");
await viewport(1440);
await call("Page.navigate", { url: APP });

// ---- login ----------------------------------------------------------------
await waitFor('document.querySelector("#workspace-email") !== null || document.querySelector(".app-shell") !== null', "app shell");
if (await evaluate('document.querySelector(".app-shell") !== null')) {
	await evaluate("localStorage.clear(); sessionStorage.clear(); true");
	await call("Page.navigate", { url: APP });
	await waitFor('document.querySelector("#workspace-email") !== null', "login screen after reset");
}
await setInput("#workspace-email", "alex.morgan@example.test");
await setInput("#workspace-password", "password123");
await evaluate('document.querySelector(".workspace-login-card form").requestSubmit(); true');
await waitFor('[...document.querySelectorAll("button")].some((node) => node.getAttribute("aria-label")?.startsWith("Continue as"))', "profile picker");
await click('[aria-label^="Continue as"]', "profile");
await waitFor('document.querySelector(".app-shell") !== null', "workspace");
pass("login -> profile -> workspace");

// ---- produce a real execution -------------------------------------------
// "List orders" inherits the collection's `{{orders_token}}` bearer auth and
// interpolates `{{base_url}}` from the seeded active environment, so the
// resulting receipt carries real variable provenance and a credential
// *reference* without ever persisting a credential value.
await openRequestFromCollections("Orders API", "List orders");
await click(".send-button", "Send");
await waitFor('document.querySelector(".response-toolbar") !== null', "terminal send result", 40000);
pass("a real execution completed through the workspace");

// ---- history entry point -------------------------------------------------
await clickText(".sidebar-tab", "History", "History tab");
await retry(() => evaluate("document.querySelector('.history-item') !== null"), "history entries");
const rows = await evaluate("document.querySelectorAll('.history-item').length");
const whyButtons = await evaluate("[...document.querySelectorAll('.history-item button')].filter((b) => b.textContent.trim() === 'Why?').length");
if (whyButtons < 1) throw new Error("No history row exposes a \"Why?\" action");
if (whyButtons !== rows) throw new Error("Only " + whyButtons + " of " + rows + " history rows expose \"Why?\"");
pass("every history row exposes an exactly-labelled \"Why?\" action");

// Capture the execution id from the app's own history API before opening.
const history = await api("GET", "/history?limit=1");
const executionId = history.body?.data?.items?.[0]?.executionId;
if (!executionId) throw new Error("Could not read the newest execution id from history: " + JSON.stringify(history).slice(0, 200));

await evaluate("(() => { const row = document.querySelector('.history-item'); [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Why?').click(); return true; })()");
await waitFor('document.querySelector(".why-dialog") !== null', "Why Inspector dialog");
await waitFor('document.querySelector(".why-dialog [role=tab]") !== null', "Why Inspector sections", 30000);
pass("\"Why?\" opens the Why Inspector dialog");

// ---- the dialog answers with recorded evidence only ---------------------
const tabs = await evaluate("[...document.querySelectorAll('.why-dialog [role=tab]')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()).join('|')");
for (const expected of ["Configuration", "Execution", "Change", "Evidence"]) {
	if (!tabs.includes(expected)) throw new Error("Why dialog is missing section: " + expected);
}
pass("dialog exposes Configuration / Execution / Change / Evidence");

const headline = await evaluate("document.querySelector('.why-headline-hint')?.textContent || ''");
if (!/Why did this request execute this way/.test(headline)) throw new Error("Dialog does not state the question it answers: " + headline);
pass("dialog states the question it answers");

// Configuration: real provenance, grouped, with an explicit state chip.
const configuration = await evaluate(
	"(() => ({ state: document.querySelector('.why-verification .why-state-pill')?.textContent.trim() || null, groups: [...document.querySelectorAll('.why-group h4')].map((n) => n.textContent.trim()), entries: document.querySelectorAll('.why-kv-row').length }))()",
);
if (!configuration.state) throw new Error("Verification card renders no state");
if (!["VERIFIED", "BLOCKED", "NEEDS_REHEARSAL", "UNKNOWN"].includes(configuration.state))
	throw new Error("Verification state is outside the recorded vocabulary: " + configuration.state);
if (configuration.entries < 5) throw new Error("Configuration section rendered only " + configuration.entries + " entries");
for (const group of ["Request", "Target", "Authentication", "Policy"]) {
	if (!configuration.groups.includes(group)) throw new Error("Configuration group missing: " + group);
}
pass("configuration renders real recorded groups, entries, and a recorded verification state");

// Dependencies: the backend's precedence ladder plus recorded references.
const ladder = await evaluate("[...document.querySelectorAll('.why-ladder li')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim())");
if (ladder.length < 3) throw new Error("Precedence ladder is not rendered (" + ladder.length + " steps)");
const applied = await evaluate("document.querySelectorAll('.why-ladder li.applied').length");
if (applied < 1) throw new Error("No scope is marked as having contributed a value");
const variableKeys = await evaluate("[...document.querySelectorAll('.why-table tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent.trim()))");
const referenceKeys = variableKeys.map((row) => row[1]);
if (!referenceKeys.includes("orders_token")) throw new Error("The credential reference `orders_token` was not recorded as a dependency: " + JSON.stringify(referenceKeys));
if (!referenceKeys.includes("base_url")) throw new Error("The `base_url` variable reference was not recorded: " + JSON.stringify(referenceKeys));
pass("dependencies record the variable references and the backend precedence ladder");

// ---- v2 envelope with no linked proof: the UNKNOWN chain ----------------
// Without a proof the dialog GETs, and Phase 49B can only report what is
// already recorded: every evidence node is present and explicit.
const verificationBasis = await evaluate("document.querySelector('.why-verification .why-basis')?.textContent.replace(/\\s+/g, ' ').trim() || ''");
if (!/UNKNOWN/.test(await evaluate("document.querySelector('.why-verification .why-state-pill')?.textContent || ''")))
	throw new Error("Without a linked proof the verification state is not UNKNOWN");
if (!/No verification evidence|none/.test(verificationBasis)) throw new Error("Without a linked proof the basis is not none: " + verificationBasis);
pass("no linked proof renders UNKNOWN with the v2 none basis");

await clickText(".why-dialog [role=tab]", "Evidence", "Evidence tab");
await sleep(200);
const chainLabels = await evaluate("[...document.querySelectorAll('.why-chain li strong')].map((n) => n.textContent.trim())");
for (const expected of ["Impact", "Drift", "Rehearsal", "Contract", "Verification", "Proof"]) {
	if (!chainLabels.includes(expected)) throw new Error("Evidence chain is missing the v2 node: " + expected + " (got " + chainLabels.join(", ") + ")");
}
const chainStatuses = await evaluate("[...document.querySelectorAll('.why-chain li')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim())");
if (!chainStatuses.some((text) => /Not recorded/.test(text))) throw new Error("Evidence chain shows no explicit not_recorded node: " + chainStatuses.join(" | "));
const metadata = await evaluate("document.querySelector('.why-content')?.textContent || ''");
if (!/tracer\.why-explanation/.test(metadata) || !/v2/.test(metadata)) throw new Error("Projection metadata does not show the v2 envelope: " + metadata.slice(0, 240));
pass("v2 evidence chain renders Impact/Drift/Rehearsal/Contract/Verification/Proof as explicit not_recorded");

// ---- the read-model never resolves a secret -----------------------------
const explanation = await api("GET", "/why/executions/" + executionId);
if (explanation.status !== 200) throw new Error("Projection endpoint returned " + explanation.status);
const envelope = explanation.body?.data;
if (envelope?.kind !== "tracer.why-explanation" || envelope?.schemaVersion !== 2) throw new Error("Unexpected envelope: " + JSON.stringify(envelope).slice(0, 200));
if (envelope?.recorded !== true) throw new Error("A recorded execution was not reported as recorded");
const serialized = JSON.stringify(envelope);
// The projection may name a field path (auth.tokenTemplate) but must never carry a
// resolved credential. The demo tokens are read here only to assert their absence.
const envFile = readFileSync(new URL("../../backend/.env", import.meta.url), "utf8");
const demoSecrets = ["DEMO_LOCAL_TOKEN", "DEMO_STAGING_TOKEN"]
	.map((key) => new RegExp("^" + key + "=(.+)$", "m").exec(envFile)?.[1]?.trim())
	.filter((value) => value && value !== "replace-me");
if (demoSecrets.length === 0) throw new Error("Could not read the demo tokens needed for the secret-exclusion assertion");
for (const secret of demoSecrets) {
	if (serialized.includes(secret)) throw new Error("The projection leaked a resolved demo credential value");
}
if (/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/.test(serialized)) throw new Error("The projection leaked a resolved credential value");
if (/local_token|staging_token/.test(serialized)) throw new Error("The projection leaked a secret alias");
if (!/orders_token/.test(serialized)) throw new Error("The projection dropped the recorded credential reference key");
await clickText(".why-dialog [role=tab]", "Configuration", "Configuration tab");
await sleep(200);
const authEvidence = await evaluate("(() => { const rows = [...document.querySelectorAll('.why-kv-row')]; const row = rows.find((r) => r.querySelector('dt')?.textContent.includes('Auth mode')); return row ? row.querySelector('dd').textContent.trim() : null; })()");
if (!authEvidence) throw new Error("Auth mode is not reported in the configuration section");
pass("projection records the credential reference but never a credential value");

// ---- fail-closed on unknown and malformed identifiers -------------------
const malformed = await api("GET", "/why/executions/not-a-uuid");
if (malformed.status !== 400 || malformed.body?.error?.code !== "VALIDATION_ERROR")
	throw new Error("Malformed identifier did not fail with VALIDATION_ERROR: " + JSON.stringify(malformed).slice(0, 200));
const unknown = await api("GET", "/why/executions/00000000-0000-4000-8000-000000000000");
if (unknown.status !== 404 || unknown.body?.error?.code !== "EXECUTION_NOT_FOUND")
	throw new Error("Unknown identifier did not fail with EXECUTION_NOT_FOUND: " + JSON.stringify(unknown).slice(0, 200));
pass("unknown and malformed identifiers fail closed with explicit codes");

// ---- discover the live request and environment identities ----------------
// The proof must name the exact request and environment the execution was
// recorded against, so both are read from the live seeded workspace.
const collections = await api("GET", "/collections");
const ordersApi = (collections.body?.data ?? []).find((c) => c.name === "Orders API");
if (!ordersApi?._id) throw new Error("Could not find the Orders API collection: " + JSON.stringify(collections).slice(0, 300));
const ordersDetail = await api("GET", "/collections/" + ordersApi._id);
const listOrders = (ordersDetail.body?.data?.requests ?? []).find((r) => r.name === "List orders");
const requestId = listOrders?.id ?? listOrders?._id;
if (!requestId) throw new Error("Could not find the List orders request id: " + JSON.stringify(collections).slice(0, 300));
const environments = await api("GET", "/environments");
const localEnv = (environments.body?.data ?? []).find((e) => e.name === "Local");
const environmentId = localEnv?._id;
if (!environmentId) throw new Error("Could not find the Local environment id: " + JSON.stringify(environments).slice(0, 300));
pass("live request and environment identities discovered");

// ---- mint real Phase 47 proofs against the backend under test ------------
const SNAPSHOT_RUN = { snapshotId: "snap-why-e2e-run", snapshotFingerprint: "f".repeat(64) };
const SNAPSHOT_SEED = { snapshotId: "snap-why-e2e-run", snapshotFingerprint: "5".repeat(64) };
const ENV_FINGERPRINT = "9".repeat(64);

function proofApiInput({ snapshot, envId, envName }) {
	// proofInput is a fixture builder: requestIds/runOptions drive its plan
	// construction but are not part of the HTTP input schema, so strip them.
	// The fixture plan/run cite synthetic identities, while the proof binds
	// the live request/environment/snapshot — rebind the plan and run to the
	// same live identity so the builder's binding check sees one story.
	const { requestIds: _requestIds, runOptions: _runOptions, ...input } = proofInput({
		requestIds: [requestId],
		snapshot,
		targetEnvironment: { environmentId: envId, environmentFingerprint: ENV_FINGERPRINT, environmentName: envName },
		// Name the real profile on the evidence so the build exercises the
		// isolation boundary instead of sidestepping it (same as 47C).
		evidence: {
			executions: [
				executionEvidence({
					ownerProfileId: pageProfileId,
					requestId,
					snapshotId: snapshot.snapshotId,
					snapshotFingerprint: snapshot.snapshotFingerprint,
					environmentId: envId,
					environmentName: envName,
				}),
			],
			assertions: [assertionEvidence({ ownerProfileId: pageProfileId, requestId })],
		},
		verification: verificationFixture({
			verifiedRequestIds: [requestId],
			affectedRequestIds: [requestId],
			requiredRehearsalRequestIds: [requestId],
			target: { snapshotId: snapshot.snapshotId, snapshotFingerprint: snapshot.snapshotFingerprint, environmentId: envId },
		}),
		impact: impactResult({ direct: [requestId] }),
		contracts: [contractResult({ requestId })],
	});
	input.plan.target.environmentId = envId;
	input.plan.target.snapshotFingerprint = snapshot.snapshotFingerprint;
	input.plan.snapshot.snapshotId = snapshot.snapshotId;
	input.plan.snapshot.snapshotFingerprint = snapshot.snapshotFingerprint;
	input.run.identity.snapshotId = snapshot.snapshotId;
	input.run.identity.snapshotFingerprint = snapshot.snapshotFingerprint;
	input.run.identity.targetEnvironment = { environmentId: envId, environmentFingerprint: ENV_FINGERPRINT, environmentName: envName };
	input.run.identity.planId = input.plan.identity.planFingerprint;
	input.run.identity.planFingerprint = input.plan.identity.planFingerprint;
	input.run.identityFingerprint = identityFingerprint(input.run.identity);
	return input;
}

async function exportArtifact(input) {
	const built = await fetch(API + "/api/v1/verification-proofs", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer " + pageToken },
		body: JSON.stringify({ input }),
	}).then((r) => r.json());
	if (!built.data?.proof) throw new Error("mint: build failed: " + JSON.stringify(built).slice(0, 300));
	const exported = await fetch(API + "/api/v1/verification-proofs/export", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer " + pageToken },
		body: JSON.stringify({ proof: built.data.proof }),
	}).then((r) => r.json());
	if (!exported.data?.text) throw new Error("mint: export failed: " + JSON.stringify(exported).slice(0, 300));
	return exported.data.text;
}

async function mintProofArtifact(snapshot) {
	return exportArtifact(proofApiInput({ snapshot, envId: environmentId, envName: "Local" }));
}

const pageToken = await evaluate("localStorage.getItem('request-desk-profile-token') || localStorage.getItem('request-desk-session-token')");
if (!pageToken) throw new Error("Could not read the page profile token for proof minting");
const pageProfileId = await evaluate("localStorage.getItem('request-desk-profile-id') || ''");
if (!pageProfileId) throw new Error("Could not read the page profile id for proof minting");

// Rehearsal-linkage reads persisted runs, so a leftover run from an earlier
// partial run would change every link verdict below. Clear this suite's runs
// up front (and again at the end) through the same database the backend reads.
const mongoose = (await import(new URL("backend/node_modules/mongoose/lib/mongoose.js", repoRootUrl).href)).default;
await mongoose.connect(process.env.MONGODB_URI);
const { RehearsalCheckpoint } = await import(new URL("backend/src/features/rehearsal-checkpoints/checkpoint.model.js", repoRootUrl).href);
await RehearsalCheckpoint.deleteMany({ ownerProfileId: pageProfileId, runId: /^why-e2e-/ });

// Proof A names this request in this environment, so with no recorded run to
// disagree with it links as RECORDED and the Phase 41 VERIFIED state appears.
const proofTextA = await mintProofArtifact(SNAPSHOT_RUN);

async function attachProof(text) {
	await waitFor('document.querySelector(".why-dialog [role=tab]") !== null', "Why sections before attach", 30000);
	await clickText(".why-dialog [role=tab]", "Evidence", "Evidence tab");
	await sleep(200);
	await setInput("#why-proof-artifact", text);
	await clickText(".why-proof-actions button", "Attach proof for this read", "Attach proof");
}

async function chainNode(label) {
	const nodes = await evaluate(
		"[...document.querySelectorAll('.why-chain li')].map((n) => ({ label: n.querySelector('strong')?.textContent.trim() ?? '', text: n.textContent.replace(/\\s+/g, ' ').trim() }))",
	);
	return (nodes ?? []).find((node) => node.label === label)?.text ?? null;
}

async function waitChainNode(label, pattern, what, timeout = 20000) {
	return retry(async () => {
		const node = await chainNode(label);
		return node && pattern.test(node) ? node : null;
	}, what, timeout);
}

async function removeProof() {
	await waitFor('document.querySelector(".why-dialog [role=tab]") !== null', "Why sections before remove", 30000);
	await clickText(".why-dialog [role=tab]", "Evidence", "Evidence tab");
	await sleep(200);
	await clickText(".why-proof-actions button", "Remove proof", "Remove proof");
}

await attachProof(proofTextA);
await waitChainNode("Proof", /Recorded/, "proof links as recorded");
await clickText(".why-dialog [role=tab]", "Configuration", "Configuration tab after link");
await sleep(200);
const linkedVerification = await evaluate(
	"(() => ({ state: document.querySelector('.why-verification .why-state-pill')?.textContent.trim() || null, basis: document.querySelector('.why-verification .why-basis')?.textContent.replace(/\\s+/g, ' ').trim() || '' }))()",
);
if (linkedVerification.state !== "VERIFIED") throw new Error("Linked proof did not surface the Phase 41 VERIFIED state: " + linkedVerification.state);
if (!/linked_verification/.test(linkedVerification.basis)) throw new Error("Linked proof did not surface the linked basis: " + linkedVerification.basis);
await clickText(".why-dialog [role=tab]", "Evidence", "Evidence tab after link");
await sleep(200);
const linkedNodes = await evaluate(
	"[...document.querySelectorAll('.why-chain li')].map((n) => ({ label: n.querySelector('strong')?.textContent.trim() ?? '', text: n.textContent.replace(/\\s+/g, ' ').trim() }))",
);
for (const expected of ["Impact", "Drift", "Contract", "Verification", "Proof"]) {
	const node = (linkedNodes ?? []).find((entry) => entry.label === expected);
	if (!node || !/Recorded/.test(node.text)) throw new Error("Linked chain node is not recorded: " + expected);
}
pass("attached proof links Impact/Drift/Contract/Phase 41/Proof with recorded evidence");

// POST envelope carries the same secret-exclusion guarantee as GET.
const posted = await api("POST", "/why/executions/" + executionId, { proof: proofTextA });
if (posted.status !== 200) throw new Error("POST explanation returned " + posted.status);
const postedSerialized = JSON.stringify(posted.body?.data);
for (const secret of demoSecrets) {
	if (postedSerialized.includes(secret)) throw new Error("The POST projection leaked a resolved demo credential value");
}
if (!/orders_token/.test(postedSerialized)) throw new Error("The POST projection dropped the recorded credential reference key");
pass("POST explanation keeps the secret-exclusion guarantee");

// ---- a recorded run that disagrees makes the proof STALE ----------------
// Seed one rehearsal checkpoint through the real Phase 46B service: it names
// this execution in its step evidence refs, but its snapshot fingerprint
// differs from proof A's, so Phase 47B answers STALE and the dialog must show it.
const { checkpointRepository } = await import(new URL("backend/src/features/rehearsal-checkpoints/checkpoint.repository.js", repoRootUrl).href);
const { createRehearsalCheckpointService } = await import(
	new URL("backend/src/features/rehearsal-checkpoints/rehearsal-checkpoint.service.js", repoRootUrl).href
);
const { STEP_STATES } = await import(new URL("backend/src/features/rehearsal-checkpoints/reason-codes.js", repoRootUrl).href);
const checkpointService = createRehearsalCheckpointService({ repository: checkpointRepository, now: () => new Date() });
const profileId = pageProfileId;
const e2eRunId = "why-e2e-" + Date.now().toString(36);
await checkpointService.createRun(profileId, {
	runId: e2eRunId,
	identity: {
		workspaceId: "ws-why-e2e",
		snapshotId: SNAPSHOT_SEED.snapshotId,
		snapshotFingerprint: SNAPSHOT_SEED.snapshotFingerprint,
		targetEnvironment: { environmentId, environmentName: "Local", environmentFingerprint: ENV_FINGERPRINT },
		planId: "plan-why-e2e",
		planFingerprint: "p".repeat(64),
	},
	plan: { steps: [{ stepId: "step:" + requestId, refId: requestId }] },
});
const startedRun = await checkpointService.startRun(profileId, e2eRunId, { owner: "why-e2e" });
await checkpointService.checkpointStep(profileId, e2eRunId, {
	generation: startedRun.generation,
	owner: "why-e2e",
	stepId: "step:" + requestId,
	state: STEP_STATES.COMPLETED,
	outcome: { outcomeId: "why-e2e-outcome" },
	evidenceRefs: [executionId],
});

// The run names this execution, so even without a proof the rehearsal node is
// now recorded evidence.
await removeProof();
await waitChainNode("Rehearsal", /Recorded/, "rehearsal links as recorded");
pass("seeded rehearsal run links as recorded rehearsal evidence");

// Re-attaching proof A now disagrees with the recorded run identity: STALE.
// STALE must read as a warning, never as success green.
await attachProof(proofTextA);
await waitChainNode("Proof", /Stale/, "proof stays stale");
const staleProofNode = await chainNode("Proof");
if (!staleProofNode || /Recorded/.test(staleProofNode)) throw new Error("Stale proof node is not explicit: " + (staleProofNode ?? "missing").slice(0, 600));
const staleProofTone = await evaluate("(() => { const node = [...document.querySelectorAll('.why-chain li')].find((n) => n.querySelector('strong')?.textContent.trim() === 'Proof'); return node?.querySelectorAll('.why-chip')[1]?.className || null; })()");
if (!staleProofTone || /success/.test(staleProofTone)) throw new Error("Stale proof renders as success: " + staleProofTone);
await clickText(".why-dialog [role=tab]", "Configuration", "Configuration tab after stale");
await sleep(200);
const staleVerification = await evaluate("document.querySelector('.why-verification .why-state-pill')?.textContent.trim() || ''");
if (staleVerification === "VERIFIED") throw new Error("A stale proof still reports VERIFIED");
pass("stale proof stays STALE and never upgrades the verification state");

// Proof B matches the recorded run identity: CURRENT with full evidence.
const proofTextB = await mintProofArtifact(SNAPSHOT_SEED);
await removeProof();
await attachProof(proofTextB);
await waitChainNode("Proof", /Recorded/, "proof links as current");
await clickText(".why-dialog [role=tab]", "Configuration", "Configuration tab when current");
await sleep(200);
const currentVerification = await evaluate("document.querySelector('.why-verification .why-state-pill')?.textContent.trim() || ''");
if (currentVerification !== "VERIFIED") throw new Error("Current proof did not restore VERIFIED: " + currentVerification);
pass("matching proof links as CURRENT with the Phase 41 state");

// A tampered artifact fails integrity: INVALID with danger tone, and the
// verification state falls back to UNKNOWN instead of trusting it.
const tampered = proofTextB.slice(0, 400) + (proofTextB[400] === "a" ? "b" : "a") + proofTextB.slice(401);
await removeProof();
await attachProof(tampered);
await waitChainNode("Proof", /Invalid/, "tampered proof is invalid");
const invalidTone = await evaluate("(() => { const node = [...document.querySelectorAll('.why-chain li')].find((n) => n.querySelector('strong')?.textContent.trim() === 'Proof'); return node?.querySelectorAll('.why-chip')[1]?.className || null; })()");
if (!invalidTone || !/danger/.test(invalidTone)) throw new Error("Invalid proof does not render with danger tone: " + invalidTone);
await clickText(".why-dialog [role=tab]", "Configuration", "Configuration tab after invalid");
await sleep(200);
const invalidVerification = await evaluate("document.querySelector('.why-verification .why-state-pill')?.textContent.trim() || ''");
if (invalidVerification === "VERIFIED") throw new Error("A tampered proof still reports VERIFIED");
pass("tampered proof is INVALID and never upgrades the verification state");

// A proof for another environment is an explicit identity mismatch. The
// artifact is internally consistent (it builds cleanly); it disagrees with
// the execution's environment, which linkProof reports without trusting it.
const elsewhereText = await exportArtifact(
	proofApiInput({ snapshot: SNAPSHOT_RUN, envId: "00000000-0000-4000-8000-000000000001", envName: "Elsewhere" }),
);
await removeProof();
await attachProof(elsewhereText);
await waitChainNode("Proof", /Identity mismatch/, "environment mismatch is explicit");
pass("wrong-environment proof is an explicit identity mismatch");

// A malformed artifact is refused with an alert, not a guess.
await removeProof();
await attachProof("{not a proof artifact");
await retry(async () => evaluate("document.querySelector('.why-proof-error') !== null"), "proof refusal alert");
pass("malformed proof artifact is refused with an explicit alert");

// Cleanup the seeded run so the dev database is left as found.
await RehearsalCheckpoint.deleteMany({ ownerProfileId: pageProfileId, runId: /^why-e2e-/ }).catch(() => null);
await mongoose.disconnect().catch(() => null);
pass("seeded rehearsal run cleaned up");

// ---- read-only: no send, save, or mutation affordance -------------------
const actionText = await evaluate("(() => { const nodes = [...document.querySelectorAll('.why-dialog button')]; return nodes.map((n) => n.textContent.trim()).join('|'); })()");
if (/\b(Send|Save|Update|Delete|Run)\b/.test(actionText)) throw new Error("Why dialog exposes a mutating action: " + actionText);
pass("dialog is read-only: no send, save, or mutate affordance");

// ---- cross-links into the rest of the investigation flow ----------------
await clickText(".why-header-actions button", "Passport", "Passport cross-link");
await waitFor('document.querySelector(".flight-recorder-dialog") !== null', "Flight Recorder dialog", 20000);
const recorderHasWhy = await evaluate("[...document.querySelectorAll('.flight-recorder-dialog button')].some((b) => b.textContent.trim() === 'Why?')");
if (!recorderHasWhy) throw new Error("Flight Recorder header does not offer a \"Why?\" cross-link");
await clickText(".flight-recorder-dialog button", "Why?", "Why cross-link");
await waitFor('document.querySelector(".why-dialog") !== null', "Why dialog from passport", 20000);
await waitFor('document.querySelector(".why-dialog [role=tab]") !== null', "Why sections from passport", 30000);
pass("Passport and Why? cross-link in both directions");

// ---- keyboard accessibility --------------------------------------------
await evaluate("document.querySelector('.why-dialog [role=tab]')?.focus(); true");
await pressKey("ArrowRight", "ArrowRight", 39);
const focusedTab = await evaluate("document.activeElement?.getAttribute('role') === 'tab' ? document.activeElement.textContent.replace(/\\s+/g, ' ').trim() : null");
if (!focusedTab) throw new Error("Arrow-key navigation moved focus out of the tab list");
pass("tab list is keyboard navigable");

await pressEscape();
await retry(() => evaluate('document.querySelector(".why-dialog") === null'), "dialog closes on Escape");
pass("Escape closes the Why Inspector");

// ---- responsive + theme matrix ------------------------------------------
// Keep one dialog open and resize it, so this measures the component under
// test rather than the app shell's drawer behaviour at narrow widths.
await clickText(".sidebar-tab", "History", "History tab");
await retry(() => evaluate("document.querySelector('.history-item') !== null"), "history entries");
await evaluate("(() => { const row = document.querySelector('.history-item'); [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Why?').click(); return true; })()");
await waitFor('document.querySelector(".why-dialog") !== null', "dialog for the matrix");
await waitFor('document.querySelector(".why-dialog [role=tab]") !== null', "sections for the matrix", 30000);

const matrix = [];
for (const width of [375, 768, 1024, 1440]) {
	for (const theme of ["dark", "light"]) {
		await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; localStorage.setItem('tracer-theme', ${JSON.stringify(theme)}); true`);
		await viewport(width, 900);
		const documentOverflow = await evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
		if (documentOverflow > 1) throw new Error(`Document overflow at ${width}px/${theme}: ${documentOverflow}px`);
		for (const label of ["Configuration", "Execution", "Change", "Evidence"]) {
			await clickText(".why-dialog [role=tab]", label, label + " tab");
			await sleep(160);
			const dialogOverflow = await evaluate("(() => { const node = document.querySelector('.why-dialog'); return node.scrollWidth - node.clientWidth; })()");
			if (dialogOverflow > 1) throw new Error(`Why dialog overflows at ${width}px/${theme}/${label}: ${dialogOverflow}px`);
		}
		matrix.push(width + "/" + theme);
	}
}
pass("responsive matrix holds at " + matrix.join(", "));

// ---- no side effects ----------------------------------------------------
const afterHistory = await api("GET", "/history?limit=1");
if (afterHistory.body?.data?.items?.[0]?.executionId !== executionId)
	throw new Error("Opening the Why Inspector produced a new execution, so it is not read-only");
pass("opening the Why Inspector produces no new execution");

if (runtimeErrors.length) throw new Error("Browser exceptions: " + runtimeErrors.join(" | "));
pass("no unhandled browser exceptions");

process.stdout.write("PHASE49B_E2E_PASS " + checks.length + "/" + checks.length + "\n");
socket.close();
