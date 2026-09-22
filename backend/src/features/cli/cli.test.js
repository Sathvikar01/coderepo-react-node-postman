// Phase 14 — end-to-end CLI tests.
//
// The point of these tests is that the CLI is not a second execution engine: it
// drives the real collection runner over the real execution pipeline. So the
// suite checks two things at once:
//
//   1. parity — the same project run through the CLI and through the runner
//      service the HTTP API calls produce the same steps and the same summary;
//   2. the CLI contract — stable JSON, documented exit codes, secret safety,
//      cancellation, and per-step Flight Recorder linkage.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { createCollectionRunnerService } from "../collection-runner/collection-runner.service.js";
import { parseRunStartInput } from "../collection-runner/collection-runner.controller.js";
import { createOperationRegistry } from "../executions/active-registry.js";
import { createExecutionService } from "../executions/execution.service.js";
import { TransportError } from "../executions/http-transport.js";
import { runCli as runCliImpl } from "./cli.js";
import { buildDomainDocuments, CLI_PROFILE_ID, loadProjectSource } from "./project-source.js";
import {
	assertion,
	cleanupTempDirs,
	collection,
	environment,
	folder,
	makeTempDir,
	project,
	request,
	secretVariable,
	variable,
	writeProject,
} from "./test-fixtures.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_cli_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase14-cli-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase14-cli-test-jwt-secret";
process.env.DEMO_CLI_TOKEN = process.env.DEMO_CLI_TOKEN || "cli-secret-token-value";
process.env.SERVER_SECRET_ALIASES_JSON =
	process.env.SERVER_SECRET_ALIASES_JSON || JSON.stringify([{ alias: "cli_token", env: "DEMO_CLI_TOKEN", profileIds: [] }]);

beforeAll(() => {
	initConfig();
});
afterAll(() => {
	cleanupTempDirs();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sink = () => {	const chunks = [];
	return {
		write: (value) => {
			chunks.push(String(value));
			return true;
		},
		text: () => chunks.join(""),
		json: () => JSON.parse(chunks.join("")),
	};
};

// Accept the short form used throughout this suite (`<project> ...`) while the
// real binary requires an explicit `run` command.
const runCli = (args, io = {}) => {
	const [first] = args;
	const explicit = first === "run" || first === "plan" || first === "validate" || first === "help" || String(first).startsWith("-");
	return runCliImpl(explicit ? args : ["run", ...args], io);
};

const publicTarget = (url) => {
	const parsed = new URL(url);
	return {
		scheme: parsed.protocol.replace(":", ""),
		originalHostname: parsed.hostname,
		authority: parsed.host,
		port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
		pathAndQuery: `${parsed.pathname}${parsed.search}`,
		ip: "93.184.216.34",
		family: 4,
		isIpLiteral: false,
		policyVersion: "1.0",
		local: false,
	};
};

const okResult = (body = { ok: true }, status = 200, statusText = "OK", headers = [{ name: "Content-Type", value: "application/json" }]) => ({
	state: { status, statusText, httpVersion: "1.1", headers },
	encoded: Buffer.from(JSON.stringify(body)),
	encodedBytes: 32,
	truncated: false,
	omittedReason: null,
	bytesSent: 64,
	timing: { totalMs: 4, firstByteMs: 2 },
	ok: true,
});

const failedResult = (kind, message) => ({
	state: { status: 0, statusText: "", httpVersion: "1.1", headers: [] },
	encoded: Buffer.alloc(0),
	encodedBytes: 0,
	truncated: false,
	omittedReason: null,
	bytesSent: 0,
	timing: { totalMs: 1, firstByteMs: null },
	ok: false,
	error: new TransportError(kind, message),
});

const dispatch = (input, result) => {
	input.onDispatch?.();
	return result;
};

// A deterministic transport/policy pair. The policy never resolves DNS, which
// keeps the unit-level tests hermetic while still exercising the real compiler,
// script runner, assertion runner, and execution service.
function makeFakeAdapters({ routes = [], fallback = (input) => dispatch(input, okResult({ token: "abc" })) } = {}) {
	const calls = [];
	const respond = (input) => {
		for (const [fragment, responder] of routes) {
			if (input.target.pathAndQuery.includes(fragment)) return responder(input);
		}
		return fallback(input);
	};
	return {
		calls,
		transport: async (input) => {
			calls.push(input);
			return respond(input);
		},
		policy: {
			async validate(url) {
				return publicTarget(url);
			},
		},
	};
}

// The UI's path: input parsed by the HTTP controller schema, then the runner the
// API calls, over the same execution service composition.
function buildUiRuntime({ collections, environments, profileId, adapters }) {
	const historyRecords = new Map();
	// The real history repository writes with `$set`, including dotted nested paths
	// such as "snapshot.scriptResults", so the stub has to nest the same way or the
	// execution service cannot read script results back out of the record.
	const applyDottedSet = (target, update) => {
		for (const [key, value] of Object.entries(update)) {
			const parts = key.split(".");
			let cursor = target;
			for (const part of parts.slice(0, -1)) {
				if (typeof cursor[part] !== "object" || cursor[part] === null) cursor[part] = {};
				cursor = cursor[part];
			}
			cursor[parts[parts.length - 1]] = value;
		}
		return target;
	};
	const history = {
		async admit(entry) {
			historyRecords.set(`${entry.ownerProfileId}:${entry.executionId}`, entry);
			return entry;
		},
		async finalize(ownerProfileId, executionId, update) {
			const key = `${ownerProfileId}:${executionId}`;
			const record = historyRecords.get(key);
			if (!record || record.status !== "running") return null;
			const next = applyDottedSet({ ...record, snapshot: { ...(record.snapshot ?? {}) } }, update);
			next.status = "terminal";
			historyRecords.set(key, next);
			return next;
		},
		async get(ownerProfileId, executionId) {
			return historyRecords.get(`${ownerProfileId}:${executionId}`) ?? null;
		},
		async reconcileStale() {
			return 0;
		},
	};
	const cookies = {
		async applyToRequest({ headers }) {
			return { headers, warnings: [], secretValues: [] };
		},
		async storeResponseCookies() {
			return { warnings: [] };
		},
	};
	const executions = createExecutionService({
		registry: createOperationRegistry(),
		history,
		cookies,
		localRuntime: { forExecution: async () => ({ enabled: false, hosts: [] }) },
		policy: adapters.policy,
		transport: adapters.transport,
		collections: { findById: async (id, owner) => collections.find((entry) => String(entry._id) === String(id) && entry.ownerProfileId === owner) ?? null },
		environments: { findById: async (id, owner) => environments.find((entry) => String(entry._id) === String(id) && entry.ownerProfileId === owner) ?? null },
		environmentSecrets: { resolveSecretAlias: () => undefined },
	});
	const runs = new Map();
	const runners = createCollectionRunnerService({
		repository: {
			async create(entry) {
				runs.set(entry.runId, entry);
				return entry;
			},
			async get(owner, runId) {
				return runs.get(runId) ?? null;
			},
			async update(owner, runId, patch) {
				const record = runs.get(runId);
				if (!record) return null;
				Object.assign(record, patch);
				return record;
			},
			async list() {
				return [];
			},
		},
		collections: { findById: async (id, owner) => collections.find((entry) => String(entry._id) === String(id) && entry.ownerProfileId === owner) ?? null },
		environments: { findById: async (id, owner) => environments.find((entry) => String(entry._id) === String(id) && entry.ownerProfileId === owner) ?? null },
		executions,
	});
	return { profileId, runners, history };
}

// The shared parity fixture: one request mints a run variable with a test
// script, the next consumes it, and the last fails a declarative assertion
// because the fake transport answers /missing with 404.
const MISSING_ROUTE = ["/missing", (input) => dispatch(input, okResult({ ok: false }, 404, "Not Found"))];

function parityProject() {
	const group = folder("Flow");
	const mint = request({
		name: "Mint token",
		method: "POST",
		folderId: group.id,
		urlTemplate: "{{base_url}}/token",
		body: { mode: "json", text: "{}" },
		scripts: {
			preRequest: "",
			test:
				'pm.variables.set("auth_token", "tok-" + pm.response.json().token);\n' +
				'pm.variables.set("log", (pm.variables.get("log") || "") + "x");',
		},
	});
	const use = request({
		name: "Use token",
		folderId: group.id,
		urlTemplate: "{{base_url}}/{{auth_token}}",
		headers: [{ id: crypto.randomUUID(), key: "X-Log", value: "{{log}}", enabled: true }],
	});
	const checked = request({
		name: "Checked",
		urlTemplate: "{{base_url}}/missing",
		assertions: { contract: "tracer.assertions/1", items: [assertion()] },
		scripts: { preRequest: "", test: 'pm.test("minted", function () { pm.expect(pm.response.status).toBe(200); });' },
	});
	return {
		mint,
		use,
		checked,
		value: project({
			collections: [
				collection({
					name: "Orders API",
					auth: { mode: "bearer", tokenTemplate: "{{api_token}}" },
					folders: [group],
					requests: [mint, use, checked],
				}),
			],
			environments: [
				environment({
					name: "Local",
					variables: [variable("base_url", "http://target.test/local"), variable("api_token", "plain-token-value")],
				}),
			],
		}),
	};
}

const normaliseResults = (results) =>
	results.map(({ executionId, durationMs, startedAt, finishedAt, ...rest }) => ({ ...rest, hasExecutionId: Boolean(executionId) }));

const normaliseSummary = ({ durationMs, ...rest }) => rest;

// ---------------------------------------------------------------------------
// plan mode
// ---------------------------------------------------------------------------

describe("cli plan mode", () => {
	test("resolves and prints the plan without dispatching anything", async () => {
		const { value } = parityProject();
		const dir = writeProject(value);
		const stdout = sink();
		const adapters = makeFakeAdapters();
		const code = await runCli(["plan", dir, "--environment", "Local", "--json"], { stdout, stderr: sink(), overrides: { ...adapters } });
		expect(code).toBe(0);
		const report = stdout.json();
		expect(report.kind).toBe("tracer.cli-plan");
		expect(report.plan.totalSteps).toBe(3);
		expect(report.plan.requestCount).toBe(3);
		expect(report.plan.steps.map((step) => step.name)).toEqual(["Mint token", "Use token", "Checked"]);
		expect(adapters.calls).toHaveLength(0);
	});

	test("the human plan is readable and marks the version", async () => {
		const dir = writeProject(parityProject().value);
		const stdout = sink();
		const code = await runCli(["plan", dir, "--environment", "Local"], { stdout, stderr: sink() });
		expect(code).toBe(0);
		expect(stdout.text()).toContain("run plan");
		expect(stdout.text()).toContain("No requests were sent (plan mode).");
	});
});

// ---------------------------------------------------------------------------
// parity with the HTTP runner
// ---------------------------------------------------------------------------

describe("cli and http runner parity", () => {
	test("the same project produces the same steps, summary, and stop reason", async () => {
		const fixture = parityProject();
		const dir = writeProject(fixture.value);
		const source = loadProjectSource(dir);
		const { collections, environments } = buildDomainDocuments({ domain: source.domain, profileId: CLI_PROFILE_ID });

		const cliAdapters = makeFakeAdapters({ routes: [MISSING_ROUTE] });
		const cliHistory = (await import("./memory-stores.js")).createMemoryHistoryStore();
		const stdout = sink();
		const cliCode = await runCli(
			[dir, "--environment", "Local", "--collection", "Orders API", "--continue", "--json"],
			{ stdout, stderr: sink(), overrides: { transport: cliAdapters.transport, policy: cliAdapters.policy, history: cliHistory } },
		);
		const cliReport = stdout.json();

		const uiAdapters = makeFakeAdapters({ routes: [MISSING_ROUTE] });
		const ui = buildUiRuntime({ collections, environments, profileId: CLI_PROFILE_ID, adapters: uiAdapters });
		const input = parseRunStartInput({
			collectionId: String(collections[0]._id),
			collectionRevision: 1,
			selection: { mode: "collection" },
			environmentId: String(environments[0]._id),
			environmentRevision: 1,
			iterations: 1,
			stopOnFailure: false,
			variables: [],
		});
		const started = await ui.runners.start(CLI_PROFILE_ID, input);
		const uiRun = await ui.runners.wait(CLI_PROFILE_ID, started.runId);

		// Same dispatch order and same per-step outcomes.
		expect(cliAdapters.calls.map((call) => call.target.pathAndQuery)).toEqual(uiAdapters.calls.map((call) => call.target.pathAndQuery));
		expect(cliAdapters.calls.map((call) => call.target.pathAndQuery)).toEqual(["/local/token", "/local/tok-abc", "/local/missing"]);
		expect(normaliseResults(cliReport.results)).toEqual(normaliseResults(uiRun.results));
		expect(normaliseSummary(cliReport.summary)).toEqual(normaliseSummary(uiRun.summary));
		expect(cliReport.stopReason).toBe(uiRun.stopReason);
		expect(cliReport.status).toBe(uiRun.status);
		expect(cliCode).toBe(1);
	});

	test("each executed step links to a Flight Recorder receipt", async () => {
		const fixture = parityProject();
		const dir = writeProject(fixture.value);
		const adapters = makeFakeAdapters({ routes: [MISSING_ROUTE] });
		const history = (await import("./memory-stores.js")).createMemoryHistoryStore();
		const stdout = sink();
		const code = await runCli([dir, "--environment", "Local", "--continue", "--json"], {
			stdout,
			stderr: sink(),
			overrides: { transport: adapters.transport, policy: adapters.policy, history },
		});
		expect(code).toBe(1);
		const report = stdout.json();
		expect(report.results.every((step) => step.executionId)).toBe(true);

		for (const step of report.results) {
			const record = await history.get(CLI_PROFILE_ID, step.executionId);
			expect(record.status).toBe("terminal");
			expect(record.receipt).toMatchObject({ kind: "tracer.execution-receipt", executionId: step.executionId });
			// The passport is already redacted upstream; nothing here re-injects a value.
			expect(JSON.stringify(record.receipt)).not.toContain("cli-secret-token-value");
		}
	});
});

// ---------------------------------------------------------------------------
// variables, scripts, and assertions
// ---------------------------------------------------------------------------

describe("cli variables and scripts", () => {
	test("run inputs, environment precedence, and script writes resolve like the app", async () => {
		const fixture = parityProject();
		const dir = writeProject(fixture.value);
		const adapters = makeFakeAdapters();
		const stdout = sink();
		const code = await runCli(
			[dir, "--environment", "Local", "--request", "Mint token", "--request", "Use token", "--continue", "--json", "--variable", "base_url=http://run-input.test/never"],
			{ stdout, stderr: sink(), overrides: { transport: adapters.transport, policy: adapters.policy } },
		);
		expect(code).toBe(0);
		const report = stdout.json();
		expect(report.options.variableKeys).toEqual(["base_url"]);
		// The persisted environment wins over an initial run input, and the script
		// write propagates into the next request's URL and header.
		expect(adapters.calls.map((call) => call.target.pathAndQuery)).toEqual(["/local/token", "/local/tok-abc"]);
		expect(adapters.calls[1].headers.find((header) => header.name === "X-Log")?.value).toBe("x");
		expect(report.summary.outcome).toBe("passed");
	});

	test("assertions and test scripts decide the step result", async () => {
		const fixture = parityProject();
		const dir = writeProject(fixture.value);
		const adapters = makeFakeAdapters({ routes: [["/missing", (input) => dispatch(input, okResult({ ok: false }, 404, "Not Found"))]] });
		const stdout = sink();
		const code = await runCli([dir, "--environment", "Local", "--request", "Checked", "--json"], {
			stdout,
			stderr: sink(),
			overrides: { transport: adapters.transport, policy: adapters.policy },
		});
		expect(code).toBe(1);
		const report = stdout.json();
		const step = report.results[0];
		expect(step.status).toBe("failed");
		expect(step.assertions.failed + step.assertions.errors).toBeGreaterThan(0);
		expect(step.failureReason).toBeTruthy();
	});

	test("secret references resolve on the wire but never appear in a report", async () => {
		const secured = request({
			name: "Secured",
			urlTemplate: "{{base_url}}/secure",
			auth: { mode: "bearer", tokenTemplate: "{{cli_token}}" },
		});
		const value = project({
			collections: [collection({ name: "Secure API", variables: [variable("base_url", "http://target.test"), secretVariable("cli_token", "cli_token")], requests: [secured] })],
		});
		const dir = writeProject(value);
		const adapters = makeFakeAdapters();
		const stdout = sink();
		const human = sink();
		const code = await runCli([dir, "--json"], { stdout, stderr: sink(), overrides: { transport: adapters.transport, policy: adapters.policy } });
		expect(code).toBe(0);
		expect(adapters.calls[0].headers.find((header) => header.name === "Authorization")?.value).toBe("Bearer cli-secret-token-value");
		expect(stdout.text()).not.toContain("cli-secret-token-value");
		expect(stdout.json().options.variableKeys).toEqual([]);

		await runCli([dir], { stdout: human, stderr: sink(), overrides: { transport: adapters.transport, policy: adapters.policy } });
		expect(human.text()).not.toContain("cli-secret-token-value");
	});

	test("a secret reference cannot be replaced by a run input", async () => {
		const secured = request({ name: "Secured", urlTemplate: "{{base_url}}/secure", auth: { mode: "bearer", tokenTemplate: "{{cli_token}}" } });
		const value = project({
			collections: [collection({ variables: [variable("base_url", "http://target.test"), secretVariable("cli_token", "cli_token")], requests: [secured] })],
		});
		const dir = writeProject(value);
		const stdout = sink();
		const adapters = makeFakeAdapters();
		const code = await runCli([dir, "--json", "--variable", "cli_token=leak"], {
			stdout,
			stderr: sink(),
			overrides: { transport: adapters.transport, policy: adapters.policy },
		});
		expect(code).toBe(2);
		expect(stdout.json()).toMatchObject({ kind: "tracer.cli-error", error: { code: "RUN_VARIABLE_RESERVED" } });
		expect(adapters.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// failure policy, iterations, cancellation
// ---------------------------------------------------------------------------

describe("cli failure policy and iterations", () => {
	const failing = { routes: [["/missing", (input) => dispatch(input, okResult({ ok: false }, 404, "Not Found"))]] };

	test("stop-on-failure is the default and skips the remaining requests", async () => {
		const fixture = parityProject();
		const dir = writeProject(fixture.value);
		const adapters = makeFakeAdapters(failing);
		const stdout = sink();
		const code = await runCli([dir, "--environment", "Local", "--json"], {
			stdout,
			stderr: sink(),
			overrides: { transport: adapters.transport, policy: adapters.policy },
		});
		expect(code).toBe(1);
		const report = stdout.json();
		expect(report.results.map((step) => step.status)).toEqual(["passed", "passed", "failed"]);
		expect(report.stopReason).toBe("stop_on_failure");
	});

	test("continue-on-failure executes every selected request", async () => {
		const fixture = parityProject();
		const dir = writeProject(fixture.value);
		const adapters = makeFakeAdapters(failing);
		const stdout = sink();
		const code = await runCli([dir, "--environment", "Local", "--continue", "--json"], {
			stdout,
			stderr: sink(),
			overrides: { transport: adapters.transport, policy: adapters.policy },
		});
		expect(code).toBe(1);
		const report = stdout.json();
		expect(report.stopReason).toBeNull();
		expect(report.progress.completed).toBe(3);
	});

	test("iterations repeat the selection in order", async () => {
		const first = request({ name: "First", urlTemplate: "{{base}}/a" });
		const second = request({ name: "Second", urlTemplate: "{{base}}/b" });
		const value = project({ collections: [collection({ requests: [first, second] })] });
		const dir = writeProject(value);
		const adapters = makeFakeAdapters();
		const stdout = sink();
		const code = await runCli([dir, "--iterations", "2", "--json"], {
			stdout,
			stderr: sink(),
			overrides: { transport: adapters.transport, policy: adapters.policy },
		});
		expect(code).toBe(0);
		const report = stdout.json();
		expect(report.results.map((step) => `${step.iteration}:${step.name}`)).toEqual(["1:First", "1:Second", "2:First", "2:Second"]);
		expect(report.plan.totalSteps).toBe(4);
	});

	test("a folder selection runs only that folder's requests", async () => {
		const group = folder("Flow");
		const inside = request({ name: "Inside", folderId: group.id, urlTemplate: "{{base}}/inside" });
		const outside = request({ name: "Outside", urlTemplate: "{{base}}/outside" });
		const value = project({ collections: [collection({ folders: [group], requests: [inside, outside] })] });
		const dir = writeProject(value);
		const adapters = makeFakeAdapters();
		const stdout = sink();
		const code = await runCli([dir, "--folder", "Flow", "--json"], { stdout, stderr: sink(), overrides: { transport: adapters.transport, policy: adapters.policy } });
		expect(code).toBe(0);
		expect(stdout.json().results.map((step) => step.name)).toEqual(["Inside"]);
	});

	test("a cancelled run exits 130 and reports a cancelled outcome", async () => {
		const slow = request({ name: "Slow", urlTemplate: "{{base}}/slow" });
		const after = request({ name: "After", urlTemplate: "{{base}}/after" });
		const value = project({ collections: [collection({ requests: [slow, after] })] });
		const dir = writeProject(value);
		let release;
		const started = new Promise((resolve) => {
			release = resolve;
		});
		const adapters = makeFakeAdapters({
			fallback: (input) => {
				release();
				return new Promise((resolve) => {
					const finish = () => resolve(failedResult("cancelled", "This execution was cancelled."));
					if (input.signal?.aborted) return finish();
					input.signal?.addEventListener("abort", finish, { once: true });
				});
			},
		});
		const controller = new AbortController();
		const stdout = sink();
		const running = runCli([dir, "--continue", "--json"], {
			stdout,
			stderr: sink(),
			abortSignal: controller.signal,
			overrides: { transport: adapters.transport, policy: adapters.policy },
		});
		await started;
		controller.abort();
		const code = await running;
		expect(code).toBe(130);
		const report = stdout.json();
		expect(report.status).toBe("cancelled");
		expect(report.stopReason).toBe("cancelled");
		expect(report.results[1].status).toBe("skipped");
	});
});

// ---------------------------------------------------------------------------
// real transport, real policy, and the cookie jar
// ---------------------------------------------------------------------------

describe("cli over a real local server", () => {
	let server;
	let baseUrl;

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/set") {
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "Content-Type": "application/json", "Set-Cookie": "sid=abc123; Path=/" },
					});
				}
				if (url.pathname === "/read") {
					const carried = (req.headers.get("cookie") ?? "").includes("sid=");
					return new Response(JSON.stringify({ carried }), { status: 200, headers: { "Content-Type": "application/json" } });
				}
				if (url.pathname === "/echo") {
					return new Response(req.headers.get("authorization") ?? "none", { status: 200, headers: { "Content-Type": "text/plain" } });
				}
				return new Response("not found", { status: 404 });
			},
		});
		baseUrl = `http://127.0.0.1:${server.port}`;
	});

	afterAll(() => {
		server?.stop(true);
	});

	test("the cookie jar replays through the real transport and policy boundary", async () => {
		const set = request({ name: "Set cookie", urlTemplate: `${baseUrl}/set` });
		const read = request({
			name: "Read cookie",
			urlTemplate: `${baseUrl}/read`,
			assertions: { contract: "tracer.assertions/1", items: [assertion({ name: "Cookie replayed", target: "body", operator: "contains", path: "", expected: '"carried":true', valueType: "string" })] },
		});
		const value = project({ collections: [collection({ variables: [], requests: [set, read] })] });
		const dir = writeProject(value);
		const stdout = sink();
		// allow-local is required: the normal SSRF boundary still applies.
		const blocked = await runCli([dir, "--json"], { stdout: sink(), stderr: sink() });
		expect(blocked).toBe(1);
		const code = await runCli([dir, "--allow-local", "127.0.0.1", "--json"], { stdout, stderr: sink() });
		expect(code).toBe(0);
		const report = stdout.json();
		expect(report.options.allowLocal).toEqual(["127.0.0.1"]);
		expect(report.results.map((step) => step.status)).toEqual(["passed", "passed"]);
	});

	test("a resolved secret is sent on the wire but never printed", async () => {
		const secured = request({
			name: "Secured",
			urlTemplate: `${baseUrl}/echo`,
			auth: { mode: "bearer", tokenTemplate: "{{cli_token}}" },
		});
		const value = project({
			collections: [collection({ name: "Secure API", variables: [secretVariable("cli_token", "cli_token")], requests: [secured] })],
		});
		const dir = writeProject(value);
		const stdout = sink();
		const code = await runCli([dir, "--allow-local", "127.0.0.1", "--json"], { stdout, stderr: sink() });
		expect(code).toBe(0);
		const report = stdout.json();
		// The server echoed the Authorization header; the response body is redacted
		// before it can reach the report.
		expect(JSON.stringify(report)).not.toContain("cli-secret-token-value");
		expect(report.results[0].httpStatus).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// CI parity: validation, environment-bound variables, timeout, and artifacts
// ---------------------------------------------------------------------------

describe("cli ci parity", () => {
	test("validate confirms a project without dispatching any request", async () => {
		const dir = writeProject(parityProject().value);
		const stdout = sink();
		const adapters = makeFakeAdapters();
		const code = await runCli(["validate", dir, "--json"], { stdout, stderr: sink(), overrides: { transport: adapters.transport, policy: adapters.policy } });
		expect(code).toBe(0);
		const report = stdout.json();
		expect(report.kind).toBe("tracer.cli-validate");
		expect(report.valid).toBe(true);
		expect(report.counts).toEqual({ collections: 1, requests: 3, environments: 1 });
		expect(adapters.calls).toHaveLength(0);
	});

	test("validate rejects a project that does not parse, with exit 2", async () => {
		const file = path.join(makeTempDir(), "broken.json");
		writeFileSync(file, "{ nope", "utf8");
		const stdout = sink();
		expect(await runCli(["validate", file, "--json"], { stdout, stderr: sink() })).toBe(2);
		expect(stdout.json().kind).toBe("tracer.cli-error");
	});

	test("--variable-env reads a value from the environment and never prints it", async () => {
		const probe = request({ name: "Probe", urlTemplate: "{{base}}/{{token}}" });
		const dir = writeProject(project({ collections: [collection({ requests: [probe] })] }));
		const adapters = makeFakeAdapters();
		const stdout = sink();
		const code = await runCli([dir, "--variable-env", "token=API_TOKEN", "--json"], {
			stdout,
			stderr: sink(),
			env: { API_TOKEN: "tok-9f3c" },
			overrides: { transport: adapters.transport, policy: adapters.policy },
		});
		expect(code).toBe(0);
		expect(adapters.calls[0].target.pathAndQuery).toBe("/tok-9f3c");
		const report = stdout.json();
		expect(report.options.variableKeys).toEqual(["token"]);
		expect(JSON.stringify(report)).not.toContain("tok-9f3c");
	});

	test("a missing environment variable is invalid input, not a partial run", async () => {
		const dir = writeProject(parityProject().value);
		const adapters = makeFakeAdapters();
		const stdout = sink();
		const code = await runCli([dir, "--variable-env", "token=API_TOKEN", "--json"], {
			stdout,
			stderr: sink(),
			env: {},
			overrides: { transport: adapters.transport, policy: adapters.policy },
		});
		expect(code).toBe(2);
		expect(stdout.json()).toMatchObject({ kind: "tracer.cli-error", error: { code: "CLI_VARIABLE_ENV_MISSING" } });
		expect(adapters.calls).toHaveLength(0);
	});

	test("--timeout stops a hung run and exits 124", async () => {
		const slow = request({ name: "Slow", urlTemplate: "{{base}}/slow" });
		const value = project({ collections: [collection({ requests: [slow] })] });
		const dir = writeProject(value);
		const adapters = makeFakeAdapters({
			fallback: (input) =>
				new Promise((resolve) => {
					const finish = () => resolve(failedResult("cancelled", "This execution was cancelled."));
					if (input.signal?.aborted) return finish();
					input.signal?.addEventListener("abort", finish, { once: true });
				}),
		});
		const stdout = sink();
		const code = await runCli([dir, "--timeout", "1", "--json"], { stdout, stderr: sink(), overrides: { transport: adapters.transport, policy: adapters.policy } });
		expect(code).toBe(124);
		const report = stdout.json();
		expect(report.timedOut).toBe(true);
		expect(report.options.timeoutMs).toBe(1000);
		expect(report.exitCode).toBe(124);
	});

	test("--report and --junit write the same outcome to files, announced on stderr", async () => {
		const dir = writeProject(parityProject().value);
		const workDir = makeTempDir();
		const jsonPath = path.join(workDir, "out", "run.json");
		const junitPath = path.join(workDir, "out", "run.junit.xml");
		const stdout = sink();
		const stderr = sink();
		const adapters = makeFakeAdapters({ routes: [MISSING_ROUTE] });
		const code = await runCli([dir, "--environment", "Local", "--continue", "--json", "--report", jsonPath, "--junit", junitPath], {
			stdout,
			stderr,
			cwd: workDir,
			overrides: { transport: adapters.transport, policy: adapters.policy },
		});
		expect(code).toBe(1);
		expect(existsSync(jsonPath)).toBe(true);
		expect(existsSync(junitPath)).toBe(true);
		expect(readFileSync(jsonPath, "utf8")).toBe(stdout.text());
		const junit = readFileSync(junitPath, "utf8");
		expect(junit).toContain("<testsuites");
		expect(junit).toContain("<failure");
		expect(stderr.text()).toContain(`JSON report: ${jsonPath}`);
		expect(stderr.text()).toContain(`JUnit report: ${junitPath}`);
	});
});

// ---------------------------------------------------------------------------
// invalid input and configuration
// ---------------------------------------------------------------------------

describe("cli invalid input", () => {
	test("a missing project exits 2 with a machine-readable error", async () => {
		const stdout = sink();
		const code = await runCli([path.join(makeTempDir(), "absent"), "--json"], { stdout, stderr: sink() });
		expect(code).toBe(2);
		expect(stdout.json()).toMatchObject({ kind: "tracer.cli-error", status: "invalid", error: { code: "CLI_PROJECT_NOT_FOUND" } });
	});

	test("a malformed project exits 2", async () => {
		const dir = makeTempDir();
		const file = path.join(dir, "project.json");
		writeFileSync(file, "{ definitely not a project", "utf8");
		const stdout = sink();
		const code = await runCli([file, "--json"], { stdout, stderr: sink() });
		expect(code).toBe(2);
		expect(stdout.json().kind).toBe("tracer.cli-error");
	});

	test("an unknown collection exits 2 and lists what is available", async () => {
		const dir = writeProject(parityProject().value);
		const stdout = sink();
		const code = await runCli([dir, "--collection", "Nope", "--json"], { stdout, stderr: sink() });
		expect(code).toBe(2);
		const report = stdout.json();
		expect(report.error.code).toBe("CLI_SELECTION_UNKNOWN");
		expect(report.error.details.available).toEqual(["Orders API"]);
	});

	test("a malformed configuration exits 2 with CLI_CONFIG", async () => {
		const dir = writeProject(parityProject().value);
		const stdout = sink();
		const code = await runCli([dir, "--json"], {
			stdout,
			stderr: sink(),
			configLoader: () => {
				throw new Error("Missing required environment variable: JWT_SECRET");
			},
		});
		expect(code).toBe(2);
		expect(stdout.json()).toMatchObject({ kind: "tracer.cli-error", error: { code: "CLI_CONFIG" } });
	});

	test("usage errors go to stderr in text mode unless --json was requested", async () => {
		const stderr = sink();
		const code = await runCli(["run"], { stdout: sink(), stderr });
		expect(code).toBe(2);
		expect(stderr.text()).toContain("CLI_NO_PROJECT");
	});

	test("--help and --version exit 0 without touching the project", async () => {
		const help = sink();
		expect(await runCli(["--help"], { stdout: help, stderr: sink() })).toBe(0);
		expect(help.text()).toContain("USAGE");
		const version = sink();
		expect(await runCli(["--version"], { stdout: version, stderr: sink() })).toBe(0);
		expect(version.text().trim()).toBe("1.0.0");
	});
});

describe("cli import boundary reuse", () => {
	test("a cURL-derived portable project runs through the same boundary", async () => {
		// The CLI consumes the same TracerProjectV1 that import/export produces, so a
		// project written by any importer is runnable without CLI-specific storage.
		const imported = request({ name: "Imported", method: "POST", urlTemplate: "{{base}}/imported", body: { mode: "json", text: '{"hello":"world"}' } });
		const dir = writeProject(project({ collections: [collection({ requests: [imported] })] }));
		const adapters = makeFakeAdapters();
		const stdout = sink();
		const code = await runCli([dir, "--json"], { stdout, stderr: sink(), overrides: { transport: adapters.transport, policy: adapters.policy } });
		expect(code).toBe(0);
		expect(adapters.calls[0].method).toBe("POST");
		expect(stdout.json().project.fingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	test("parity holds for a request-selection run too", async () => {
		const fixture = parityProject();
		const dir = writeProject(fixture.value);
		const source = loadProjectSource(dir);
		const { collections, environments } = buildDomainDocuments({ domain: source.domain, profileId: CLI_PROFILE_ID });

		const cliAdapters = makeFakeAdapters();
		const stdout = sink();
		const code = await runCli([dir, "--environment", "Local", "--request", "Mint token", "--request", "Use token", "--continue", "--json"], {
			stdout,
			stderr: sink(),
			overrides: { transport: cliAdapters.transport, policy: cliAdapters.policy },
		});
		expect(code).toBe(0);

		const uiAdapters = makeFakeAdapters();
		const ui = buildUiRuntime({ collections, environments, profileId: CLI_PROFILE_ID, adapters: uiAdapters });
		const input = parseRunStartInput({
			collectionId: String(collections[0]._id),
			collectionRevision: 1,
			selection: { mode: "requests", requestIds: [fixture.mint.id, fixture.use.id] },
			environmentId: String(environments[0]._id),
			environmentRevision: 1,
			iterations: 1,
			stopOnFailure: false,
			variables: [],
		});
		const started = await ui.runners.start(CLI_PROFILE_ID, input);
		const uiRun = await ui.runners.wait(CLI_PROFILE_ID, started.runId);
		expect(normaliseResults(stdout.json().results)).toEqual(normaliseResults(uiRun.results));
	});
});
