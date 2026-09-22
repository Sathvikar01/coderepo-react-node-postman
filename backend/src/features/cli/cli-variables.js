// Resolving CLI run variables from argv and from the environment.
//
// `--variable KEY=VALUE` puts the value in argv, which is visible to `ps` and to
// shell history. `--variable-env KEY=ENV_VAR` names an environment variable
// instead, so a value (often a credential) can be injected by CI without ever
// appearing on a command line. Both forms produce the same run-variable shape;
// the resolved value is handed straight to the runner and is never printed.

import { LIMITS } from "../../shared/utils/limits.js";
import { CliError } from "./cli-errors.js";

export function resolveRunVariables(options, env = process.env) {
	const variables = [...(options.variables ?? [])];
	const seen = new Set(variables.map((variable) => variable.key));

	for (const binding of options.variablesFromEnv ?? []) {
		if (seen.has(binding.key))
			throw new CliError(`Variable "${binding.key}" was provided more than once.`, {
				code: "CLI_VARIABLE_DUPLICATE",
				details: { key: binding.key },
			});
		const raw = env?.[binding.env];
		if (raw === undefined)
			throw new CliError(`Environment variable ${binding.env} for variable "${binding.key}" is not set.`, {
				code: "CLI_VARIABLE_ENV_MISSING",
				details: { key: binding.key, env: binding.env },
			});
		const value = String(raw);
		if (Buffer.byteLength(value, "utf8") > LIMITS.variableValueBytes)
			throw new CliError(`The value from ${binding.env} for "${binding.key}" exceeds the ${LIMITS.variableValueBytes}-byte variable limit.`, {
				code: "CLI_VARIABLE_ENV_TOO_LARGE",
				details: { key: binding.key, env: binding.env },
			});
		variables.push({ key: binding.key, value });
		seen.add(binding.key);
	}

	return variables;
}
