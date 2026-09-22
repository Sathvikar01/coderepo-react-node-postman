// Dependency-free argument parser for the Tracer CLI.
//
// The parser is pure and synchronous: it turns argv into a plain object or throws
// a CliError. It never touches the filesystem, config, or network, so command
// shape (including every usage error) is testable without any runtime setup.
//
// Long flags accept both `--flag value` and `--flag=value`. `--variable` uses
// `KEY=VALUE` and splits on the first `=`, so values may contain `=`.
// `--variable-env` uses `KEY=ENV_VAR` and keeps only the environment variable
// name, so a secret value is never placed in argv (where `ps` could read it).

import { LIMITS } from "../../shared/utils/limits.js";
import { RUN_LIMITS } from "../collection-runner/run-limits.js";
import { normalizeLocalHost } from "../local-runtime/local-address-policy.js";
import { CliError } from "./cli-errors.js";

export const CLI_NAME = "tracer";
export const CLI_VERSION = "1.0.0";

// GNU `timeout` style ceiling. A run longer than this should be batched by the
// caller rather than pinned to one CI job.
export const TIMEOUT_MAX_SECONDS = 3600;

const COMMANDS = new Set(["run", "plan", "validate", "help"]);

const BOOLEAN_FLAGS = new Set(["--json", "--plan", "--continue", "--stop-on-failure", "--help"]);
const VALUE_FLAGS = new Set([
	"--collection",
	"--environment",
	"--folder",
	"--request",
	"--iterations",
	"--variable",
	"--variable-env",
	"--allow-local",
	"--timeout",
	"--report",
	"--junit",
]);
const REPEATABLE_FLAGS = new Set(["--request", "--variable", "--variable-env", "--allow-local"]);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Options that only make sense when a run is actually going to be executed.
const RUN_ONLY_FLAGS = ["--collection", "--environment", "--folder", "--request", "--iterations", "--variable", "--variable-env", "--allow-local", "--timeout", "--junit", "--plan"];

export function formatCliUsage() {
	return [
		`${CLI_NAME} ${CLI_VERSION} — headless collection runner`,
		"",
		"USAGE",
		`  ${CLI_NAME} run <project> [options]`,
		`  ${CLI_NAME} plan <project> [options]`,
		`  ${CLI_NAME} validate <project> [options]`,
		`  ${CLI_NAME} help`,
		"",
		"PROJECT",
		"  <project> is a git-native project directory or a portable TracerProjectV1 JSON file.",
		"",
		"OPTIONS",
		"  --collection <name|index>   Collection to run (default: the first collection).",
		"  --environment <name|index>  Environment to apply (default: none).",
		"  --folder <name|id>          Run one folder instead of the whole collection.",
		"  --request <name|id>         Run one request; repeat to run several in order.",
		"  --iterations <n>            Repeat the selection 1.." + RUN_LIMITS.iterationsPerRun + " times (default: 1).",
		"  --variable <KEY=VALUE>      Initial run variable; repeat for several.",
		"  --variable-env <KEY=ENV>    Bind a run variable to an environment variable; repeat for several.",
		"                              The variable value never appears in argv or in any report.",
		"  --allow-local <host>        Opt in to one exact loopback/private host; repeat to allow several.",
		"  --timeout <seconds>         Stop the run after this many seconds (1.." + TIMEOUT_MAX_SECONDS + "); exit code 124.",
		"  --continue                  Keep running after a failed request.",
		"  --stop-on-failure           Stop at the first failed request (default).",
		"  --plan                      Resolve and print the run plan without sending anything.",
		"  --report <path>             Write the authoritative JSON report to a file (CI artifact).",
		"  --junit <path>              Write a JUnit XML report to a file (CI test summary).",
		"  --json                      Emit machine-readable JSON.",
		"  --help                      Print this help.",
		"",
		"EXIT CODES",
		"  0    the run completed and every executed request passed",
		"  1    the run completed but at least one request failed",
		"  2    invalid arguments, project, selection, or configuration",
		"  3    the runner or execution pipeline failed unexpectedly",
		"  124  the run exceeded the --timeout budget",
		"  130  the run was cancelled (SIGINT)",
		"",
		"OUTPUT",
		"  stdout carries the machine document when --json is set (otherwise the human report).",
		"  stderr carries diagnostics, artifact notices, and text-mode errors.",
		"",
		"SECRETS",
		"  Secret references resolve from the server secret aliases (SERVER_SECRET_ALIASES_JSON +",
		"  DEMO_* environment variables) at run time and are never printed or written to reports.",
		"",
	].join("\n");
}

function usageError(message, details = null) {
	return new CliError(message, { code: "CLI_USAGE", details });
}

function requireValue(name, inlineValue, tokens, index) {
	if (inlineValue !== null) return { value: inlineValue, next: index };
	const next = tokens[index + 1];
	if (next === undefined) throw usageError(`Option ${name} requires a value.`);
	return { value: next, next: index + 1 };
}

function parseIntOption(raw) {
	if (!/^\d+$/.test(raw)) throw usageError(`--iterations expects a whole number between 1 and ${RUN_LIMITS.iterationsPerRun}.`);
	const value = Number(raw);
	if (value < 1 || value > RUN_LIMITS.iterationsPerRun)
		throw usageError(`--iterations must be between 1 and ${RUN_LIMITS.iterationsPerRun}.`);
	return value;
}

function parseTimeoutOption(raw) {
	if (!/^\d+$/.test(raw)) throw usageError(`--timeout expects a whole number of seconds between 1 and ${TIMEOUT_MAX_SECONDS}.`);
	const seconds = Number(raw);
	if (seconds < 1 || seconds > TIMEOUT_MAX_SECONDS)
		throw usageError(`--timeout must be between 1 and ${TIMEOUT_MAX_SECONDS} seconds.`);
	return seconds * 1000;
}

function parseVariable(raw) {
	const separator = raw.indexOf("=");
	if (separator <= 0) throw usageError("--variable expects KEY=VALUE.");
	const key = raw.slice(0, separator).trim();
	const value = raw.slice(separator + 1);
	if (!VARIABLE_NAME.test(key)) throw usageError(`"${key}" is not a valid variable name.`);
	if (Buffer.byteLength(value, "utf8") > LIMITS.variableValueBytes)
		throw usageError(`The value for "${key}" exceeds the ${LIMITS.variableValueBytes}-byte variable limit.`);
	return { key, value };
}

function parseVariableEnv(raw) {
	const separator = raw.indexOf("=");
	if (separator <= 0) throw usageError("--variable-env expects KEY=ENV_VAR.");
	const key = raw.slice(0, separator).trim();
	const env = raw.slice(separator + 1).trim();
	if (!VARIABLE_NAME.test(key)) throw usageError(`"${key}" is not a valid variable name.`);
	if (!ENV_NAME.test(env)) throw usageError(`"${env}" is not a valid environment variable name.`);
	return { key, env };
}

function parseLocalHost(raw) {
	try {
		return normalizeLocalHost(raw);
	} catch (error) {
		throw usageError(error?.message ?? "The approved local host is not valid.");
	}
}

export function parseCliArgs(argv = []) {
	const tokens = argv.map((token) => String(token));
	if (tokens.length === 0) throw new CliError("No command was provided.", { code: "CLI_NO_COMMAND" });

	const first = tokens[0];
	if (first === "--help" || first === "-h") return baseResult({ helpRequested: true });
	if (first === "--version") return baseResult({ versionRequested: true });
	if (first.startsWith("-")) throw usageError(`Unknown option ${first}.`);
	if (!COMMANDS.has(first)) throw usageError(`Unknown command "${first}". Use run, plan, validate, or help.`);

	const command = first;
	const parsed = baseResult({ command, planOnly: command === "plan", validateOnly: command === "validate" });
	if (command === "help") {
		parsed.helpRequested = true;
		return parsed;
	}

	const seen = new Map();
	let stopOnFailureChosen = null;
	let projectPath = null;

	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		let name = token;
		let inlineValue = null;
		if (token.startsWith("--") && token.includes("=")) {
			const separator = token.indexOf("=");
			name = token.slice(0, separator);
			inlineValue = token.slice(separator + 1);
		}

		if (BOOLEAN_FLAGS.has(name)) {
			if (inlineValue !== null) throw usageError(`Option ${name} does not take a value.`);
			if (name === "--help") {
				parsed.helpRequested = true;
				continue;
			}
			seen.set(name, true);
			if (name === "--json") parsed.options.json = true;
			if (name === "--plan") parsed.options.planOnly = true;
			if (name === "--continue") stopOnFailureChosen = stopOnFailureChosen === "stop" ? "conflict" : "continue";
			if (name === "--stop-on-failure") stopOnFailureChosen = stopOnFailureChosen === "continue" ? "conflict" : "stop";
			continue;
		}

		if (VALUE_FLAGS.has(name)) {
			if (seen.has(name) && !REPEATABLE_FLAGS.has(name)) throw usageError(`Option ${name} was provided more than once.`);
			seen.set(name, true);
			const resolved = requireValue(name, inlineValue, tokens, index);
			index = resolved.next;
			const value = resolved.value;
			if (name !== "--variable" && value === "") throw usageError(`Option ${name} requires a non-empty value.`);
			if (name === "--collection") parsed.options.collection = value;
			if (name === "--environment") parsed.options.environment = value;
			if (name === "--folder") parsed.options.folder = value;
			if (name === "--request") parsed.options.requests.push(value);
			if (name === "--iterations") parsed.options.iterations = parseIntOption(value);
			if (name === "--variable") parsed.options.variables.push(parseVariable(value));
			if (name === "--variable-env") parsed.options.variablesFromEnv.push(parseVariableEnv(value));
			if (name === "--allow-local") parsed.options.allowLocal.push(parseLocalHost(value));
			if (name === "--timeout") parsed.options.timeoutMs = parseTimeoutOption(value);
			if (name === "--report") parsed.options.reportPath = value;
			if (name === "--junit") parsed.options.junitPath = value;
			continue;
		}

		if (token.startsWith("-") && token !== "-") throw usageError(`Unknown option ${token}.`);
		if (projectPath !== null) throw usageError("Provide exactly one project path.");
		projectPath = token;
	}

	if (stopOnFailureChosen === "conflict") throw usageError("--continue and --stop-on-failure cannot be combined.");
	if (stopOnFailureChosen) parsed.options.stopOnFailure = stopOnFailureChosen === "stop";

	if (parsed.options.validateOnly) {
		const disallowed = RUN_ONLY_FLAGS.filter((flag) => seen.has(flag));
		if (disallowed.length > 0) throw usageError(`validate only accepts --json and --report; remove ${disallowed.join(", ")}.`);
	}
	if (parsed.options.planOnly && parsed.options.junitPath)
		throw usageError("--junit requires an actual run; it cannot be combined with --plan.");
	if (parsed.options.planOnly && parsed.options.timeoutMs)
		throw usageError("--timeout requires an actual run; it cannot be combined with --plan.");

	parsed.options.allowLocal = [...new Set(parsed.options.allowLocal)];
	if (parsed.options.allowLocal.length > LIMITS.localRuntimeTargets)
		throw usageError(`At most ${LIMITS.localRuntimeTargets} approved local hosts may be supplied.`);
	const variableCount = parsed.options.variables.length + parsed.options.variablesFromEnv.length;
	if (variableCount > LIMITS.variablesPerScope)
		throw usageError(`At most ${LIMITS.variablesPerScope} run variables may be supplied.`);
	if (parsed.options.folder && parsed.options.requests.length > 0) throw usageError("--folder and --request cannot be combined.");

	if (!parsed.helpRequested && projectPath === null) throw new CliError("A project path is required.", { code: "CLI_NO_PROJECT" });
	parsed.projectPath = projectPath;
	return parsed;
}

function baseResult(overrides = {}) {
	return {
		command: overrides.command ?? null,
		projectPath: null,
		helpRequested: overrides.helpRequested ?? false,
		versionRequested: overrides.versionRequested ?? false,
		options: {
			collection: null,
			environment: null,
			folder: null,
			requests: [],
			iterations: 1,
			stopOnFailure: true,
			variables: [],
			variablesFromEnv: [],
			allowLocal: [],
			timeoutMs: null,
			reportPath: null,
			junitPath: null,
			json: false,
			planOnly: overrides.planOnly ?? false,
			validateOnly: overrides.validateOnly ?? false,
		},
	};
}
