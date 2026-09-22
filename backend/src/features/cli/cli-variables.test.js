// Phase 15 — environment-bound run variables. The whole point of this path is
// that a secret can reach the runner without ever appearing in argv, so these
// tests pin resolution, fail-closed behavior, and the absence of the value from
// any message.

import { describe, expect, test } from "bun:test";
import { LIMITS } from "../../shared/utils/limits.js";
import { resolveRunVariables } from "./cli-variables.js";

const options = (overrides = {}) => ({
	variables: [],
	variablesFromEnv: [],
	...overrides,
});

describe("cli run variable resolution", () => {
	test("plain values pass through and environment values are read by name", () => {
		const resolved = resolveRunVariables(options({ variables: [{ key: "region", value: "eu" }], variablesFromEnv: [{ key: "token", env: "API_TOKEN" }] }), {
			API_TOKEN: "s3cr3t",
		});
		expect(resolved).toEqual([
			{ key: "region", value: "eu" },
			{ key: "token", value: "s3cr3t" },
		]);
	});

	test("a missing environment variable fails closed without echoing a value", () => {
		try {
			resolveRunVariables(options({ variablesFromEnv: [{ key: "token", env: "API_TOKEN" }] }), {});
			throw new Error("expected a CliError");
		} catch (error) {
			expect(error.code).toBe("CLI_VARIABLE_ENV_MISSING");
			expect(error.message).toContain("API_TOKEN");
			expect(error.message).not.toContain("undefined");
		}
	});

	test("a duplicated variable is rejected even across the two forms", () => {
		try {
			resolveRunVariables(options({ variables: [{ key: "token", value: "a" }], variablesFromEnv: [{ key: "token", env: "API_TOKEN" }] }), { API_TOKEN: "b" });
			throw new Error("expected a CliError");
		} catch (error) {
			expect(error.code).toBe("CLI_VARIABLE_DUPLICATE");
			expect(error.message).toContain("token");
		}
	});

	test("an oversized environment value fails closed", () => {
		try {
			resolveRunVariables(options({ variablesFromEnv: [{ key: "token", env: "API_TOKEN" }] }), { API_TOKEN: "x".repeat(LIMITS.variableValueBytes + 1) });
			throw new Error("expected a CliError");
		} catch (error) {
			expect(error.code).toBe("CLI_VARIABLE_ENV_TOO_LARGE");
		}
	});
});
