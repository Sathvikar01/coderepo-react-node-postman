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
	const expression = "(() => { const node = document.querySelector(" + JSON.stringify(selector) + "); if (!node || node.disabled || node.getClientRects().length === 0) return false; node.click(); return true; })()";
	if (!(await evaluate(expression))) throw new Error("Could not click " + label);
}

async function clickButtonText(text) {
	const expression = "(() => { const target = " + JSON.stringify(text) + "; const node = [...document.querySelectorAll('button')].find((button) => !button.disabled && button.getClientRects().length > 0 && button.textContent.trim().includes(target)); if (!node) return false; node.click(); return true; })()";
	if (!(await evaluate(expression))) throw new Error("Could not click button: " + text);
}

async function setInput(selector, value) {
	const expression = "(() => { const node = document.querySelector(" + JSON.stringify(selector) + "); if (!node) return false; const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set; if (!setter) return false; setter.call(node, " + JSON.stringify(value) + "); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()";
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

await waitFor('document.querySelector("#workspace-email") !== null', "login screen");
await setInput("#workspace-email", "alex.morgan@example.test");
await setInput("#workspace-password", "password123");
await evaluate('document.querySelector(".workspace-login-card form").requestSubmit(); true');
await waitFor('[...document.querySelectorAll("button")].some((node) => node.getAttribute("aria-label")?.startsWith("Continue as"))', "profile picker");
await click('[aria-label^="Continue as"]', "profile");
await waitFor('document.querySelector(".app-shell") !== null', "workspace");
pass("login -> profile -> workspace");

for (const width of [375, 768, 1024, 1440]) {
	await viewport(width);
	const overflow = await evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
	if (overflow > 1) throw new Error("Horizontal overflow at " + width + "px: " + overflow + "px");
}
pass("375/768/1024/1440 no document overflow");

await viewport(375, 820);
const mobileCommands = await evaluate("(() => { const nodes=[...document.querySelectorAll('.rail-primary .rail-command')]; return nodes.length === 4 && nodes.every((node) => getComputedStyle(node).display !== 'none'); })()");
if (!mobileCommands) throw new Error("Primary mobile rail commands are not all reachable");
pass("mobile rail keeps four primary commands reachable");

await viewport(1440);
const oldTheme = await evaluate('document.documentElement.dataset.theme || "dark"');
await click('[aria-label^="Switch to "]', "theme");
await retry(async () => (await evaluate('document.documentElement.dataset.theme || "dark"')) !== oldTheme, "theme change");
pass("theme button works");

await clickButtonText("History");
await retry(() => evaluate("document.querySelector('.sidebar-tab[aria-selected=true]')?.textContent.includes('History')"), "History tab");
await click('[aria-label="Open collections"]', "Collections rail command");
await retry(() => evaluate("document.querySelector('.sidebar-tab[aria-selected=true]')?.textContent.includes('Collections')"), "Collections tab");
pass("Collections rail command changes resource mode");

await click('[aria-label="Import cURL"]', "Import");
await waitFor('document.body.textContent.includes("Import cURL")', "Import dialog");
await pressEscape();
pass("Import opens");

await click('[aria-label="Environments"]', "Variables");
await waitFor('document.body.textContent.includes("Environments")', "Environments");
await pressEscape();
pass("Variables opens");

await click('[aria-label^="Local Runtime is "]', "Runtime");
await waitFor('document.body.textContent.includes("Local Runtime")', "Runtime dialog");
await pressEscape();
pass("Runtime opens");

await click('[aria-label="New request"]', "New request");
await waitFor('document.querySelector(".request-builder") !== null', "request builder");
pass("new request works");

await clickButtonText("Headers");
await retry(() => evaluate('[...document.querySelectorAll(".editor-tab")].some((node) => node.textContent.includes("Headers") && node.getAttribute("aria-selected") === "true")'), "Headers tab");
await clickButtonText("Params");
pass("request editor tabs work");

await click(".code-button", "Code");
await waitFor('document.querySelector(".code-dialog-modal[open]") !== null', "Code dialog");
await pressEscape();
pass("Code opens");

await click(".send-button", "Send");
await waitFor('document.querySelector(".response-toolbar") !== null && document.body.textContent.includes("200")', "successful response", 20000);
pass("Send returns response");

await clickButtonText("History");
await waitFor('document.querySelector(".history-item") !== null', "history entry");
await clickButtonText("Analyze");
await waitFor('document.querySelector(".flight-recorder-dialog") !== null', "Flight Recorder");
const recorderTabs = await evaluate("[...document.querySelectorAll('.flight-recorder-dialog [role=tab]')].map((node) => node.textContent.trim()).join('|')");
for (const expected of ["Passport", "Compare", "Minimize", "Capsule"]) {
	if (!recorderTabs.includes(expected)) throw new Error("Flight Recorder missing " + expected);
}
pass("History -> Flight Recorder exposes all four analysis modes");
await pressEscape();

if (runtimeErrors.length) throw new Error("Browser exceptions: " + runtimeErrors.join(" | "));
pass("no unhandled browser exceptions");
process.stdout.write("PHASE30_E2E_PASS " + checks.length + "/" + checks.length + "\n");
socket.close();
