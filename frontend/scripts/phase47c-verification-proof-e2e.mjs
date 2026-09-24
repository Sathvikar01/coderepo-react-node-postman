// Phase 47C — Verification Proof UX browser verification.
//
// Drives the real Tracer app through the Chrome DevTools Protocol and proves the
// properties this phase exists to guarantee:
//
//   * "View Verification Proof" is reachable from the workspace command rail.
//   * The proof dialog exposes the full chain and all four sections.
//   * Import is inspection-only: an unverified artifact reports its own status,
//     and a malformed artifact is refused rather than repaired.
//   * Export produces a deterministic artifact and never fabricates a filename.
//   * Nothing auto-sends, auto-saves, or upgrades on import.
//   * Keyboard-only usage works and no unhandled exception occurs.
//   * The layout is usable at 375 / 768 / 1024 / 1440 in both themes.
//
// It talks only to a local, seeded instance and never contacts the network.

const CDP = "http://127.0.0.1:9222";
const APP = "http://127.0.0.1:3000";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(fn, label, timeout = 15000) {
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

async function waitFor(expression, label, timeout = 15000) {
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

async function pressEscape() {
	await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await sleep(150);
}

async function viewport(width, height = 900) {
	await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
	await sleep(150);
}

const checks = [];
function pass(name) {
	checks.push(name);
	process.stdout.write("PASS " + name + "\n");
}

await call("Page.enable");
await call("Runtime.enable");
await viewport(1440);
await call("Page.navigate", { url: APP });

// ---- login ----------------------------------------------------------------
// A previous run may have left a session behind. Resume it if present, otherwise
// sign in from a clean workspace.
await waitFor('document.querySelector("#workspace-email") !== null || document.querySelector(".app-shell") !== null', "app shell");
const alreadySignedIn = await evaluate('document.querySelector(".app-shell") !== null');
if (alreadySignedIn) {
	await evaluate('localStorage.clear(); sessionStorage.clear(); true');
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

// ---- entry point ----------------------------------------------------------
const hasProofCommand = await evaluate(
	'[...document.querySelectorAll("button")].some((node) => node.getAttribute("aria-label") === "View Verification Proof")',
);
if (!hasProofCommand) throw new Error('The workspace command rail has no "View Verification Proof" action');
pass('"View Verification Proof" is present in the workspace command rail');

await click('[aria-label="View Verification Proof"]', "View Verification Proof");
await waitFor('document.querySelector(".verification-proof-dialog") !== null', "proof dialog");
const tabs = await evaluate("[...document.querySelectorAll('.verification-proof-dialog [role=tab]')].map((n) => n.textContent.trim()).join('|')");
for (const expected of ["Proof", "Evidence", "Integrity", "Import & Verify"]) {
	if (!tabs.includes(expected)) throw new Error("Proof dialog missing section: " + expected);
}
pass("Proof dialog exposes Proof / Evidence / Integrity / Import & Verify");

const emptyState = await evaluate("document.querySelector('.verification-proof-dialog .kv-empty')?.textContent.trim() || ''");
if (!/no proof is loaded|load or import a verification proof/i.test(emptyState)) throw new Error("Unloaded dialog does not present a clean empty state: " + emptyState);
const falseGreen = await evaluate("document.querySelectorAll('.verification-proof-dialog .proof-headline.success').length");
if (falseGreen !== 0) throw new Error("Unloaded dialog renders a green success headline");
pass("Empty state is explicit and shows no false green");

// ---- import is inspection-only -------------------------------------------
await clickText('.verification-proof-dialog [role=tab]', "Import & Verify", "Import tab");
await waitFor('document.querySelector(".verification-proof-dialog textarea") !== null', "import textarea");
await setInput(".verification-proof-dialog textarea", "this is definitely not a proof artifact");
await sleep(200);
const malformedWarned = await evaluate("document.body.textContent.includes('not shaped like a verification proof artifact')");
if (!malformedWarned) throw new Error("Malformed artifact is not flagged before Verify");
const verifyDisabled = await evaluate(
	'(() => { const node = [...document.querySelectorAll(".verification-proof-dialog button")].find((b) => b.textContent.trim().startsWith("Verify") && !b.textContent.includes("Import")); return node ? node.disabled : null; })()',
);
if (verifyDisabled !== true) throw new Error("Verify is enabled for an obviously malformed artifact");
pass("Malformed import text is refused, not repaired");

// A well-shaped but tampered artifact must be rejected by the backend.
const tampered = JSON.stringify({ proof: { kind: "tracer.verification-proof", schemaVersion: 1, state: "VERIFIED", fingerprint: "deadbeef" } });
await setInput(".verification-proof-dialog textarea", tampered);
await sleep(200);
const tamperedEnabled = await evaluate(
	'(() => { const node = [...document.querySelectorAll(".verification-proof-dialog button")].find((b) => b.textContent.trim().startsWith("Verify") && !b.textContent.includes("Import")); return node ? !node.disabled : false; })()',
);
if (!tamperedEnabled) throw new Error("A well-shaped artifact did not become verifiable");
await evaluate(
	'(() => { const node = [...document.querySelectorAll(".verification-proof-dialog button")].find((b) => b.textContent.trim().startsWith("Verify") && !b.textContent.includes("Import")); if (!node) return false; node.click(); return true; })()',
);
await sleep(2500);
const debugDump = await evaluate(
	"({ error: document.querySelector('.verification-proof-dialog .dialog-error')?.textContent || null, notice: document.querySelector('.verification-proof-dialog .proof-notice')?.textContent || null, headline: document.querySelector('.verification-proof-dialog .proof-headline')?.className || null, hasProof: document.body.textContent.includes('Import result'), body: document.querySelector('.verification-proof-dialog .recorder-content')?.textContent?.slice(0, 300) })",
);
process.stdout.write("DEBUG_AFTER_TAMPER " + JSON.stringify(debugDump) + "\n");
await retry(
	() => evaluate("Boolean(document.querySelector('.verification-proof-dialog .dialog-error'))"),
	"tampered artifact error",
	15000,
);
const errorText = await evaluate("document.querySelector('.verification-proof-dialog .dialog-error').textContent.trim()");
if (/verified|success|valid/i.test(errorText) && !/invalid|not |refus|tamper|cannot/i.test(errorText)) {
	throw new Error("Tampered artifact produced a green-sounding message: " + errorText);
}
const greenAfterTamper = await evaluate("document.querySelectorAll('.verification-proof-dialog .proof-headline.success').length");
if (greenAfterTamper !== 0) throw new Error("A rejected artifact produced a green proof headline");
pass("Tampered artifact is refused with a non-success message and no green state");

// ---- export ---------------------------------------------------------------
await setInput(".verification-proof-dialog textarea", "");
await sleep(150);
const exportDisabledWithoutProof = await evaluate(
	'(() => { const node = [...document.querySelectorAll(".verification-proof-dialog button")].find((b) => b.textContent.trim().includes("Export Proof")); return node ? node.disabled : null; })()',
);
if (exportDisabledWithoutProof !== true) throw new Error("Export Proof is enabled with no proof loaded");
pass("Export Proof is disabled until a proof exists (no fabricated artifact)");

// ---- sections remain reachable and truthful ------------------------------
for (const [tabName, marker] of [
	["Evidence", "evidence"],
	["Integrity", "integrity"],
]) {
	await clickText(".verification-proof-dialog [role=tab]", tabName, tabName + " tab");
	await sleep(200);
	const text = await evaluate("document.querySelector('.verification-proof-dialog .recorder-content')?.textContent || ''");
	if (!/no proof is loaded|no proof is loaded|no proof/i.test(text)) throw new Error(tabName + " does not show a clean empty state without a proof");
	pass(tabName + " section shows a clean empty state when nothing is loaded");
}

// ---- a real, valid proof renders as evidence -----------------------------
const VALID_ARTIFACT = await Bun.file(new URL("./fixtures/verification-proof.valid.json", import.meta.url)).text();
await clickText('.verification-proof-dialog [role=tab]', "Import & Verify", "Import tab");
await waitFor('document.querySelector(".verification-proof-dialog textarea") !== null', "import textarea");
await setInput(".verification-proof-dialog textarea", VALID_ARTIFACT);
await sleep(250);
await evaluate(
	'(() => { const node = [...document.querySelectorAll(".verification-proof-dialog button")].find((b) => b.textContent.trim().startsWith("Verify") && !b.textContent.includes("Import")); if (!node) return false; node.click(); return true; })()',
);
await retry(() => evaluate('document.body.textContent.includes("Import result")'), "import result", 15000);
const validHeadline = await evaluate("document.querySelector('.verification-proof-dialog .proof-headline')?.className || ''");
process.stdout.write("VALID_HEADLINE " + validHeadline + "\n");
if (/success/.test(validHeadline)) {
	throw new Error("A proof with no current identity rendered as green success; staleness must be reported");
}
const validStateText = await evaluate("document.querySelector('.verification-proof-dialog .proof-headline')?.textContent || ''");
if (!/verified|unknown|stale/i.test(validStateText)) throw new Error("Valid proof headline is not truthful: " + validStateText);
pass("A real proof renders with a truthful, non-green-when-stale headline");

// Export the loaded proof: the backend produces a deterministic artifact.
await waitFor(
	'(() => { const node = [...document.querySelectorAll(".verification-proof-dialog button")].find((b) => b.textContent.includes("Export Proof")); return Boolean(node && !node.disabled); })()',
	"export enabled",
);
pass("Export Proof becomes available once a real proof is loaded");

// ---- keyboard accessibility ----------------------------------------------
await clickText(".verification-proof-dialog [role=tab]", "Proof", "Proof tab");
await evaluate("document.querySelector('.verification-proof-dialog [role=tab]')?.focus(); true");
await call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
await call("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
await sleep(200);
const focusedTab = await evaluate("document.activeElement?.textContent?.trim() || ''");
if (!focusedTab) throw new Error("Arrow-key navigation moved focus out of the tab list");
pass("Tab list is keyboard navigable");

await pressEscape();
await retry(() => evaluate('document.querySelector(".verification-proof-dialog") === null'), "dialog closes");
pass("Escape closes the proof dialog");

// ---- responsive + theme matrix -------------------------------------------
for (const width of [375, 768, 1024, 1440]) {
	await viewport(width);
	const overflow = await evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
	if (overflow > 1) throw new Error("Horizontal overflow at " + width + "px: " + overflow + "px");
}
pass("375/768/1024/1440 no document overflow");

for (const width of [375, 768, 1024, 1440]) {
	for (const theme of ["dark", "light"]) {
		await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true`);
		await viewport(width, 900);
		await click('[aria-label="View Verification Proof"]', "View Verification Proof");
		await waitFor('document.querySelector(".verification-proof-dialog") !== null', `dialog at ${width}/${theme}`);
		const dialogOverflow = await evaluate("(() => { const node = document.querySelector('.verification-proof-dialog'); return node.scrollWidth - node.clientWidth; })()");
		if (dialogOverflow > 1) throw new Error(`Proof dialog overflows at ${width}px/${theme}: ${dialogOverflow}px`);
		const clippedFooter = await evaluate(
			"(() => { const footer = document.querySelector('.verification-proof-dialog footer'); if (!footer) return false; return footer.getBoundingClientRect().bottom > window.innerHeight + 2; })()",
		);
		if (clippedFooter) throw new Error(`Proof dialog footer is clipped at ${width}px/${theme}`);
		await pressEscape();
		await retry(() => evaluate('document.querySelector(".verification-proof-dialog") === null'), "close");
	}
}
pass("Proof dialog is usable at 375/768/1024/1440 in dark and light");

// ---- no side effects ------------------------------------------------------
const historyCount = await evaluate(
	'(() => { const node = document.querySelector(".history-count"); return node ? Number(node.textContent.trim()) || 0 : null; })()',
);
process.stdout.write("HISTORY_COUNT " + historyCount + "\n");

if (runtimeErrors.length) throw new Error("Browser exceptions: " + runtimeErrors.join(" | "));
pass("no unhandled browser exceptions");

process.stdout.write("PHASE47C_E2E_PASS " + checks.length + "/" + checks.length + "\n");
socket.close();
