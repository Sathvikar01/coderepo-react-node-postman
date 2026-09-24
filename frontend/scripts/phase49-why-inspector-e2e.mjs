// Phase 49 — "Why?" Inspector browser verification.
//
// Drives the real Tracer app through the Chrome DevTools Protocol against a
// local, seeded instance and proves the properties this phase exists to
// guarantee:
//
//   * A real execution exposes a "Why?" action on its history row.
//   * The dialog answers the question from recorded evidence only:
//     configuration, dependencies/precedence, the execution pipeline, change
//     evidence, and the evidence chain.
//   * The read-model never resolves a secret: a `{{orders_token}}` reference is
//     reported as a reference while no credential value appears anywhere.
//   * Change evidence fails closed when nothing recorded it, instead of
//     inventing a cause.
//   * The dialog is read-only: nothing sends, saves, or mutates.
//   * Keyboard-only usage works, and the layout holds at 375 / 768 / 1024 /
//     1440 in both themes.
//
// It talks only to a local, seeded instance and never contacts the network.

import { readFileSync } from "node:fs";

const CDP = process.env.TRACER_CDP_URL || "http://127.0.0.1:9222";
const APP = process.env.TRACER_APP_URL || "http://127.0.0.1:3000";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
async function api(method, path) {
	const payload = await evaluate(
		"(async () => { const token = localStorage.getItem('request-desk-profile-token') || localStorage.getItem('request-desk-session-token'); const response = await fetch('/api/v1" +
			path +
			"', { method: " +
			JSON.stringify(method) +
			", headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } }); return { status: response.status, body: await response.json() }; })()",
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

// Execution: the full pipeline is present with per-stage recorded state.
await clickText(".why-dialog [role=tab]", "Execution", "Execution tab");
await sleep(200);
const stages = await evaluate("[...document.querySelectorAll('.why-stages li')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim())");
for (const expected of ["Compile", "Target policy", "DNS resolution", "Transport", "Response capture", "Normalize", "History record"]) {
	if (!stages.some((stage) => stage.includes(expected))) throw new Error("Execution pipeline is missing stage: " + expected);
}
const recordedStages = await evaluate("document.querySelectorAll('.why-stages li.recorded').length");
if (recordedStages !== stages.length) throw new Error("Only " + recordedStages + " of " + stages.length + " pipeline stages are recorded for a successful send");
pass("execution pipeline reports all seven stages as recorded");

// Change: fail closed rather than invent a cause.
await clickText(".why-dialog [role=tab]", "Change", "Change tab");
await sleep(200);
const changeText = await evaluate("document.querySelector('.why-content')?.textContent || ''");
if (!/No change evidence recorded/i.test(changeText)) throw new Error("Change section did not fail closed: " + changeText.slice(0, 240));
if (/first meaningful divergence/i.test(changeText)) throw new Error("Change section rendered a divergence with no recorded analysis");
pass("change evidence fails closed when nothing recorded it");

// Evidence: a real chain plus projection metadata.
await clickText(".why-dialog [role=tab]", "Evidence", "Evidence tab");
await sleep(200);
const chain = await evaluate("[...document.querySelectorAll('.why-chain li')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim())");
if (chain.length < 3) throw new Error("Evidence chain has only " + chain.length + " nodes");
const chainText = chain.join(" | ");
if (!/Execution receipt/.test(chainText)) throw new Error("Evidence chain has no execution receipt node: " + chainText);
const metadata = await evaluate("document.querySelector('.why-content')?.textContent || ''");
if (!/tracer\.why-explanation/.test(metadata) || !/v1/.test(metadata)) throw new Error("Projection metadata is not shown: " + metadata.slice(0, 240));
pass("evidence chain and projection metadata are rendered");

// ---- the read-model never resolves a secret -----------------------------
const explanation = await api("GET", "/why/executions/" + executionId);
if (explanation.status !== 200) throw new Error("Projection endpoint returned " + explanation.status);
const envelope = explanation.body?.data;
if (envelope?.kind !== "tracer.why-explanation" || envelope?.schemaVersion !== 1) throw new Error("Unexpected envelope: " + JSON.stringify(envelope).slice(0, 200));
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
			if (dialogOverflow > 1) throw new Error(`Why dialog overflows at ${width}px/${theme} on ${label}: ${dialogOverflow}px`);
			const rendered = await evaluate("document.querySelector('.why-content')?.textContent?.length || 0");
			if (rendered < 20) throw new Error(`Why dialog rendered nothing at ${width}px/${theme} on ${label}`);
		}
		const clippedFooter = await evaluate(
			"(() => { const footer = document.querySelector('.why-dialog footer'); if (!footer) return false; return footer.getBoundingClientRect().bottom > window.innerHeight + 2; })()",
		);
		if (clippedFooter) throw new Error(`Why dialog footer is clipped at ${width}px/${theme}`);
		const surface = await evaluate(
			"(() => { const dialog = document.querySelector('.why-modal'); const body = document.querySelector('.why-dialog'); return getComputedStyle(dialog).backgroundColor + '|' + getComputedStyle(body).color; })()",
		);
		matrix.push(`${width}/${theme}:${surface}`);
	}
}
if (new Set(matrix.map((entry) => entry.split(":").slice(1).join(":"))).size !== 2) throw new Error("Both themes did not produce a distinct dialog surface: " + matrix.join(" "));
await pressEscape();
await retry(() => evaluate('document.querySelector(".why-dialog") === null'), "close after matrix");
pass("Why Inspector renders at 375/768/1024/1440 in both themes with no overflow or clipping");

// ---- no side effects ----------------------------------------------------
const afterHistory = await api("GET", "/history?limit=1");
if (afterHistory.body?.data?.items?.[0]?.executionId !== executionId)
	throw new Error("Opening the Why Inspector produced a new execution, so it is not read-only");
pass("opening the Why Inspector produces no new execution");

if (runtimeErrors.length) throw new Error("Browser exceptions: " + runtimeErrors.join(" | "));
pass("no unhandled browser exceptions");

process.stdout.write("PHASE49_E2E_PASS " + checks.length + "/" + checks.length + "\n");
socket.close();
