// Top-level CLI orchestration.
//
// `runCli` is a pure-ish function over its inputs: it parses argv, loads config
// and the project, resolves selectors, builds the plan with the same pure
// `buildRunPlan` the workspace uses, starts a run through the real collection
// runner, waits for it, and renders a report. It never calls `process.exit`, so
// every path — including usage errors, timeouts, and cancellation — is testable
// in-process.
//
// A CLI run is not a second execution engine. The steps are ordinary executions
// through the normally-compiled pipeline, so a result carries its own execution
// id and can be opened in the Flight Recorder exactly like an in-app run.
//
// For CI parity the same report object drives three destinations: stdout/human
// text for logs, an authoritative JSON file (`--report`), and a JUnit XML file
// (`--junit`). All three are derived from one render of one outcome, so they can
// never disagree.

import { buildRunPlan } from "../collection-runner/run-plan.js";
import { CLI_VERSION, formatCliUsage, parseCliArgs } from "./cli-args.js";
import { loadCliConfig } from "./cli-config.js";
import { classifyCliError } from "./cli-errors.js";
import { EXIT_CODES, exitCodeForRun } from "./cli-exit.js";
import {
	buildErrorReport,
	buildPlanReport,
	buildRunReport,
	buildValidateReport,
	ERROR_REPORT_KIND,
	renderErrorHuman,
	renderReportHuman,
	stringifyReport,
} from "./cli-output.js";
import { writeJsonReport, writeJUnitReport } from "./cli-report-writer.js";
import { createCliRuntime } from "./cli-runtime.js";
import { resolveRunVariables } from "./cli-variables.js";
import { buildDomainDocuments, CLI_PROFILE_ID, loadProjectSource, resolveRunTargets } from "./project-source.js";

function wantsJson(argv) {
	return argv.some((token) => token === "--json" || String(token).startsWith("--json="));
}

// One sink for every outcome. `stdout` carries the machine document (or, in text
// mode, the human report); `stderr` carries diagnostics, artifact notices, and
// text-mode errors. An artifact write failure is a system failure even when the
// run itself passed, because CI cannot consume a report that was never saved.
function emitOutcome({ report, json, stdout, stderr, reportPath = null, junitPath = null, cwd }) {
	const isError = report.kind === ERROR_REPORT_KIND;
	if (json) {
		stdout.write(stringifyReport(report));
		if (isError) stderr.write(`${report.error.code}: ${report.error.message}\n`);
	} else if (isError) {
		stderr.write(renderErrorHuman(report));
	} else {
		stdout.write(renderReportHuman(report));
	}

	try {
		if (reportPath) stderr.write(`JSON report: ${writeJsonReport(reportPath, report, { cwd })}\n`);
		if (junitPath) stderr.write(`JUnit report: ${writeJUnitReport(junitPath, report, { cwd })}\n`);
	} catch (error) {
		const issue = classifyCliError(error);
		if (json) stderr.write(`${issue.code}: ${issue.message}\n`);
		else stderr.write(renderErrorHuman(buildErrorReport({ error: issue, exitCode: issue.exitCode })));
		return issue.exitCode;
	}

	return report.exitCode;
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
	const cwd = io.cwd ?? process.cwd();

	let parsed;
	try {
		parsed = parseCliArgs(argv);
	} catch (error) {
		const classified = classifyCliError(error);
		return emitOutcome({ report: buildErrorReport({ error: classified, exitCode: classified.exitCode }), json: wantsJson(argv), stdout, stderr, cwd });
	}

	if (parsed.versionRequested) {
		stdout.write(`${CLI_VERSION}\n`);
		return EXIT_CODES.success;
	}
	if (parsed.helpRequested) {
		stdout.write(formatCliUsage());
		return EXIT_CODES.success;
	}

	const { json, reportPath, junitPath } = parsed.options;
	const emit = (report) => emitOutcome({ report, json, stdout, stderr, reportPath, junitPath, cwd });

	const profileId = io.profileId ?? CLI_PROFILE_ID;
	let source;
	let resolved;
	let plan;
	let collections;
	let environments;
	let variables;
	try {
		loadCliConfig(io.env ?? process.env, { loader: io.configLoader });
		source = loadProjectSource(parsed.projectPath, { cwd });
		if (parsed.options.validateOnly) return emit(buildValidateReport({ source, domain: source.domain }));
		({ collections, environments } = buildDomainDocuments({ domain: source.domain, profileId }));
		resolved = resolveRunTargets({ domain: { collections, environments } }, parsed.options);
		variables = resolveRunVariables(parsed.options, io.env ?? process.env);
		plan = buildRunPlan({ collection: resolved.collection, selection: resolved.selection, iterations: parsed.options.iterations });
	} catch (error) {
		const classified = classifyCliError(error);
		return emit(buildErrorReport({ error: classified, exitCode: classified.exitCode }));
	}

	if (parsed.options.planOnly) {
		return emit(buildPlanReport({ source, resolved, plan, options: parsed.options, variables }));
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
		variables,
	};

	let started;
	try {
		started = await runtime.runners.start(profileId, input);
	} catch (error) {
		const classified = classifyCliError(error);
		return emit(buildErrorReport({ error: classified, exitCode: classified.exitCode }));
	}

	// A `--timeout` is a hard wall-clock budget for the whole run. When it fires
	// we ask the runner to cancel, exactly as a SIGINT would; the timeout only
	// counts if the run did not reach a terminal completed state first.
	let timerFired = false;
	let timeoutHandle = null;
	if (parsed.options.timeoutMs) {
		timeoutHandle = setTimeout(() => {
			timerFired = true;
			runtime.runners.cancel(profileId, started.runId).catch(() => null);
		}, parsed.options.timeoutMs);
		timeoutHandle.unref?.();
	}

	const detach = attachCancellation({ runtime, profileId, runId: started.runId, signal: io.abortSignal });
	let run;
	try {
		run = await runtime.runners.wait(profileId, started.runId);
	} catch (error) {
		detach?.();
		if (timeoutHandle) clearTimeout(timeoutHandle);
		const classified = classifyCliError(error);
		return emit(buildErrorReport({ error: classified, exitCode: classified.exitCode }));
	}
	detach?.();
	if (timeoutHandle) clearTimeout(timeoutHandle);

	const timedOut = timerFired && run.status !== "completed";
	const exitCode = timedOut ? EXIT_CODES.timeout : exitCodeForRun(run);
	return emit(
		buildRunReport({
			source,
			resolved,
			plan,
			run,
			exitCode,
			allowLocal: parsed.options.allowLocal,
			timeoutMs: parsed.options.timeoutMs,
			timedOut,
		}),
	);
}
