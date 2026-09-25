// Final Phase 50 UX polish — direct Verification Proof -> Review browser acceptance.
//
// Proves the copy/paste seam is gone without changing review semantics:
//   1. load a real backend-built + wrapped Verification Proof,
//   2. click Promote proof,
//   3. land in Reviews with a prefilled form,
//   4. prove the proof artifact is attached internally (no artifact textarea),
//   5. cancel and prove no review was auto-created.

import { readFileSync } from "node:fs";

const CDP = process.env.TRACER_CDP_URL || "http://127.0.0.1:9222";
const APP = process.env.TRACER_APP_URL || "http://127.0.0.1:3000";
const API = process.env.TRACER_API_URL || "http://127.0.0.1:8000";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const repoRootUrl = process.env.TRACER_REPO_ROOT
	? new URL("file://" + process.env.TRACER_REPO_ROOT + "/")
	: new URL("../../", import.meta.url);
const backendEnvUrl = process.env.TRACER_BACKEND_ENV
	? new URL("file://" + process.env.TRACER_BACKEND_ENV)
	: new URL("backend/.env", repoRootUrl);
const backendEnvText = readFileSync(backendEnvUrl, "utf8");

function readBackendEnv(key) {
	const line = backendEnvText.split("\n").find((value) => value.startsWith(key + "="));
	if (!line) throw new Error("backend/.env has no " + key + "; run setup/seed first");
	return line.slice(key.length + 1).trim();
}

process.env.MONGODB_URI ??= readBackendEnv("MONGODB_URI");
process.env.EXECUTION_FINGERPRINT_KEY ??= readBackendEnv("EXECUTION_FINGERPRINT_KEY");
process.env.JWT_SECRET ??= readBackendEnv("JWT_SECRET");

const { initConfig } = await import(new URL("backend/src/shared/config/index.js", repoRootUrl).href);
initConfig();
const { buildVerificationProof } = await import(new URL("backend/src/features/verification-proof/index.js", repoRootUrl).href);
const { proofInput } = await import(new URL("backend/src/features/verification-proof/proof-fixtures.js", repoRootUrl).href);
const { buildProofArtifact, serializeProofArtifact } = await import(
	new URL("backend/src/features/verification-proof-api/proof-artifact.js", repoRootUrl).href
);

const proof = buildVerificationProof(proofInput());
const artifactText = serializeProofArtifact(buildProofArtifact(proof));

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

async function clickText(selector, text, label = text) {
	const expression =
		"(() => { const target = " +
		JSON.stringify(text) +
		"; const node = [...document.querySelectorAll(" +
		JSON.stringify(selector) +
		")].find((n) => !n.disabled && n.getClientRects().length > 0 && n.textContent.replace(/\\s+/g, ' ').trim().includes(target)); if (!node) return false; node.click(); return true; })()";
	if (!(await evaluate(expression))) throw new Error("Could not click " + label);
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

async function api(path) {
	return evaluate(
		"(async () => { const token = localStorage.getItem('request-desk-profile-token') || localStorage.getItem('request-desk-session-token'); const workspace = localStorage.getItem('request-desk-workspace-id'); const response = await fetch('/api/v1" +
			path +
			"', { headers: { Authorization: 'Bearer ' + token, 'x-workspace-id': workspace } }); return { status: response.status, body: await response.json() }; })()",
	);
}

const checks = [];
function pass(name) {
	checks.push(name);
	process.stdout.write("PASS " + name + "\n");
}

await call("Page.enable");
await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
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

const pageToken = await evaluate("localStorage.getItem('request-desk-profile-token') || localStorage.getItem('request-desk-session-token')");
if (!pageToken) throw new Error("Could not read the authenticated profile token");
const importPreflight = await fetch(API + "/api/v1/verification-proofs/import", {
	method: "POST",
	headers: { "content-type": "application/json", authorization: "Bearer " + pageToken },
	body: JSON.stringify({ text: artifactText }),
});
const importPreflightBody = await importPreflight.json().catch(() => null);
if (importPreflight.status !== 200) {
	throw new Error("Backend refused the proof artifact before the UI flow: " + importPreflight.status + " " + JSON.stringify(importPreflightBody).slice(0, 600));
}
pass("backend accepts the exact proof artifact used by the UI flow");

const before = await api("/reviews");
if (before.status !== 200) throw new Error("Could not read reviews before flow: " + before.status);
const beforeCount = (before.body?.data ?? []).length;

await click('[aria-label="View Verification Proof"]', "Verification Proof command");
await waitFor('document.querySelector(".verification-proof-dialog") !== null', "Verification Proof dialog");
await clickText('.verification-proof-dialog [role="tab"]', "Import & Verify", "Import & Verify tab");
await setInput('textarea[aria-label="Verification proof artifact JSON"]', artifactText);
await clickText(".verification-proof-dialog .recorder-actions button", "Verify", "Verify proof");
await retry(async () => {
	const state = await evaluate(`
		(() => ({
			selected: [...document.querySelectorAll(".verification-proof-dialog [role=tab]")]
				.find((node) => node.getAttribute("aria-selected") === "true")?.textContent.trim() || "",
			error: document.querySelector(".verification-proof-dialog .dialog-error")?.textContent.trim() || "",
			notice: document.querySelector(".verification-proof-dialog .proof-notice")?.textContent.trim() || "",
		}))()
	`);
	if (state.error) throw new Error("Verification Proof UI rejected the backend-accepted artifact: " + state.error);
	return state.selected.includes("Proof") ? state : null;
}, "Proof tab after import");
pass("backend-built proof imported and validated");

await waitFor('[...document.querySelectorAll(".verification-proof-dialog button")].some((node) => node.textContent.includes("Promote proof"))', "Promote proof action");
await clickText(".verification-proof-dialog button", "Promote proof", "Promote proof");
await waitFor('document.querySelector(".verification-proof-dialog") === null', "proof dialog closes");
await waitFor('document.querySelector(".promote-form") !== null', "prefilled review form");
pass("Promote proof opens Reviews directly");

const formState = await evaluate(`
	(() => {
		const form = document.querySelector(".promote-form");
		const selects = [...form.querySelectorAll("select")];
		const finding = selects[0];
		return {
			title: form.querySelector('input[maxlength="120"]')?.value || "",
			summary: form.querySelector('textarea[maxlength="1000"]')?.value || "",
			finding: finding?.value || "",
			findingDisabled: Boolean(finding?.disabled),
			attached: form.querySelector(".review-attached-proof")?.textContent.replace(/\\s+/g, " ").trim() || "",
			artifactTextarea: Boolean(
				[...form.querySelectorAll("textarea")].find((node) =>
					node.getAttribute("placeholder")?.includes("Paste the exported Tracer Verification Proof JSON"),
				),
			),
		};
	})()
`);
if (formState.finding !== "verification_proof" || !formState.findingDisabled) {
	throw new Error("Direct promotion did not lock the intended finding type: " + JSON.stringify(formState));
}
if (!formState.title || !formState.summary) throw new Error("Direct promotion did not prefill human review metadata");
if (!formState.attached.includes("Verification Proof attached") || !formState.attached.includes(proof.proofId)) {
	throw new Error("Attached proof note does not identify the exact proof: " + formState.attached);
}
if (formState.artifactTextarea) throw new Error("Direct promotion still exposes the proof copy/paste textarea");
pass("exact proof is attached internally; no artifact copy/paste field is shown");

await clickText(".promote-form button", "Cancel", "Cancel direct promotion");
await waitFor('document.querySelector(".promote-form") === null', "promotion form closes");
const after = await api("/reviews");
if (after.status !== 200) throw new Error("Could not read reviews after cancel: " + after.status);
const afterCount = (after.body?.data ?? []).length;
if (afterCount !== beforeCount) throw new Error("Opening/cancelling direct promotion created a review unexpectedly");
pass("opening the direct flow has no write side effect until explicit Promote");

if (runtimeErrors.length > 0) throw new Error("Browser runtime errors: " + runtimeErrors.join(" | "));

socket.close();
await fetch(CDP + "/json/close/" + target.id).catch(() => null);
process.stdout.write("\nDONE: " + checks.length + " direct proof-to-review browser checks passed.\n");
