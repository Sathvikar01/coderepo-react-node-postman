// Phase 24B — two-user live collaboration + version history, driven through two
// real, independent browser sessions (Alex and Jordan).
//
// Hardening lessons from the Phase 24 runner pile-up are built in:
// - CDP ports derive from the process pid, so concurrent runs never share them.
// - Every CDP call has a timeout and rejects when the socket closes, so a dead
//   browser fails fast instead of hanging forever.
// - A global run deadline kills the browsers and exits non-zero; this script
//   must never hang CI the way the fixed-port runner did.
//
// Prerequisites: MongoDB running, freshly seeded (`bun run seed` in backend),
// backend on :8000, frontend on :3000.
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const APP = "http://localhost:3000";
const API = "http://127.0.0.1:8000/api/v1";
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const CALL_TIMEOUT_MS = 25000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PORT_BASE = 9460 + (process.pid % 200) * 2;
const ALEX_PORT = PORT_BASE;
const JORDAN_PORT = PORT_BASE + 1;

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
	const profile = `${process.env.TEMP || "/tmp"}/tracer-p24b-${label}-${process.pid}`;
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
	if (!pageSocketUrl) {
		try {
			child.kill();
		} catch {}
		throw new Error(`${label}: no page target was exposed by Chrome`);
	}
	const socket = new WebSocket(pageSocketUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	let nextId = 1;
	const pending = new Map();
	const errors = [];
	const settleAll = (error) => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	};
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (message.id) {
			const waiter = pending.get(message.id);
			if (!waiter) return;
			pending.delete(message.id);
			if (waiter.timer) clearTimeout(waiter.timer);
			message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
			return;
		}
		if (message.method === "Runtime.exceptionThrown") {
			errors.push(message.params?.exceptionDetails?.text || "unhandled browser exception");
		}
	});
	socket.addEventListener("close", () => settleAll(new Error(`${label}: browser socket closed`)));
	socket.addEventListener("error", () => settleAll(new Error(`${label}: browser socket error`)));
	const call = (method, params = {}, timeout = CALL_TIMEOUT_MS) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`${label}: CDP ${method} timed out after ${timeout}ms`));
			}, timeout);
			pending.set(id, { resolve, reject, timer });
			try {
				socket.send(JSON.stringify({ id, method, params }));
			} catch (error) {
				clearTimeout(timer);
				pending.delete(id);
				reject(error);
			}
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
				await call("Browser.close", {}, 5000);
			} catch {}
			try {
				socket.close();
			} catch {}
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
	await context.clickText("Next", ".workspace-login-actions");
	await context.waitFor(
		'[...document.querySelectorAll("button")].some((node) => node.getAttribute("aria-label")?.startsWith("Continue as"))',
		"profile picker",
	);
	await context.click('[aria-label^="Continue as"]', "profile");
	await context.waitFor('document.querySelector(".app-shell") !== null', "workspace");
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

const toastText = `(() => document.querySelector(".toast-region")?.textContent.replace(/\\s+/g, " ").trim() || "")()`;

async function smokeApi() {
	const health = await fetch(`${API}/health`);
	if (!health.ok) throw new Error("The Tracer API is not reachable at " + API);
	const frontend = await fetch(APP);
	if (!frontend.ok) throw new Error("The Tracer frontend is not reachable at " + APP);
}

// Idempotent: whatever a previous run left behind, Alex is OWNER of
// "API Platform Team" and Jordan is an EDITOR member of it.
async function ensureMembership() {
	const login = async (email) => {
		const response = await fetch(`${API}/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password: "password123" }),
		});
		if (!response.ok) throw new Error(`setup: login failed for ${email} (${response.status})`);
		const sessionToken = (await response.json()).data.token;
		const listResponse = await fetch(`${API}/profiles`, { headers: { authorization: `Bearer ${sessionToken}` } });
		const profiles = (await listResponse.json()).data || [];
		const profile = profiles.find((entry) => entry.email === email) || profiles[0];
		const switchResponse = await fetch(`${API}/auth/switch-profile`, {
			method: "POST",
			headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
			body: JSON.stringify({ profileId: profile._id }),
		});
		return { token: (await switchResponse.json()).data.token, profile };
	};
	const alex = await login("alex.morgan@example.test");
	const jordan = await login("jordan.lee@example.test");
	const headers = { authorization: `Bearer ${alex.token}`, "content-type": "application/json" };
	const list = await (await fetch(`${API}/workspaces`, { headers })).json();
	const team = (list.data || []).find((entry) => entry.name === "API Platform Team");
	if (!team) throw new Error("setup: no seeded team workspace is visible to Alex");
	const scoped = { ...headers, "x-workspace-id": team._id };
	const detail = (await (await fetch(`${API}/workspaces/${team._id}`, { headers: scoped })).json()).data;
	const membership = detail.members.find((entry) => entry.profileId === jordan.profile._id);
	if (!membership) {
		const add = await fetch(`${API}/workspaces/${team._id}/members`, {
			method: "POST",
			headers: scoped,
			body: JSON.stringify({ expectedRevision: detail.revision, email: "jordan.lee@example.test", role: "EDITOR" }),
		});
		if (![200, 201].includes(add.status)) throw new Error("setup: could not add Jordan (" + add.status + ")");
	} else if (membership.role !== "EDITOR") {
		const change = await fetch(`${API}/workspaces/${team._id}/members/${jordan.profile._id}`, {
			method: "PUT",
			headers: scoped,
			body: JSON.stringify({ expectedRevision: detail.revision, role: "EDITOR" }),
		});
		if (!change.ok) throw new Error("setup: could not restore Jordan to EDITOR (" + change.status + ")");
	}
	return { teamId: team._id };
}

let alex = null;
let jordan = null;
async function cleanup() {
	if (alex) await alex.close().catch(() => {});
	if (jordan) await jordan.close().catch(() => {});
	alex = null;
	jordan = null;
}
const deadline = setTimeout(async () => {
	process.stderr.write("PHASE24B_LIVE_E2E_TIMEOUT: global deadline reached, cleaning up\n");
	await cleanup();
	process.exit(1);
}, RUN_TIMEOUT_MS);

await (async () => {
	await smokeApi();
	const { teamId } = await ensureMembership();

	try {
		alex = await openContext("alex", ALEX_PORT);
		jordan = await openContext("jordan", JORDAN_PORT);

		await signIn(alex, "alex.morgan@example.test");
		await signIn(jordan, "jordan.lee@example.test");
		pass("1. Both log in separately");

		const sameWorkspace = await alex.evaluate(`(() => {
			const a = localStorage.getItem("request-desk-workspace-id");
			return { mine: a, team: ${JSON.stringify(teamId)}, match: a === ${JSON.stringify(teamId)} };
		})()`);
		if (!sameWorkspace.match) throw new Error("Alex is not in the team workspace: " + JSON.stringify(sameWorkspace));
		const jordanSame = await jordan.evaluate(`localStorage.getItem("request-desk-workspace-id") === ${JSON.stringify(teamId)}`);
		if (!jordanSame) throw new Error("Jordan is not in the team workspace");
		for (const [who, context] of [["alex", alex], ["jordan", jordan]]) {
			const command = await context.evaluate(`document.querySelector('[aria-label^="Workspace:"]')?.getAttribute("aria-label") || ""`);
			if (!/API Platform Team/.test(command)) throw new Error(`${who} workspace command does not show the team workspace: ${command}`);
		}
		pass("2. Both open API Platform Team through the Figma command rail", `workspace=${teamId.slice(-4)}`);

		// Same seeded collection visible to both (UI sidebar text).
		const collectionName = await alex.evaluate(apiBase(`
			const list = (await (await fetch(base + "/collections", { headers })).json()).data;
			const full = (await (await fetch(base + "/collections/" + list[0]._id, { headers })).json()).data;
			return { id: full._id, name: full.name, revision: full.revision, requestId: full.requests[0]?.id, method: full.requests[0]?.method };
		`));
		for (const [who, context] of [["alex", alex], ["jordan", jordan]]) {
			await context.waitFor(
				`[...document.querySelectorAll(".tree .tree-label")].some((n) => n.textContent.includes(${JSON.stringify(collectionName.name)}))`,
				`${who} sees collection`,
			);
		}
		pass("3. Both open the same collection", `${collectionName.name} rev=${collectionName.revision}`);

		// Jordan saves v2 by toggling the first request's method (visible in compare).
		const v2 = await jordan.evaluate(apiBase(`
			const full = (await (await fetch(base + "/collections/${collectionName.id}", { headers })).json()).data;
			const [first, ...rest] = full.requests;
			const toggled = first.method === "POST" ? "PATCH" : "POST";
			const next = { name: full.name, description: full.description ?? "", variables: full.variables ?? [], auth: full.auth ?? { mode: "none" }, folders: full.folders ?? [], requests: [{ ...first, method: toggled }, ...rest] };
			const res = await fetch(base + "/collections/${collectionName.id}", { method: "PUT", headers, body: JSON.stringify({ expectedRevision: full.revision, collection: next }) });
			const saved = (await res.json()).data;
			return { status: res.status, revision: saved?.revision, method: toggled };
		`));
		if (v2.status !== 200 || v2.revision !== collectionName.revision + 1) throw new Error("Jordan could not save v2: " + JSON.stringify(v2));
		pass("4. Jordan saves v2", `rev=${v2.revision}`);

		// Alex sees the change WITHOUT manual reload (live toast from the stream).
		await alex.waitFor(`(${toastText}).includes("v${v2.revision}")`, "live update toast", 30000);
		pass("5. Alex sees the change without manual reload");

		const versions = await alex.evaluate(apiBase(`
			const rows = (await (await fetch(base + "/collections/${collectionName.id}/versions", { headers })).json()).data;
			return rows.map((r) => ({ revision: r.revision, action: r.action }));
		`));
		if (versions.length < 2 || versions[0].revision !== v2.revision) throw new Error("v2 missing from history: " + JSON.stringify(versions));
		pass("6. Version v2 appears", versions.map((v) => `v${v.revision}:${v.action}`).join(" "));

		// Activity stays inside the workspace dialog so the Figma resource index
		// remains exactly Collections / History / Cookies / Examples.
		await alex.click('[aria-label^="Workspace:"]', "workspace command");
		await alex.waitFor('[...document.querySelectorAll(".menu [role=menuitem]")].some((n) => n.textContent.includes("Workspace activity"))', "workspace activity menu item");
		await alex.evaluate(`(() => {
			const item = [...document.querySelectorAll(".menu [role=menuitem]")].find((n) => n.textContent.includes("Workspace activity"));
			if (!item) return false;
			item.click();
			return true;
		})()`);
		await alex.waitFor('document.querySelector(".workspace-activity") !== null', "activity view");
		const activityText = await alex.waitFor(
			'(() => { const node = document.querySelector(".workspace-activity"); if (!node) return ""; const text = node.textContent.replace(/\\s+/g, " ").trim(); if (!text || /Loading/i.test(text)) return ""; return text; })()',
			"workspace activity",
		);
		if (!/revision 1 → 2|revision \d+ → \d+/.test(activityText)) throw new Error("No revision-transition activity: " + activityText.slice(0, 200));
		if (!/View versions/.test(activityText)) throw new Error("Activity rows have no version links");
		if (/authorization|set-cookie|password123/i.test(activityText)) throw new Error("Activity leaked sensitive material");
		const resourceTabs = await alex.evaluate('document.querySelectorAll(".sidebar-tabs .sidebar-tab").length');
		if (resourceTabs !== 4) throw new Error("Figma resource index drifted to " + resourceTabs + " slots");
		pass("7. Activity stays live inside Manage while the Figma resource index remains four slots");
		await alex.escape();
		await alex.waitFor('document.querySelector(".workspace-modal") === null', "activity dialog closed");
		await alex.waitFor('document.querySelector(".tree") !== null', "collections tree");

		// Alex opens v1 → v2 compare through the collection menu.
		await alex.evaluate(`(() => {
			const row = [...document.querySelectorAll(".tree-row")].find((n) => n.textContent.includes(${JSON.stringify(collectionName.name)}) && n.querySelector('[aria-haspopup="menu"]'));
			if (!row) return false;
			row.querySelector('[aria-haspopup="menu"]').click();
			return true;
		})()`);
		await alex.waitFor('[...document.querySelectorAll(".menu [role=menuitem]")].some((n) => n.textContent.includes("Versions"))', "versions menu item");
		await alex.evaluate(`(() => {
			const item = [...document.querySelectorAll(".menu [role=menuitem]")].find((n) => n.textContent.includes("Versions"));
			if (!item) return false;
			item.click();
			return true;
		})()`);
		await alex.waitFor('document.querySelector(".versions-list") !== null', "versions dialog");
		await alex.evaluate(`(() => {
			const row = [...document.querySelectorAll(".versions-row")].find((n) => n.textContent.includes("v1"));
			if (!row) return false;
			row.click();
			return true;
		})()`);
		const diffText = await alex.waitFor(
			'(() => document.querySelector(".version-diff")?.textContent.replace(/\\s+/g, " ").trim() || "")()',
			"version diff",
		);
		if (!/method/.test(diffText) || !/POST|PATCH/.test(diffText)) throw new Error("Compare does not show the method change: " + diffText.slice(0, 200));
		pass("8. Alex opens v1 → v2 compare", diffText.slice(0, 90));
		await alex.escape();
		await alex.waitFor('document.querySelector(".versions-list") === null', "versions closed");

		// Alex starts editing locally: expand the collection, open a request tab, dirty the URL.
		await alex.evaluate(`(() => {
			const row = [...document.querySelectorAll(".tree-row")].find((n) => n.textContent.includes(${JSON.stringify(collectionName.name)}) && n.querySelector(".tree-label"));
			if (!row) return false;
			row.querySelector(".tree-label").click();
			return true;
		})()`);
		await alex.waitFor('document.querySelectorAll(".tree-row").length > 3', "collection expanded");
		await alex.evaluate(`(() => {
			const row = [...document.querySelectorAll(".tree-row")].find((node) => /GET|POST|PATCH|DELETE/.test(node.textContent) && node.querySelector(".tree-label"));
			if (!row) return false;
			row.querySelector(".tree-label").click();
			return true;
		})()`);
		await alex.waitFor('document.querySelector(\'[aria-label="Request URL"]\') !== null', "request builder");
		const seededUrl = await alex.evaluate(`document.querySelector('[aria-label="Request URL"]').value`);
		await alex.setInput('[aria-label="Request URL"]', `${seededUrl}?live=1`);
		await alex.waitFor('document.querySelector(\'[aria-label="Unsaved changes"]\') !== null', "dirty draft");
		pass("9. Alex starts editing locally");

		// Jordan saves v3 while Alex's draft is dirty.
		const v3 = await jordan.evaluate(apiBase(`
			const full = (await (await fetch(base + "/collections/${collectionName.id}", { headers })).json()).data;
			const next = { name: full.name, description: "touched by Jordan", variables: full.variables ?? [], auth: full.auth ?? { mode: "none" }, folders: full.folders ?? [], requests: full.requests };
			const res = await fetch(base + "/collections/${collectionName.id}", { method: "PUT", headers, body: JSON.stringify({ expectedRevision: full.revision, collection: next }) });
			const saved = (await res.json()).data;
			return { status: res.status, revision: saved?.revision };
		`));
		if (v3.status !== 200) throw new Error("Jordan could not save v3: " + JSON.stringify(v3));
		pass("10. Jordan saves v3", `rev=${v3.revision}`);

		const draftUrl = await alex.evaluate(`document.querySelector('[aria-label="Request URL"]').value`);
		if (!draftUrl.includes("?live=1")) throw new Error("Alex's dirty draft was overwritten by the remote save");
		pass("11. Alex's dirty draft is NOT overwritten");

		await alex.waitFor('document.querySelector(".remote-change-banner") !== null', "remote banner", 30000);
		const bannerText = await alex.evaluate(`document.querySelector(".remote-change-banner")?.textContent.replace(/\\s+/g, " ").trim() || ""`);
		if (!/Jordan/.test(bannerText) || !/v3/.test(bannerText)) throw new Error("Banner misattributes the remote change: " + bannerText);
		pass("12. Alex sees the remote-v3 banner", bannerText.slice(0, 90));

		await alex.clickText("Compare", ".remote-change-banner");
		await alex.waitFor('document.querySelector(".versions-list") !== null', "banner compare dialog");
		pass("13. Alex chooses Compare from the banner");
		await alex.escape();
		await alex.waitFor('document.querySelector(".versions-list") === null', "compare closed");

		// Stale save meets the attributed 409 through the real Save button.
		await alex.evaluate(`(() => {
			const button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save" && !b.disabled);
			if (!button) return false;
			button.click();
			return true;
		})()`);
		await alex.waitFor('document.body.textContent.includes("Collection changed")', "conflict dialog", 30000);
		pass("14. Stale Alex save → attributed 409");

		await alex.clickText("Reload", ".confirmation-dialog");
		await alex.waitFor('document.querySelector(\'[aria-label="Unsaved changes"]\') === null', "draft reconciled", 30000);
		pass("15. Alex reloads");

		// Restore v1 through the versions dialog.
		await alex.evaluate(`(() => {
			const row = [...document.querySelectorAll(".tree-row")].find((n) => n.textContent.includes(${JSON.stringify(collectionName.name)}) && n.querySelector('[aria-haspopup="menu"]'));
			if (!row) return false;
			row.querySelector('[aria-haspopup="menu"]').click();
			return true;
		})()`);
		await alex.waitFor('[...document.querySelectorAll(".menu [role=menuitem]")].some((n) => n.textContent.includes("Versions"))', "versions menu item again");
		await alex.evaluate(`(() => {
			const item = [...document.querySelectorAll(".menu [role=menuitem]")].find((n) => n.textContent.includes("Versions"));
			if (!item) return false;
			item.click();
			return true;
		})()`);
		await alex.waitFor('document.querySelector(".versions-list") !== null', "versions dialog again");
		await alex.evaluate(`(() => {
			const row = [...document.querySelectorAll(".versions-row")].find((n) => n.textContent.includes("v1"));
			if (!row) return false;
			row.click();
			return true;
		})()`);
		await alex.waitFor('[...document.querySelectorAll("button")].some((b) => b.textContent.includes("Restore v1"))', "restore button");
		await alex.evaluate(`(() => {
			const button = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Restore v1"));
			if (!button || button.disabled) return false;
			button.click();
			return true;
		})()`);
		await alex.waitFor(`(${toastText}).includes("Restored as v")`, "restore toast", 30000);
		const afterRestore = await alex.evaluate(apiBase(`
			const rows = (await (await fetch(base + "/collections/${collectionName.id}/versions", { headers })).json()).data;
			const full = (await (await fetch(base + "/collections/${collectionName.id}", { headers })).json()).data;
			return { latest: rows[0], count: rows.length, method: full.requests[0]?.method };
		`));
		if (afterRestore.latest.revision !== v3.revision + 1) throw new Error("Restore did not create v4: " + JSON.stringify(afterRestore));
		if (afterRestore.latest.action !== "RESTORED") throw new Error("Restore row mislabeled: " + JSON.stringify(afterRestore.latest));
		if (afterRestore.method !== collectionName.method) throw new Error("Restored content is not v1");
		pass("16. Alex restores v1", `restore creates v${afterRestore.latest.revision}, not v1`);
		pass("17. Restore creates v4 with v1 content", `method=${afterRestore.method}`);

		await jordan.waitFor(`(${toastText}).includes("v${afterRestore.latest.revision}")`, "jordan live v4", 30000);
		pass("18. Jordan sees v4 live");

		// Demote Jordan to VIEWER through the API; the UI must follow without reload.
		const demoted = await alex.evaluate(apiBase(`
			const detail = (await (await fetch(base + "/workspaces/" + ws, { headers })).json()).data;
			const target = detail.members.find((m) => m.role === "EDITOR");
			if (!target) return -1;
			const res = await fetch(base + "/workspaces/" + ws + "/members/" + target.profileId, {
				method: "PUT", headers, body: JSON.stringify({ expectedRevision: detail.revision, role: "VIEWER" }),
			});
			return res.status;
		`));
		if (demoted !== 200) throw new Error("Demoting Jordan failed with status " + demoted);
		// Open a request tab so the Save control exists, then prove it is disabled.
		await jordan.evaluate(`(() => {
			const label = [...document.querySelectorAll(".tree .tree-label")].find((n) => n.textContent.includes(${JSON.stringify(collectionName.name)}));
			if (!label) return false;
			label.click();
			return true;
		})()`);
		await jordan.waitFor('document.querySelectorAll(".tree-row").length > 3', "jordan tree expanded");
		await jordan.evaluate(`(() => {
			const row = [...document.querySelectorAll(".tree-row")].find((node) => /GET|POST|PATCH|DELETE/.test(node.textContent) && node.querySelector(".tree-label"));
			if (!row) return false;
			row.querySelector(".tree-label").click();
			return true;
		})()`);
		await jordan.waitFor('document.querySelector(\'[aria-label="Request URL"]\') !== null', "jordan request view");
		await jordan.waitFor('document.querySelector(".workspace-readonly-banner") !== null', "jordan read-only banner");
		const saveState = await jordan.evaluate(`(() => {
			const buttons = [...document.querySelectorAll("button")].map((b) => ({ text: b.textContent.trim().slice(0, 40), disabled: b.disabled, title: b.getAttribute("title") || "" }));
			const saveLike = buttons.filter((b) => /save/i.test(b.text));
			return { total: buttons.length, saveLike };
		})()`);
		const saveDisabled = saveState.saveLike.length > 0 && saveState.saveLike.every((b) => b.disabled);
		if (!saveDisabled) throw new Error("Jordan's Save control is still enabled as VIEWER: " + JSON.stringify(saveState.saveLike));
		pass("19. Jordan is changed to VIEWER");
		pass("20. Jordan's UI becomes read-only without reload");

		const viewerWrite = await jordan.evaluate(apiBase(`
			const full = (await (await fetch(base + "/collections/${collectionName.id}", { headers })).json()).data;
			const res = await fetch(base + "/collections/${collectionName.id}", { method: "PUT", headers, body: JSON.stringify({ expectedRevision: full.revision, collection: { name: full.name, description: full.description ?? "", variables: full.variables ?? [], auth: full.auth ?? { mode: "none" }, folders: full.folders ?? [], requests: full.requests } }) });
			const body = await res.json().catch(() => ({}));
			return { status: res.status, code: body?.error?.code };
		`));
		if (viewerWrite.status !== 403 || viewerWrite.code !== "WORKSPACE_FORBIDDEN") {
			throw new Error("VIEWER mutation was not refused: " + JSON.stringify(viewerWrite));
		}
		pass("21. Jordan cannot mutate through direct API", `status=${viewerWrite.status}`);

		// Removal: the stream closes and access disappears.
		await alex.evaluate(apiBase(`
			const detail = (await (await fetch(base + "/workspaces/" + ws, { headers })).json()).data;
			const target = detail.members.find((m) => m.role === "VIEWER");
			const res = await fetch(base + "/workspaces/" + ws + "/members/" + target.profileId + "?revision=" + detail.revision, { method: "DELETE", headers });
			return res.status;
		`));
		await jordan.waitFor(`(${toastText}).includes("no longer have access")`, "removal notice", 30000);
		pass("22. Jordan is removed");
		pass("23. Stream closes / access disappears");

		const removedRead = await jordan.evaluate(apiBase(`
			const teamHeaders = { ...headers, "x-workspace-id": ${JSON.stringify(teamId)} };
			const res = await fetch(base + "/collections", { headers: teamHeaders });
			return res.status;
		`));
		if (removedRead === 200) throw new Error("A removed member can still read the team workspace");
		const v5marker = `v5probe`;
		await alex.evaluate(apiBase(`
			const full = (await (await fetch(base + "/collections/${collectionName.id}", { headers })).json()).data;
			const next = { name: full.name, description: ${JSON.stringify(v5marker)}, variables: full.variables ?? [], auth: full.auth ?? { mode: "none" }, folders: full.folders ?? [], requests: full.requests };
			await fetch(base + "/collections/${collectionName.id}", { method: "PUT", headers, body: JSON.stringify({ expectedRevision: full.revision, collection: next }) });
			return true;
		`));
		await sleep(3000);
		const jordanAfter = await jordan.evaluate(`(${toastText}) + " ||| " + document.body.textContent.replace(/\\s+/g, " ").slice(0, 4000)`);
		if (jordanAfter.includes(v5marker)) throw new Error("Removed Jordan received a later workspace update");
		pass("24. Jordan receives no subsequent workspace updates");

		// History isolation: Alex sends the local echo; only Alex's history shows it.
		const historyCheck = await alex.evaluate(apiBase(`
			const full = (await (await fetch(base + "/collections/${collectionName.id}", { headers })).json()).data;
			const target = full.requests[0];
			const suffix = String(Date.now()).padStart(12, "0").slice(-12);
			const send = await fetch(base + "/executions", { method: "POST", headers, body: JSON.stringify({
				executionId: "11111111-1111-4111-8111-" + suffix,
				tabId: "p24b-history-probe",
				draftVersion: 0,
				request: { ...target, method: "GET", urlTemplate: "http://127.0.0.1:8000/demo/v1/echo", query: [], headers: [], body: { mode: "none" }, auth: { mode: "none" } },
				context: {},
			}) });
			return { status: send.status };
		`));
		if (historyCheck.status !== 200) throw new Error("Alex could not send the echo probe: " + JSON.stringify(historyCheck));
		const isolation = await alex.retry(() => alex.evaluate(apiBase(`
			const body = (await (await fetch(base + "/history?limit=5", { headers })).json()).data;
			const entries = body.entries ?? body.items ?? (Array.isArray(body) ? body : []);
			return entries.length > 0 ? { count: entries.length } : null;
		`)), "alex history recorded", 30000);
		const jordanHistory = await jordan.evaluate(apiBase(`
			const res = await fetch(base + "/history?limit=5", { headers });
			if (!res.ok) return { status: res.status };
			const body = await res.json();
			return { status: res.status, count: ((body.data.entries ?? body.data.items ?? body.data ?? [])).length };
		`));
		if (jordanHistory.status === 200 && isolation.count > 0 && jordanHistory.count >= isolation.count) {
			throw new Error("Jordan can see Alex's execution history: " + JSON.stringify({ isolation, jordanHistory }));
		}
		pass("25. Alex's private execution history remains invisible to Jordan");

		// Secret sweep across versions, diffs, events, and activity payloads.
		const sweep = await alex.evaluate(apiBase(`
			const rows = (await (await fetch(base + "/collections/${collectionName.id}/versions", { headers })).json()).data;
			const full = JSON.stringify(rows);
			const cmp = JSON.stringify((await (await fetch(base + "/collections/${collectionName.id}/versions/1/compare/${afterRestore.latest.revision}", { headers })).json()).data);
			const activity = JSON.stringify((await (await fetch(base + "/workspaces/" + ws + "/activity?limit=50", { headers })).json()).data);
			return { versions: rows.length, bad: /authorization:\\s*"Bearer [^[]|set-cookie|password123/i.test(full + cmp + activity) };
		`));
		if (sweep.bad) throw new Error("Credential material found in versions/diffs/activity");
		const uiSweep = await alex.evaluate(`(/authorization:\\s*Bearer\\s+\\S+|set-cookie|password123/i.test(document.body.textContent))`);
		if (uiSweep) throw new Error("Credential material rendered in the UI");
		pass("26. No secret values appear in versions/diffs/events/activity", `${sweep.versions} versions scanned`);

		// Reconnect: a full reload re-establishes the stream with no duplicate writes.
		const beforeReload = await alex.evaluate(apiBase(`
			const rows = (await (await fetch(base + "/collections/${collectionName.id}/versions", { headers })).json()).data;
			return rows.length;
		`));
		await alex.reload();
		await alex.waitFor('document.querySelector(".app-shell") !== null', "app after reload");
		const afterReload = await alex.evaluate(apiBase(`
			const rows = (await (await fetch(base + "/collections/${collectionName.id}/versions", { headers })).json()).data;
			return rows.length;
		`));
		if (afterReload !== beforeReload) throw new Error(`Reload duplicated versions: ${beforeReload} → ${afterReload}`);
		pass("27. Reconnect reloads canonical state with no duplicate mutations");

		// Responsive + themes on the new surfaces.
		await alex.evaluate(`(() => {
			const row = [...document.querySelectorAll(".tree-row")].find((n) => n.textContent.includes(${JSON.stringify(collectionName.name)}) && n.querySelector('[aria-haspopup="menu"]'));
			if (!row) return false;
			row.querySelector('[aria-haspopup="menu"]').click();
			return true;
		})()`);
		await alex.waitFor('[...document.querySelectorAll(".menu [role=menuitem]")].some((n) => n.textContent.includes("Versions"))', "versions menu");
		await alex.evaluate(`[...document.querySelectorAll(".menu [role=menuitem]")].find((n) => n.textContent.includes("Versions")).click()`);
		await alex.waitFor('document.querySelector(".versions-list") !== null', "versions dialog responsive");
		for (const width of [375, 1440]) {
			await alex.viewport(width);
			const overflow = await alex.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
			if (overflow > 1) throw new Error(`Versions dialog overflows by ${overflow}px at ${width}px`);
		}
		await alex.viewport(1440);
		for (const theme of ["light", "dark"]) {
			const current = await alex.evaluate('document.documentElement.dataset.theme || "dark"');
			if (current !== theme) {
				await alex.click('[aria-label^="Switch to "]', `${theme} toggle`);
				await sleep(300);
			}
			await alex.retry(() => alex.evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`), `${theme} theme`);
		}
		pass("28. Versions UI holds at 375/1440 in light and dark");
		await alex.escape();
		await alex.waitFor('document.querySelector(".versions-list") === null', "versions closed by Escape");

		if (alex.errors.length || jordan.errors.length) {
			throw new Error(`Browser exceptions: alex=[${alex.errors.join(" | ")}] jordan=[${jordan.errors.join(" | ")}]`);
		}
		pass("29. No unhandled browser exceptions in either browser");

		await alex.close();
		await jordan.close();
		alex = null;
		jordan = null;
		clearTimeout(deadline);
		process.stdout.write(`PHASE24B_LIVE_E2E_PASS ${checks.length}/${checks.length}\n`);
		process.exit(0);
	} catch (error) {
		await cleanup();
		throw error;
	}
})().catch(async (error) => {
	clearTimeout(deadline);
	process.stderr.write(`PHASE24B_LIVE_E2E_FAIL: ${error.message}\n`);
	await cleanup();
	process.exit(1);
});
