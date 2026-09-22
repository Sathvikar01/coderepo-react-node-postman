// Phase 15 — process-level CI parity.
//
// The in-process tests prove the CLI's logic. These tests prove the contract a
// CI job actually consumes: the exit status of the real `bun main.js` process,
// the machine document on stdout, the JSON and JUnit files on disk, and the
// guarantee that an environment-injected secret reaches the wire but never the
// artifacts. Everything runs against a real loopback HTTP server through the
// real SSRF/local-runtime boundary, so this is the closest local equivalent of
// the example GitHub Actions workflow.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTempDirs, collection, makeTempDir, project, request, secretVariable, writeProject } from "./test-fixtures.js";

const MAIN = fileURLToPath(new URL("./main.js", import.meta.url));
const SECRET = "tok_live_3f19c2-never-in-artifacts";
const ALIASES = JSON.stringify([{ alias: "ci_token", env: "DEMO_CI_TOKEN", profileIds: [] }]);

let server;
let baseUrl;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/health") {
				return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.pathname === "/token") {
				return new Response(JSON.stringify({ token: "abc" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.pathname === "/echo") {
				// Echo the bearer token so we can prove the secret was really sent.
				return new Response(req.headers.get("authorization") ?? "none", { status: 200, headers: { "Content-Type": "text/plain" } });
			}
			if (url.pathname === "/slow") {
				await Bun.sleep(30000);
				return new Response("late", { status: 200 });
			}
			return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	cleanupTempDirs();
});

function spawnCli(args, { env = {} } = {}) {
	const child = Bun.spawn([process.execPath, MAIN, ...args], {
		cwd: path.dirname(MAIN),
		env: {
			...process.env,
			MONGODB_URI: "mongodb://127.0.0.1:27017/tracer_cli_ci_test",
			JWT_SECRET: "phase15-cli-ci-test-jwt-secret",
			EXECUTION_FINGERPRINT_KEY: "phase15-cli-ci-test-fingerprint-key-0123",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return (async () => {
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		return { code, stdout, stderr };
	})();
}

// A portable project written by the real serializer: a passing health check and
// a request whose declarative assertion fails against a 404.
function ciProject() {
	const health = request({
		name: "Health check",
		urlTemplate: `${baseUrl}/health`,
		assertions: { contract: "tracer.assertions/1", items: [{ id: crypto.randomUUID(), name: "Status is 200", enabled: true, target: "status", operator: "equals", path: "", expected: "200", valueType: "number" }] },
	});
	const missing = request({
		name: "Missing order",
		urlTemplate: `${baseUrl}/missing`,
		assertions: { contract: "tracer.assertions/1", items: [{ id: crypto.randomUUID(), name: "Status is 200", enabled: true, target: "status", operator: "equals", path: "", expected: "200", valueType: "number" }] },
	});
	const secured = request({ name: "Secured echo", urlTemplate: `${baseUrl}/echo`, auth: { mode: "bearer", tokenTemplate: "{{ci_token}}" } });
	const slow = request({ name: "Slow endpoint", urlTemplate: `${baseUrl}/slow` });
	return project({
		collections: [collection({ name: "CI Smoke", variables: [secretVariable("ci_token", "ci_token")], requests: [health, missing, secured, slow] })],
	});
}

function normalise(report) {
	const clone = JSON.parse(JSON.stringify(report));
	clone.runId = "<run>";
	clone.startedAt = "<t>";
	clone.finishedAt = "<t>";
	if (clone.summary) clone.summary.durationMs = "<ms>";
	for (const step of clone.results ?? []) {
		step.executionId = step.executionId ? "<exec>" : null;
		step.durationMs = step.durationMs === null || step.durationMs === undefined ? step.durationMs : "<ms>";
		step.startedAt = step.startedAt ? "<t>" : null;
		step.finishedAt = step.finishedAt ? "<t>" : null;
	}
	return clone;
}

describe("tracer cli process contract", () => {
	const dir = () => writeProject(ciProject());

	test("a passing collection exits 0 with a machine document and both artifacts", async () => {
		const projectDir = dir();
		const out = makeTempDir();
		const jsonPath = path.join(out, "pass.json");
		const junitPath = path.join(out, "pass.junit.xml");
		const result = await spawnCli(["run", projectDir, "--request", "Health check", "--allow-local", "127.0.0.1", "--json", "--report", jsonPath, "--junit", junitPath]);
		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.kind).toBe("tracer.cli-run");
		expect(report.exitCode).toBe(0);
		expect(report.results.map((step) => step.status)).toEqual(["passed"]);
		expect(report.results[0].executionId).toBeTruthy();
		// stdout is exactly one JSON document; notices go to stderr.
		expect(JSON.parse(result.stdout).schemaVersion).toBe(2);
		expect(result.stderr).toContain(`JSON report: ${jsonPath}`);
		expect(result.stderr).toContain(`JUnit report: ${junitPath}`);
		expect(readFileSync(jsonPath, "utf8")).toBe(result.stdout);
		expect(readFileSync(junitPath, "utf8")).toContain('<testsuite name="CI Smoke" tests="1" failures="0"');
	}, 60000);

	test("a failing assertion exits 1 and still writes both artifacts", async () => {
		const projectDir = dir();
		const out = makeTempDir();
		const jsonPath = path.join(out, "fail.json");
		const junitPath = path.join(out, "fail.junit.xml");
		const result = await spawnCli(["run", projectDir, "--request", "Missing order", "--allow-local", "127.0.0.1", "--json", "--report", jsonPath, "--junit", junitPath]);
		expect(result.code).toBe(1);
		const report = JSON.parse(result.stdout);
		expect(report.exitCode).toBe(1);
		expect(report.results[0].status).toBe("failed");
		expect(report.results[0].failureReason).toBeTruthy();
		expect(readFileSync(jsonPath, "utf8")).toBe(result.stdout);
		const junit = readFileSync(junitPath, "utf8");
		expect(junit).toContain('failures="1"');
		expect(junit).toContain("<failure");
	}, 60000);

	test("the JSON output is byte-identical across runs once volatile fields are normalised", async () => {
		const projectDir = dir();
		const first = await spawnCli(["run", projectDir, "--request", "Health check", "--allow-local", "127.0.0.1", "--json"]);
		const second = await spawnCli(["run", projectDir, "--request", "Health check", "--allow-local", "127.0.0.1", "--json"]);
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(normalise(JSON.parse(first.stdout))).toEqual(normalise(JSON.parse(second.stdout)));
	}, 90000);

	test("validate exits 0 without touching the network", async () => {
		const projectDir = dir();
		const result = await spawnCli(["validate", projectDir, "--json"]);
		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.kind).toBe("tracer.cli-validate");
		expect(report.counts.requests).toBe(4);
	}, 60000);

	test("--timeout turns a hung run into exit 124", async () => {
		const projectDir = dir();
		const result = await spawnCli(["run", projectDir, "--request", "Slow endpoint", "--allow-local", "127.0.0.1", "--timeout", "1", "--json"]);
		expect(result.code).toBe(124);
		const report = JSON.parse(result.stdout);
		expect(report.timedOut).toBe(true);
		expect(report.options.timeoutMs).toBe(1000);
	}, 60000);

	test("an environment-injected secret reaches the wire but never an artifact", async () => {
		const projectDir = dir();
		const out = makeTempDir();
		const jsonPath = path.join(out, "secret.json");
		const junitPath = path.join(out, "secret.junit.xml");
		const result = await spawnCli(["run", projectDir, "--request", "Secured echo", "--allow-local", "127.0.0.1", "--json", "--report", jsonPath, "--junit", junitPath], {
			env: { DEMO_CI_TOKEN: SECRET, SERVER_SECRET_ALIASES_JSON: ALIASES },
		});
		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain(SECRET);
		expect(result.stderr).not.toContain(SECRET);
		expect(readFileSync(jsonPath, "utf8")).not.toContain(SECRET);
		expect(readFileSync(junitPath, "utf8")).not.toContain(SECRET);
	}, 60000);

	test("invalid input exits 2 with a machine-readable error on stdout", async () => {
		const result = await spawnCli(["run", path.join(makeTempDir(), "missing"), "--json"]);
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout)).toMatchObject({ kind: "tracer.cli-error", status: "invalid" });
	}, 60000);
});
