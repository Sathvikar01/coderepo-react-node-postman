/*
 * Phase 37 — Investigation acceptance, final real-browser verification (raw CDP, no new dependencies).
 *
 * This is the acceptance counterpart to the Phase 36 state-matrix harness. It runs ONE
 * deterministic seeded/local scenario and observes the complete evidence chain through the
 * real React UI, ending with the step Phase 36 did not perform: manually Sending the
 * capsule-imported draft and confirming it reproduces the failure.
 *
 *   saved request succeeds
 *     → introduce a replayable change (URL /status/200 → /status/500)
 *     → the later execution fails
 *     → Tracer resolves the regression boundary
 *     → comparison and the 8-question view render truthful evidence
 *     → the counterfactual probe proves the causal change (apply reproduces / revert removes)
 *     → the minimizer produces a smallest reproducer
 *     → the reproduction series is reliable
 *     → a secret-safe Repro Capsule is exported
 *     → the capsule imports as an unsent, unsaved dirty draft (no auto-send / auto-save)
 *     → the imported draft MANUALLY reproduces the failure
 *
 * Then it verifies the 375/768/1024/1440 × dark/light overflow matrix and zero console errors,
 * saving screenshots under ~/hackerrank_postman/phase37-browser-evidence.
 *
 * Run with Chrome started: chrome --remote-debugging-port=9222 (app served on :3000 and a
 * seeded backend on :8000). No results are inferred from Phase 36.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CDP = process.env.P37_CDP ?? "http://127.0.0.1:9222";
const APP = process.env.P37_APP ?? "http://127.0.0.1:3000";
const API_TARGET = process.env.P37_API ?? "8000";
const EVIDENCE_DIR = join(homedir(), "hackerrank_postman", "phase37-browser-evidence");
mkdirSync(EVIDENCE_DIR, { recursive: true });
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
		await sleep(150);
	}
	throw new Error(label + " timed out" + (last ? ": " + last.message : ""));
}

await retry(async () => (await fetch(CDP + "/json/version")).ok, "Chrome CDP");
try {
	const existing = await (await fetch(CDP + "/json/list")).json();
	await Promise.all(
		existing.filter((entry) => entry.type === "page").slice(1).map((entry) => fetch(CDP + "/json/close/" + entry.id).catch(() => {})),
	);
	await sleep(400);
} catch {
	// Best effort cleanup only.
}
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
		const details = message.params?.exceptionDetails || {};
		runtimeErrors.push(details.exception?.description || details.text || "Unhandled browser exception");
	}
	if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
		const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
		if (!text.includes("Failed to load resource")) runtimeErrors.push("console.error: " + text);
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
	const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
	}
	return result.result?.value;
}

async function waitFor(expression, label, timeout = 20000) {
	return retry(() => evaluate(expression), label, timeout);
}

async function click(selector, label = selector) {
	const ok = await evaluate(
		"(() => { const node = document.querySelector(" + JSON.stringify(selector) + "); if (!node || node.disabled || node.getClientRects().length === 0) return false; node.focus(); node.click(); return true; })()",
	);
	if (!ok) throw new Error("Could not click " + label);
}

async function clickButtonText(text, timeout = 10000) {
	return retry(() => {
		const ok = evaluate(
			"(() => { const target = " +
				JSON.stringify(text) +
				"; const node = [...document.querySelectorAll('button')].find((button) => !button.disabled && button.getClientRects().length > 0 && button.textContent.trim().includes(target)); if (!node) return false; node.focus(); node.click(); return true; })()",
		);
		return ok;
	}, "button: " + text, timeout);
}

async function setInput(selector, value) {
	try {
		await call("DOM.enable");
		const doc = await call("DOM.getDocument");
		const found = await call("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
		if (found?.nodeId) await call("DOM.focus", { nodeId: found.nodeId });
	} catch {
		// Focusing via DOM is best effort; the synthetic value set below still applies.
	}
	const ok = await evaluate(
		"(() => { const node = document.querySelector(" +
			JSON.stringify(selector) +
			"); if (!node) return false; const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set; if (!setter) return false; setter.call(node, " +
			JSON.stringify(value) +
			"); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()",
	);
	if (!ok) throw new Error("Could not set " + selector);
	await retry(async () => (await evaluate("document.querySelector(" + JSON.stringify(selector) + ")?.value")) === value, "value committed to " + selector);
}

async function setRequestUrl(url) {
	await setInput('input[aria-label="Request URL"]', url);
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sendAndWait(expectedUrl = null) {
	if (expectedUrl) await setRequestUrl(expectedUrl);
	// Wait for the *next* terminal result. A previously completed send leaves a status pill on
	// screen, so waiting merely for "a terminal status" races ahead and reads the stale value.
	const before = await evaluate('document.querySelector(".response-toolbar .status-pill")?.textContent?.trim() || ""');
	await click(".send-button", "Send");
	const wait = `(() => {
		const text = document.querySelector('.response-toolbar .status-pill')?.textContent?.trim() || '';
		const terminal = /^\\d{3}\\b/.test(text) || /^(Cancelled|Blocked|Failed|Error|Timed out)/i.test(text);
		return terminal && text !== ${JSON.stringify(before)};
	})()`;
	await waitFor(wait, "terminal send result", 30000);
	await sleep(300);
}

async function responseStatus() {
	// A fresh tab renders a placeholder ("Not sent") before the first terminal result, so wait
	// for a real status number or an explicit terminal outcome before reading the pill.
	await waitFor(
		"(() => { const text = document.querySelector('.response-toolbar .status-pill')?.textContent?.trim() || ''; return /^\\d{3}\\b/.test(text) || /^(Cancelled|Blocked|Failed|Error|Timed out)/i.test(text); })()",
		"terminal response status",
		30000,
	);
	return evaluate('document.querySelector(".response-toolbar .status-pill")?.textContent?.trim() || ""');
}

async function expectStatus(expected) {
	const status = await responseStatus();
	if (!new RegExp("^" + expected + "\\b").test(status)) throw new Error('Expected HTTP ' + expected + ' but the response viewer showed "' + status + '"');
	return status;
}

async function pressKey(key, code, virtualKeyCode) {
	await call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKeyCode });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKeyCode });
	await sleep(120);
}

async function viewport(width, height = 900) {
	await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
	await sleep(150);
}

async function screenshot(name) {
	const shot = await call("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(EVIDENCE_DIR, name + ".png"), Buffer.from(shot.data, "base64"));
}

async function api(method, path, body = null) {
	const payload = await evaluate(
		"(async () => { const token = localStorage.getItem('request-desk-profile-token') || localStorage.getItem('request-desk-session-token'); const response = await fetch('/api/v1" +
			path +
			"', { method: " +
			JSON.stringify(method) +
			", headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, " +
			(body ? "body: JSON.stringify(" + JSON.stringify(body) + ")" : "") +
			" }); const text = await response.text(); return { ok: response.ok, status: response.status, text }; })()",
	);
	const payloadData = payload.text ? JSON.parse(payload.text) : null;
	if (payloadData?.error) throw new Error(method + " " + path + " failed: " + JSON.stringify(payloadData.error));
	if (!payload.ok && payload.status !== 204) throw new Error(method + " " + path + " failed: HTTP " + payload.status + " " + payload.text.slice(0, 200));
	return payloadData?.data;
}

const checks = [];
function pass(name) {
	checks.push(name);
	process.stdout.write("PASS " + name + "\n");
}

function requestDefinition(id, name, method, urlTemplate, extra = {}) {
	return {
		schemaVersion: 1,
		id,
		folderId: null,
		name,
		method,
		urlTemplate,
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		scripts: { preRequest: "", test: "" },
		assertions: [],
		settings: { timeoutMs: 30000 },
		...extra,
	};
}

async function createCollectionWithRequests(name, requests) {
	// Idempotent: remove any collection left behind by a previous run so the scenario is repeatable.
	const existing = await api("GET", "/collections");
	const stale = (Array.isArray(existing) ? existing : existing?.items ?? []).filter((item) => item?.name === name);
	for (const item of stale) {
		const id = item._id ?? item.id;
		if (id) await api("DELETE", `/collections/${id}?revision=${item.revision ?? 1}`);
	}
	const created = await api("POST", "/collections", { name });
	const collectionId = created?._id ?? created?.collection?._id;
	const revision = created?.revision ?? created?.collection?.revision ?? 1;
	if (!collectionId) throw new Error("Collection create returned unexpected shape: " + JSON.stringify(created));
	await api("PUT", `/collections/${collectionId}`, {
		expectedRevision: revision,
		collection: { name, description: "", variables: [], auth: { mode: "none" }, folders: [], requests },
	});
	return collectionId;
}

async function ensureCollectionsPanel() {
	const visible = await evaluate("(() => [...document.querySelectorAll('.tree-label')].some((label) => label.getClientRects().length > 0))()");
	if (!visible) await click('[aria-label="Open collections"]', "Collections rail");
	await retry(() => evaluate("document.querySelector('.sidebar-tab[aria-selected=true]')?.textContent.includes('Collections')"), "Collections tab");
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

const dialogText = () => evaluate("document.querySelector('dialog[open]')?.textContent || ''");

async function waitForInvestigationComplete(timeout = 60000) {
	await waitFor(
		"document.querySelector('[data-testid=investigation-status]')?.textContent.includes('Investigation complete') || document.querySelector('[data-testid=investigation-status]')?.textContent.includes('Investigation cancelled')",
		"investigation terminal state",
		timeout,
	);
}

function assertNoPercentOrConfidence(text) {
	if (/\d+\s*%|\d+ percent|confidence/i.test(text)) throw new Error("Investigation UI leaked a confidence/percentage claim: " + text.slice(0, 300));
	for (const raw of ["not_causal", "leading_divergence", "correlated_change", "not_replayable", "verificationStatus", "minimality:"]) {
		if (text.includes(raw)) throw new Error("Investigation UI exposed raw model vocabulary: " + raw);
	}
}

const QUESTIONS = [
	"What happened?",
	"When did it start?",
	"What changed?",
	"What was experimentally verified to cause it?",
	"What remains unverified?",
	"What is the smallest reproducer?",
	"Does it reproduce reliably?",
	"Export Repro Capsule",
];

/* ------------------------------------------------------------------ S1 login */
await call("Page.enable");
await call("Runtime.enable");
await call("Page.addScriptToEvaluateOnNewDocument", {
	source: `
		window.__p37FetchLog = [];
		window.__p37Blobs = [];
		const __p37OriginalFetch = window.fetch.bind(window);
		window.fetch = (...args) => {
			try {
				const input = args[0];
				const url = typeof input === "string" ? input : (input && input.url) || String(input);
				const method = ((args[1] && args[1].method) || (input && input.method) || "GET").toUpperCase();
				window.__p37FetchLog.push(method + " " + url);
			} catch {}
			return __p37OriginalFetch(...args);
		};
		const __p37CreateObjectURL = URL.createObjectURL.bind(URL);
		URL.createObjectURL = (blob) => {
			try { blob.text().then((text) => window.__p37Blobs.push(text)).catch(() => {}); } catch {}
			return __p37CreateObjectURL(blob);
		};
	`,
});
await viewport(1440);
let loginReady = false;
for (let attempt = 0; attempt < 3 && !loginReady; attempt += 1) {
	await call("Page.navigate", { url: APP });
	await sleep(1200);
	await evaluate("localStorage.clear(); true");
	await call("Page.navigate", { url: APP });
	try {
		await waitFor('document.querySelector("#workspace-email") !== null', "login screen", 8000);
		loginReady = true;
	} catch (error) {
		const body = await evaluate("document.body.textContent.replace(/\\s+/g, ' ').slice(0, 160)");
		console.log("DEBUG login attempt " + (attempt + 1) + " body:", JSON.stringify(body), "errors:", JSON.stringify(runtimeErrors.slice(-3)));
	}
}
if (!loginReady) throw new Error("login screen never appeared");
await setInput("#workspace-email", "alex.morgan@example.test");
await setInput("#workspace-password", "password123");
await evaluate('document.querySelector(".workspace-login-card form").requestSubmit(); true');
await waitFor('[...document.querySelectorAll("button")].some((node) => node.getAttribute("aria-label")?.startsWith("Continue as"))', "profile picker");
await click('[aria-label^="Continue as"]', "profile");
await waitFor('document.querySelector(".app-shell") !== null', "workspace");
pass("login -> profile -> workspace");

/* ------------------------------------------------------------------ S2 setup */
const ROW = (id, key, value) => ({ id, key, value, enabled: true });
const UUID = (n) => `${String(n).padStart(8, "0")}-1111-4222-8333-444444444444`;
const SECRET = "super-secret-987";
const GOOD_URL = `http://127.0.0.1:${API_TARGET}/demo/v1/status/200`;
const BAD_URL = `http://127.0.0.1:${API_TARGET}/demo/v1/status/500`;

await createCollectionWithRequests("P37 Acceptance", [requestDefinition(UUID(1), "Status probe", "GET", GOOD_URL)]);
await createCollectionWithRequests("P37 Secret", [
	requestDefinition(UUID(2), "Secret probe", "GET", GOOD_URL, { headers: [ROW(UUID(21), "Authorization", `Bearer ${SECRET}`)] }),
]);
pass("seeded the deterministic acceptance collections through the real collections API");
await call("Page.navigate", { url: APP });
await waitFor('document.querySelector(".app-shell") !== null', "workspace after reload", 40000);
await sleep(600);

/* --------------------------------------------- S3 saved request succeeds (1) */
await openRequestFromCollections("P37 Acceptance", "Status probe");
await sendAndWait();
{
	await expectStatus(200);
	const hasEntry = await evaluate("[...document.querySelectorAll('.response-area button')].some((b) => b.textContent.includes('Investigate'))");
	if (hasEntry) throw new Error("Investigate entry point appeared on a successful execution");
}
pass("a saved request succeeds and a passing run exposes no Investigate entry point");

/* ---------------------------------- S4 replayable change + failure (3 + 4) */
await sendAndWait(BAD_URL);
await expectStatus(500);
pass("introducing one replayable change makes the later execution fail");

/* --------------------------- S5 investigate: verified cause + minimization */
await retry(() => evaluate("[...document.querySelectorAll('.response-area button')].some((b) => b.textContent.trim() === 'Investigate failure')"), "Investigate failure button");
await clickButtonText("Investigate failure");
await waitFor('document.querySelector("dialog[open]") !== null', "investigation dialog");
await waitFor('document.querySelector("button[data-autofocus]") !== null', "investigation pre-start card", 15000);
await clickButtonText("Start investigation");
await waitForInvestigationComplete();
{
	const text = await dialogText();
	for (const question of QUESTIONS) {
		if (!text.includes(question)) throw new Error("Missing investigation question: " + question);
	}
	if (!text.includes("Verified cause")) throw new Error("Verified cause not shown");
	if (!/reverted → failure disappeared/.test(text)) throw new Error("Apply/revert evidence line missing");
	if (!text.includes("Failure begins between passing run")) throw new Error("Regression boundary not resolved: " + text.slice(0, 400));
	if (!text.includes("chronological evidence only")) throw new Error("Boundary disclaimer missing");
	if (!/Removed \d+ of \d+/.test(text)) throw new Error("Minimization summary missing");
	if (!/reproduced/i.test(text)) throw new Error("Reproduction reliability statement missing");
	if (!text.includes("Available")) throw new Error("Capsule availability line missing");
	assertNoPercentOrConfidence(text);
}
pass("investigation shows the regression boundary, verified causal change, minimized reproducer, reliability, and capsule availability");
await screenshot("phase37-investigation-verified-1440-dark");

/* ------------------------- S6 secret-safe capsule export (13) ------------------------- */
{
	const blobsBefore = await evaluate("window.__p37Blobs.length");
	await clickButtonText("Export Repro Capsule");
	await retry(() => evaluate("window.__p37Blobs.length > " + blobsBefore), "capsule blob captured", 15000);
	const capsuleText = await evaluate("window.__p37Blobs[window.__p37Blobs.length - 1]");
	const capsule = JSON.parse(capsuleText);
	if (capsule.kind !== "tracer.repro-capsule" || capsule.schemaVersion !== 1) throw new Error("Capsule envelope is wrong");
	if (capsuleText.includes(SECRET)) throw new Error("Capsule leaked the resolved credential");
	if (!JSON.stringify(capsule.request).includes("/status/500")) throw new Error("Capsule does not carry the failing request");
	assertNoPercentOrConfidence(capsuleText);
}
pass("exported Repro Capsule is versioned, carries the failing request, and leaks no credential");

/* ------------- S7 capsule imports as unsent/unsaved draft (14 + 15) ------------- */
// Baseline the mutation log now so the import step can prove it caused no send/save of its own.
const mutatingBaseline = await evaluate(
	"window.__p37FetchLog.filter((entry) => entry.startsWith('POST /api/v1/executions') || entry.startsWith('POST /api/v1/collections') || entry.startsWith('PUT /api/v1/collections')).length",
);
await clickButtonText("Open as draft");
await waitFor('document.querySelectorAll("dialog[open]").length === 0', "dialog closed after Open as draft");
await waitFor('document.querySelector(".dirty-dot") !== null', "dirty draft tab after Open as draft");
{
	const toast = await evaluate("[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')");
	if (!toast.includes("unsent, unsaved")) throw new Error("Open as draft did not confirm the unsent/unsaved draft: " + toast);
	const draftUrl = await evaluate('document.querySelector(\'input[aria-label="Request URL"]\')?.value || ""');
	if (!draftUrl.includes("/status/500")) throw new Error("Imported draft does not carry the failing URL: " + draftUrl);
	const sentOrSaved = await evaluate(
		"window.__p37FetchLog.filter((entry) => entry.startsWith('POST /api/v1/executions') || entry.startsWith('POST /api/v1/collections') || entry.startsWith('PUT /api/v1/collections')).length",
	);
	if (sentOrSaved !== mutatingBaseline) throw new Error("Importing the capsule triggered an automatic send or save (" + (sentOrSaved - mutatingBaseline) + " call(s))");
}
pass("capsule imports through the normalized boundary as an unsent, dirty draft with no auto-send and no auto-save");

/* ----------------- S8 manual reproduction of the imported draft (16) ----------------- */
{
	const sendsBefore = await evaluate("window.__p37FetchLog.filter((entry) => entry.startsWith('POST /api/v1/executions')).length");
	await sendAndWait();
	const sendsAfter = await evaluate("window.__p37FetchLog.filter((entry) => entry.startsWith('POST /api/v1/executions')).length");
	if (sendsAfter !== sendsBefore + 1) throw new Error("Manual Send did not dispatch exactly one execution request");
	await expectStatus(500);
	await screenshot("phase37-manual-reproduction-1440-dark");
}
pass("the imported draft manually reproduces the failure through a user-initiated Send");

/* --------------------- S9 secret-bearing request capsule is redacted --------------------- */
await openRequestFromCollections("P37 Secret", "Secret probe");
await sendAndWait(GOOD_URL);
await expectStatus(200);
await sendAndWait(BAD_URL);
await expectStatus(500);
await retry(() => evaluate("[...document.querySelectorAll('.response-area button')].some((b) => b.textContent.trim() === 'Investigate failure')"), "Investigate failure button");
await clickButtonText("Investigate failure");
await waitFor('document.querySelector("dialog[open]") !== null', "investigation dialog");
await waitFor('document.querySelector("button[data-autofocus]") !== null', "investigation pre-start card", 15000);
await clickButtonText("Start investigation");
await waitForInvestigationComplete();
{
	const blobsBefore = await evaluate("window.__p37Blobs.length");
	await clickButtonText("Export Repro Capsule");
	await retry(() => evaluate("window.__p37Blobs.length > " + blobsBefore), "auth capsule blob captured", 15000);
	const capsuleText = await evaluate("window.__p37Blobs[window.__p37Blobs.length - 1]");
	if (capsuleText.includes(SECRET)) throw new Error("Auth-bearing capsule leaked the credential");
	const capsule = JSON.parse(capsuleText);
	const headers = (capsule.request?.headers || []).map((header) => ({ key: String(header.key ?? header.name ?? "").toLowerCase(), value: String(header.value ?? "") }));
	const authHeader = headers.find((header) => header.key === "authorization" || header.key.includes("auth"));
	if (authHeader) {
		if (!authHeader.value.includes("{{capsule_")) throw new Error("Auth-bearing capsule kept a literal Authorization value");
		if (!capsuleText.includes("{{capsule_header_authorization}}") && !(capsule.requiredInputs || []).some((input) => /authorization/i.test(input.name)))
			throw new Error("Auth-bearing capsule did not document the authorization input");
	}
}
pass("an auth-bearing capsule is secret-redacted and documents the required input");
await pressKey("Escape", "Escape", 27);

/* ------------- S10 375/768/1024/1440 x dark/light overflow matrix ------------- */
await openRequestFromCollections("P37 Acceptance", "Status probe");
await sendAndWait(GOOD_URL);
await expectStatus(200);
await sendAndWait(BAD_URL);
await expectStatus(500);
await retry(() => evaluate("[...document.querySelectorAll('.response-area button')].some((b) => b.textContent.trim() === 'Investigate failure')"), "Investigate failure button");
await clickButtonText("Investigate failure");
await waitFor('document.querySelector("dialog[open]") !== null', "investigation dialog");
await waitFor('document.querySelector("button[data-autofocus]") !== null', "investigation pre-start card", 15000);
await clickButtonText("Start investigation");
await waitForInvestigationComplete();

for (const width of [375, 768, 1024, 1440]) {
	for (const theme of ["dark", "light"]) {
		await viewport(width, width === 375 ? 760 : 900);
		const current = await evaluate('document.documentElement.dataset.theme || "dark"');
		if (current !== theme) {
			await click('[aria-label^="Switch to "]', "theme");
			await retry(async () => (await evaluate('document.documentElement.dataset.theme || "dark"')) === theme, "theme " + theme);
		}
		const overflow = await evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
		if (overflow > 1) throw new Error(`Document overflow at ${width}px/${theme}: ${overflow}px`);
		const dialogOverflow = await evaluate(
			"(() => { const dialog = document.querySelector('dialog[open]'); if (!dialog) return { over: -1, offenders: [] }; const box = dialog.getBoundingClientRect(); const offenders = [...dialog.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > box.right + 1).slice(0, 6).map((el) => el.tagName + '.' + (typeof el.className === 'string' ? el.className : '') + ' +' + Math.round(el.getBoundingClientRect().right - box.right) + ' :: ' + el.textContent.trim().slice(0, 48)); return { over: dialog.scrollWidth - dialog.clientWidth, offenders }; })()",
		);
		if (dialogOverflow.over > 1)
			throw new Error(`Dialog overflow at ${width}px/${theme}: ${dialogOverflow.over}px :: ${JSON.stringify(dialogOverflow.offenders)}`);
		await screenshot(`phase37-investigation-${width}-${theme}`);
		pass(`investigation dialog fits ${width}px in the ${theme} theme with zero horizontal overflow`);
	}
}

/* -------------------------------------------------- S11 final console/teardown */
await viewport(1440);
if (runtimeErrors.length) throw new Error("Browser exceptions/console errors: " + runtimeErrors.join(" | "));
pass("zero unhandled browser exceptions and zero console errors across the acceptance flow");
await screenshot("phase37-final-state");
process.stdout.write("PHASE37_E2E_PASS " + checks.length + "/" + checks.length + "\n");
socket.close();
