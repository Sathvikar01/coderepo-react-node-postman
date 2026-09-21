import { describe, expect, test } from "bun:test";
import { runSandboxedScript } from "./sandbox.js";
import { scanForbiddenTokens } from "./script-scanner.js";

function input(overrides = {}) {
	return {
		phase: "prerequest",
		request: {
			method: "GET",
			url: "https://example.test/ping",
			headers: [{ name: "Accept", value: "application/json" }],
		},
		variables: { host: "example.test", limit: "5" },
		collection: { host: "example.test" },
		environment: { limit: "5" },
		response: null,
		...overrides,
	};
}

function run(source, overrides = {}) {
	return runSandboxedScript({ source, phase: overrides.phase ?? "prerequest", input: input(overrides) });
}

describe("script sandbox", () => {
	test("runs a script and captures console output", () => {
		const result = run('pm.console.log("hello", 2, { a: 1 });');
		expect(result.ok).toBe(true);
		expect(result.error).toBeNull();
		expect(result.output.console).toEqual([{ level: "log", message: 'hello 2 {"a":1}' }]);
	});

	test("records variable writes and header mutations", () => {
		const result = run(`
			pm.variables.set("host", "other.test");
			pm.variables.unset("limit");
			pm.request.headers.add("X-Trace", "abc");
			pm.request.headers.upsert({ key: "Accept", value: "text/plain" });
			pm.request.headers.remove("X-Missing");
		`);
		expect(result.ok).toBe(true);
		expect(result.output.variables).toEqual([
			{ op: "set", key: "host", value: "other.test" },
			{ op: "unset", key: "limit", value: "" },
		]);
		expect(result.output.headers).toEqual([
			{ op: "set", name: "X-Trace", value: "abc" },
			{ op: "set", name: "Accept", value: "text/plain" },
			{ op: "remove", name: "X-Missing", value: "" },
		]);
	});

	test("supports assertions with pass and fail results", () => {
		const result = run(`
			pm.test("status is fine", function () {
				pm.expect(2).toBe(2);
				pm.expect("tracer").toContain("race");
				pm.expect({ a: [1, 2] }).toEqual({ a: [1, 2] });
			});
			pm.test("deliberate failure", function () {
				pm.expect(1).toBe(2);
			});
			pm.test("throws", function () {
				throw new Error("boom");
			});
		`);
		expect(result.ok).toBe(true);
		expect(result.output.tests).toEqual([
			{ name: "status is fine", status: "passed", message: null },
			{ name: "deliberate failure", status: "failed", message: "Expected 2 but received 1." },
			{ name: "throws", status: "failed", message: "boom" },
		]);
	});

	test("keeps results collected before a runtime error", () => {
		const result = run(`
			pm.test("first", function () { pm.expect(true).toBeTruthy(); });
			pm.console.log("before failure");
			throw new Error("exploded");
		`);
		expect(result.ok).toBe(true);
		expect(result.error).toEqual({ code: "SCRIPT_ERROR", message: "exploded" });
		expect(result.output.tests).toHaveLength(1);
		expect(result.output.console[0].message).toBe("before failure");
	});

	test("reports syntax errors without running the script", () => {
		const result = run("function broken( {");
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe("SCRIPT_SYNTAX_ERROR");
	});

	test(
		"enforces the execution timeout",
		() => {
			const result = run("while (true) {}");
			expect(result.ok).toBe(false);
			expect(result.error.code).toBe("SCRIPT_TIMEOUT");
		},
		20000,
	);

	test("blocks forbidden capabilities with deterministic codes", () => {
		const cases = [
			'require("fs")',
			'process.env.SECRET',
			'fetch("http://example.test")',
			'setTimeout(function () {}, 1)',
			'new Function("return 1")',
			'eval("1 + 1")',
			'Promise.resolve(1)',
			'async function f() {}',
			'import("node:fs")',
			'globalThis.process',
			'Object.prototype.polluted = true',
			'({"a": 1}).constructor',
			'const module = {}',
			'new Worker("x")',
			'new WebSocket("ws://example.test")',
			'new XMLHttpRequest()',
			'SharedArrayBuffer',
			'Buffer.from("x")',
		];
		for (const source of cases) {
			const result = run(source);
			expect(result.ok).toBe(false);
			expect(result.error.code).toBe("SCRIPT_FORBIDDEN_API");
		}
	});

	test("allows forbidden words inside strings and comments", () => {
		const result = run(`
			// require("fs") is blocked in comments
			pm.console.log("process constructor fetch");
			pm.variables.set("message", "setTimeout is not available");
		`);
		expect(result.ok).toBe(true);
		expect(result.output.console[0].message).toBe("process constructor fetch");
	});

	test("keeps the host realm free of prototype pollution", () => {
		const result = run(`
			var slot = "proto" + "type";
			try { Object[slot].polluted = true; } catch (e) {}
			try { Array[slot].push = function () { return 1; }; } catch (e) {}
			pm.console.log("inside", ({}).polluted);
		`);
		expect(result.ok).toBe(true);
		expect(result.output.console[0].message).toBe("inside undefined");
		expect(({}).polluted).toBeUndefined();
		expect([].push(1)).toBe(1);
	});

	test("runs scripts in strict mode without a global this", () => {
		const result = run(`
			var state = {};
			state["strictThis"] = typeof this;
			state["console"] = typeof console.log;
			pm.variables.set("probe", JSON.stringify(state));
		`);
		expect(result.ok).toBe(true);
		expect(JSON.parse(result.output.variables[0].value)).toEqual({
			strictThis: "undefined",
			console: "function",
		});
	});

	test("does not allow request method or URL mutation", () => {
		const result = run(`
			pm.test("url write fails", function () {
				pm.request.url = "http://169.254.169.254/latest/meta-data";
			});
		`);
		expect(result.ok).toBe(true);
		expect(result.output.tests[0].status).toBe("failed");
		expect(result.output.tests[0].message).toContain("cannot change the request URL");
	});

	test("rejects header mutations after the request was sent", () => {
		const result = run(
			`
			pm.test("headers are locked", function () {
				pm.request.headers.add("X-Late", "1");
			});
		`,
			{ phase: "test", response: { status: 200, statusText: "OK", headers: [], body: null, binary: false, truncated: false } },
		);
		expect(result.ok).toBe(true);
		expect(result.output.tests[0].status).toBe("failed");
		expect(result.output.tests[0].message).toContain("pre-request script");
	});

	test("exposes response status, headers, text, and JSON", () => {
		const result = run(
			`
			pm.test("response is readable", function () {
				pm.expect(pm.response.code).toBe(201);
				pm.expect(pm.response.headers.get("content-type")).toBe("application/json");
				pm.expect(pm.response.json().items.length).toBe(2);
				pm.expect(pm.response.text()).toContain("items");
			});
		`,
			{
				phase: "test",
				response: {
					status: 201,
					statusText: "Created",
					headers: [{ name: "Content-Type", value: "application/json" }],
					body: '{"items":[1,2]}',
					binary: false,
					truncated: false,
				},
			},
		);
		expect(result.ok).toBe(true);
		expect(result.output.tests).toEqual([{ name: "response is readable", status: "passed", message: null }]);
	});

	test("caps console entries and mutation counts", () => {
		const result = run(`
			for (var index = 0; index < 400; index++) pm.console.log("line " + index);
			for (var header = 0; header < 250; header++) pm.request.headers.add("X-Cap-" + header, "v");
		`);
		expect(result.ok).toBe(true);
		expect(result.output.console).toHaveLength(100);
		expect(result.output.headers).toHaveLength(100);
	});

	test("rejects scripts above the source size limit", () => {
		const result = run(`pm.console.log("${"x".repeat(33 * 1024)}");`);
		expect(result.ok).toBe(false);
		expect(result.error.code).toBe("SCRIPT_TOO_LARGE");
	});

	test("rejects thenable test callbacks", () => {
		const result = run(`
			pm.test("thenable attempt", function () {
				return { then: function () {} };
			});
		`);
		expect(result.ok).toBe(true);
		expect(result.output.tests[0].status).toBe("failed");
		expect(result.output.tests[0].message).toContain("Async tests are not supported");
	});

	test("scanner skips strings and comments but flags code", () => {
		expect(scanForbiddenTokens('pm.console.log("require")')).toBeNull();
		expect(scanForbiddenTokens("// process\npm.console.log(1);")).toBeNull();
		const flagged = scanForbiddenTokens("pm.console.log(1);\nprocess.env;");
		expect(flagged.token).toBe("process");
		expect(flagged.line).toBe(2);
	});
});
