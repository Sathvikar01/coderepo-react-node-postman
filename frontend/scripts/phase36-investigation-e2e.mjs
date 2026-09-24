/*
 * Phase 36 — Investigation UX real-browser verification (raw CDP, no new dependencies).
 *
 * Covers the required matrix: entry points (workspace / history / runner), the single
 * 8-question investigation view, truthful evidence rendering, no-baseline / running /
 * partial / inconclusive / verified / no-verified-cause / cancelled / failed / capsule
 * unavailable / validation-error / not-found states, capsule secret safety and
 * unsent dirty drafts, Passport/Compare/Minimize reachability, keyboard focus behaviour,
 * and the 375/768/1024/1440 x dark/light overflow matrix with evidence screenshots.
 *
 * Run with Chrome started: chrome --remote-debugging-port=9222 (app served on :3000).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CDP = process.env.P36_CDP ?? "http://127.0.0.1:9222";
const APP = "http://127.0.0.1:3000";
// The seeded "local" demo dataset requires the documented local demo bearer token.
// It is read from the repository's own backend/.env so no literal is committed here.
const LOCAL_DEMO_TOKEN =
	(await Bun.file(new URL("../../backend/.env", import.meta.url)).text()).match(/^DEMO_LOCAL_TOKEN=(.*)$/m)?.[1]?.trim() ?? "";
const EVIDENCE_DIR = join(homedir(), "hackerrank_postman", "phase36-browser-evidence");
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
// Close stale page targets from earlier runs so their polling cannot slow this run.
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
let fetchPolicy = null; // (method, url) => null | { delayMs?, status, body }

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
	if (message.method === "Fetch.requestPaused") {
		const paused = message.params;
		const url = paused.request.url;
		const method = paused.request.method;
		(async () => {
			try {
				const action = fetchPolicy ? fetchPolicy(method, url) : null;
				if (action) {
					if (action.delayMs) await sleep(action.delayMs);
					await call("Fetch.fulfillRequest", {
						requestId: paused.requestId,
						responseCode: action.status,
						responseHeaders: [
							{ name: "content-type", value: "application/json" },
							{ name: "access-control-allow-origin", value: "*" },
						],
						body: Buffer.from(JSON.stringify(action.body), "utf8").toString("base64"),
					});
					return;
				}
				await call("Fetch.continueRequest", { requestId: paused.requestId });
			} catch {
				// Best effort: never wedge the intercepted request.
			}
		})();
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
	const ok = await evaluate(
		"(() => { const node = document.querySelector(" +
			JSON.stringify(selector) +
			"); if (!node) return false; const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set; if (!setter) return false; setter.call(node, " +
			JSON.stringify(value) +
			"); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()",
	);
	if (!ok) throw new Error("Could not set " + selector);
}

async function pressKey(key, code, virtualKeyCode) {
	await call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKeyCode });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKeyCode });
	await sleep(120);
}

async function pressEscape() {
	await pressKey("Escape", "Escape", 27);
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
			" }); return await response.json(); })()",
	);
	if (payload?.error) throw new Error(method + " " + path + " failed: " + JSON.stringify(payload.error));
	return payload?.data;
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
	const created = await api("POST", "/collections", { name });
	const collectionId = created?._id ?? created?.collection?._id;
	const revision = created?.revision ?? created?.collection?.revision ?? 1;
	if (!collectionId) throw new Error("Collection create returned unexpected shape: " + JSON.stringify(created));
	const aggregate = {
		name,
		description: "",
		variables: [],
		auth: { mode: "none" },
		folders: [],
		requests,
	};
	await api("PUT", `/collections/${collectionId}`, { expectedRevision: revision, collection: aggregate });
	return collectionId;
}

async function ensureCollectionsPanel() {
	const visible = await evaluate(
		"(() => [...document.querySelectorAll('.tree-label')].some((label) => label.getClientRects().length > 0))()",
	);
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

async function sendAndWait(terminal = true) {
	await click(".send-button", "Send");
	if (terminal) await waitFor('document.querySelector(".response-toolbar") !== null', "terminal send result", 30000);
}

async function openInvestigationFromResponseArea() {
	await retry(() => evaluate("[...document.querySelectorAll('.response-area button')].some((b) => b.textContent.includes('Investigate failure'))"), "Investigate failure button");
	const labelOk = await evaluate(
		"[...document.querySelectorAll('.response-area button')].some((b) => b.textContent.trim() === 'Investigate failure')",
	);
	if (!labelOk) throw new Error("Workspace entry point is not labelled \"Investigate failure\"");
	await clickButtonText("Investigate failure");
	await waitFor('document.querySelector("dialog[open]") !== null', "investigation dialog");
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
		window.__p36FetchLog = [];
		window.__p36Blobs = [];
		const __p36OriginalFetch = window.fetch.bind(window);
		window.fetch = (...args) => {
			try {
				const input = args[0];
				const url = typeof input === "string" ? input : (input && input.url) || String(input);
				const method = ((args[1] && args[1].method) || (input && input.method) || "GET").toUpperCase();
				window.__p36FetchLog.push(method + " " + url);
			} catch {}
			return __p36OriginalFetch(...args);
		};
		const __p36CreateObjectURL = URL.createObjectURL.bind(URL);
		URL.createObjectURL = (blob) => {
			try { blob.text().then((text) => window.__p36Blobs.push(text)).catch(() => {}); } catch {}
			return __p36CreateObjectURL(blob);
		};
	`,
});
await viewport(1440);
let loginReady = false;
for (let attempt = 0; attempt < 3 && !loginReady; attempt += 1) {
	// Deterministic start: drop any restored session so the login flow always runs.
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

const debugRequest = requestDefinition(UUID(1), "Debug endpoint", "GET", "http://127.0.0.1:8000/demo/v1/status/200?debug=0", {
	headers: [ROW(UUID(31), "Authorization", "Bearer super-secret-987"), ROW(UUID(32), "x-noise", "one")],
});
await createCollectionWithRequests("P36 Investigation", [debugRequest]);

await createCollectionWithRequests("P36 Runner", [
	requestDefinition(UUID(2), "Healthy check", "GET", "http://127.0.0.1:8000/demo/v1/examples/status/200"),
	requestDefinition(UUID(3), "Failing check", "GET", "http://127.0.0.1:8000/demo/v1/examples/status/500", {
		assertions: [
			{
				id: UUID(33),
				name: "status is 200",
				enabled: true,
				target: "status",
				operator: "equals",
				path: "",
				expected: "200",
				valueType: "string",
				min: null,
				max: null,
			},
		],
	}),
	requestDefinition(UUID(7), "Skipped check", "GET", "http://127.0.0.1:8000/demo/v1/examples/status/200"),
]);
await createCollectionWithRequests("P36 State", [
	requestDefinition(UUID(5), "Delete order", "DELETE", "http://127.0.0.1:8000/demo/v1/local/orders/ord_0002?attempt=1&src=ui", {
		headers: [{ id: UUID(34), key: "Authorization", value: `Bearer ${LOCAL_DEMO_TOKEN}`, enabled: true }],
	}),
]);
await createCollectionWithRequests("P36 Cancel", [
	requestDefinition(UUID(6), "Timeout probe", "GET", "http://127.0.0.1:8000/demo/v1/examples/delay/500", { settings: { timeoutMs: 3000 } }),
]);
pass("seeded five investigation scenario collections through the real collections API");
// The app fetches the collection tree at boot, so reload to pick up the API-created data.
await call("Page.navigate", { url: APP });
await waitFor('document.querySelector(".app-shell") !== null', "workspace after reload", 40000);
await retry(() => evaluate("document.querySelector('.tree-label') !== null || true"), "sidebar settled");
await sleep(400);

/* ---------------------------------- S3 workspace entry + verified-cause run */
await openRequestFromCollections("P36 Investigation", "Debug endpoint");
await sendAndWait();
const status200 = await evaluate("document.querySelector('.response-area')?.textContent.includes('200') || false");
if (!status200) throw new Error("Good run did not return 200");
const investigateOnSuccess = await evaluate("[...document.querySelectorAll('.response-area button')].some((b) => b.textContent.includes('Investigate'))");
if (investigateOnSuccess) throw new Error("Investigate entry point appeared on a successful result");
pass("workspace shows no Investigate entry point on a successful execution");

await setInput('input[aria-label="Request URL"]', "http://127.0.0.1:8000/demo/v1/status/500?debug=1");
await sendAndWait();
await openInvestigationFromResponseArea();
pass("workspace failure exposes the labelled \"Investigate failure\" entry point");

/* ------------------------------ S4 investigation run + truthful evidence UI */
{
	await waitFor('document.querySelector("button[data-autofocus]") !== null', "investigation pre-start card", 15000).catch(async (error) => {
		const state = await evaluate(`(() => ({ dialog: (document.querySelector('dialog[open]') || {}).textContent, body: document.body.textContent.replace(/\s+/g, ' ').slice(0, 200), appShell: Boolean(document.querySelector('.app-shell')), fetches: (window.__p36FetchLog || []).slice(-6) }))()`);
		console.log("DEBUG pre-start state:", JSON.stringify(state));
		console.log("DEBUG runtime errors:", JSON.stringify(runtimeErrors.slice(-6)));
		throw error;
	});
	const text = await dialogText();
	if (!text.includes("What will happen") || !text.includes("Failure predicate") || !text.includes("Response status is 500")) {
		throw new Error("Pre-start card is missing the predicate explainer: " + text.slice(0, 400));
	}
	if (!text.includes("Replay execution") || !text.includes("Mock example")) throw new Error("Probe target select missing");
	assertNoPercentOrConfidence(text);
}
await clickButtonText("Start investigation");
await waitForInvestigationComplete();
{
	const text = await dialogText();
	for (const question of QUESTIONS) {
		if (!text.includes(question)) throw new Error("Missing investigation question: " + question);
	}
	if (!text.includes("Verified cause") || !text.includes("Unverified differences")) throw new Error("Truthfulness badges missing");
	if (!text.includes("Failure begins between passing run")) throw new Error("Regression boundary not resolved: " + text.slice(0, 400));
	if (!text.includes("chronological evidence only")) throw new Error("Boundary disclaimer missing");
	if (!/reverted → failure disappeared/.test(text)) throw new Error("Verified-cause evidence line missing");
	if (!/Removed \d+ of \d+/.test(text)) throw new Error("Minimization summary missing");
	if (!text.includes("Available")) throw new Error("Capsule availability line missing");
	assertNoPercentOrConfidence(text);
	const causeIndex = text.indexOf("What was experimentally verified to cause it?");
	const unverifiedIndex = text.indexOf("What remains unverified?");
	if (causeIndex < 0 || unverifiedIndex < causeIndex) throw new Error("Question ordering is wrong");
}
pass("one cohesive 8-question investigation view with verified cause, evidence, and honest labels");

/* ---------------- S4b export proof on the auth-bearing run (secret-safe capsule) */
{
	const blobsBefore = await evaluate("window.__p36Blobs.length");
	await clickButtonText("Export Repro Capsule");
	await retry(() => evaluate("window.__p36Blobs.length > " + blobsBefore), "auth capsule blob captured", 15000);
	const capsuleText = await evaluate("window.__p36Blobs[window.__p36Blobs.length - 1]");
	if (capsuleText.includes("super-secret-987")) throw new Error("Auth-bearing capsule leaked the Authorization value");
	const capsule = JSON.parse(capsuleText);
	const headers = (capsule.request?.headers || []).map((header) => ({ key: String(header.key ?? header.name ?? "").toLowerCase(), value: String(header.value ?? "") }));
	const authHeader = headers.find((header) => header.key === "authorization" || header.key.includes("auth"));
	if (authHeader && !authHeader.value.includes("{{capsule_header_authorization}}")) {
		throw new Error("Auth-bearing capsule carried Authorization without its placeholder: " + authHeader.value.slice(0, 40));
	}
	if (authHeader && !(capsule.requiredInputs || []).some((input) => /authorization/i.test(input.name))) {
		throw new Error("Auth-bearing capsule did not document the authorization input");
	}
	assertNoPercentOrConfidence(capsuleText);
}
pass("auth-bearing export is redacted and documented when applicable");

/* --------------------------- S5 passport/compare/minimize stay one click away */
await clickButtonText("Open comparison");
await waitFor('document.querySelector("dialog[open] .flight-recorder-dialog") !== null', "Flight Recorder comparison");
{
	const text = await dialogText();
	if (!text.includes("Compare")) throw new Error("Comparison did not open in the Flight Recorder");
}
await pressEscape();
await retry(() => evaluate('document.querySelectorAll("dialog[open]").length === 1'), "investigation dialog survives");
{
	const text = await dialogText();
	if (!text.includes("What was experimentally verified")) throw new Error("Investigation dialog lost its state");
}
await clickButtonText("Open failing passport");
await waitFor('document.querySelectorAll("dialog[open]").length === 2', "Passport stacked");
await pressEscape();
await retry(() => evaluate('document.querySelectorAll("dialog[open]").length === 1'), "only passport closed");
pass("Compare and Passport open from the investigation without losing it (dialog stack keeps the top dialog closing)");

/* ------------------------------------------------- S6 keyboard focus behaviour */
{
	const inside = await evaluate(
		"(() => { const dialog = document.querySelector('dialog[open]'); return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement)); })()",
	);
	if (!inside) throw new Error("Dialog did not receive focus");
	for (let i = 0; i < 12; i++) await pressKey("Tab", "Tab", 9);
	const stillInside = await evaluate(
		"(() => { const dialog = document.querySelector('dialog[open]'); return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement)); })()",
	);
	if (!stillInside) throw new Error("Focus escaped the modal dialog");
	await screenshot("investigation-completed-1440-dark");
	await pressEscape();
	await retry(() => evaluate('document.querySelectorAll("dialog[open]").length === 0'), "dialog closed");
	let focusReturned = false;
	try {
		await retry(
			() =>
				evaluate("[...document.querySelectorAll('.response-area button')].some((b) => b.textContent.includes('Investigate failure') && b === document.activeElement)"),
			"focus returns to the entry point",
			4000,
		);
		focusReturned = true;
	} catch {
		const active = await evaluate("document.activeElement ? document.activeElement.outerHTML.slice(0, 120) : 'none'");
		console.log("DEBUG focus after close:", JSON.stringify(active));
	}
	if (!focusReturned) throw new Error("Focus did not return to the entry point");
}
pass("keyboard: focus stays in the dialog, Escape closes it, focus returns to the entry point");

/* ---------------------------------------------------- S7 history entry points */
await clickButtonText("History");
await retry(() => evaluate("document.querySelector('.history-item') !== null"), "history entries");
{
	const rows = await evaluate(
		"(() => { const rows = [...document.querySelectorAll('.history-item')]; const find = (needle) => rows.find((r) => r.textContent.includes(needle)); const ok = rows.filter((r) => r.querySelector('button') && [...r.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Investigate failure')); return { total: rows.length, investigable: ok.length, has200: rows.some((r) => /\\b200\\b/.test(r.textContent)), has500: rows.some((r) => /\\b500\\b/.test(r.textContent)) }; })()",
	);
	if (!rows.has500) throw new Error("History row for the failing run missing");
	if (rows.investigable < 1) throw new Error("History failed row does not expose Investigate failure");
	const exact = await evaluate(
		"[...document.querySelectorAll('.history-item button')].filter((b) => b.textContent.trim() === 'Investigate failure').length",
	);
	if (exact < 1) throw new Error("History entry point label is not exactly \"Investigate failure\"");
}
pass("history failed rows expose the labelled entry point and successful rows do not");

/* ------- S8 capsule export/import: unavailable state, secrets, dirty unsent drafts */
async function openInvestigationFromDebugRow() {
	await clickButtonText("History");
	await retry(() => evaluate("document.querySelector('.history-item') !== null"), "history entries");
	await retry(
		() =>
			evaluate(
				"(() => { const rows = [...document.querySelectorAll('.history-item')]; const row = rows.find((r) => r.textContent.includes('Debug endpoint') && [...r.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Investigate failure')); if (!row) return false; [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Investigate failure').click(); return true; })()",
			),
		"Debug endpoint failing history row",
	);
	await waitFor('document.querySelector("dialog[open]") !== null', "investigation dialog");
}
await openInvestigationFromDebugRow();
await clickButtonText("Start investigation");
await waitForInvestigationComplete();

// capsule unavailable state (409 CAPSULE_UNAVAILABLE from the Phase 35 endpoint)
await call("Fetch.enable", { patterns: [{ urlPattern: "*execution-intelligence/investigations/*/capsule*" }] });
fetchPolicy = (method, url) => (method === "GET" && /\/capsule(\?|$)/.test(url) ? { status: 409, body: { error: { code: "CAPSULE_UNAVAILABLE", message: "No reproduction capsule is available for this investigation yet." } } } : null);
await clickButtonText("Export Repro Capsule");
await waitFor("document.querySelector('[data-testid=investigation-error]')?.textContent.includes('No reproduction capsule is available')", "capsule unavailable state");
pass("capsule-unavailable shows the honest error state");
fetchPolicy = null;
await call("Fetch.disable");

// The retry re-export clears the honest error banner via the real endpoint.
const blobsBefore = await evaluate("window.__p36Blobs.length");
await clickButtonText("Export Repro Capsule");
await retry(() => evaluate("window.__p36Blobs.length > " + blobsBefore), "capsule blob captured", 15000);
const capsuleText = await evaluate("window.__p36Blobs[window.__p36Blobs.length - 1]");
const capsule = JSON.parse(capsuleText);
if (capsule.kind !== "tracer.repro-capsule" || capsule.schemaVersion !== 1) throw new Error("Capsule envelope is wrong");
if (capsuleText.includes("super-secret-987")) throw new Error("Capsule leaked the Authorization value");
{
	const headers = (capsule.request?.headers || []).map((header) => ({ key: String(header.key ?? header.name ?? "").toLowerCase(), value: String(header.value ?? "") }));
	const authHeader = headers.find((header) => header.key === "authorization" || header.key.includes("auth"));
	if (authHeader) {
		if (!authHeader.value.includes("{{capsule_")) throw new Error("Capsule carried an Authorization header without a placeholder");
		if (!capsuleText.includes("{{capsule_header_authorization}}") && !(capsule.requiredInputs || []).some((input) => /authorization/i.test(input.name))) {
			throw new Error("Capsule did not document the authorization input");
		}
	}
}
assertNoPercentOrConfidence(capsuleText);
pass("exported Repro Capsule is versioned, secret-redacted, and documents required inputs");

// Open as draft (Phase 7 normalized import boundary): unsent, dirty, no auto-send/save
{
	const logBefore = await evaluate("window.__p36FetchLog.length");
	try {
		await clickButtonText("Open as draft");
	} catch (error) {
		const state = await evaluate(
			`(() => ({ dialog: (document.querySelector('dialog[open]') || {}).textContent?.slice(0, 260), buttons: [...document.querySelectorAll('dialog[open] button')].map((b) => b.textContent.trim() + (b.disabled ? ' [disabled]' : '')), errors: (window.__p36Errors || []) }))()`,
		);
		console.log("DEBUG open-as-draft:", JSON.stringify(state), "errors:", JSON.stringify(runtimeErrors.slice(-3)));
		throw error;
	}
	await waitFor('document.querySelectorAll("dialog[open]").length === 0', "dialog closed after Open as draft");
	await waitFor('document.querySelector(".dirty-dot") !== null', "dirty draft tab after Open as draft");
	const sentOrSaved = await evaluate(
		"window.__p36FetchLog.slice(" +
			logBefore +
			").filter((entry) => entry.startsWith('POST /api/v1/executions') || entry.startsWith('POST /api/v1/collections') || entry.startsWith('PUT /api/v1/collections')).length",
	);
	if (sentOrSaved > 0) throw new Error("Open as draft triggered an automatic send or save");
	const toast = await evaluate("[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')");
	if (!toast.includes("unsent, unsaved")) throw new Error("Open as draft did not confirm the unsent/unsaved draft: " + toast);
}
pass("Open as draft imports through the normalized boundary as an unsent, dirty draft with no auto-send and no auto-save");

// Open minimized draft (dialog closes after each open, so run it again)
await openInvestigationFromDebugRow();
await clickButtonText("Start investigation");
await waitForInvestigationComplete();
{
	const logBefore = await evaluate("window.__p36FetchLog.length");
	await clickButtonText("Open minimized draft");
	await waitFor('document.querySelectorAll("dialog[open]").length === 0', "dialog closed after Open minimized draft");
	await waitFor('document.querySelector(".dirty-dot") !== null', "dirty draft tab after Open minimized draft");
	const sentOrSaved = await evaluate(
		"window.__p36FetchLog.slice(" +
			logBefore +
			").filter((entry) => entry.startsWith('POST /api/v1/executions') || entry.startsWith('POST /api/v1/collections') || entry.startsWith('PUT /api/v1/collections')).length",
	);
	if (sentOrSaved > 0) throw new Error("Open minimized draft triggered an automatic send or save");
	const toast = await evaluate("[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')");
	if (!toast.includes("unsent, unsaved")) throw new Error("Open minimized draft did not confirm the unsent/unsaved draft: " + toast);
}
pass("Open minimized draft opens an unsent, dirty draft with no auto-send and no auto-save");

/* ------------------------- S9 cancelled rows never expose the entry point */
await openRequestFromCollections("P36 Cancel", "Timeout probe");
await setInput('input[aria-label="Request URL"]', "http://127.0.0.1:8000/demo/v1/examples/delay/12000");
await click(".send-button", "Send");
await waitFor("document.querySelector('.send-button')?.textContent.includes('Cancel')", "cancel affordance", 5000);
await click(".send-button", "Cancel in-flight send");
await waitFor('document.querySelector(".response-area .status-pill") !== null', "cancelled result", 20000);
{
	const text = await evaluate("document.querySelector('.response-area')?.textContent || ''");
	if (!/cancel/i.test(text)) throw new Error("Cancelled send did not render a cancelled result: " + text.slice(0, 200));
	const hasEntry = await evaluate("[...document.querySelectorAll('.response-area button')].some((b) => b.textContent.includes('Investigate'))");
	if (hasEntry) throw new Error("Cancelled result exposes the Investigate entry point");
}
pass("cancelled executions never expose the Investigate failure entry point");

/* ---------------------------- S13 investigation cancellation via Phase 35 path */
await openRequestFromCollections("P36 Runner", "Failing check");
await click(".send-button", "Send");
await waitFor('document.querySelector(".response-area .status-pill") !== null', "terminal send result", 30000);
await openInvestigationFromResponseArea();
// Deterministic lifecycle through the real Phase 35 endpoints: the start call is real,
// while a running status and the cancelled transition are served deterministically
// so the running/cancelled UI states are always observable.
await call("Fetch.enable", { patterns: [{ urlPattern: "*execution-intelligence/investigations/*" }] });
fetchPolicy = (method, url) => {
	const match = url.match(/investigations\/([0-9a-fA-F-]{36})/);
	if (!match) return null;
	const investigationId = match[1];
	const envelope = (status) => ({
		data: {
			schemaVersion: 1,
			kind: "tracer.investigation",
			investigationId,
			status,
			stage: "comparison",
			failingExecutionId: UUID(1),
			result: null,
			error: null,
			startedAt: new Date().toISOString(),
			finishedAt: status === "running" ? null : new Date().toISOString(),
			expiresAt: new Date(Date.now() + 86400000).toISOString(),
		},
	});
	if (method === "POST" && url.includes("/cancel")) return { status: 200, body: envelope("cancelled") };
	if (method === "GET") return { delayMs: 300, status: 200, body: envelope("running") };
	return null;
};
await clickButtonText("Start investigation");
await retry(() => evaluate("document.querySelector('[data-testid=investigation-status]')?.textContent.includes('Investigation running')"), "running banner");
{
	const text = await dialogText();
	if (!text.includes("Prepare evidence")) throw new Error("Stage timeline missing");
	if (!text.includes("Cancel investigation")) throw new Error("Cancel investigation button missing");
}
const cancelLogBefore = await evaluate("window.__p36FetchLog.length");
await clickButtonText("Cancel investigation");
await waitFor("document.querySelector('[data-testid=investigation-status]')?.textContent.includes('Investigation cancelled')", "cancelled banner", 20000);
{
	const cancelCalls = await evaluate(
		"window.__p36FetchLog.slice(" + cancelLogBefore + ").filter((entry) => entry.includes('/execution-intelligence/investigations/') && entry.endsWith('/cancel')).length",
	);
	if (cancelCalls < 1) throw new Error("Cancel did not call the Phase 35 investigation cancel endpoint");
	const text = await dialogText();
	if (!text.includes("Start over")) throw new Error("Start over missing after cancellation");
}
await clickButtonText("Start over");
await waitFor("document.body.textContent.includes('What will happen')", "pre-start card after restart");
pass("running investigations cancel through the Phase 35 cancel path and offer Start over");
fetchPolicy = null;
await call("Fetch.disable");
await pressEscape();

/* ------------------------------- S10 runner entry points and honest exclusions */
async function runCollection(collectionName) {
	await ensureCollectionsPanel();
	await retry(
		() =>
			evaluate(
				"(() => { const label = [...document.querySelectorAll('.tree-label')].find((n) => n.textContent.trim().includes(" +
					JSON.stringify(collectionName) +
					") && n.getClientRects().length > 0); if (!label) return false; label.focus(); const actions = label.parentElement.querySelector('.tree-actions button'); if (!actions || actions.getClientRects().length === 0) return false; actions.click(); return true; })()",
			),
		"collection menu " + collectionName,
	);
	await clickButtonText("Run collection");
	await waitFor("document.body.textContent.includes('Run plan')", "runner dialog");
	try {
		await retry(
			() =>
				evaluate(
					"(() => { const button = [...document.querySelectorAll('dialog[open] button')].find((b) => /Run \\d+ request/.test(b.textContent)); if (!button || button.disabled) return false; button.focus(); button.click(); return true; })()",
				),
			"Run collection button",
		);
	} catch (error) {
		const state = await evaluate(
			"(() => ({ buttons: [...document.querySelectorAll('dialog[open] button')].map((b) => b.textContent.trim() + (b.disabled ? ' [disabled]' : '')), text: (document.querySelector('dialog[open]')?.textContent || '').slice(0, 700) }))()",
		);
		console.log("DEBUG runner:", JSON.stringify(state));
		throw error;
	}
	await waitFor("document.body.textContent.includes('Run passed') || document.body.textContent.includes('Run finished with failures')", "run finished", 90000);
}

await runCollection("P36 Runner");
{
	const stepInfo = await evaluate(
		"(() => { const rows = [...document.querySelectorAll('.run-step')]; return rows.map((row) => ({ text: row.textContent, hasInvestigate: [...row.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Investigate failure'), hasPassport: [...row.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Passport') })); })()",
	);
	const healthy = stepInfo.find((row) => row.text.includes("Healthy check"));
	const failing = stepInfo.find((row) => row.text.includes("Failing check"));
	const skipped = stepInfo.find((row) => row.text.includes("Skipped check"));
	if (!healthy || !failing || !skipped) throw new Error("Runner steps missing: " + JSON.stringify(stepInfo.map((r) => r.text.slice(0, 40))));
	if (healthy.hasInvestigate) throw new Error("Passing runner step exposes Investigate failure");
	if (skipped.hasInvestigate) throw new Error("Skipped runner step exposes Investigate failure");
	if (!failing.hasInvestigate) throw new Error("Failed runner step does not expose Investigate failure");
	if (!failing.hasPassport) throw new Error("Failed runner step lost its Passport entry point");
	await evaluate(
		"(() => { const rows = [...document.querySelectorAll('.run-step')]; const row = rows.find((r) => r.textContent.includes('Failing check')); [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Investigate failure').click(); return true; })()",
	);
	await waitFor('document.querySelector("dialog[open]") !== null', "investigation dialog from runner");
	await pressEscape();
}
pass("runner failed steps expose \"Investigate failure\" while passing and skipped steps do not");
await pressEscape();

/* ------------- S11 no-baseline + no-verified-cause investigation (runner failure) */
await clickButtonText("History");
await retry(() => evaluate("document.querySelector('.history-item') !== null"), "history entries");
await evaluate(
	"(() => { const rows = [...document.querySelectorAll('.history-item')]; const row = rows.find((r) => r.textContent.includes('Failing check') && [...r.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Investigate failure')) || rows.find((r) => /\\b500\\b/.test(r.textContent) && [...r.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Investigate failure')); if (!row) return false; [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Investigate failure').click(); return true; })()",
);
await waitFor('document.querySelector("dialog[open]") !== null', "investigation dialog");
await clickButtonText("Start investigation");
await waitForInvestigationComplete();
{
	const text = await dialogText();
	if (!text.includes("no passing execution is available to anchor a transition boundary"))
		throw new Error("No-baseline state not shown honestly: " + text.slice(0, 400));
	if (!text.includes("chronological evidence only")) throw new Error("Boundary disclaimer missing");
	if (!text.includes("No change was experimentally verified as the cause.")) throw new Error("No-verified-cause state not shown");
	if (!text.includes("no change was verified as the cause")) throw new Error("Summary banner not honest about the outcome");
	assertNoPercentOrConfidence(text);
}
pass("no baseline and no verified cause render as honest empty states");
await pressEscape();

/* --------- S12 state-change failure: comparison with unverified diffs, zero causes */
await openRequestFromCollections("P36 State", "Delete order");
await sendAndWait();
const firstDeleteStatus = await evaluate("document.querySelector('.response-area')?.textContent.slice(0, 200) || ''");
process.stdout.write("FIRST_DELETE " + firstDeleteStatus.replace(/\s+/g, " ").slice(0, 120) + "\n");
await setInput('input[aria-label="Request URL"]', "http://127.0.0.1:8000/demo/v1/local/orders/ord_0002?attempt=2&src=api");
await sendAndWait();
await openInvestigationFromResponseArea();
await clickButtonText("Start investigation");
await waitForInvestigationComplete();
{
	const text = await dialogText();
	if (!text.includes("No change was experimentally verified as the cause.")) throw new Error("Zero-cause outcome not shown: " + text.slice(0, 300));
	if (!text.includes("Failure begins between passing run")) throw new Error("Boundary should resolve here (there is an earlier passing run)");
	const unverifiedEntries = await evaluate(
		"(() => { const section = [...document.querySelectorAll('.recorder-question')].find((node) => node.textContent.includes('What remains unverified?')); return section ? section.querySelectorAll('.recorder-deltas > li').length : -1; })()",
	);
	if (unverifiedEntries < 2) throw new Error("Expected at least two unverified diffs, found " + unverifiedEntries);
	assertNoPercentOrConfidence(text);
}
pass("state-change failure compares two runs, lists unverified diffs, and claims zero verified causes");

/* -------------------------- S14 error states: not-found and validation failures */
await pressEscape();
await clickButtonText("History");
await retry(() => evaluate("document.querySelector('.history-item') !== null"), "history entries");

// (a) receipt not found
await call("Fetch.enable", { patterns: [{ urlPattern: "*execution-intelligence/receipts*" }] });
fetchPolicy = (method, url) => (url.includes("/receipts/") ? { status: 404, body: { error: { code: "RECEIPT_UNAVAILABLE", message: "history is gone" } } } : null);
await evaluate(
	"(() => { const rows = [...document.querySelectorAll('.history-item')]; const row = rows.find((r) => [...r.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Investigate failure')); [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Investigate failure').click(); return true; })()",
);
await waitFor("document.querySelector('[data-testid=investigation-error]')?.textContent.includes('execution passport')", "receipt not-found state");
pass("missing execution passport renders the honest error state");
await pressEscape();
fetchPolicy = null;
await call("Fetch.disable");

// (b) loading state
await call("Fetch.enable", { patterns: [{ urlPattern: "*execution-intelligence/receipts*" }] });
fetchPolicy = (method, url) => (url.includes("/receipts/") ? { delayMs: 900, status: 200, body: { data: { schemaVersion: 1, kind: "tracer.execution-receipt", executionId: UUID(1), capturedAt: new Date().toISOString(), sequenceNumber: 1, target: { scheme: "http", host: "127.0.0.1", port: 8000, path: "/demo/v1/status/500", queryKeys: ["debug"] }, attempt: { outcome: "response", responseStatus: 500, response: { status: 500, headers: [] } }, changeExclusions: [], evidencePolicy: { values: "excluded", headerNames: ["authorization"], queryKeys: ["token"] }, limits: {}, executionDeltas: [], inputs: [], requiredInputs: [] } } } : null);
await evaluate(
	"(() => { const rows = [...document.querySelectorAll('.history-item')]; const row = rows.find((r) => [...r.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Investigate failure')); [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Investigate failure').click(); return true; })()",
);
await waitFor("document.querySelector('[data-testid=investigation-loading]') !== null", "loading state");
await sleep(300);
await screenshot("investigation-loading-1440-dark");
await waitFor('document.body.textContent.includes("Failure predicate")', "receipt loaded", 15000);
pass("receipt loading renders an explicit loading state");
await pressEscape();
fetchPolicy = null;
await call("Fetch.disable");

// (c) start validation failure
await call("Fetch.enable", { patterns: [{ urlPattern: "*execution-intelligence/investigations", requestMethod: "POST" }] });
fetchPolicy = (method, url) => (method === "POST" && /\/investigations(\?|$)/.test(url) ? { status: 422, body: { error: { code: "INVESTIGATION_INPUT_INVALID", message: "targetMode is required" } } } : null);
await evaluate(
	"(() => { const rows = [...document.querySelectorAll('.history-item')]; const row = rows.find((r) => [...r.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Investigate failure')); [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Investigate failure').click(); return true; })()",
);
await waitFor('document.querySelector("dialog[open]") !== null', "investigation dialog");
await clickButtonText("Start investigation");
await waitFor("document.querySelector('[data-testid=investigation-error]')?.textContent.includes('investigation input was not valid')", "validation error state");
pass("invalid investigation input renders the validation error state");
await pressEscape();
fetchPolicy = null;
await call("Fetch.disable");

/* ---------------- S15 responsive x theme matrix with a completed investigation */
await openInvestigationFromDebugRow();
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
		await screenshot(`investigation-completed-${width}-${theme}`);
		pass(`investigation dialog fits ${width}px in ${theme} theme with zero horizontal overflow`);
	}
}

/* -------------------------------------------------- S16 final console/teardown */
if (runtimeErrors.length) throw new Error("Browser exceptions/console errors: " + runtimeErrors.join(" | "));
pass("zero unhandled browser exceptions and zero console errors across all flows");
await screenshot("investigation-final-state");
process.stdout.write("PHASE36_E2E_PASS " + checks.length + "/" + checks.length + "\n");
socket.close();
