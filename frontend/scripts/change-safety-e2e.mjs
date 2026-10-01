// Phase 54 — complete Change Safety browser acceptance.
//
// Proves the issue #71 path through the real Tracer UI:
// saved change -> Impact -> Drift -> Contract generation -> Rehearsal -> Proof.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CDP = process.env.TRACER_CDP_URL || "http://127.0.0.1:9222";
const APP = process.env.TRACER_APP_URL || "http://127.0.0.1:3000";
const OUTPUT = process.env.TRACER_CHANGE_SAFETY_OUTPUT || "output/change-safety-e2e";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(OUTPUT, { recursive: true });
const screenshots = [];
const checks = [];

function pass(name) {
	checks.push(name);
	process.stdout.write("PASS " + name + "\n");
}

async function retry(fn, label, timeout = 30000) {
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
		runtimeErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "Unhandled browser exception");
	}
	if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
		runtimeErrors.push("console: " + (message.params.entry.text || "error"));
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

async function waitFor(expression, label, timeout = 30000) {
	return retry(() => evaluate(expression), label, timeout);
}

async function click(selector, label = selector) {
	const expression =
		"(() => { const node = document.querySelector(" +
		JSON.stringify(selector) +
		"); if (!node || node.disabled || node.getClientRects().length === 0) return false; node.focus(); node.click(); return true; })()";
	await retry(() => evaluate(expression), "click " + label, 10000);
}

async function clickText(selector, text, label = text) {
	const expression =
		"(() => { const target = " +
		JSON.stringify(text) +
		"; const node = [...document.querySelectorAll(" +
		JSON.stringify(selector) +
		")].find((n) => !n.disabled && n.getClientRects().length > 0 && n.textContent.replace(/\\s+/g, ' ').trim().includes(target)); if (!node) return false; node.focus(); node.click(); return true; })()";
	await retry(() => evaluate(expression), "click " + label, 10000);
}

async function selectMenu(label, optionText) {
	await click('[role="combobox"][aria-label="' + label + '"]', label);
	await clickText('.select-menu-list [role="option"]', optionText, label + ' -> ' + optionText);
	await waitFor(
		'(() => { const node=document.querySelector(' + JSON.stringify('[role="combobox"][aria-label="' + label + '"]') + '); return Boolean(node && node.textContent.replace(/\\s+/g, " ").includes(' + JSON.stringify(optionText) + ')); })()',
		label + ' selected ' + optionText,
	);
}

async function selectPreviousRevision() {
	await click('[role="combobox"][aria-label="Baseline revision"]', "Baseline revision");
	const selected = await retry(
		async () => {
			const label = await evaluate(
				"(() => { const options=[...document.querySelectorAll('.select-menu-list [role=option]')].map((node)=>({ node, label: node.querySelector('span')?.textContent.trim() || '', revision: Number((node.querySelector('span')?.textContent.match(/Revision v(\\d+)/) || [])[1]) })).filter((item)=>Number.isInteger(item.revision)); if (options.length < 2) return ''; options.sort((a,b)=>a.revision-b.revision); const choice=options[0]; choice.node.focus(); choice.node.click(); return choice.label; })()",
			);
			return label || null;
		},
		"select oldest saved revision",
		10000,
	);
	await waitFor(
		'(() => document.querySelector(\'[role="combobox"][aria-label="Baseline revision"]\')?.textContent.trim().includes(' + JSON.stringify(selected) + '))()',
		"oldest saved revision selected",
	);
	return selected;
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

async function pressEscape() {
	await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await sleep(120);
}

async function viewport(width, height = 900) {
	await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
	await sleep(150);
}

async function screenshot(name) {
	const captured = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	const filename = name + ".png";
	writeFileSync(join(OUTPUT, filename), Buffer.from(captured.data, "base64"));
	screenshots.push(filename);
}

async function dialogOverflow(selector) {
	const expression =
		"(() => { const node = document.querySelector(" +
		JSON.stringify(selector) +
		"); if (!node) return null; const box = node.getBoundingClientRect(); const offenders = [...node.querySelectorAll('*')].filter((el) => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.right > box.right + 2; }).slice(0,5).map((el) => ({ tag: el.tagName, cls: typeof el.className === 'string' ? el.className : '', over: Math.round(el.getBoundingClientRect().right - box.right) })); return { scroll: node.scrollWidth - node.clientWidth, offenders }; })()";
	return evaluate(expression);
}

async function api(method, path, body) {
	const expression =
		"(async () => { const token = localStorage.getItem('request-desk-profile-token') || localStorage.getItem('request-desk-session-token'); const workspace = localStorage.getItem('request-desk-workspace-id'); const response = await fetch('/api/v1" +
		path +
		"', { method: " +
		JSON.stringify(method) +
		", headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'x-workspace-id': workspace }" +
		(body === undefined ? "" : ", body: " + JSON.stringify(JSON.stringify(body))) +
		" }); const payload = response.status === 204 ? null : await response.json().catch(() => null); return { status: response.status, body: payload }; })()";
	return evaluate(expression);
}

await call("Page.enable");
await call("Runtime.enable");
await call("Log.enable");
await viewport(1440);
await call("Page.navigate", { url: APP });

await waitFor('document.querySelector("#workspace-email") !== null || document.querySelector(".app-shell") !== null', "app shell");
if (await evaluate('document.querySelector(".app-shell") !== null')) {
	await evaluate("localStorage.clear(); sessionStorage.clear(); true");
	await call("Page.navigate", { url: APP });
	await waitFor('document.querySelector("#workspace-email") !== null', "login screen");
}

await setInput("#workspace-email", "alex.morgan@example.test");
await setInput("#workspace-password", "password123");
await evaluate('document.querySelector(".workspace-login-card form").requestSubmit(); true');
await waitFor('[...document.querySelectorAll("button")].some((node) => node.getAttribute("aria-label")?.startsWith("Continue as"))', "profile picker");
await click('[aria-label^="Continue as"]', "profile");
await waitFor('document.querySelector(".app-shell") !== null', "workspace");
pass("login -> profile -> workspace");

await click('[aria-label="Open collections"]', "Collections rail command");
await clickText(".tree-row .tree-label", "Orders API", "Orders API collection");
await waitFor(
	'[...document.querySelectorAll(".tree-row .tree-label")].some((node)=>node.textContent.replace(/\\s+/g," ").trim().includes("List orders"))',
	"List orders visible",
);
await clickText(".tree-row .tree-label", "List orders", "List orders request");
await waitFor('document.querySelector(".request-name-input")?.value === "List orders"', "List orders request builder");

await clickText(".request-builder button", "Params", "Params tab");
await waitFor('document.querySelector(\'.kv-editor[aria-label="Query parameters"]\') !== null', "Query parameters editor");
const seededQuery = await evaluate(
	`(() => { const editor=document.querySelector('.kv-editor[aria-label="Query parameters"]'); const keys=[...editor.querySelectorAll('input[placeholder="Key"]')].map((node)=>node.value); const values=[...editor.querySelectorAll('input[placeholder="Value"]')].map((node)=>node.value); const index=keys.indexOf("status"); return index >= 0 ? values[index] : null; })()`,
);
if (seededQuery !== "paid") throw new Error("Expected seeded status=paid query parameter, got " + JSON.stringify(seededQuery));
const statusValueSelector = '.kv-editor[aria-label="Query parameters"] input[placeholder="Value"]';
await setInput(statusValueSelector, "pending");
await waitFor(
	'document.querySelector(' + JSON.stringify(statusValueSelector) + ')?.value === "pending"',
	"tracked query parameter changed",
);
await waitFor('document.body.textContent.includes("Unsaved changes.")', "dirty saved request");

await clickText(".request-title-row button", "Save", "Save request");
await waitFor(
	'[...document.querySelectorAll(".toast")].some((node)=>node.textContent.includes("Request saved."))',
	"request saved through browser UI",
);
await waitFor('!document.body.textContent.includes("Unsaved changes.")', "saved draft clean");
pass("saved Phase-39-trackable collection change created through the request UI");

await call("Page.reload", { ignoreCache: true });
await waitFor(
	'document.readyState === "complete" && document.querySelector(".app-shell") !== null && document.querySelector(\'[aria-label="Open Change Safety"]\')?.getClientRects().length > 0',
	"workspace and Verify rail command after saved change",
);
await click('[aria-label="Open Change Safety"]', "Verify rail command");
await waitFor('document.querySelector(".change-safety-dialog") !== null', "Change Safety dialog");
pass("Change Safety is reachable from the existing workbench rail");

await pressEscape();
await waitFor('document.querySelector(".change-safety-dialog") === null', "Change Safety closes with Escape");
const focusReturned = await evaluate('document.activeElement?.getAttribute("aria-label") === "Open Change Safety"');
if (!focusReturned) throw new Error("Focus did not return to Change Safety rail command");
pass("Escape closes dialog and returns focus");

await click('[aria-label="Open Change Safety"]', "Verify rail command");
await waitFor('document.querySelector(".change-safety-dialog") !== null', "Change Safety dialog reopened");
await selectMenu("Change Safety collection", "Orders API");
await selectMenu("Baseline revision", "Revision v1");
await selectMenu("Source environment", "Local");
await selectMenu("Target environment", "Staging");
await waitFor(
	'document.querySelector(\'[role="combobox"][aria-label="Baseline revision"]\')?.textContent.trim().includes("Revision v1")',
	"v1 baseline selection remains stable",
);
pass("Change Safety collection, v1 baseline, source, and target selected through the browser");

await clickText(".change-safety-dialog button", "Analyze saved change", "Analyze saved change");
const analysisState = await retry(async () => {
	const state = await evaluate(
		"(() => { const button=[...document.querySelectorAll('.change-safety-dialog button')].find((node)=>node.textContent.includes('Analyz')); return { dialog: Boolean(document.querySelector('.change-safety-dialog')), error: document.querySelector('.change-safety-dialog .dialog-error')?.textContent.trim() || '', analyzeButton: button?.textContent.replace(/\\s+/g,' ').trim() || '', stages: [...document.querySelectorAll('.change-safety-stage')].map((node) => node.textContent.replace(/\\s+/g,' ').trim()), blockers: [...document.querySelectorAll('.change-safety-blockers p')].map((node)=>node.textContent.replace(/\\s+/g,' ').trim()) }; })()"
	);
	if (state.error) throw new Error("Analysis failed: " + state.error);
	if (state.stages.length === 5 && state.stages[0]?.includes("Impact") && state.stages[0]?.includes("affected")) return state;
	throw new Error("Analysis not ready: " + JSON.stringify({ ...state, runtimeErrors: runtimeErrors.slice(-3) }));
}, "Change Safety analysis", 15000);

for (const label of ["Impact", "Environment drift", "Rehearsal", "Contract", "Proof"]) {
	if (!analysisState.stages.some((value) => value.includes(label))) throw new Error("Missing stage: " + label);
}
pass("backend analysis renders Impact -> Drift -> Rehearsal -> Contract -> Proof");

for (const width of [1440, 1024, 768, 375]) {
	await viewport(width, width === 375 ? 760 : 900);
	const overflow = await dialogOverflow(".change-safety-dialog");
	if (!overflow || overflow.scroll > 2 || overflow.offenders.length > 0) {
		throw new Error("Change Safety overflow at " + width + ": " + JSON.stringify(overflow));
	}
	await screenshot("change-safety-analysis-" + width);
}
await viewport(1440);
pass("Change Safety is overflow-free at 375/768/1024/1440");

const contractBefore = await evaluate(
	"([...document.querySelectorAll('.change-safety-stage')].find((node)=>node.textContent.includes('Contract'))?.textContent || '').replace(/\\s+/g,' ').trim()"
);
if (!/0 missing/.test(contractBefore) || /[1-9][0-9]* bound to an older snapshot/.test(contractBefore)) {
	await clickText(".change-safety-dialog button", "Generate contracts from source", "Generate contracts from source");
	await retry(async () => {
		const state = await evaluate(
			"(() => ({ error: document.querySelector('.change-safety-dialog .dialog-error')?.textContent.trim() || '', notice: document.querySelector('.change-safety-contract-notice')?.textContent.trim() || '', contract: ([...document.querySelectorAll('.change-safety-stage')].find((node)=>node.textContent.includes('Contract'))?.textContent || '').replace(/\\s+/g,' ').trim() }))()"
		);
		if (state.error) throw new Error("Contract generation failed: " + state.error);
		return state.notice && /0 missing/.test(state.contract) && /0 bound to an older snapshot/.test(state.contract) ? state : null;
	}, "contract generation", 45000);
	pass("missing contract generated and published from source response");
} else {
	pass("affected request already has a current published contract");
}

await clickText(".change-safety-dialog button", "Run rehearsal & generate proof", "Run rehearsal");
const complete = await retry(async () => {
	const state = await evaluate(
		"(() => ({ error: document.querySelector('.change-safety-dialog .dialog-error')?.textContent.trim() || '', proof: ([...document.querySelectorAll('.change-safety-stage')].find((node)=>node.textContent.includes('Proof'))?.textContent || '').replace(/\\s+/g,' ').trim(), openProof: [...document.querySelectorAll('.change-safety-dialog button')].some((node)=>!node.disabled && node.textContent.includes('Open Verification Proof')) }))()"
	);
	if (state.error) throw new Error("Rehearsal/proof failed: " + state.error);
	return state.openProof && !state.proof.includes("Not generated") ? state : null;
}, "rehearsal and proof", 60000);
if (!/VERIFIED|BLOCKED|NEEDS_REHEARSAL|UNKNOWN/.test(complete.proof)) {
	throw new Error("Proof stage has no canonical backend state: " + complete.proof);
}
await screenshot("change-safety-proof-ready-1440");
pass("target rehearsal -> compatibility -> verification -> proof completes");

await clickText(".change-safety-dialog button", "Open Verification Proof", "Open Verification Proof");
await waitFor('document.querySelector(".verification-proof-dialog") !== null', "Verification Proof dialog");
const proofState = await retry(async () => {
	const state = await evaluate(
		"(() => ({ error: document.querySelector('.verification-proof-dialog .dialog-error')?.textContent.trim() || '', text: document.querySelector('.verification-proof-dialog')?.textContent.replace(/\\s+/g,' ').trim() || '' }))()"
	);
	if (state.error) throw new Error("Generated proof verification failed: " + state.error);
	return state.text.includes("Verification state") && state.text.includes("Report status") ? state : null;
}, "generated proof validation");
if (!/VERIFIED|BLOCKED|NEEDS REHEARSAL|UNKNOWN/.test(proofState.text)) throw new Error("Proof dialog did not show a canonical verification state");
await screenshot("verification-proof-generated-1440");
pass("generated proof opens in the canonical Verification Proof surface");

await viewport(375, 760);
const proofOverflow = await dialogOverflow(".verification-proof-dialog");
if (!proofOverflow || proofOverflow.scroll > 2 || proofOverflow.offenders.length > 0) {
	throw new Error("Verification Proof overflow at 375px: " + JSON.stringify(proofOverflow));
}
await screenshot("verification-proof-generated-375");
await viewport(1440);
pass("generated proof is usable at phone width");

if (runtimeErrors.length > 0) throw new Error("Browser runtime/console errors: " + runtimeErrors.join(" | "));

let index = "<!doctype html><html><head><meta charset='utf-8'><title>Tracer Change Safety E2E</title>";
index += "<style>body{font-family:system-ui;margin:24px;background:#111;color:#eee}figure{margin:0 0 24px}img{max-width:100%;border:1px solid #444}</style>";
index += "</head><body><h1>Tracer Change Safety browser evidence</h1><p>" + checks.length + " checks passed.</p>";
for (const file of screenshots) index += "<figure><figcaption>" + file + "</figcaption><img src='" + file + "' alt='" + file + "'></figure>";
index += "</body></html>";
writeFileSync(join(OUTPUT, "index.html"), index);

socket.close();
await fetch(CDP + "/json/close/" + target.id).catch(() => null);
process.stdout.write("\nDONE: " + checks.length + " Change Safety browser checks passed.\n");
