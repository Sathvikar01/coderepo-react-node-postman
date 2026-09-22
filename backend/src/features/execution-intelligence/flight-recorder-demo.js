// Tracer — API Flight Recorder demo (Phase 28).
//
// One deterministic, end-to-end demonstration of the complete Flight Recorder
// flow over local seeded infrastructure only:
//
//   Passport → Compare → Minimize → Capsule → Reproduce
//
//   1. successful request           6. minimize to smallest reproducing request
//   2. one subtle change            7. export a redacted reproduction capsule
//   3. request fails                8. import it through the Phase 7 boundary
//   4. compare the two runs         9. open as an unsent dirty draft
//   5. first meaningful divergence 10. manually reproduce the failure
//
// Plus the Phase 28 acceptance invariants: passport immutability after
// request/env/auth/cookie/assertion changes, minimizer budget and hidden
// probes, SSRF and unsafe-method restrictions, mutating probes only against
// approved local or mock targets, capsule round-trip without semantic drift,
// capsule import never auto-Sending or auto-Saving, and zero resolved secrets
// in passports, comparisons, capsules, minimizer records, history, or errors.
//
// Run against the seeded, running app:
//   bash setup.sh --seed && bun start        (in one terminal)
//   bun run demo:flight-recorder             (in another)
//
// The demo cleans up everything it creates and exits non-zero on any failure.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { capsuleDraftTab } from "../../../../frontend/src/features/execution-intelligence/flight-recorder-model.js";
import { initConfig, getConfig } from "../../shared/config/index.js";
import { matchesFailurePredicate } from "./failure-minimizer.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });
const config = initConfig();

const API = (process.env.TRACER_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const EMAIL = process.env.TRACER_DEMO_EMAIL || "alex.morgan@example.test";
const PASSWORD = process.env.TRACER_DEMO_PASSWORD || "password123";
const DEMO_TARGET = "http://127.0.0.1:8000/demo/v1";

const checks = [];
const errorBodies = [];
const created = { executions: [], collectionId: null, collectionRevision: null };
const demoState = { environmentId: null, name: null, variables: null, originalAlias: null, revertRevision: null };
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
	if (!response.ok) {
		errorBodies.push({ path, method, status: response.status, body: parsed });
		throw new ApiFailure(response.status, parsed);
	}
	return parsed?.data;
}

const secretValues = () =>
	[...config.secretAliases.map((entry) => entry.value), config.jwtSecret, config.fingerprintKey, PASSWORD].filter(
		(value) => value && value.length >= 4,
	);

function assertNoSecrets(label, serialized) {
	const leaked = secretValues().filter((secret) => serialized.includes(secret));
	check(`${label} contains no resolved secrets`, leaked.length === 0, `leaked ${leaked.length} secret value(s)`);
}

const row = (key, value) => ({ id: randomUUID(), key, value, enabled: true });

const withAlias = (variables, aliasForSecrets) =>
	variables.map((variable) =>
		variable.key === "orders_token"
			? { id: variable.id, key: variable.key, kind: "secretRef", alias: aliasForSecrets, enabled: true }
			: {
					id: variable.id,
					key: variable.key,
					kind: variable.kind,
					enabled: variable.enabled !== false,
					...(variable.kind === "plain" ? { value: variable.value } : { alias: variable.alias }),
				},
	);

// Runs whether the demo passes, fails, or crashes, so a rerun always starts
// from the seeded baseline.
async function cleanupLeftovers() {
	if (authToken) {
		say("· Cleanup");
		if (created.collectionId)
			await api(`/collections/${created.collectionId}?revision=${created.collectionRevision}`, { method: "DELETE" }).catch(() => undefined);
		if (demoState.environmentId && demoState.originalAlias && demoState.revertRevision)
			await api(`/environments/${demoState.environmentId}`, {
				method: "PUT",
				body: {
					expectedRevision: demoState.revertRevision,
					environment: { name: demoState.name, variables: withAlias(demoState.variables, demoState.originalAlias) },
				},
			}).catch(() => undefined);
		for (const executionId of created.executions) {
			await api(`/history/${executionId}`, { method: "DELETE" }).catch(() => undefined);
		}
		say("  removed the scratch collection, environment change, and demo history entries.");
	}
	const failed = checks.filter((item) => !item.passed);
	say("");
	say(`Flight Recorder demo: ${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ""}.`);
	for (const item of failed) say(`  FAILED: ${item.name}`);
	if (failed.length > 0) process.exitCode = 1;
}

function recorderRequest() {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name: "Flight Recorder probe",
		method: "GET",
		urlTemplate: "{{base_url}}/orders",
		query: [row("status", "paid"), row("limit", "5")],
		headers: [
			row("Accept", "application/json"),
			row("X-Demo-Flight", "recorder"),
			row("X-Trace-Mode", "verbose"),
			row("X-Campaign", "alpha"),
		],
		body: { mode: "none" },
		auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
		scripts: { preRequest: "", test: "" },
		assertions: [],
		settings: { timeoutMs: 15000 },
	};
}

async function send(request, { environmentId, environmentRevision, tabId = "flight-recorder-demo", label } = {}) {
	const executionId = randomUUID();
	created.executions.push(executionId);
	const result = await api("/executions", {
		method: "POST",
		body: {
			executionId,
			tabId,
			draftVersion: created.executions.length,
			request,
			context: { environmentId, environmentRevision },
		},
	});
	if (label) say(`  · ${label}: outcome=${result.outcome} status=${result.response?.status ?? "—"} (${result.error?.code ?? "ok"})`);
	return result;
}

const receiptOf = (executionId) => api(`/execution-intelligence/receipts/${executionId}`);

async function waitMinimization(jobId) {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const job = await api(`/execution-intelligence/minimizations/${jobId}`);
		if (job.status !== "running") return job;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Minimization job ${jobId} did not finish in time.`);
}

async function main() {
	say("Tracer — API Flight Recorder demo");
	say("Passport → Compare → Minimize → Capsule → Reproduce");
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

	const environments = await api("/environments");
	const environmentSummary = environments.find((item) => item.name === "Local");
	const environment = await api(`/environments/${environmentSummary._id}`);
	const originalAlias = environment.variables.find((variable) => variable.key === "orders_token")?.alias;
	check("seeded Local environment provides the orders_token secret reference", Boolean(environment && originalAlias));
	demoState.environmentId = environment._id;
	demoState.name = environment.name;
	demoState.variables = environment.variables;
	demoState.originalAlias = originalAlias;

	const request = recorderRequest();

	// ── 1. successful request ────────────────────────────────────────────────
	say("[1/10] Record — successful request against the seeded local demo target");
	const okRun = await send(request, {
		environmentId: environment._id,
		environmentRevision: environment.revision,
		label: "run 1",
	});
	check("run 1 answered 200 from the local demo target", okRun.response?.status === 200, `status ${okRun.response?.status}`);
	const passportOne = await receiptOf(okRun.executionId);
	check("run 1 has an Execution Passport", passportOne?.kind === "tracer.execution-receipt");
	check("passport records the secret reference, never the value", JSON.stringify(passportOne.request.auth).includes("orders_token"));
	const passportOneSnapshot = JSON.stringify(passportOne);

	// ── 2. one subtle change ─────────────────────────────────────────────────
	say("[2/10] Subtle change — the orders_token secret reference is pointed at the staging alias");
	const updated = await api(`/environments/${environment._id}`, {
		method: "PUT",
		body: {
			expectedRevision: environment.revision,
			environment: { name: environment.name, variables: withAlias(environment.variables, "staging_token") },
		},
	});
	check("the environment revision advanced", updated.revision === environment.revision + 1);
	demoState.revertRevision = updated.revision;
	check("passport is immutable after the environment change", JSON.stringify(await receiptOf(okRun.executionId)) === passportOneSnapshot);

	// ── 3. request fails ─────────────────────────────────────────────────────
	say("[3/10] Request fails — the unchanged request now answers 401");
	const failRun = await send(request, {
		environmentId: environment._id,
		environmentRevision: updated.revision,
		label: "run 2",
	});
	check("run 2 failed with 401", failRun.response?.status === 401, `status ${failRun.response?.status}`);
	const passportTwo = await receiptOf(failRun.executionId);
	const passportTwoSnapshot = JSON.stringify(passportTwo);

	// ── 4. compare the two runs ──────────────────────────────────────────────
	say("[4/10] Compare — causal comparison of the two execution passports");
	const comparison = await api("/execution-intelligence/comparisons", {
		method: "POST",
		body: { baseExecutionId: okRun.executionId, candidateExecutionId: failRun.executionId },
	});
	check("comparison links both runs", comparison.baseExecutionId === okRun.executionId && comparison.candidateExecutionId === failRun.executionId);

	// ── 5. first meaningful divergence ───────────────────────────────────────
	say("[5/10] Divergence — the first meaningful divergence is identified");
	check(
		"first divergence is the environment change",
		comparison.firstDivergence?.path === "source.environmentRevision",
		JSON.stringify(comparison.firstDivergence),
	);
	check("the comparison explains the divergence", /environment revision/i.test(comparison.firstDivergence?.message ?? ""));
	check("contract diff flags the unexpected status", comparison.contract.breaking === true);
	check(
		"contract diff records the status change",
		comparison.contract.changes.some((change) => change.kind === "status_changed" && change.after === 401),
	);
	check(
		"contract diff records removed response fields",
		comparison.contract.changes.some((change) => change.kind === "body_path_removed"),
	);

	// ── 6. minimize ─────────────────────────────────────────────────────────
	say("[6/10] Minimize — bounded delta reduction to the smallest reproducing request");
	const historyBeforeMinimization = (await api("/history?limit=25")).items.length;
	const startedJob = await api("/execution-intelligence/minimizations", {
		method: "POST",
		body: { sourceExecutionId: failRun.executionId, predicate: { type: "status", equals: 401 }, targetMode: "execution" },
	});
	const job = await waitMinimization(startedJob.jobId);
	check("minimization completed", job.status === "completed", JSON.stringify(job.error ?? {}));
	check("the failure predicate was stable across baseline probes", job.result?.stable === true);
	check("the probe budget is capped at 12", job.probeBudget === 12 && job.result?.probesUsed <= 12, `used ${job.result?.probesUsed}`);
	check("minimization reached the smallest reproducing request", job.result?.remainingComponentCount === 0, `remaining ${job.result?.remainingComponentCount}`);
	check("all removable query rows and headers were removed", (job.result?.removed ?? []).length === 6, `removed ${job.result?.removed?.length}`);
	check("hidden probes stay out of the history list", (await api("/history?limit=25")).items.length === historyBeforeMinimization);
	assertNoSecrets("minimizer record", JSON.stringify(job));

	// ── 7. export a redacted reproduction capsule ────────────────────────────
	say("[7/10] Capsule — export a redacted reproduction capsule");
	const exported = await api("/execution-intelligence/capsules/export", {
		method: "POST",
		body: { executionId: failRun.executionId, includeResponseBody: true },
	});
	check("capsule exports as a .repro.json file", exported.filename.endsWith(".repro.json"));
	check("capsule keeps the variable placeholder", exported.text.includes("{{orders_token}}"));
	const capsule = JSON.parse(exported.text);
	check("capsule lists required inputs instead of values", capsule.requiredInputs.some((input) => input.name === "orders_token"));
	check("capsule records the deterministic failure predicate", capsule.predicate?.type === "status" && capsule.predicate?.equals === 401);
	assertNoSecrets("reproduction capsule", exported.text);

	// ── 8. import through the Phase 7 boundary ───────────────────────────────
	say("[8/10] Import — through the Phase 7 normalized import boundary, preview only");
	const historyBeforeImport = (await api("/history?limit=25")).items.length;
	const collectionsBefore = (await api("/collections")).length;
	const preview = await api("/execution-intelligence/capsules/import", { method: "POST", body: { text: exported.text } });
	check("import never auto-Sends", preview.autoSend === false);
	check("import never auto-Saves", preview.autoSave === false);
	check(
		"capsule round-trips without semantic drift",
		preview.draft.method === capsule.request.method && preview.draft.urlTemplate === capsule.request.urlTemplate,
	);
	const tab = capsuleDraftTab(preview);
	check("the Phase 7 boundary yields a workspace draft tab", Boolean(tab && tab.request));
	check(
		"draft preserves request semantics",
		tab.request.auth?.tokenTemplate === "{{orders_token}}" &&
			tab.request.query.map((item) => `${item.key}=${item.value}`).join("&") ===
				capsule.request.query.map((item) => `${item.key}=${item.value}`).join("&"),
	);
	check("import created no history entry", (await api("/history?limit=25")).items.length === historyBeforeImport);
	check("import saved nothing to a collection", (await api("/collections")).length === collectionsBefore);

	// ── 9. open as dirty draft ───────────────────────────────────────────────
	say("[9/10] Open — as an unsent, unsaved dirty draft");
	check("the opened draft is dirty", tab.dirty === true);
	check("the opened draft was never sent", tab.status === "idle" && tab.executionId === null);

	// ── 10. manually reproduce the failure ───────────────────────────────────
	say("[10/10] Reproduce — send the draft manually and reproduce the failure");
	const reproRun = await send(tab.request, {
		environmentId: environment._id,
		environmentRevision: updated.revision,
		tabId: "flight-recorder-repro",
		label: "reproduction",
	});
	check("the failure reproduces from the imported draft", matchesFailurePredicate(reproRun, capsule.predicate), `status ${reproRun.response?.status}`);

	// ── invariants ───────────────────────────────────────────────────────────
	say("");
	say("Acceptance invariants");

	say("· Passport immutability across request, auth, and assertion changes");
	const scratch = await api("/collections", { method: "POST", body: { name: "Flight Recorder Demo Scratch" } });
	created.collectionId = scratch._id;
	created.collectionRevision = scratch.revision;
	const scratchAggregate = {
		name: scratch.name,
		description: "Temporary Phase 28 demo collection.",
		variables: [],
		auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
		folders: [],
		requests: [
			{
				...recorderRequest(),
				name: "Mutable request",
				assertions: [
					{
						id: randomUUID(),
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
			},
		],
	};
	const scratchFirst = await api(`/collections/${created.collectionId}`, {
		method: "PUT",
		body: { expectedRevision: created.collectionRevision, collection: scratchAggregate },
	});
	created.collectionRevision = scratchFirst.revision;
	scratchAggregate.auth = { mode: "apiKey", key: "X-API-Key", valueTemplate: "{{orders_token}}", in: "header" };
	scratchAggregate.requests[0].name = "Mutable request edited";
	scratchAggregate.requests[0].urlTemplate = "{{base_url}}/orders/{{order_id}}";
	scratchAggregate.requests[0].query = [row("limit", "1")];
	scratchAggregate.requests[0].assertions[0].expected = "201";
	const scratchSecond = await api(`/collections/${created.collectionId}`, {
		method: "PUT",
		body: { expectedRevision: created.collectionRevision, collection: scratchAggregate },
	});
	created.collectionRevision = scratchSecond.revision;
	check(
		"passports are immutable after request, auth, and assertion edits",
		JSON.stringify(await receiptOf(okRun.executionId)) === passportOneSnapshot,
	);

	say("· Passport immutability across cookie changes");
	await send(
		{ ...recorderRequest(), name: "Cookie setter", urlTemplate: `${DEMO_TARGET}/cookies/set`, query: [], auth: { mode: "none" } },
		{ environmentId: environment._id, environmentRevision: updated.revision, label: "cookie set" },
	);
	await api("/cookies", { method: "DELETE" });
	check("passports are immutable after cookie changes", JSON.stringify(await receiptOf(failRun.executionId)) === passportTwoSnapshot);

	say("· SSRF boundary");
	const metadataRun = await send(
		{
			...recorderRequest(),
			name: "Blocked metadata probe",
			method: "POST",
			urlTemplate: "http://169.254.169.254/latest/meta-data/",
			query: [],
			headers: [],
			auth: { mode: "none" },
			body: { mode: "json", text: '{"probe":true}' },
		},
		{ label: "metadata target" },
	);
	check(
		"cloud metadata targets are blocked before dispatch",
		metadataRun.outcome === "validation_error" && metadataRun.error?.code === "TARGET_BLOCKED",
		`${metadataRun.outcome}/${metadataRun.error?.code}`,
	);
	check("blocked targets record the policy decision", (await receiptOf(metadataRun.executionId)).policy?.decision === "blocked");

	say("· Mutating probes only against approved local or mock targets");
	const blockedProbe = await api("/execution-intelligence/minimizations", {
		method: "POST",
		body: { sourceExecutionId: metadataRun.executionId, predicate: { type: "outcome", equals: "validation_error" }, targetMode: "execution" },
	}).catch((error) => error);
	check(
		"mutating probes against a non-local target are refused",
		blockedProbe instanceof ApiFailure && blockedProbe.code === "MINIMIZATION_UNSAFE_METHOD",
		blockedProbe?.code,
	);
	const mutRun = await send(
		{
			...recorderRequest(),
			name: "Failing write probe",
			method: "POST",
			query: [],
			headers: [row("Content-Type", "application/json")],
			body: { mode: "json", text: '{"items":[]}' },
		},
		{ environmentId: environment._id, environmentRevision: updated.revision, label: "write probe" },
	);
	const unconfirmed = await api("/execution-intelligence/minimizations", {
		method: "POST",
		body: {
			sourceExecutionId: mutRun.executionId,
			predicate: { type: "status", equals: mutRun.response?.status },
			targetMode: "execution",
		},
	}).catch((error) => error);
	check(
		"mutating probes need explicit confirmation even on an approved local target",
		unconfirmed instanceof ApiFailure && unconfirmed.code === "MINIMIZATION_CONFIRMATION_REQUIRED",
		unconfirmed?.code,
	);
	const confirmedJob = await api("/execution-intelligence/minimizations", {
		method: "POST",
		body: {
			sourceExecutionId: mutRun.executionId,
			predicate: { type: "status", equals: mutRun.response?.status },
			targetMode: "execution",
			allowUnsafeLocal: true,
		},
	});
	const confirmedDone = await waitMinimization(confirmedJob.jobId);
	check(
		"confirmed mutating probes run only against the approved local target",
		confirmedDone.status === "completed",
		JSON.stringify(confirmedDone.error ?? {}),
	);

	say("· Secret scanning across every Flight Recorder artifact");
	assertNoSecrets("run 1 passport", passportOneSnapshot);
	assertNoSecrets("run 2 passport", passportTwoSnapshot);
	assertNoSecrets("comparison", JSON.stringify(comparison));
	assertNoSecrets("history list", JSON.stringify(await api("/history?limit=25")));
	assertNoSecrets("error responses", JSON.stringify(errorBodies));
}

main()
	.catch((error) => {
		say(`Flight Recorder demo could not complete: ${error.message}`);
		process.exitCode = 1;
	})
	.finally(cleanupLeftovers);
