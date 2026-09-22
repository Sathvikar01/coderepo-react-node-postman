// Dependency-free argument parser for the Tracer CLI.
//
// The parser is pure and synchronous: it turns argv into a plain object or throws
// a CliError. It never touches the filesystem, config, or network, so command
// shape (including every usage error) is testable without any runtime setup.
//
// Long flags accept both `--flag value` and `--flag=value`. `--variable` uses
// `KEY=VALUE` and splits on the first `=`, so values may contain `=`.

import { LIMITS } from "../../shared/utils/limits.js";
import { RUN_LIMITS } from "../collection-runner/run-limits.js";
import { normalizeLocalHost } from "../local-runtime/local-address-policy.js";
import { CliError } from "./cli-errors.js";

export const CLI_NAME = "tracer";
export const CLI_VERSION = "1.0.0";

const COMMANDS = new Set(["run", "plan", "help"]);

const BOOLEAN_FLAGS = new Set(["--json", "--plan", "--continue", "--stop-on-failure", "--help"]);
const VALUE_FLAGS = new Set(["--collection", "--environment", "--folder", "--request", "--iterations", "--variable", "--allow-local"]);
const REPEATABLE_FLAGS = new Set(["--request", "--variable", "--allow-local"]);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function formatCliUsage() {
	return [
		`${CLI_NAME} ${CLI_VERSION} — headless collection runner`,
		"",
		"USAGE",
		`  ${CLI_NAME} run <project> [options]`,
		`  ${CLI_NAME} plan <project> [options]`,
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
		"  --allow-local <host>        Opt in to one exact loopback/private host; repeat to allow several.",
		"  --continue                  Keep running after a failed request.",
		"  --stop-on-failure           Stop at the first failed request (default).",
		"  --plan                      Resolve and print the run plan without sending anything.",
		"  --json                      Emit machine-readable JSON.",
		"  --help                      Print this help.",
		"",
		"EXIT CODES",
		"  0    the run completed and every executed request passed",
		"  1    the run completed but at least one request failed",
		"  2    invalid arguments, project, selection, or configuration",
		"  3    the runner or execution pipeline failed unexpectedly",
		"  130  the run was cancelled (SIGINT)",
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
	if (!COMMANDS.has(first)) throw usageError(`Unknown command "${first}". Use run, plan, or help.`);

	const command = first;
	const parsed = baseResult({ command, planOnly: command === "plan" });
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
			if (name === "--allow-local") parsed.options.allowLocal.push(parseLocalHost(value));
			continue;
		}

		if (token.startsWith("-") && token !== "-") throw usageError(`Unknown option ${token}.`);
		if (projectPath !== null) throw usageError("Provide exactly one project path.");
		projectPath = token;
	}

	if (stopOnFailureChosen === "conflict") throw usageError("--continue and --stop-on-failure cannot be combined.");
	if (stopOnFailureChosen) parsed.options.stopOnFailure = stopOnFailureChosen === "stop";

	parsed.options.allowLocal = [...new Set(parsed.options.allowLocal)];
	if (parsed.options.allowLocal.length > LIMITS.localRuntimeTargets)
		throw usageError(`At most ${LIMITS.localRuntimeTargets} approved local hosts may be supplied.`);
	if (parsed.options.variables.length > LIMITS.variablesPerScope)
		throw usageError(`At most ${LIMITS.variablesPerScope} run variables may be supplied.`);
	if (parsed.options.folder && parsed.options.requests.length > 0)
		throw usageError("--folder and --request cannot be combined.");

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
			allowLocal: [],
			json: false,
			planOnly: overrides.planOnly ?? false,
		},
	};
}
