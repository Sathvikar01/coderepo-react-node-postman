// Rendering for the CLI: one stable JSON shape and one readable text shape.
//
// The JSON report is the machine contract. Its key order is fixed by
// construction, so two runs of the same project differ only in genuinely
// volatile values (ids, timestamps, durations). The human report is derived from
// the same report object, so the two formats can never disagree about an outcome.
//
// Reports never contain resolved secret values: secret references appear only as
// variable keys, and execution payloads are already redacted upstream.

import { CLI_NAME, CLI_VERSION } from "./cli-args.js";
import { EXIT_CODE_MEANINGS } from "./cli-exit.js";

export const REPORT_KIND = "tracer.cli-run";
export const REPORT_SCHEMA_VERSION = 1;

function publicPlan(plan) {
	if (!plan) return null;
	return {
		iterations: plan.iterations,
		requestCount: plan.requestCount,
		totalSteps: plan.totalSteps,
		steps: plan.steps.map((step) => ({
			index: step.index,
			iteration: step.iteration,
			requestId: step.requestId,
			name: step.name,
			method: step.method,
		})),
	};
}

export function buildRunReport({ source, resolved, plan, run, exitCode, allowLocal = [] }) {
	return {
		schemaVersion: REPORT_SCHEMA_VERSION,
		kind: REPORT_KIND,
		tool: { name: CLI_NAME, version: CLI_VERSION },
		project: { path: source.path, kind: source.kind, name: source.name, fingerprint: source.fingerprint },
		collection: { id: run.collection.id, name: run.collection.name, revision: run.collection.revision },
		environment: resolved.environment
			? { id: String(resolved.environment._id), name: resolved.environment.name, revision: resolved.environment.revision }
			: null,
		options: {
			selection: run.options.selection,
			selectionLabel: resolved.selectionLabel ?? null,
			iterations: run.options.iterations,
			stopOnFailure: run.options.stopOnFailure,
			variableKeys: run.options.variableKeys,
			allowLocal: [...allowLocal],
		},
		plan: publicPlan(plan),
		runId: run.runId,
		status: run.status,
		stopReason: run.stopReason,
		progress: run.progress,
		summary: run.summary,
		results: run.results ?? [],
		error: run.error ?? null,
		startedAt: run.startedAt ?? null,
		finishedAt: run.finishedAt ?? null,
		exitCode,
	};
}

export function buildPlanReport({ source, resolved, plan, options }) {
	return {
		schemaVersion: REPORT_SCHEMA_VERSION,
		kind: "tracer.cli-plan",
		tool: { name: CLI_NAME, version: CLI_VERSION },
		project: { path: source.path, kind: source.kind, name: source.name, fingerprint: source.fingerprint },
		collection: { id: resolved.collection._id ? String(resolved.collection._id) : null, name: resolved.collection.name, revision: resolved.collection.revision ?? null },
		environment: resolved.environment
			? { id: resolved.environment._id ? String(resolved.environment._id) : null, name: resolved.environment.name, revision: resolved.environment.revision ?? null }
			: null,
		options: {
			selection: resolved.selection,
			selectionLabel: resolved.selectionLabel ?? null,
			iterations: options.iterations,
			stopOnFailure: options.stopOnFailure,
			variableKeys: options.variables.map((variable) => variable.key),
			allowLocal: [...options.allowLocal],
		},
		plan: publicPlan(plan),
		exitCode: 0,
	};
}

export function buildErrorReport({ error, exitCode }) {
	return {
		schemaVersion: REPORT_SCHEMA_VERSION,
		kind: "tracer.cli-error",
		tool: { name: CLI_NAME, version: CLI_VERSION },
		status: exitCode === 2 ? "invalid" : "error",
		error: { code: error.code, message: error.message, details: error.details ?? null },
		exitCode,
	};
}

export function stringifyReport(report) {
	return `${JSON.stringify(report, null, 2)}\n`;
}

const STEP_MARKERS = {
	passed: "PASS",
	failed: "FAIL",
	cancelled: "CANCEL",
	skipped: "SKIP",
	running: "RUN",
	pending: "PEND",
};

function resultLine(step) {
	const marker = (STEP_MARKERS[step.status] ?? String(step.status).toUpperCase()).padEnd(6);
	const index = String(step.index).padStart(3, " ");
	const status = step.httpStatus === null || step.httpStatus === undefined ? "   " : String(step.httpStatus).padStart(3, " ");
	const duration = step.durationMs === null || step.durationMs === undefined ? "" : `${step.durationMs}ms`;
	const detail = step.failureReason ? `  ${step.failureReason}` : "";
	return `  ${marker} ${index}  iv${step.iteration} ${String(step.method ?? "").padEnd(6)} ${status} ${duration.padStart(7)}  ${step.name}${detail}`;
}

function summaryLine(report) {
	const summary = report.summary;
	if (!summary) return `Outcome: ${report.status} (no summary was recorded)`;
	const assertions = summary.assertions ?? { passed: 0, failed: 0, errors: 0 };
	return (
		`Outcome: ${summary.outcome} · ${summary.executed} executed of ${summary.total} · ` +
		`${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped · ` +
		`${summary.cancelled} cancelled · assertions ${assertions.passed}/${assertions.passed + assertions.failed + assertions.errors} passed`
	);
}

export function renderRunHuman(report) {
	const lines = [];
	lines.push(`${report.tool.name} ${report.tool.version} — collection run`);
	lines.push(`Project:     ${report.project.path} (${report.project.kind})`);
	lines.push(`Collection:  ${report.collection.name}`);
	lines.push(`Environment: ${report.environment ? report.environment.name : "none"}`);
	lines.push(`Selection:   ${report.options.selectionLabel ?? describeSelection(report.options.selection)}`);
	lines.push(`Iterations:  ${report.options.iterations}`);
	lines.push(`Failure:     ${report.options.stopOnFailure ? "stop at the first failure" : "continue after a failure"}`);
	if (report.options.allowLocal.length > 0) lines.push(`Local hosts: ${report.options.allowLocal.join(", ")}`);
	if (report.options.variableKeys.length > 0) lines.push(`Variables:   ${report.options.variableKeys.join(", ")} (values are never printed)`);
	lines.push("");
	for (const step of report.results) lines.push(resultLine(step));
	if (report.results.length > 0) lines.push("");
	lines.push(summaryLine(report));
	if (report.stopReason) lines.push(`Stop reason: ${report.stopReason}`);
	if (report.error) lines.push(`Error:       ${report.error.code} — ${report.error.message}`);
	lines.push(`Run id:      ${report.runId}`);
	lines.push(`Exit code:   ${report.exitCode} (${EXIT_CODE_MEANINGS[report.exitCode] ?? "unknown"})`);
	return `${lines.join("\n")}\n`;
}

export function renderPlanHuman(report) {
	const lines = [];
	lines.push(`${report.tool.name} ${report.tool.version} — run plan`);
	lines.push(`Project:     ${report.project.path} (${report.project.kind})`);
	lines.push(`Collection:  ${report.collection.name}`);
	lines.push(`Environment: ${report.environment ? report.environment.name : "none"}`);
	lines.push(`Selection:   ${report.options.selectionLabel ?? describeSelection(report.options.selection)}`);
	lines.push(`Iterations:  ${report.options.iterations}`);
	lines.push(`Failure:     ${report.options.stopOnFailure ? "stop at the first failure" : "continue after a failure"}`);
	if (report.options.variableKeys.length > 0) lines.push(`Variables:   ${report.options.variableKeys.join(", ")} (values are never printed)`);
	lines.push("");
	lines.push(`Steps:       ${report.plan.totalSteps} (${report.plan.requestCount} request(s) × ${report.plan.iterations} iteration(s))`);
	for (const step of report.plan.steps) {
		lines.push(`  ${String(step.index).padStart(3, " ")}  iv${step.iteration}  ${String(step.method).padEnd(6)}  ${step.name}`);
	}
	lines.push("");
	lines.push("No requests were sent (plan mode).");
	return `${lines.join("\n")}\n`;
}

export function renderErrorHuman(report) {
	const lines = [`${report.tool.name} ${report.tool.version} — error`];
	lines.push(`${report.error.code}: ${report.error.message}`);
	if (report.error.details && Object.keys(report.error.details).length > 0)
		lines.push(`Details: ${JSON.stringify(report.error.details)}`);
	lines.push(`Exit code: ${report.exitCode} (${EXIT_CODE_MEANINGS[report.exitCode] ?? "unknown"})`);
	return `${lines.join("\n")}\n`;
}

function describeSelection(selection) {
	if (!selection) return "whole collection";
	if (selection.mode === "folder") return `folder ${selection.folderId}`;
	if (selection.mode === "requests") return `${selection.requestIds.length} selected request(s)`;
	return "whole collection";
}
