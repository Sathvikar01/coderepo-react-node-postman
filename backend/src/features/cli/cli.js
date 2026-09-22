// Top-level CLI orchestration.
//
// `runCli` is a pure-ish function over its inputs: it parses argv, loads config
// and the project, resolves selectors, builds the plan with the same pure
// `buildRunPlan` the workspace uses, starts a run through the real collection
// runner, waits for it, and renders a report. It never calls `process.exit`, so
// every path — including usage errors and cancellation — is testable in-process.
//
// A CLI run is not a second execution engine. The steps are ordinary executions
// through the normally-compiled pipeline, so a result carries its own execution
// id and can be opened in the Flight Recorder exactly like an in-app run.

import { buildRunPlan } from "../collection-runner/run-plan.js";
import { CLI_VERSION, formatCliUsage, parseCliArgs } from "./cli-args.js";
import { loadCliConfig } from "./cli-config.js";
import { classifyCliError } from "./cli-errors.js";
import { EXIT_CODES, exitCodeForRun } from "./cli-exit.js";
import {
	buildErrorReport,
	buildPlanReport,
	buildRunReport,
	renderErrorHuman,
	renderPlanHuman,
	renderRunHuman,
	stringifyReport,
} from "./cli-output.js";
import { createCliRuntime } from "./cli-runtime.js";
import { buildDomainDocuments, CLI_PROFILE_ID, loadProjectSource, resolveRunTargets } from "./project-source.js";

function wantsJson(argv) {
	return argv.some((token) => token === "--json" || String(token).startsWith("--json="));
}

function emitError({ error, json, stdout, stderr }) {
	const report = buildErrorReport({ error, exitCode: error.exitCode });
	if (json) stdout.write(stringifyReport(report));
	else stderr.write(renderErrorHuman(report));
	return error.exitCode;
}

// Cancellation is cooperative: an abort signal asks the runner to cancel the
// active run, which also cancels the in-flight execution. The run then reaches a
// terminal `cancelled` state and `wait` resolves normally.
function attachCancellation({ runtime, profileId, runId, signal }) {
	if (!signal) return null;
	const cancel = () => {
		runtime.runners.cancel(profileId, runId).catch(() => null);
	};
	if (signal.aborted) {
		cancel();
		return null;
	}
	signal.addEventListener("abort", cancel, { once: true });
	return () => signal.removeEventListener("abort", cancel);
}

export async function runCli(argv = [], io = {}) {
	const stdout = io.stdout ?? process.stdout;
	const stderr = io.stderr ?? process.stderr;

	let parsed;
	try {
		parsed = parseCliArgs(argv);
	} catch (error) {
		return emitError({ error: classifyCliError(error), json: wantsJson(argv), stdout, stderr });
	}

	if (parsed.versionRequested) {
		stdout.write(`${CLI_VERSION}\n`);
		return EXIT_CODES.success;
	}
	if (parsed.helpRequested) {
		stdout.write(formatCliUsage());
		return EXIT_CODES.success;
	}

	const profileId = io.profileId ?? CLI_PROFILE_ID;
	let source;
	let resolved;
	let plan;
	let collections;
	let environments;
	try {
		loadCliConfig(io.env ?? process.env, { loader: io.configLoader });
		source = loadProjectSource(parsed.projectPath, { cwd: io.cwd });
		({ collections, environments } = buildDomainDocuments({ domain: source.domain, profileId }));
		resolved = resolveRunTargets({ domain: { collections, environments } }, parsed.options);
		plan = buildRunPlan({ collection: resolved.collection, selection: resolved.selection, iterations: parsed.options.iterations });
	} catch (error) {
		return emitError({ error: classifyCliError(error), json: parsed.options.json, stdout, stderr });
	}

	if (parsed.options.planOnly) {
		const report = buildPlanReport({ source, resolved, plan, options: parsed.options });
		if (parsed.options.json) stdout.write(stringifyReport(report));
		else stdout.write(renderPlanHuman(report));
		return EXIT_CODES.success;
	}

	const runtime = createCliRuntime({
		collections,
		environments,
		profileId,
		allowLocal: parsed.options.allowLocal,
		overrides: io.overrides ?? {},
	});

	const input = {
		collectionId: String(resolved.collection._id),
		collectionRevision: resolved.collection.revision,
		selection: resolved.selection,
		...(resolved.environment ? { environmentId: String(resolved.environment._id), environmentRevision: resolved.environment.revision } : {}),
		iterations: plan.iterations,
		stopOnFailure: parsed.options.stopOnFailure,
		variables: parsed.options.variables,
	};

	let started;
	try {
		started = await runtime.runners.start(profileId, input);
	} catch (error) {
		return emitError({ error: classifyCliError(error), json: parsed.options.json, stdout, stderr });
	}

	const detach = attachCancellation({ runtime, profileId, runId: started.runId, signal: io.abortSignal });
	let run;
	try {
		run = await runtime.runners.wait(profileId, started.runId);
	} catch (error) {
		detach?.();
		return emitError({ error: classifyCliError(error), json: parsed.options.json, stdout, stderr });
	}
	detach?.();

	const exitCode = exitCodeForRun(run);
	const report = buildRunReport({
		source,
		resolved,
		plan,
		run,
		exitCode,
		allowLocal: parsed.options.allowLocal,
	});
	if (parsed.options.json) stdout.write(stringifyReport(report));
	else stdout.write(renderRunHuman(report));
	return exitCode;
}
