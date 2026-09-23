// Tracer — Investigation Engine demo (Phase 35).
//
// One deterministic, end to end demonstration of the complete Investigation
// (Workflow 5) flow over local seeded infrastructure only:
//
//   regression boundary → comparison → counterfactual verification
//   → failure minimization → reproducibility → safe reproduction capsule
//
// The demo ends with the exact requested reproduction:
//   a failing request, a proven cause, a smallest reproducer,
//   a reliable reproduction, and a safe reproduction capsule.
//
// Run against the seeded, running app:
//   bash setup.sh --seed && bun start        (in one terminal)
//   bun run demo:investigation               (in another)
//
// The demo cleans up everything it creates and exits non-zero on any failure.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { initConfig } from "../../shared/config/index.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });
initConfig();

const API = (process.env.TRACER_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const EMAIL = process.env.TRACER_DEMO_EMAIL || "alex.morgan@example.test";
const PASSWORD = process.env.TRACER_DEMO_PASSWORD || "password123";
const DEMO_TARGET = "http://127.0.0.1:8000/demo/v1";

const checks = [];
const created = { executions: [], collectionId: null, collectionRevision: null };
let authToken = "";

const say = (message) => process.stdout.write(`${message}\n`);

function check(name, condition, detail = "") {
	const passed = Boolean(condition);
	checks.push({ name, passed });
	say(`  ${passed ? "PASS" : "FAIL"}  ${name}${!passed && detail ? ` — ${detail}` : ""}`);
	return passed;
}

class ApiFailure extends Error {
	constructor(status, body) {
		super(body?.error?.message || `HTTP ${status}`);
		this.status = status;
		this.code = body?.error?.code || `HTTP_${status}`;
		this.body = body;
	}
}

async function api(path, { method = "GET", body, token } = {}) {
	const response = await fetch(`${API}/api/v1${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(token === null ? {} : { Authorization: `Bearer ${token ?? authToken}` }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	const parsed = text ? JSON.parse(text) : null;
	if (!response.ok) throw new ApiFailure(response.status, parsed);
	return parsed?.data;
}

const row = (key, value) => ({ id: randomUUID(), key, value, enabled: true });

function probeRequest({ url, debug }) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name: "Investigation demo probe",
		method: "GET",
		urlTemplate: url,
		query: [row("debug", debug)],
		headers: [row("Accept", "application/json")],
		body: { mode: "none" },
		auth: { mode: "none" },
		scripts: { preRequest: "", test: "" },
		assertions: [],
		settings: { timeoutMs: 15000 },
	};
}

async function send(request, { collectionId, tabId = "investigation-demo", label } = {}) {
	const executionId = randomUUID();
	created.executions.push(executionId);
	const result = await api("/executions", {
		method: "POST",
		body: {
			executionId,
			tabId,
			draftVersion: created.executions.length,
			request,
			context: collectionId ? { collectionId } : {},
		},
	});
	if (label) say(`  · ${label}: outcome=${result.outcome} status=${result.response?.status ?? "—"}`);
	return result;
}

async function waitInvestigation(investigationId) {
	for (let attempt = 0; attempt < 240; attempt += 1) {
		const record = await api(`/execution-intelligence/investigations/${investigationId}`);
		if (record.status !== "running") return record;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Investigation ${investigationId} did not finish in time.`);
}

function normalize(value) {
	return JSON.stringify(value)
		.replace(/investigation-[0-9a-f]{8}/g, "investigation-<id>")
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
		.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<time>")
		.replace(/(durationMs|minMs|medianMs|maxMs)[^0-9-]{0,4}[0-9.]+/g, "$1:<ms>");
}

// Runs whether the demo passes, fails, or crashes, so a rerun always starts
// from the seeded baseline.
async function cleanupLeftovers() {
	if (authToken) {
		say("· Cleanup");
		if (created.collectionId) {
			const revision = created.collectionRevision ? `?revision=${created.collectionRevision}` : "";
			await api(`/collections/${created.collectionId}${revision}`, { method: "DELETE" }).catch(() => undefined);
		}
		for (const executionId of created.executions) {
			await api(`/history/${executionId}`, { method: "DELETE" }).catch(() => undefined);
		}
		say("  removed the scratch collection and demo history entries.");
	}
	const failed = checks.filter((item) => !item.passed);
	say("");
	say(`Investigation Engine demo: ${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ""}.`);
	for (const item of failed) say(`  FAILED: ${item.name}`);
	if (failed.length > 0) process.exitCode = 1;
}

async function main() {
	say("Tracer — Investigation Engine demo (Phase 35)");
	say("regression boundary → comparison → counterfactual → minimization → reproducibility → capsule");
	say(`API: ${API}`);
	say("");

	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			const health = await fetch(`${API}/api/v1/health`);
			if (health.ok) break;
		} catch {
			// keep polling
		}
		if (attempt === 39) throw new Error("The seeded Tracer app is not reachable. Run `bash setup.sh --seed` and `bun start` first.");
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	const session = await api("/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD }, token: null });
	const profiles = await api("/profiles", { token: session.token });
	const profile = await api("/auth/switch-profile", {
		method: "POST",
		token: session.token,
		body: { profileId: profiles[0]._id },
	});
	authToken = profile.token;

	// ── 1. the known-good run, saved to a collection (Phase 33 lineage) ──
	say("· Evidence");
	const goodRequest = probeRequest({ url: `${DEMO_TARGET}/status/200`, debug: "0" });
	const collection = await api("/collections", { method: "POST", body: { name: "Investigation Demo Scratch" } });
	created.collectionId = collection._id;
	created.collectionRevision = collection.revision;
	const saved = await api(`/collections/${created.collectionId}`, {
		method: "PUT",
		body: {
			expectedRevision: created.collectionRevision,
			collection: {
				name: collection.name,
				description: "Temporary Phase 35 demo collection.",
				variables: [],
				auth: { mode: "none" },
				folders: [],
				requests: [goodRequest],
			},
		},
	});
	created.collectionRevision = saved.revision;
	const savedRequestId = saved.requests?.[0]?.id ?? goodRequest.id;

	const goodDraft = { ...goodRequest, id: savedRequestId };
	const goodRun = await send(goodDraft, { collectionId: created.collectionId, label: "known-good run " });

	// ── 2. one subtle change later: the request starts failing ──
	const failingDraft = {
		...goodDraft,
		urlTemplate: `${DEMO_TARGET}/status/500`,
		query: [row("debug", "1")],
	};
	const failingRun = await send(failingDraft, { collectionId: created.collectionId, label: "failing run      " });

	// ── 3. investigate: the Phase 33 timeline finds the boundary on its own ──
	say("· Investigation (Workflow 5)");
	const started = await api("/execution-intelligence/investigations", {
		method: "POST",
		body: {
			failingExecutionId: failingRun.executionId,
			predicate: { type: "status", equals: 500 },
			targetMode: "execution",
			reproductionProbes: 3,
		},
	});
	const record = await waitInvestigation(started.investigationId);
	const result = record.result;
	check("the investigation completes", record.status === "completed", record.error?.code ?? record.status);
	check("the regression boundary is resolved from collection lineage", result.regressionBoundary.source === "phase33" && result.regressionBoundary.goodExecutionId === goodRun.executionId, result.regressionBoundary.unresolved?.reason ?? "unresolved");
	check("the boundary states when the failure began", /Failure begins between/.test(result.summary.text), result.summary.text);

	// ── 4. what changed and what is proven ──
	check("exactly one change is a verified cause", result.verifiedCauses.length === 1, `${result.verifiedCauses.length} verified`);
	const cause = result.verifiedCauses[0];
	check(
		"the cause is proven by apply/revert probes",
		cause.evidence.applied.predicateMatched === true && cause.evidence.reverted.predicateMatched === false && Boolean(cause.evidence.appliedProbeExecutionId) && Boolean(cause.evidence.revertedProbeExecutionId),
		cause.delta.path,
	);
	const unverifiedDebug = result.unverifiedChanges.find((change) => /debug/i.test(change.change.path));
	check("the unproven query change stays explicitly unverified", unverifiedDebug && unverifiedDebug.label === "unverified", unverifiedDebug?.label ?? "missing");
	check("the summary names the proven cause", /Verified cause\(s\):/.test(result.summary.text), result.summary.text);

	// ── 5. smallest reproducer and reliability ──
	check("minimization produced the smallest reproducer", result.minimization.status === "completed" && result.minimization.remainingComponentCount < result.minimization.originalComponentCount, result.minimization.reason ?? "");
	check("the reproduction series is reliable", result.reproducibility.classification === "reproducible", result.reproducibility.statement ?? result.reproducibility.status);
	check("the reproducer is claimed minimized", result.reproductionCapsule.requestSource === "minimized");

	// ── 6. safe reproduction capsule → import as an unsent dirty draft ──
	const capsule = await api(`/execution-intelligence/investigations/${record.investigationId}/capsule`);
	check("a redacted reproduction capsule is exported", typeof capsule.text === "string" && capsule.text.includes("tracer.repro-capsule"), capsule.filename);
	const imported = await api("/execution-intelligence/capsules/import", { method: "POST", body: { text: capsule.text } });
	check("the capsule imports as an unsent dirty draft", imported?.dirty === true && imported?.autoSend === false && imported?.autoSave === false);
	check("the capsule contains no credentials", !capsule.text.includes(PASSWORD));

	// ── 7. determinism: the same evidence yields the same investigation ──
	say("· Determinism");
	const again = await api("/execution-intelligence/investigations", {
		method: "POST",
		body: {
			failingExecutionId: failingRun.executionId,
			predicate: { type: "status", equals: 500 },
			targetMode: "execution",
			reproductionProbes: 3,
		},
	});
	const againRecord = await waitInvestigation(again.investigationId);
	check("identical evidence produces an identical InvestigationV1", normalize(againRecord.result) === normalize(result));

	// ── the exact requested ending ──
	say("");
	say("· Reproduction (the exact requested ending)");
	say(`  1. a failing request .......... GET ${failingDraft.urlTemplate} (outcome ${failingRun.outcome})`);
	say(`  2. a proven cause ............. ${cause.delta.path} (${cause.label}, probes ${cause.evidence.appliedProbeExecutionId.slice(0, 8)} + ${cause.evidence.revertedProbeExecutionId.slice(0, 8)})`);
	say(`  3. the smallest reproducer .... ${result.minimization.remainingComponentCount} of ${result.minimization.originalComponentCount} structural inputs remain (${result.minimization.minimality})`);
	say(`  4. a reliable reproduction .... ${result.reproducibility.statement}`);
	say(`  5. a safe reproduction capsule  ${capsule.filename} (imports as a dirty, unsent draft)`);
}

try {
	await main();
} catch (error) {
	say(`\nDemo failed: ${error.message}`);
	if (error instanceof ApiFailure && error.body) say(JSON.stringify(error.body, null, 2));
	process.exitCode = 1;
} finally {
	await cleanupLeftovers();
}
