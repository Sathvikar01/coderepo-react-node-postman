// Phase 14 — every failure that reaches the CLI top level must map onto the
// documented exit contract without leaking internals.

import { describe, expect, test } from "bun:test";
import { AppError } from "../../shared/errors/app-error.js";
import { loadCliConfig, STANDALONE_DEFAULTS } from "./cli-config.js";
import { classifyCliError, CliError } from "./cli-errors.js";
import { EXIT_CODES } from "./cli-exit.js";

describe("cli error classification", () => {
	test("a usage error stays an invalid-input failure with its own code", () => {
		const result = classifyCliError(new CliError("Unknown option --nope.", { code: "CLI_USAGE" }));
		expect(result).toMatchObject({ code: "CLI_USAGE", exitCode: EXIT_CODES.invalidInput });
	});

	test("a client-side AppError is an invalid input, a server-side one is a system failure", () => {
		expect(classifyCliError(new AppError(400, "RUN_TOO_LARGE", "Too many steps."))).toMatchObject({
			code: "RUN_TOO_LARGE",
			exitCode: EXIT_CODES.invalidInput,
		});
		expect(classifyCliError(new AppError(500, "RUN_FAILED", "The run broke."))).toMatchObject({
			code: "RUN_FAILED",
			exitCode: EXIT_CODES.systemFailure,
		});
	});

	test("an unclassified error is a system failure, never a silent success", () => {
		const result = classifyCliError(new Error("boom"));
		expect(result).toMatchObject({ code: "CLI_FAILURE", message: "boom", exitCode: EXIT_CODES.systemFailure });
	});
});

describe("cli configuration", () => {
	test("non-secret standalone placeholders fill only the values the CLI never uses", () => {
		const env = {};
		const loaded = loadCliConfig(env, { loader: () => ({ ok: true }) });
		expect(loaded.config).toEqual({ ok: true });
		expect(loaded.standalone).toBe(true);
		expect(loaded.applied.sort()).toEqual(Object.keys(STANDALONE_DEFAULTS).sort());
		expect(env.MONGODB_URI).toBe(STANDALONE_DEFAULTS.MONGODB_URI);
	});

	test("a malformed configuration fails closed as invalid input, not a crash", () => {
		const env = { MONGODB_URI: "mongodb://127.0.0.1:27017/keep", JWT_SECRET: "keep", EXECUTION_FINGERPRINT_KEY: "keep" };
		let caught = null;
		try {
			loadCliConfig(env, {
				loader: () => {
					throw new Error("Missing required environment variable: JWT_SECRET");
				},
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CliError);
		expect(caught.code).toBe("CLI_CONFIG");
		expect(caught.exitCode).toBe(EXIT_CODES.invalidInput);
		expect(classifyCliError(caught)).toMatchObject({ code: "CLI_CONFIG", exitCode: EXIT_CODES.invalidInput });
	});

	test("configuration already loaded is not treated as a failure", () => {
		const env = { MONGODB_URI: "mongodb://x/y", JWT_SECRET: "s", EXECUTION_FINGERPRINT_KEY: "k" };
		const loaded = loadCliConfig(env, { loader: () => "config" });
		expect(loaded.config).toBe("config");
		expect(loaded.standalone).toBe(false);
		expect(loaded.applied).toEqual([]);
	});
});
