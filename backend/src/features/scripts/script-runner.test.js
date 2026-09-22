import { describe, expect, test } from "bun:test";
import {
	applyHeaderMutations,
	applyVariableWrites,
	composeScriptResults,
	mergePostResponseResults,
	scriptService,
	scriptVariableScopes,
} from "./script-runner.js";

const request = (overrides = {}) => ({
	schemaVersion: 1,
	id: "11111111-1111-4111-8111-111111111111",
	folderId: null,
	name: "Probe",
	method: "GET",
	urlTemplate: "https://{{host}}/ping",
	query: [],
	headers: [],
	body: { mode: "none" },
	auth: { mode: "none" },
	scripts: { preRequest: "", test: "" },
	settings: { timeoutMs: 5000 },
	...overrides,
});

const collection = (overrides = {}) => ({
	name: "Collection",
	variables: [
		{ id: "v1", key: "host", kind: "plain", value: "example.test", enabled: true },
		{ id: "v2", key: "apiToken", kind: "secretRef", alias: "DEMO_LOCAL_TOKEN", enabled: true },
	],
	auth: { mode: "none" },
	...overrides,
});

const environment = (overrides = {}) => ({
	name: "Environment",
	variables: [{ id: "v3", key: "stage", kind: "plain", value: "dev", enabled: true }],
	...overrides,
});

describe("header mutations", () => {
	test("adds, upserts, and removes rows while preserving identifiers", () => {
		const warnings = [];
		const rows = [
			{ id: "row-1", key: "Accept", value: "application/json", enabled: true },
			{ id: "row-2", key: "X-Old", value: "1", enabled: true },
		];
		const result = applyHeaderMutations(
			rows,
			[
				{ op: "set", name: "Accept", value: "text/plain" },
				{ op: "set", name: "X-New", value: "2" },
				{ op: "remove", name: "x-old" },
			],
			warnings,
		);
		expect(warnings).toEqual([]);
		expect(result.changed).toBe(true);
		expect(result.rows.map((row) => [row.key, row.value])).toEqual([
			["Accept", "text/plain"],
			["X-New", "2"],
		]);
		expect(result.rows[0].id).toBe("row-1");
		expect(result.rows[1].id).toBeTruthy();
	});

	test("rejects managed transport headers and invalid values", () => {
		const warnings = [];
		const result = applyHeaderMutations(
			[{ id: "row-1", key: "Accept", value: "application/json", enabled: true }],
			[
				{ op: "set", name: "Host", value: "evil.test" },
				{ op: "set", name: "Content-Length", value: "10" },
				{ op: "set", name: "X-Bad\r\nInjected", value: "1" },
				{ op: "set", name: "X-Linebreak", value: "a\r\nb" },
				{ op: "set", name: "X-Ok", value: "1" },
			],
			warnings,
		);
		expect(result.rows.map((row) => row.key)).toEqual(["Accept", "X-Ok"]);
		expect(warnings.map((warning) => warning.code)).toEqual([
			"SCRIPT_HEADER_RESERVED",
			"SCRIPT_HEADER_RESERVED",
			"SCRIPT_HEADER_INVALID",
			"SCRIPT_HEADER_INVALID",
		]);
	});
});

describe("variable writes", () => {
	test("applies sets and unsets and rejects invalid or secret keys", () => {
		const warnings = [];
		const overlay = new Map();
		applyVariableWrites(
			overlay,
			[
				{ op: "set", key: "host", value: "other.test" },
				{ op: "set", key: "newKey", value: "1" },
				{ op: "unset", key: "stage", value: "" },
				{ op: "set", key: "1bad", value: "x" },
				{ op: "set", key: "apiToken", value: "leak" },
			],
			new Set(["apiToken"]),
			warnings,
		);
		expect([...overlay.entries()]).toEqual([
			["host", "other.test"],
			["newKey", "1"],
			["stage", null],
		]);
		expect(warnings.map((warning) => warning.code)).toEqual(["SCRIPT_VARIABLE_INVALID", "SCRIPT_VARIABLE_RESERVED"]);
	});
});

describe("script scopes", () => {
	test("exposes plain variables only and merges environment over collection", () => {
		const scopes = scriptVariableScopes(
			collection(),
			environment({ variables: [{ id: "v3", key: "host", kind: "plain", value: "env.test", enabled: true }] }),
		);
		expect(scopes.collection).toEqual({ host: "example.test" });
		expect(scopes.environment).toEqual({ host: "env.test" });
		expect(scopes.merged).toEqual({ host: "env.test" });
		expect(scopes.merged.apiToken).toBeUndefined();
	});
});

describe("pre-request scripts", () => {
	test("applies header and variable mutations to the draft", () => {
		const outcome = scriptService.runPreRequest({
			request: request({
				headers: [{ id: "row-1", key: "Accept", value: "application/json", enabled: true }],
				scripts: {
					preRequest: 'pm.variables.set("host", "script.test"); pm.request.headers.add("X-Script", "1");',
					test: "",
				},
			}),
			collection: collection(),
			environment: environment(),
		});
		expect(outcome.phase.status).toBe("passed");
		expect(outcome.warnings).toEqual([]);
		expect([...outcome.variables.entries()]).toEqual([["host", "script.test"]]);
		expect(outcome.request.headers.map((header) => header.key)).toEqual(["Accept", "X-Script"]);
	});

	test(
		"discards mutations when the sandbox refuses to run the script",
		() => {
			const outcome = scriptService.runPreRequest({
				request: request({
					headers: [{ id: "row-1", key: "Accept", value: "application/json", enabled: true }],
					scripts: { preRequest: 'pm.request.headers.add("X-Escape", "1"); while (true) {}', test: "" },
				}),
				collection: collection(),
				environment: environment(),
			});
			expect(outcome.phase.status).toBe("error");
			expect(outcome.phase.error.code).toBe("SCRIPT_TIMEOUT");
			expect(outcome.variables.size).toBe(0);
			expect(outcome.request.headers).toHaveLength(1);
			expect(outcome.warnings[0].code).toBe("SCRIPT_TIMEOUT");
		},
		20000,
	);

	test("returns the draft untouched when no pre-request script is defined", () => {
		const draft = request();
		const outcome = scriptService.runPreRequest({ request: draft, collection: collection(), environment: environment() });
		expect(outcome.request).toBe(draft);
		expect(outcome.phase).toBeNull();
		expect(outcome.warnings).toEqual([]);
	});
});

describe("post-response scripts", () => {
	test("collects test results from the response", () => {
		const outcome = scriptService.runPostResponse({
			request: request({ scripts: { preRequest: "", test: 'pm.test("created", function () { pm.expect(pm.response.code).toBe(201); });' } }),
			response: {
				status: 201,
				statusText: "Created",
				headers: [{ name: "Content-Type", value: "application/json" }],
				body: { encoding: "utf8", value: '{"ok":true}', mediaType: "application/json", truncated: false },
			},
			collection: collection(),
			environment: environment(),
		});
		expect(outcome.phase.status).toBe("passed");
		expect(outcome.tests).toEqual([{ name: "created", status: "passed", message: null }]);
	});

	test("marks the test phase skipped when no response is available", () => {
		const outcome = scriptService.skippedPostResponse(request({ scripts: { preRequest: "", test: "pm.test('x', function () {});" } }));
		expect(outcome.phase.status).toBe("skipped");
		expect(outcome.tests).toEqual([]);
	});

	test("does not leak script state between runs", () => {
		const definition = request({
			scripts: {
				preRequest: 'pm.variables.set("leak", "yes"); pm.request.headers.add("X-Leak", "1");',
				test: "",
			},
		});
		scriptService.runPreRequest({ request: definition, collection: collection(), environment: environment() });
		const second = scriptService.runPreRequest({ request: definition, collection: collection(), environment: environment() });
		expect(second.request.headers.map((header) => header.key)).toEqual(["X-Leak"]);
		expect(second.variables.get("leak")).toBe("yes");
		expect(({}).leak).toBeUndefined();
	});
});

describe("result counts", () => {
	test("counts passes, failures, and script errors", () => {
		const results = composeScriptResults({
			preRequest: { status: "error", error: { code: "SCRIPT_TIMEOUT", message: "slow" }, console: [], mutations: { headers: [], variables: [] } },
			postResponse: { status: "passed", error: null, console: [], mutations: { headers: [], variables: [] } },
			tests: [
				{ name: "a", status: "passed", message: null },
				{ name: "b", status: "failed", message: "nope" },
			],
		});
		expect(results.counts).toEqual({ passed: 1, failed: 1, errors: 1 });
	});

	test("merges post-response results into an existing result set", () => {
		const base = composeScriptResults({ preRequest: { status: "passed", error: null, console: [], mutations: { headers: [], variables: [] } } });
		const merged = mergePostResponseResults(base, { status: "passed", error: null, console: [], mutations: { headers: [], variables: [] } }, [
			{ name: "x", status: "passed", message: null },
		]);
		expect(merged.preRequest.status).toBe("passed");
		expect(merged.postResponse.status).toBe("passed");
		expect(merged.counts).toEqual({ passed: 1, failed: 0, errors: 0 });
	});
});

describe("run scope visibility", () => {
	test("merges initial inputs below persisted scopes and writes above them", () => {
		const scopes = scriptVariableScopes(collection(), environment(), {
			initial: new Map([
				["stage", "initial"],
				["seed", "from-run"],
			]),
			writes: new Map([
				["host", "written.test"],
				["stage", "written"],
				["gone", null],
			]),
		});
		expect(scopes.merged).toEqual({ stage: "written", seed: "from-run", host: "written.test" });
		expect(scopes.environment.stage).toBe("dev");
		expect(scopes.collection.host).toBe("example.test");
	});

	test("returns post-response variable writes so a run can propagate them", () => {
		const result = scriptService.runPostResponse({
			request: request({
				scripts: { preRequest: "", test: 'pm.variables.set("token", "abc"); pm.variables.unset("host");' },
			}),
			response: { status: 200, statusText: "OK", headers: [], body: { encoding: "utf8", value: "{}", truncated: false } },
			collection: collection(),
			environment: environment(),
		});
		expect(result.variables instanceof Map).toBe(true);
		expect(result.variables.get("token")).toBe("abc");
		expect(result.variables.get("host")).toBeNull();
		expect(result.tests).toHaveLength(0);
	});
});
