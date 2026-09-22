// Phase 14 — the argument parser is the CLI's public surface. It is pure, so the
// whole command shape is pinned here without any config, disk, or network.

import { describe, expect, test } from "bun:test";
import { formatCliUsage, parseCliArgs } from "./cli-args.js";
import { CliError } from "./cli-errors.js";
import { RUN_LIMITS } from "../collection-runner/run-limits.js";

const capture = (fn) => {
	try {
		return { value: fn(), error: null };
	} catch (error) {
		return { value: null, error };
	}
};

describe("cli argument parsing", () => {
	test("run with a project path and defaults", () => {
		const parsed = parseCliArgs(["run", "./api-project"]);
		expect(parsed.command).toBe("run");
		expect(parsed.projectPath).toBe("./api-project");
		expect(parsed.options).toEqual({
			collection: null,
			environment: null,
			folder: null,
			requests: [],
			iterations: 1,
			stopOnFailure: true,
			variables: [],
			allowLocal: [],
			json: false,
			planOnly: false,
		});
	});

	test("plan is a first-class command that implies plan mode", () => {
		const parsed = parseCliArgs(["plan", "./api-project", "--environment", "Local"]);
		expect(parsed.command).toBe("plan");
		expect(parsed.options.planOnly).toBe(true);
		expect(parsed.options.environment).toBe("Local");
	});

	test("value flags accept both separated and inline forms", () => {
		const separated = parseCliArgs(["run", "./p", "--collection", "Orders", "--iterations", "3"]);
		const inline = parseCliArgs(["run", "./p", "--collection=Orders", "--iterations=3"]);
		expect(separated.options.collection).toBe("Orders");
		expect(separated.options.iterations).toBe(3);
		expect(inline.options.collection).toBe("Orders");
		expect(inline.options.iterations).toBe(3);
	});

	test("repeatable flags collect values in order", () => {
		const parsed = parseCliArgs([
			"run",
			"./p",
			"--request",
			"Create order",
			"--request",
			"Read order",
			"--variable",
			"token=abc=def",
			"--variable",
			"region=eu",
		]);
		expect(parsed.options.requests).toEqual(["Create order", "Read order"]);
		// --variable splits on the first "=" so values may contain "=".
		expect(parsed.options.variables).toEqual([
			{ key: "token", value: "abc=def" },
			{ key: "region", value: "eu" },
		]);
	});

	test("--allow-local normalizes each exact host and de-duplicates", () => {
		const parsed = parseCliArgs(["run", "./p", "--allow-local", "127.0.0.1", "--allow-local", "localhost", "--allow-local", "127.0.0.1"]);
		expect(parsed.options.allowLocal).toEqual(["127.0.0.1", "localhost"]);
	});

	test("failure policy flags resolve and reject contradictions", () => {
		expect(parseCliArgs(["run", "./p", "--continue"]).options.stopOnFailure).toBe(false);
		expect(parseCliArgs(["run", "./p", "--stop-on-failure"]).options.stopOnFailure).toBe(true);
		const conflict = capture(() => parseCliArgs(["run", "./p", "--continue", "--stop-on-failure"]));
		expect(conflict.error).toBeInstanceOf(CliError);
		expect(conflict.error.code).toBe("CLI_USAGE");
	});

	test("help and version short-circuit without a project", () => {
		expect(parseCliArgs(["--help"])).toMatchObject({ helpRequested: true, command: null });
		expect(parseCliArgs(["--version"])).toMatchObject({ versionRequested: true });
		expect(parseCliArgs(["help"])).toMatchObject({ command: "help", helpRequested: true });
		expect(parseCliArgs(["run", "./p", "--help"])).toMatchObject({ helpRequested: true, projectPath: "./p" });
	});

	test("usage errors carry the CLI_USAGE code and a helpful message", () => {
		const cases = [
			[[], "CLI_NO_COMMAND"],
			[["frobnicate"], "CLI_USAGE"],
			[["--nope"], "CLI_USAGE"],
			[["run"], "CLI_NO_PROJECT"],
			[["run", "./p", "extra"], "CLI_USAGE"],
			[["run", "./p", "--iterations"], "CLI_USAGE"],
			[["run", "./p", "--iterations", "0"], "CLI_USAGE"],
			[["run", "./p", "--iterations", String(RUN_LIMITS.iterationsPerRun + 1)], "CLI_USAGE"],
			[["run", "./p", "--variable", "novalue"], "CLI_USAGE"],
			[["run", "./p", "--variable", "1bad=x"], "CLI_USAGE"],
			[["run", "./p", "--collection", "a", "--collection", "b"], "CLI_USAGE"],
			[["run", "./p", "--folder", "f", "--request", "r"], "CLI_USAGE"],
			[["run", "./p", "--allow-local", "169.254.169.254"], "CLI_USAGE"],
			[["run", "./p", "--allow-local", "http://127.0.0.1"], "CLI_USAGE"],
			[["run", "./p", "--json=yes"], "CLI_USAGE"],
		];
		for (const [argv, code] of cases) {
			const result = capture(() => parseCliArgs(argv));
			expect(result.error).toBeInstanceOf(CliError);
			expect({ argv, code: result.error.code }).toEqual({ argv, code });
		}
	});

	test("the usage text documents commands, options, and exit codes", () => {
		const usage = formatCliUsage();
		expect(usage).toContain("tracer run <project>");
		expect(usage).toContain("--allow-local");
		expect(usage).toContain("130");
	});
});
