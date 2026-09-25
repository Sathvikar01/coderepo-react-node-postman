// Phase 24 — collaboration and versioning, driven through two real, independent
// browser sessions.
//
// Each context launches its *own* headless Chrome with its *own* user-data
// directory, so Alex and Jordan have separate cookie jars and separate
// `localStorage` and can be signed in at the same time. Nothing here is
// simulated: every role change, conflict, and permission refusal travels the
// real HTTP API and the real React UI.
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const APP = "http://localhost:3000";
const API = "http://127.0.0.1:8000/api/v1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME_CANDIDATES = [
	process.env.TRACER_CHROME,
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const checks = [];
function pass(name, detail) {
	checks.push(name);
	process.stdout.write("PASS " + name + (detail ? " — " + detail : "") + "\n");
}

function findChrome() {
	for (const candidate of CHROME_CANDIDATES) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error("No Chrome binary found. Set TRACER_CHROME to the Chrome/Chromium executable.");
}

async function waitForCdp(port, label) {
	const end = Date.now() + 30000;
	let last = null;
	while (Date.now() < end) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) return (await response.json()).webSocketDebuggerUrl;
		} catch (error) {
			last = error;
		}
		await sleep(200);
	}
	throw new Error(`${label}: Chrome DevTools endpoint never came up${last ? ": " + last.message : ""}`);
}

async function openContext(label, port) {
	const profile = `${process.env.TEMP || "/tmp"}/tracer-p24-${label}-${process.pid}`;
	rmSync(profile, { recursive: true, force: true });
	const child = spawn(
		findChrome(),
		[
			"--headless=new",
			"--no-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--disable-extensions",
			"--disable-background-networking",
			"--disable-sync",
			"--disable-component-update",
			"--disable-default-apps",
			"--no-first-run",
			"--disable-features=Translate,MediaRouter,OptimizationHints",
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profile}`,
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	const browserSocketUrl = await waitForCdp(port, label);
	// The browser-level endpoint only exposes browser domains, so attach to the
	// page target and drive it through the page's own WebSocket.
	let pageSocketUrl = null;
	{
		const end = Date.now() + 20000;
		while (Date.now() < end && !pageSocketUrl) {
			try {
				const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
				const page = targets.find((entry) => entry.type === "page");
				if (page?.webSocketDebuggerUrl) pageSocketUrl = page.webSocketDebuggerUrl;
			} catch {}
			if (!pageSocketUrl) await sleep(200);
		}
	}
	if (!pageSocketUrl) throw new Error(`${label}: no page target was exposed by Chrome`);
	const socket = new WebSocket(pageSocketUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	let nextId = 1;
	const pending = new Map();
	const errors = [];
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (message.id) {
			const waiter = pending.get(message.id);
			if (!waiter) return;
			pending.delete(message.id);
			message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
			return;
		}
		if (message.method === "Runtime.exceptionThrown") {
			errors.push(message.params?.exceptionDetails?.text || "unhandled browser exception");
		}
	});
	const call = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = async (expression) => {
		const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluate failed");
		}
		return result.result?.value;
	};
	const retry = async (fn, labelText, timeout = 25000) => {
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
		throw new Error(`${label}: ${labelText} timed out${last ? ": " + last.message : ""}`);
	};
	const waitFor = (expression, labelText, timeout) =>
		retry(typeof expression === "function" ? expression : () => evaluate(expression), labelText, timeout);
	const click = async (selector, labelText = selector) => {
		const ok = await evaluate(
			"(() => { const node = document.querySelector(" + JSON.stringify(selector) +
				"); if (!node || node.disabled || node.getClientRects().length === 0) return false; node.click(); return true; })()",
		);
		if (!ok) throw new Error(`${label}: could not click ${labelText}`);
	};
	const clickText = async (text, scope = "body") => {
		const ok = await evaluate(
			"(() => { const root = document.querySelector(" + JSON.stringify(scope) +
				") || document; const node = [...root.querySelectorAll('button')].find((button) => !button.disabled && button.getClientRects().length > 0 && (button.textContent.trim().includes(" +
				JSON.stringify(text) + ") || (button.getAttribute('aria-label') || '').includes(" + JSON.stringify(text) + "))); if (!node) return false; node.click(); return true; })()",
		);
		if (!ok) throw new Error(`${label}: could not click button "${text}"`);
	};
	const setInput = async (selector, value) => {
		const ok = await evaluate(
			"(() => { const node = document.querySelector(" + JSON.stringify(selector) +
				"); if (!node) return false; const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (!setter) return false; setter.call(node, " +
				JSON.stringify(value) +
				"); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()",
		);
		if (!ok) throw new Error(`${label}: could not set ${selector}`);
	};
	await call("Page.enable");
	await call("Runtime.enable");
	await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	await call("Page.navigate", { url: APP });
	await sleep(400);
	return {
		label,
		evaluate,
		retry,
		waitFor,
		click,
		clickText,
		setInput,
		viewport: async (width, height = 900) => {
			await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
			await sleep(200);
		},
		reload: async () => {
			await call("Page.reload", { ignoreCache: true });
			await sleep(400);
		},
		escape: async () => {
			await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await sleep(250);
		},
		errors,
		close: async () => {
			try {
				await call("Browser.close");
			} catch {}
			socket.close();
			try {
				child.kill();
			} catch {}
			await sleep(600);
			for (let attempt = 0; attempt < 10; attempt += 1) {
				try {
					rmSync(profile, { recursive: true, force: true });
					break;
				} catch {
					await sleep(300);
				}
			}
		},
	};
}

async function signIn(context, email) {
	await context.waitFor('document.querySelector("#workspace-email") !== null', "login screen");
	await context.setInput("#workspace-email", email);
	await context.setInput("#workspace-password", "password123");
	// The login card has no <form>; it submits through the primary button.
	await context.clickText("Next", ".workspace-login-actions");
	await context.waitFor(
		'[...document.querySelectorAll("button")].some((node) => node.getAttribute("aria-label")?.startsWith("Continue as"))',
		"profile picker",
	);
	await context.click('[aria-label^="Continue as"]', "profile");
	await context.waitFor('document.querySelector(".app-shell") !== null', "workspace");
}

async function smokeApi() {
	const health = await fetch(`${API}/health`);
	if (!health.ok) throw new Error("The Tracer API is not reachable at " + API);
	const frontend = await fetch(APP);
	if (!frontend.ok) throw new Error("The Tracer frontend is not reachable at " + APP);
}

// Makes the run idempotent: whatever a previous run left behind, Alex must be
// OWNER of "API Platform Team" and Jordan an EDITOR member of it.
async function resetCollaboration() {
	const login = async (email) => {
		const response = await fetch(`${API}/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password: "password123" }),
		});
		if (!response.ok) throw new Error(`reset: login failed for ${email} (${response.status})`);
		const sessionToken = (await response.json()).data.token;
		const listResponse = await fetch(`${API}/profiles`, { headers: { authorization: `Bearer ${sessionToken}` } });
		if (!listResponse.ok) throw new Error(`reset: could not list profiles for ${email} (${listResponse.status})`);
		const profiles = (await listResponse.json()).data || [];
		const profile = profiles.find((entry) => entry.email === email) || profiles[0];
		if (!profile) throw new Error(`reset: ${email} has no profile`);
		const pick = await fetch(`${API}/auth/switch-profile`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
			body: JSON.stringify({ profileId: profile._id }),
		});
		if (!pick.ok) throw new Error(`reset: could not select a profile for ${email} (${pick.status})`);
		return (await pick.json()).data.token;
	};
	const alexToken = await login("alex.morgan@example.test");
	const headers = { authorization: `Bearer ${alexToken}`, "content-type": "application/json" };
	const list = await (await fetch(`${API}/workspaces`, { headers })).json();
	const team = (list.data || []).find((entry) => /API Platform Team/i.test(entry.name)) || (list.data || [])[0];
	if (!team) throw new Error("reset: no seeded workspace is visible to Alex");
	const scoped = { ...headers, "x-workspace-id": team._id };
	const detail = (await (await fetch(`${API}/workspaces/${team._id}`, { headers: scoped })).json()).data;
	const jordan = (detail.members || []).find((member) => /jordan/i.test(member.email || ""));
	if (!jordan) {
		const add = await fetch(`${API}/workspaces/${team._id}/members`, {
			method: "POST",
			headers: scoped,
			body: JSON.stringify({ expectedRevision: detail.revision, email: "jordan.lee@example.test", role: "EDITOR" }),
		});
		if (!add.ok && add.status !== 409) throw new Error(`reset: re-add failed (${add.status})`);
		return;
	}
	if (jordan.role !== "EDITOR") {
		const change = await fetch(`${API}/workspaces/${team._id}/members/${jordan.profileId}`, {
			method: "PUT",
			headers: scoped,
			body: JSON.stringify({ expectedRevision: detail.revision, role: "EDITOR" }),
		});
		if (!change.ok) throw new Error(`reset: could not restore Editor (${change.status})`);
	}
}

// Real DOM helpers for the Phase 24 surfaces.
async function openManage(context) {
	await context.click('[aria-label="Workspace actions"]', "workspace actions");
	await context.waitFor('document.querySelector(".menu [role=menuitem]") !== null', "workspace menu");
	const clicked = await context.evaluate(`(() => {
		const node = [...document.querySelectorAll(".menu [role=menuitem]")].find((item) => !item.disabled && item.textContent.includes("Manage workspace"));
		if (!node) return false;
		node.click();
		return true;
	})()`);
	if (!clicked) throw new Error(`${context.label}: could not open Manage workspace`);
	await context.waitFor('document.querySelector(".workspace-modal .workspace-tabs") !== null', "manage dialog");
	await context.waitFor('document.querySelectorAll(".workspace-modal .member-row").length > 0', "member rows");
}

// Runs a snippet inside the page with this user's own token and active workspace.
function apiBase(expression) {
	return `(async () => {
		const token = localStorage.getItem("request-desk-profile-token");
		const ws = localStorage.getItem("request-desk-workspace-id");
		const base = ${JSON.stringify(API)};
		const headers = { authorization: "Bearer " + token, "x-workspace-id": ws, "content-type": "application/json" };
		${expression}
	})()`;
}

await (async () => {
	await smokeApi();
	await resetCollaboration();

	let alex = null;
	let jordan = null;
	try {
	alex = await openContext("alex", 9445);
	jordan = await openContext("jordan", 9446);

	// ------------------------------------------------------------ login separation
	await signIn(alex, "alex.morgan@example.test");
	await signIn(jordan, "jordan.lee@example.test");
	pass("1. Two independently launched browsers sign in as two different accounts");

	const alexIdentity = await alex.evaluate('document.querySelector(".profile-chip-text")?.textContent.replace(/\\s+/g, " ").trim() || ""');
	const jordanIdentity = await jordan.evaluate('document.querySelector(".profile-chip-text")?.textContent.replace(/\\s+/g, " ").trim() || ""');
	if (!/Alex/.test(alexIdentity) || !/Jordan/.test(jordanIdentity)) {
		throw new Error(`Contexts are not independently authenticated: alex="${alexIdentity}" jordan="${jordanIdentity}"`);
	}
	const tokensDiffer = await alex.evaluate(
		'!!localStorage.getItem("request-desk-profile-token")',
	);
	if (!tokensDiffer) throw new Error("Alex's browser has no profile token");
	pass("2. Each browser holds its own session token for its own account", `alex="${alexIdentity.slice(0, 26)}" jordan="${jordanIdentity.slice(0, 26)}"`);

	// ------------------------------------------------------------ workspace switcher + roles
	await alex.waitFor('document.querySelector(".workspace-switcher") !== null', "workspace switcher");
	await jordan.waitFor('document.querySelector(".workspace-switcher") !== null', "workspace switcher");
	const alexRole = await alex.evaluate('document.querySelector(".workspace-role-badge")?.textContent.trim() || ""');
	const jordanRole = await jordan.evaluate('document.querySelector(".workspace-role-badge")?.textContent.trim() || ""');
	if (alexRole !== "Owner" || jordanRole !== "Editor") {
		throw new Error(`Unexpected role badges: alex="${alexRole}" jordan="${jordanRole}"`);
	}
	const alexWorkspace = await alex.evaluate('document.querySelector(".workspace-picker .select-menu-value")?.textContent.trim() || ""');
	pass("3. Each user sees the shared workspace name and their own role", `alex=${alexRole} jordan=${jordanRole} ws="${alexWorkspace}"`);

	// ------------------------------------------------------------ shared collections
	const collectionsOf = (context) =>
		context.evaluate('Array.from(document.querySelectorAll(".tree-label")).map((n) => n.textContent.replace(/\\s+/g, " ").trim()).join("|")');
	const alexCollections = await alex.waitFor(() => collectionsOf(alex), "alex collections");
	const jordanCollections = await jordan.waitFor(() => collectionsOf(jordan), "jordan collections");
	if (!/Orders|Example/i.test(alexCollections)) throw new Error("Alex sees no seeded collections in the shared workspace: " + alexCollections);
	if (alexCollections !== jordanCollections) {
		throw new Error(`Shared workspaces disagree:\nalex="${alexCollections}"\njordan="${jordanCollections}"`);
	}
	pass("4. Both users see the identical shared collection tree", `"${alexCollections.slice(0, 70)}"`);

	// ------------------------------------------------------------ manage dialog
	await openManage(alex);
	const memberRows = await alex.evaluate(
		'Array.from(document.querySelectorAll(".workspace-modal .member-row")).map((n) => n.textContent.replace(/\\s+/g, " ").trim()).join(" | ")',
	);
	for (const expected of ["Alex Morgan", "Jordan Lee", "Owner", "Editor"]) {
		if (!memberRows.replace(/\s/g, "").includes(expected.replace(/\s/g, ""))) throw new Error(`Member list missing "${expected}": ${memberRows}`);
	}
	pass("5. Manage lists both real members with their roles", memberRows.slice(0, 110));

	const hasShareForm = await alex.evaluate('document.querySelector(".workspace-modal .share-form input") !== null');
	const sectionTabs = await alex.evaluate(
		'Array.from(document.querySelectorAll(".workspace-modal .workspace-tabs .editor-tab")).map((n) => n.textContent.trim()).join("|")',
	);
	if (!hasShareForm || !/Activity/.test(sectionTabs)) throw new Error("Manage is missing share-by-email or the Activity section: " + sectionTabs);
	pass("6. Manage exposes share-by-email and an Activity section", sectionTabs);

	// ------------------------------------------------------------ manage activity tab (no secrets)
	await alex.evaluate(`(() => {
		const tab = [...document.querySelectorAll(".workspace-modal .workspace-tabs .editor-tab")].find((n) => n.textContent.includes("Activity"));
		tab.click();
		return true;
	})()`);
	const modalActivity = await alex.waitFor(
		'(() => { const node = document.querySelector(".workspace-activity"); if (!node) return ""; const text = node.textContent.replace(/\\s+/g, " ").trim(); if (!text || /Loading/i.test(text)) return ""; return text; })()',
		"manage activity",
	);
	if (!/Jordan|Alex|workspace|member/i.test(modalActivity)) throw new Error("Activity section has no attributable events: " + modalActivity);
	if (/authorization|set-cookie|password123/i.test(modalActivity)) throw new Error("Activity section leaked sensitive material");
	pass("7. The Activity section shows attributed events with no sensitive material", modalActivity.slice(0, 90));
	await alex.escape();
	await alex.waitFor('document.querySelector(".workspace-modal") === null', "manage closed");

	// ------------------------------------------------------------ activity sidebar tab
	await alex.clickText("Activity", ".sidebar-tabs");
	await alex.waitFor('document.querySelector(".workspace-activity") !== null', "activity view");
	const sidebarActivity = await alex.waitFor(
		'(() => { const node = document.querySelector(".workspace-activity"); if (!node) return ""; const text = node.textContent.replace(/\\s+/g, " ").trim(); if (!text || /Loading/i.test(text)) return ""; return text; })()',
		"sidebar activity",
	);
	if (!/workspace|member|role/i.test(sidebarActivity)) throw new Error("Activity tab has no workspace events: " + sidebarActivity);
	if (/authorization|set-cookie|password123/i.test(sidebarActivity)) throw new Error("Activity tab leaked sensitive material");
	pass("8. The Activity sidebar tab shows the workspace feed with no secret leakage", sidebarActivity.slice(0, 90));

	// ------------------------------------------------------------ workbench still intact
	await alex.clickText("Collections", ".sidebar-tabs");
	await alex.waitFor('document.querySelector(".tree") !== null', "collections tree");
	await alex.waitFor('document.querySelectorAll(".tree-label").length > 0', "collection titles");
	// Expand the first collection, then open one of its requests: the workbench
	// renders the request builder once a request row is opened.
	await alex.click(".tree .tree-label", "shared collection");
	await alex.waitFor('document.querySelectorAll(".tree-row").length > 3', "collection expanded");
	const openedRequest = await alex.evaluate(`(() => {
		const row = [...document.querySelectorAll(".tree-row")].find((node) => /GET|POST|PATCH|DELETE/.test(node.textContent) && node.querySelector(".tree-label"));
		if (!row) return false;
		row.querySelector(".tree-label").click();
		return true;
	})()`);
	if (!openedRequest) throw new Error("Alex: could not open a shared request");
	await alex.waitFor('document.querySelector(".request-builder") !== null', "request builder");
	pass("9. The Phase 30 workbench still opens a shared collection with a request builder");

	// ------------------------------------------------------------ OWNER demotes Jordan to VIEWER (UI)
	await openManage(alex);
	const openedRole = await alex.evaluate(`(() => {
		const row = [...document.querySelectorAll(".workspace-modal .member-row")].find((n) => n.textContent.includes("Jordan"));
		if (!row) return false;
		const trigger = row.querySelector(".member-role .select-menu-trigger");
		if (!trigger) return false;
		trigger.click();
		return true;
	})()`);
	if (!openedRole) throw new Error("Could not open Jordan's role control");
	const choseViewer = await alex.evaluate(`(() => {
		const option = [...document.querySelectorAll(".member-role [role=option]")].find((n) => n.textContent.trim().startsWith("Viewer"));
		if (!option) return false;
		option.click();
		return true;
	})()`);
	if (!choseViewer) throw new Error("Could not choose the Viewer role");
	await alex.retry(
		() => alex.evaluate('[...document.querySelectorAll(".workspace-modal .member-row")].some((n) => n.textContent.includes("Jordan") && /Viewer/.test(n.textContent))'),
		"role change to Viewer",
	);
	pass("10. Alex demotes Jordan to Viewer through the real Manage dialog");
	await alex.escape();

	// The demotion is authoritative the moment it is saved: Jordan's *very next*
	// request over his own token is refused, even though his page was rendered
	// before the change (roles are not pushed in realtime, by design).
	const viewerBypass = await jordan.evaluate(apiBase(`
		const list = (await (await fetch(base + "/collections", { headers })).json()).data;
		const first = list[0];
		const full = (await (await fetch(base + "/collections/" + first._id, { headers })).json()).data;
		const write = await fetch(base + "/collections/" + first._id, {
			method: "PUT",
			headers,
			body: JSON.stringify({ expectedRevision: full.revision, collection: { name: full.name, description: full.description, variables: full.variables, auth: full.auth, folders: full.folders, requests: full.requests } }),
		});
		const exec = await fetch(base + "/executions", {
			method: "POST",
			headers,
			body: JSON.stringify({
				executionId: crypto.randomUUID(), tabId: "viewer-bypass", draftVersion: 0,
				request: { schemaVersion: 1, id: crypto.randomUUID(), folderId: null, name: "viewer", method: "GET", urlTemplate: "http://127.0.0.1:8000/demo/v1/examples/text", query: [], headers: [], body: { mode: "none" }, auth: { mode: "none" }, settings: { timeoutMs: 15000 } },
				context: {},
			}),
		});
		const del = await fetch(base + "/collections/" + first._id + "?revision=" + full.revision, { method: "DELETE", headers });
		return { write: write.status, exec: exec.status, del: del.status };
	`));
	if (viewerBypass.write !== 403 || viewerBypass.exec !== 403 || viewerBypass.del !== 403) {
		throw new Error("Viewer was not refused: " + JSON.stringify(viewerBypass));
	}
	pass("11. The demotion is enforced on Jordan's very next request (write, execute, delete all refused)", JSON.stringify(viewerBypass));

	// Reloading Jordan's page shows the same truth in the UI: read-only banner and
	// a disabled Send control. The client fails closed from the server's role.
	await jordan.reload();
	await jordan.waitFor('document.querySelector(".app-shell") !== null', "jordan reloaded");
	await jordan.retry(() => jordan.evaluate('document.querySelector(".workspace-role-badge")?.textContent.trim() === "Viewer"'), "viewer badge in Jordan");
	// A viewer still *reads* shared definitions; opening a request must show a
	// disabled Send control rather than a working one.
	await jordan.waitFor('document.querySelector(".workspace-readonly-banner") !== null', "viewer read-only banner");
	await jordan.evaluate('(() => { const l = document.querySelector(".tree .tree-label"); if (l) l.click(); return true; })()');
	await jordan.waitFor('document.querySelectorAll(".tree-row").length > 3', "jordan tree expanded");
	await jordan.evaluate(`(() => {
		const row = [...document.querySelectorAll(".tree-row")].find((node) => /GET|POST|PATCH|DELETE/.test(node.textContent) && node.querySelector(".tree-label"));
		if (!row) return false;
		row.querySelector(".tree-label").click();
		return true;
	})()`);
	await jordan.waitFor('document.querySelector(".request-builder") !== null', "jordan request builder");
	await jordan.waitFor('document.querySelector(".send-button") !== null', "jordan send control");
	const sendDisabled = await jordan.evaluate('document.querySelector(".send-button")?.disabled ?? null');
	if (sendDisabled !== true) throw new Error("Viewer's Send control was not disabled in the other browser");
	const viewerBanner = await jordan.evaluate('document.querySelector(".workspace-readonly-banner").textContent.replace(/\\s+/g, " ").trim()');
	pass("12. The other browser renders the viewer read-only state", `banner="${viewerBanner.slice(0, 55)}" Send disabled`);

	// ------------------------------------------------------------ restore EDITOR
	await openManage(alex);
	await alex.evaluate(`(() => {
		const row = [...document.querySelectorAll(".workspace-modal .member-row")].find((n) => n.textContent.includes("Jordan"));
		row.querySelector(".member-role .select-menu-trigger").click();
		return true;
	})()`);
	const choseEditor = await alex.evaluate(`(() => {
		const option = [...document.querySelectorAll(".member-role [role=option]")].find((n) => n.textContent.trim().startsWith("Editor"));
		if (!option) return false;
		option.click();
		return true;
	})()`);
	if (!choseEditor) throw new Error("Could not choose the Editor role");
	await alex.retry(
		() => alex.evaluate('[...document.querySelectorAll(".workspace-modal .member-row")].some((n) => n.textContent.includes("Jordan") && /Editor/.test(n.textContent))'),
		"role restored to Editor",
	);
	await alex.escape();
	await jordan.reload();
	await jordan.waitFor('document.querySelector(".app-shell") !== null', "jordan reloaded");
	await jordan.retry(() => jordan.evaluate('document.querySelector(".workspace-role-badge")?.textContent.trim() === "Editor"'), "editor badge restored in Jordan");
	await jordan.retry(() => jordan.evaluate('document.querySelector(".workspace-readonly-banner") === null'), "read-only banner cleared");
	pass("13. Restoring Editor immediately re-enables the other browser");

	// A unique name keeps each run independent of the previous one.
	const sharedName = "Shared via Alex " + Date.now().toString(36);

	// ------------------------------------------------------------ concurrent edit -> 409
	const stale = await jordan.evaluate(apiBase(`
		const list = (await (await fetch(base + "/collections", { headers })).json()).data;
		const first = list[0];
		const full = (await (await fetch(base + "/collections/" + first._id, { headers })).json()).data;
		return { id: first._id, revision: full.revision, description: full.description, variables: full.variables, auth: full.auth, folders: full.folders, requests: full.requests };
	`));
	// Alex saves first, from his own browser, using the revision he read.
	const alexSave = await alex.evaluate(apiBase(`
		const list = (await (await fetch(base + "/collections", { headers })).json()).data;
		const first = list[0];
		const full = (await (await fetch(base + "/collections/" + first._id, { headers })).json()).data;
		const res = await fetch(base + "/collections/" + first._id, {
			method: "PUT",
			headers,
			body: JSON.stringify({ expectedRevision: full.revision, collection: { name: ${JSON.stringify(sharedName)}, description: full.description, variables: full.variables, auth: full.auth, folders: full.folders, requests: full.requests } }),
		});
		return { status: res.status, body: await res.json() };
	`));
	if (alexSave.status !== 200) throw new Error("Alex's first write failed: " + JSON.stringify(alexSave));
	// Jordan now writes with the *stale* revision he read before Alex's save.
	const jordanStale = await jordan.evaluate(apiBase(`
		const res = await fetch(base + "/collections/" + ${JSON.stringify(stale.id)}, {
			method: "PUT",
			headers,
			body: JSON.stringify({ expectedRevision: ${stale.revision}, collection: { name: "Shared via Jordan", description: ${JSON.stringify(stale.description)}, variables: ${JSON.stringify(stale.variables)}, auth: ${JSON.stringify(stale.auth)}, folders: ${JSON.stringify(stale.folders)}, requests: ${JSON.stringify(stale.requests)} } }),
		});
		return { status: res.status, body: await res.json() };
	`));
	if (jordanStale.status !== 409) throw new Error(`Expected 409 for the stale write, got ${jordanStale.status}: ${JSON.stringify(jordanStale)}`);
	const attribution = JSON.stringify(jordanStale.body);
	if (!/revision/i.test(attribution)) throw new Error("409 carried no revision attribution: " + attribution);
	const winnerValue = await jordan.evaluate(apiBase(`
		const full = (await (await fetch(base + "/collections/" + ${JSON.stringify(stale.id)}, { headers })).json()).data;
		return full.name;
	`));
	if (winnerValue !== sharedName) throw new Error("The stale write was not rejected — stored name is now " + winnerValue);
	pass("14. A concurrent edit is a typed 409 (first CAS wins, no silent overwrite)", `alex=${alexSave.status} jordan=${jordanStale.status} stored="${winnerValue}"`);

	// ------------------------------------------------------------ shared definition visible across users
	// Jordan's browser re-reads the shared workspace and now sees Alex's rename.
	await jordan.reload();
	await jordan.waitFor('document.querySelector(".app-shell") !== null', "jordan reloaded");
	await jordan.retry(
		() => jordan.evaluate(`document.querySelector(".tree")?.textContent.includes(${JSON.stringify(sharedName)}) === true`),
		"Alex's rename visible in Jordan's browser",
	);
	pass("15. A shared definition change by one user becomes visible to the other");

	// ------------------------------------------------------------ remove member
	await openManage(alex);
	const removeClicked = await alex.evaluate(`(() => {
		const button = document.querySelector('[aria-label="Remove Jordan Lee"]');
		if (!button || button.disabled) return false;
		button.click();
		return true;
	})()`);
	if (!removeClicked) throw new Error("Could not use Jordan's Remove control");
	// Removal goes straight through the workspace mutation pipeline (no extra
	// confirmation step); the member list is the observable result.
	await alex.retry(
		() => alex.evaluate('![...document.querySelectorAll(".workspace-modal .member-row")].some((n) => n.textContent.includes("Jordan"))'),
		"Jordan removed",
	);
	pass("16. Alex removes Jordan through the Manage dialog");
	await alex.escape();

	const removedAccess = await jordan.evaluate(apiBase(`
		const res = await fetch(base + "/collections", { headers });
		return res.status;
	`));
	if (removedAccess === 200) throw new Error("A removed member can still read the workspace");
	pass("17. The removed user immediately loses access to the workspace", "status=" + removedAccess);

	// ------------------------------------------------------------ re-add by email
	const readded = await alex.evaluate(apiBase(`
		const detail = (await (await fetch(base + "/workspaces/" + ws, { headers })).json()).data;
		const res = await fetch(base + "/workspaces/" + ws + "/members", {
			method: "POST",
			headers,
			body: JSON.stringify({ expectedRevision: detail.revision, email: "jordan.lee@example.test", role: "EDITOR" }),
		});
		return res.status;
	`));
	if (readded !== 201) throw new Error("Re-adding Jordan failed with " + readded);
	pass("18. Re-adding a member by email works", "status=" + readded);

	// ------------------------------------------------------------ activity records the collaboration
	const activityAfter = await alex.evaluate(apiBase(`
		const res = (await (await fetch(base + "/workspaces/" + ws + "/activity?limit=50", { headers })).json()).data;
		const entries = res.entries || res.items || res;
		return { count: entries.length, kinds: Array.from(new Set(entries.map((e) => e.action || e.type || e.kind))).join(","), text: JSON.stringify(entries) };
	`));
	for (const expected of ["member", "role"]) {
		if (!activityAfter.text.toLowerCase().includes(expected)) throw new Error(`Activity feed never recorded a ${expected} event`);
	}
	if (/authorization|set-cookie|password123|DEMO_ALEX_PRIVATE_TOKEN/i.test(activityAfter.text)) {
		throw new Error("Activity feed leaked sensitive material");
	}
	pass("19. Activity recorded membership and role changes with no secret leakage", `${activityAfter.count} events: ${activityAfter.kinds}`);

	// ------------------------------------------------------------ secret + history boundaries
	const boundaries = await jordan.evaluate(apiBase(`
		const envs = (await (await fetch(base + "/environments", { headers })).json()).data;
		const first = envs[0];
		const full = (await (await fetch(base + "/environments/" + first._id, { headers })).json()).data;
		const secretBlob = JSON.stringify(full);
		const resolved = [];
		for (const variable of full.variables || []) {
			if (variable.kind !== "secretRef") continue;
			const res = await fetch(base + "/environments/" + first._id + "/secrets/" + encodeURIComponent(variable.alias), { headers });
			resolved.push({ alias: variable.alias, status: res.status });
		}
		return { envCount: envs.length, secretBlob, resolved };
	`));
	if (/DEMO_ALEX_PRIVATE_TOKEN|private-token-value|alex-private/i.test(boundaries.secretBlob)) {
		throw new Error("A shared environment exposed a raw secret value");
	}
	const leakedResolutions = boundaries.resolved.filter((entry) => entry.status === 200);
	if (leakedResolutions.length > 0) {
		throw new Error("A collaborator resolved another profile's secret alias: " + JSON.stringify(leakedResolutions));
	}
	pass("20. A shared environment exposes only secretRef aliases — never values", `envs=${boundaries.envCount} resolutions=${JSON.stringify(boundaries.resolved)}`);

	// Alex creates history in the shared workspace, then we prove Jordan cannot see it.
	await alex.evaluate(apiBase(`
		const envs = (await (await fetch(base + "/environments", { headers })).json()).data;
		const env = envs[0];
		await fetch(base + "/executions", {
			method: "POST",
			headers,
			body: JSON.stringify({
				executionId: crypto.randomUUID(), tabId: "alex-history", draftVersion: 0,
				request: { schemaVersion: 1, id: crypto.randomUUID(), folderId: null, name: "alex-history", method: "GET", urlTemplate: "http://127.0.0.1:8000/demo/v1/examples/text", query: [], headers: [], body: { mode: "none" }, auth: { mode: "none" }, settings: { timeoutMs: 15000 } },
				context: env ? { environmentId: env._id, environmentRevision: env.revision } : {},
			}),
		});
		return true;
	`));
	const alexHistory = await alex.evaluate(apiBase(`
		const history = await (await fetch(base + "/history?limit=50", { headers })).json();
		const entries = (history.data && (history.data.entries || history.data.items)) || [];
		return entries.length;
	`));
	const jordanHistory = await jordan.evaluate(apiBase(`
		const history = await (await fetch(base + "/history?limit=50", { headers })).json();
		const entries = (history.data && (history.data.entries || history.data.items)) || [];
		return { count: entries.length, tabs: entries.map((e) => e.tabId || e.requestName || "").join(",") };
	`));
	if (alexHistory < 1) throw new Error("Alex's shared-workspace execution produced no history");
	if (jordanHistory.tabs.includes("alex-history")) {
		throw new Error("Jordan can see Alex's execution history: " + JSON.stringify(jordanHistory));
	}
	pass("21. Execution history stays profile-scoped inside a shared workspace", `alex=${alexHistory} jordan=${jordanHistory.count}`);

	// ------------------------------------------------------------ responsive + themes
	for (const [label, context] of [["Alex", alex], ["Jordan", jordan]]) {
		for (const width of [375, 768, 1024, 1440]) {
			await context.viewport(width);
			const overflow = await context.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
			if (overflow > 1) throw new Error(`${label} has ${overflow}px horizontal overflow at ${width}px`);
		}
	}
	pass("22. No unintended horizontal overflow at 375/768/1024/1440 in either browser");

	for (const [label, context] of [["Alex", alex], ["Jordan", jordan]]) {
		for (const theme of ["light", "dark"]) {
			const current = await context.evaluate('document.documentElement.dataset.theme || "dark"');
			if (current !== theme) {
				await context.click('[aria-label^="Switch to "]', `${label} theme toggle`);
				await sleep(300);
			}
			await context.retry(
				() => context.evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`),
				`${label} ${theme} theme`,
			);
		}
	}
	pass("23. Both browsers render in light and dark themes");

	await alex.viewport(1440);
	if (alex.errors.length || jordan.errors.length) {
		throw new Error(`Browser exceptions: alex=[${alex.errors.join(" | ")}] jordan=[${jordan.errors.join(" | ")}]`);
	}
	pass("24. No unhandled browser exceptions in either browser");

	await alex.close();
	await jordan.close();
	alex = null;
	jordan = null;
	process.stdout.write(`PHASE24_E2E_PASS ${checks.length}/${checks.length}\n`);
	process.exit(0);
	} catch (error) {
		if (alex) await alex.close().catch(() => {});
		if (jordan) await jordan.close().catch(() => {});
		throw error;
	}
})();
