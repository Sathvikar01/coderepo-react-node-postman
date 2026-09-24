import { describe, expect, it } from "bun:test";
import { initConfig } from "../../shared/config/index.js";

// planRehearsal reuses the history fingerprint HMAC key, so the suite
// initializes config once like the 46A suite does. No database, no network.
process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase46_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase46-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase46-test-jwt-secret";
initConfig();

import { planRehearsal } from "../rehearsal-planning/index.js";
import { STEP_STATES as CHECKPOINT_STEP_STATES } from "../rehearsal-checkpoints/index.js";
import {
	CONTRACT_STATUS,
	EXECUTOR_ERROR_CODES,
	EXECUTOR_LIMITS,
	EXECUTOR_STOP_REASONS,
	parseDeadline,
	parseExecutorInput,
} from "./executor-schema.js";
import { deriveRunBinding, stepByRequestId } from "./step-plan.js";
import {
	EXECUTION_OUTCOMES,
	buildContractAssertion,
	buildOutcomeId,
	buildStepMetadata,
	classifyExecution,
	isKnownOutcome,
	mapAbortReasonCode,
	toObservedResponse,
} from "./outcome-mapping.js";
import { buildExecutionEvidence, createEvidenceRecorder } from "./evidence-recorder.js";
import { createRehearsalExecutor } from "./rehearsal-executor.service.js";

const WORKSPACE_ID = "ws-46c";
const SNAPSHOT_ID = "snap-46c";
const SNAPSHOT_FP = "fp-snapshot-46c";
const SOURCE_ENV = "env-local";
const TARGET_ENV = "env-staging";
const ENV_FP = "env-fingerprint-46c";
const POLICY_IDENTITY = "policy-identity-46c";
const PROFILE = "profile-46c";

function impactResult({ direct = [], indirect = [] } = {}) {
	const toRow = (requestId) => ({ requestId, nodeKind: "request", collectionId: "col-1" });
	return {
		kind: "tracer.change-impact",
		schemaVersion: 1,
		resolved: true,
		truncated: false,
		summary: { directRequests: direct.length, indirectRequests: indirect.length, unknownReferences: 0 },
		requests: {
			direct: direct.map((id) => ({ ...toRow(id), impact: "direct", hop: 1, confidence: "exact" })),
			indirect: indirect.map((id) => ({ ...toRow(id), impact: "indirect", hop: 2, confidence: "exact" })),
		},
		unknown: [],
	};
}

function driftResult() {
	const drift = [{ category: "VARIABLE_CHANGED", path: "variables.baseUrl", severity: "high", status: "confirmed" }];
	return {
		kind: "tracer.environment-drift",
		schemaVersion: 1,
		source: { environmentId: SOURCE_ENV, name: "local", revision: 1 },
		target: { environmentId: TARGET_ENV, name: "staging", revision: 2 },
		identical: false,
		summary: { total: 1, byCategory: { VARIABLE_CHANGED: 1 }, bySeverity: { high: 1 } },
		drift,
	};
}

function blastRadiusResult(decisions) {
	const entries = Object.entries(decisions).map(([requestId, decision]) => ({
		requestId,
		host: decision.host ?? "api.test",
		hostKey: decision.hostKey ?? "api.test",
		port: decision.port ?? null,
		method: decision.method ?? "GET",
		classification: decision.classification ?? "NON_MUTATING",
		mutating: decision.mutating === true,
		admission: decision.admission,
		reasonCodes: decision.reasonCodes ?? [],
	}));
	const byState = (state) => entries.filter((entry) => entry.admission === state);
	return {
		kind: "tracer.blast-radius-envelope",
		version: 1,
		policy: { kind: "tracer.blast-radius-policy", version: 1, identity: POLICY_IDENTITY },
		workspace: { workspaceId: WORKSPACE_ID, snapshotId: SNAPSHOT_ID },
		environment: { environmentId: SOURCE_ENV, targetEnvironmentId: TARGET_ENV },
		admissionState: "ADMITTED",
		requests: {
			proposed: entries.length,
			admitted: byState("ADMITTED").length,
			blocked: byState("BLOCKED").length,
			unknown: byState("UNKNOWN").length,
			requiresConfirmation: byState("REQUIRES_CONFIRMATION").length,
		},
		allowedRequests: byState("ADMITTED"),
		blockedRequests: byState("BLOCKED"),
		unknownRequests: byState("UNKNOWN"),
		confirmationRequests: byState("REQUIRES_CONFIRMATION"),
	};
}

function planInput(requestIds = ["r1", "r2"]) {
	const decisions = {};
	for (const requestId of requestIds) decisions[requestId] = { admission: "ADMITTED" };
	return {
		workspaceId: WORKSPACE_ID,
		snapshot: { snapshotId: SNAPSHOT_ID, snapshotFingerprint: SNAPSHOT_FP },
		source: { environmentId: SOURCE_ENV, snapshotFingerprint: SNAPSHOT_FP },
		target: { environmentId: TARGET_ENV, snapshotFingerprint: SNAPSHOT_FP },
		impact: impactResult({ direct: requestIds }),
		drift: driftResult(),
		blastRadius: blastRadiusResult(decisions),
		candidates: requestIds.map((requestId) => ({ requestId, collectionId: "col-1", host: "api.test", method: "GET" })),
	};
}

function buildPlan(requestIds = ["r1", "r2"]) {
	const input = planInput(requestIds);
	const plan = planRehearsal(input);
	return { plan, blastRadius: input.blastRadius };
}

function executorInput(overrides = {}) {
	const { plan, blastRadius } = buildPlan();
	return {
		plan,
		blastRadius,
		environment: { environmentId: TARGET_ENV, environmentFingerprint: ENV_FP, environmentName: "staging" },
		...overrides,
	};
}

function okResponse(status = 200) {
	return {
		outcome: "response",
		response: {
			status,
			headers: [{ name: "content-type", value: "application/json" }],
			body: { encoding: "text", value: JSON.stringify({ ok: status < 400 }) },
			timing: { totalMs: 5 },
		},
		startedAt: new Date("2026-09-24T00:00:00.000Z"),
		finishedAt: new Date("2026-09-24T00:00:01.000Z"),
	};
}

// Minimal in-memory twin of the 46B checkpoint service surface the executor uses.
// No persistence, no CAS races: single worker, deterministic generation.
function createFakeCheckpoints() {
	const runs = new Map();
	const calls = { checkpointStep: 0, completeRun: 0, pauseRun: 0, abortRun: 0, failRun: 0, beginStep: 0, releaseStep: 0 };
	function stored(runId) {
		const run = runs.get(runId);
		if (!run) throw new Error(`missing run ${runId}`);
		return run;
	}
	return {
		calls,
		runs,
		async ensureRun(_profileId, { runId, identity, plan }) {
			let run = runs.get(runId);
			if (!run) {
				run = {
					runId,
					kind: "tracer.rehearsal-checkpoint",
					schemaVersion: 1,
					runState: "RUNNING",
					generation: 1,
					owner: null,
					lastOwnerGeneration: null,
					identity,
					identityFingerprint: "fp-fake",
					plan: { steps: plan.steps.map((s) => ({ stepId: s.stepId })) },
					stepStates: plan.steps.map((s) => ({ stepId: s.stepId, state: "PENDING" })),
					completedStepIds: [],
					pendingStepIds: plan.steps.map((s) => s.stepId),
					terminalReasonCode: null,
					terminalReason: null,
				};
				runs.set(runId, run);
				return { created: true, run };
			}
			return { created: false, run };
		},
		async resumeRun(_profileId, runId, { owner }) {
			const run = stored(runId);
			run.generation += 1;
			run.owner = owner;
			run.lastOwnerGeneration = run.generation;
			run.runState = "RUNNING";
			const done = new Set(
				run.stepStates
					.filter((s) => s.state === CHECKPOINT_STEP_STATES.COMPLETED || s.state === CHECKPOINT_STEP_STATES.SKIPPED)
					.map((s) => s.stepId),
			);
			const pendingStepIds = run.plan.steps.map((s) => s.stepId).filter((id) => !done.has(id));
			run.pendingStepIds = pendingStepIds;
			return { run, pendingStepIds };
		},
		async checkpointStep(_profileId, runId, { stepId, state, outcome }) {
			calls.checkpointStep += 1;
			const run = stored(runId);
			const entry = run.stepStates.find((s) => s.stepId === stepId);
			entry.state = state;
			entry.completion = { metadata: outcome?.metadata ?? {} };
			if (!run.completedStepIds.includes(stepId)) run.completedStepIds.push(stepId);
			return { run };
		},
		// Mirror the real service's in-flight marker semantics: PENDING -> IN_PROGRESS
		// before dispatch, IN_PROGRESS -> PENDING on release.
		async beginStep(_profileId, runId, { stepId, generation }) {
			calls.beginStep += 1;
			const run = stored(runId);
			const entry = run.stepStates.find((s) => s.stepId === stepId);
			if (entry.state === CHECKPOINT_STEP_STATES.IN_PROGRESS && entry.attempt?.ownerGeneration === generation) return { run, idempotent: true, stepId };
			if (entry.state !== CHECKPOINT_STEP_STATES.PENDING) {
				const error = new Error(`step ${stepId} is ${entry.state}`);
				error.code = "REHEARSAL_CHECKPOINT_STEP_NOT_PENDING";
				throw error;
			}
			entry.state = CHECKPOINT_STEP_STATES.IN_PROGRESS;
			entry.attempt = { attempts: (entry.attempt?.attempts ?? 0) + 1, ownerGeneration: generation, evidenceRefs: [] };
			return { run, idempotent: false, stepId };
		},
		async releaseStep(_profileId, runId, { stepId }) {
			calls.releaseStep += 1;
			const run = stored(runId);
			const entry = run.stepStates.find((s) => s.stepId === stepId);
			if (entry.state === CHECKPOINT_STEP_STATES.PENDING) return { run, idempotent: true, stepId };
			if (entry.state !== CHECKPOINT_STEP_STATES.IN_PROGRESS) {
				const error = new Error(`step ${stepId} is ${entry.state}`);
				error.code = "REHEARSAL_CHECKPOINT_STEP_NOT_PENDING";
				throw error;
			}
			entry.state = CHECKPOINT_STEP_STATES.PENDING;
			return { run, idempotent: false, stepId };
		},
		async completeRun(_profileId, runId) {
			calls.completeRun += 1;
			const run = stored(runId);
			run.runState = "COMPLETED";
			return run;
		},
		async pauseRun(_profileId, runId) {
			calls.pauseRun += 1;
			const run = stored(runId);
			run.runState = "PAUSED";
			return run;
		},
		async abortRun(_profileId, runId) {
			calls.abortRun += 1;
			const run = stored(runId);
			run.runState = "ABORTED";
			return run;
		},
		async failRun(_profileId, runId, input = {}) {
			calls.failRun += 1;
			const run = stored(runId);
			run.runState = "FAILED";
			run.terminalReasonCode = input.reasonCode ?? null;
			return run;
		},
	};
}

const continueEvaluator = () => ({ decision: "CONTINUE", reasonCodes: [] });

describe("executor input contract", () => {
	it("rejects a missing plan and a missing blast-radius envelope", () => {
		const base = executorInput();
		expect(() => parseExecutorInput({ ...base, plan: null })).toThrow();
		try {
			parseExecutorInput({ ...base, plan: null });
		} catch (error) {
			expect(error.code).toBe(EXECUTOR_ERROR_CODES.MISSING_PLAN);
		}
		try {
			parseExecutorInput({ ...base, blastRadius: null });
		} catch (error) {
			expect(error.code).toBe(EXECUTOR_ERROR_CODES.BLAST_RADIUS_MISSING);
		}
	});

	it("fails closed on an unparseable deadline", () => {
		expect(parseDeadline(null)).toBeNull();
		expect(parseDeadline(new Date("2026-09-24T00:00:00.000Z"))).toBeGreaterThan(0);
		expect(() => parseDeadline("not-a-date")).toThrow();
		expect(() => parseDeadline(Number.NaN)).toThrow();
	});

	it("caps maxSteps at the executor limit", () => {
		const parsed = parseExecutorInput(executorInput({ maxSteps: 999999 }));
		expect(parsed.maxSteps).toBe(EXECUTOR_LIMITS.maxSteps);
	});
});

describe("run binding derivation", () => {
	it("derives identity and checkpoint plan from the exact 46A plan", () => {
		const { plan, blastRadius } = buildPlan(["r1", "r2"]);
		const binding = deriveRunBinding({
			plan,
			blastRadius,
			environment: { environmentId: TARGET_ENV, environmentFingerprint: ENV_FP },
		});
		expect(binding.planFingerprint).toBe(plan.identity.planFingerprint);
		expect(binding.executableSteps).toHaveLength(2);
		expect(binding.checkpointPlan.steps.map((s) => s.stepId)).toHaveLength(2);
		expect(binding.identity.workspaceId).toBe(WORKSPACE_ID);
		expect(stepByRequestId(binding, "r1")?.requestId).toBe("r1");
		expect(stepByRequestId(binding, "missing")).toBeNull();
	});

	it("refuses a caller environment that is not the plan target", () => {
		const { plan, blastRadius } = buildPlan();
		expect(() =>
			deriveRunBinding({
				plan,
				blastRadius,
				environment: { environmentId: "env-elsewhere", environmentFingerprint: ENV_FP },
			}),
		).toThrow();
		try {
			deriveRunBinding({
				plan,
				blastRadius,
				environment: { environmentId: "env-elsewhere", environmentFingerprint: ENV_FP },
			});
		} catch (error) {
			expect(error.code).toBe(EXECUTOR_ERROR_CODES.IDENTITY_MISMATCH);
		}
	});

	it("refuses a blast-radius envelope evaluated for another workspace", () => {
		const { plan } = buildPlan();
		const foreign = blastRadiusResult({ r1: { admission: "ADMITTED" }, r2: { admission: "ADMITTED" } });
		foreign.workspace.workspaceId = "ws-foreign";
		try {
			deriveRunBinding({ plan, blastRadius: foreign, environment: { environmentId: TARGET_ENV, environmentFingerprint: ENV_FP } });
			expect.unreachable();
		} catch (error) {
			expect(error.code).toBe(EXECUTOR_ERROR_CODES.BLAST_RADIUS_MISMATCH);
		}
	});

	it("refuses a non-admitted executable step even when the plan claims it", () => {
		const { plan } = buildPlan();
		const partial = blastRadiusResult({ r1: { admission: "ADMITTED" }, r2: { admission: "BLOCKED" } });
		try {
			deriveRunBinding({ plan, blastRadius: partial, environment: { environmentId: TARGET_ENV, environmentFingerprint: ENV_FP } });
			expect.unreachable();
		} catch (error) {
			expect(error.code).toBe(EXECUTOR_ERROR_CODES.STEP_NOT_ADMITTED);
		}
	});
});

describe("outcome mapping", () => {
	it("covers the known execution vocabulary", () => {
		expect(EXECUTION_OUTCOMES).toContain("response");
		for (const outcome of EXECUTION_OUTCOMES) expect(isKnownOutcome(outcome)).toBe(true);
		expect(isKnownOutcome("hallucinated")).toBe(false);
	});

	it("treats error statuses as failures for the abort policy", () => {
		expect(classifyExecution(okResponse(200))).toBe("success");
		expect(classifyExecution(okResponse(500))).toBe("failure");
		expect(classifyExecution({ outcome: "timeout" })).toBe("failure");
		expect(classifyExecution({ outcome: "network_error" })).toBe("error");
		expect(classifyExecution({ outcome: "cancelled" })).toBe("canceled");
	});

	it("builds bounded credential-free step metadata", () => {
		const metadata = buildStepMetadata(okResponse(200), { contractStatus: CONTRACT_STATUS.ABSENT });
		expect(metadata.outcome).toBe("response");
		expect(metadata.httpStatus).toBe(200);
		expect(metadata.contractStatus).toBe(CONTRACT_STATUS.ABSENT);
		expect(JSON.stringify(metadata)).not.toMatch(/password|secret|token/i);
	});

	it("keeps outcome ids short and deterministic", () => {
		expect(buildOutcomeId("s1", "response")).toBe("s1:response");
		expect(buildOutcomeId("s1", "response")).toBe(buildOutcomeId("s1", "response"));
		expect(buildOutcomeId("s".repeat(200), "response").length).toBeLessThanOrEqual(48);
	});

	it("projects only trustworthy bodies for contract comparison", () => {
		const { status, response } = toObservedResponse(okResponse(200), { requestId: "r1" });
		expect(status).toBe(CONTRACT_STATUS.COMPARED);
		expect(response.status).toBe(200);
		expect(toObservedResponse({ outcome: "timeout" }).status).toBe(CONTRACT_STATUS.SKIPPED_NO_RESPONSE);
		expect(toObservedResponse({ outcome: "response", response: { status: 200, body: null } }).status).toBe(
			CONTRACT_STATUS.SKIPPED_NO_BODY,
		);
	});

	it("maps abort causes onto the checkpoint vocabulary with a safe fallback", () => {
		expect(mapAbortReasonCode(["FAILURE_LIMIT_REACHED"])).toBe("FAILURE_LIMIT_REACHED");
		expect(mapAbortReasonCode(["CRITICAL_FAILURE"])).toBe("BLAST_RADIUS_LIMIT");
		expect(mapAbortReasonCode(["something-new"])).toBe("BLAST_RADIUS_LIMIT");
	});

	it("never fabricates a passing contract assertion", () => {
		const pass = buildContractAssertion({ executionId: "e1", requestId: "r1", compatible: true });
		const fail = buildContractAssertion({ executionId: "e1", requestId: "r1", compatible: false });
		expect(pass.status).toBe("passed");
		expect(fail.status).toBe("failed");
		expect(pass.required).toBe(true);
	});
});

describe("evidence recorder", () => {
	it("accumulates executions, assertions, and step outcomes without invention", () => {
		const recorder = createEvidenceRecorder();
		expect(recorder.projection()).toEqual({ executions: [], assertions: [] });
		recorder.recordExecution(buildExecutionEvidence(okResponse(200), { executionId: "e1", requestId: "r1" }));
		recorder.recordAssertion(buildContractAssertion({ executionId: "e1", requestId: "r1", compatible: true }));
		recorder.recordStepOutcome({ stepId: "s1", outcome: "response" });
		expect(recorder.projection().executions).toHaveLength(1);
		expect(recorder.projection().assertions).toHaveLength(1);
		expect(recorder.stepOutcomes()).toHaveLength(1);
		expect(recorder.hasOverflowed()).toBe(false);
	});

	it("flags overflow instead of silently truncating evidence", () => {
		const recorder = createEvidenceRecorder({ maxStepOutcomes: 1, maxReasonCodes: 1 });
		recorder.recordExecution({ executionId: "e1" });
		recorder.recordExecution({ executionId: "e2" });
		recorder.addReasonCode("A");
		recorder.addReasonCode("B");
		expect(recorder.hasOverflowed()).toBe(true);
		expect(recorder.projection().executions).toHaveLength(1);
	});

	it("dedupes reason codes", () => {
		const recorder = createEvidenceRecorder();
		recorder.addReasonCode("X");
		recorder.addReasonCode("X");
		expect(recorder.reasonCodes()).toEqual(["X"]);
	});
});

describe("rehearsal executor", () => {
	it("runs every eligible step through the existing execution path and completes", async () => {
		const checkpoints = createFakeCheckpoints();
		const sent = [];
		const executor = createRehearsalExecutor({
			checkpoints,
			executions: {
				send: async (_profileId, req) => {
					sent.push(req);
					return okResponse(200);
				},
			},
			contractCompatibility: { compare: () => ({ compatible: true, summary: { total: 0, breaking: 0, nonBreaking: 0, unknown: 0 } }) },
			verify: null,
			abortEvaluator: continueEvaluator,
			newExecutionId: (() => {
				let n = 0;
				return () => `exec-${(n += 1)}`;
			})(),
		});
		const report = await executor.run(PROFILE, executorInput());
		expect(report.stopReason).toBe(EXECUTOR_STOP_REASONS.COMPLETED);
		expect(report.runState).toBe("COMPLETED");
		expect(report.executedStepIds).toHaveLength(2);
		expect(sent).toHaveLength(2);
		// One ordinary execution per step through the same path the app uses.
		expect(sent[0].context.requestId).toBe("r1");
		expect(report.evidence.executions).toHaveLength(2);
		expect(checkpoints.calls.checkpointStep).toBe(2);
		expect(checkpoints.calls.completeRun).toBe(1);
	});

	it("never re-executes completed work on resume", async () => {
		const checkpoints = createFakeCheckpoints();
		let sends = 0;
		const executor = createRehearsalExecutor({
			checkpoints,
			executions: { send: async () => ({ ...(sends += 1), ...okResponse(200) }) },
			abortEvaluator: continueEvaluator,
			newExecutionId: (() => {
				let n = 0;
				return () => `exec-${(n += 1)}`;
			})(),
		});
		const input = executorInput();
		const first = await executor.run(PROFILE, input);
		expect(first.executedStepIds).toHaveLength(2);
		const second = await executor.run(PROFILE, input);
		expect(second.stopReason).toBe(EXECUTOR_STOP_REASONS.TERMINAL);
		expect(second.executedStepIds).toHaveLength(0);
		expect(sends).toBe(2);
	});

	it("stops immediately on a blast-radius abort without completing", async () => {
		const checkpoints = createFakeCheckpoints();
		const executor = createRehearsalExecutor({
			checkpoints,
			executions: { send: async () => okResponse(500) },
			abortEvaluator: () => ({ decision: "ABORT", reasonCodes: ["FAILURE_LIMIT_REACHED"] }),
			newExecutionId: () => "exec-abort",
		});
		const report = await executor.run(PROFILE, executorInput());
		expect(report.stopReason).toBe(EXECUTOR_STOP_REASONS.BLAST_RADIUS_ABORT);
		expect(report.runState).toBe("ABORTED");
		expect(report.executedStepIds).toHaveLength(1);
		expect(checkpoints.calls.abortRun).toBe(1);
	});

	it("pauses on cancellation instead of checkpointing unfinished work", async () => {
		const checkpoints = createFakeCheckpoints();
		const executor = createRehearsalExecutor({
			checkpoints,
			executions: { send: async () => ({ outcome: "cancelled" }) },
			abortEvaluator: continueEvaluator,
			newExecutionId: () => "exec-cancel",
		});
		const report = await executor.run(PROFILE, executorInput());
		expect(report.stopReason).toBe(EXECUTOR_STOP_REASONS.CANCELLED);
		expect(checkpoints.calls.checkpointStep).toBe(0);
		expect(checkpoints.calls.pauseRun).toBe(1);
		// The in-flight claim is released, so a resume may safely re-run the step.
		expect(checkpoints.calls.releaseStep).toBe(1);
		const run = [...checkpoints.runs.values()][0];
		expect(run.stepStates.find((s) => s.stepId === "step:r1").state).toBe(CHECKPOINT_STEP_STATES.PENDING);
	});

	it("fails closed instead of replaying a step whose remote side effect is in doubt", async () => {
		const checkpoints = createFakeCheckpoints();
		const sent = [];
		const originalCheckpointStep = checkpoints.checkpointStep;
		let crashOnce = true;
		checkpoints.checkpointStep = async (...args) => {
			if (crashOnce) {
				crashOnce = false;
				// Simulate the process dying after the remote request returned but before
				// the checkpoint write landed: the step stays IN_PROGRESS.
				throw new Error("simulated crash between remote execution and checkpoint");
			}
			return originalCheckpointStep(...args);
		};
		const send = async (_profileId, request) => {
			sent.push(request.context.requestId);
			return okResponse(200);
		};

		const first = createRehearsalExecutor({ checkpoints, executions: { send }, abortEvaluator: continueEvaluator, newExecutionId: () => "exec-crash" });
		await expect(first.run(PROFILE, executorInput())).rejects.toThrow();

		const crashedRun = [...checkpoints.runs.values()][0];
		expect(crashedRun.stepStates.find((s) => s.stepId === "step:r1").state).toBe(CHECKPOINT_STEP_STATES.IN_PROGRESS);
		expect(sent).toEqual(["r1"]);

		// Resume in a fresh worker (simulating a restart after the crash).
		const second = createRehearsalExecutor({ checkpoints, executions: { send }, abortEvaluator: continueEvaluator, newExecutionId: () => "exec-resume" });
		const report = await second.run(PROFILE, executorInput());

		// The possibly-mutating request is NOT replayed, and no false completion is claimed.
		expect(sent).toEqual(["r1"]);
		expect(report.stopReason).toBe(EXECUTOR_STOP_REASONS.EXECUTION_ERROR);
		expect(report.runState).toBe("FAILED");
		expect(report.reasonCodes).toContain(EXECUTOR_ERROR_CODES.EXECUTION_FAILED);
		expect(report.run.terminalReasonCode).toBe("STEP_IN_DOUBT");
		expect(report.executedStepIds).toHaveLength(0);
		expect(report.completedStepIds).not.toContain("step:r1");
	});

	it("fails closed on an unknown execution outcome", async () => {
		const checkpoints = createFakeCheckpoints();
		const executor = createRehearsalExecutor({
			checkpoints,
			executions: { send: async () => ({ outcome: "teleportation" }) },
			abortEvaluator: continueEvaluator,
			newExecutionId: () => "exec-unknown",
		});
		const report = await executor.run(PROFILE, executorInput());
		expect(report.stopReason).toBe(EXECUTOR_STOP_REASONS.EXECUTION_ERROR);
		expect(report.runState).toBe("FAILED");
	});

	it("fails closed when a scratch step cannot be resolved", async () => {
		const checkpoints = createFakeCheckpoints();
		const { plan, blastRadius } = buildPlan(["r1"]);
		// Scratch step: no collection to resolve against and no resolver supplied.
		plan.steps[0].collectionId = null;
		const executor = createRehearsalExecutor({
			checkpoints,
			executions: {
				send: async () => {
					throw new Error("must not send an unresolved step");
				},
			},
			abortEvaluator: continueEvaluator,
		});
		const input = executorInput({ plan, blastRadius });
		delete input.resolveRequest;
		const report = await executor.run(PROFILE, input);
		expect(report.stopReason).toBe(EXECUTOR_STOP_REASONS.EXECUTION_ERROR);
		expect(report.runState).toBe("FAILED");
	});

	it("resolves scratch steps through the caller-supplied request", async () => {
		const checkpoints = createFakeCheckpoints();
		const { plan, blastRadius } = buildPlan(["r1"]);
		plan.steps[0].collectionId = null;
		let resolved = false;
		const executor = createRehearsalExecutor({
			checkpoints,
			executions: { send: async () => okResponse(200) },
			abortEvaluator: continueEvaluator,
			newExecutionId: () => "exec-scratch",
		});
		const report = await executor.run(
			PROFILE,
			executorInput({
				plan,
				blastRadius,
				resolveRequest: async () => {
					resolved = true;
					return { method: "GET", url: "https://api.test/r1" };
				},
			}),
		);
		expect(resolved).toBe(true);
		expect(report.stopReason).toBe(EXECUTOR_STOP_REASONS.COMPLETED);
	});

	it("records no contract assertion when no contract is comparable", async () => {
		const checkpoints = createFakeCheckpoints();
		const executor = createRehearsalExecutor({
			checkpoints,
			executions: { send: async () => okResponse(200) },
			abortEvaluator: continueEvaluator,
			newExecutionId: () => "exec-nocontract",
		});
		const report = await executor.run(PROFILE, executorInput());
		expect(report.evidence.assertions).toHaveLength(0);
		expect(report.stepOutcomes[0].contractStatus).toBe(CONTRACT_STATUS.ABSENT);
	});

	it("honours a per-invocation step budget and pauses", async () => {
		const checkpoints = createFakeCheckpoints();
		const executor = createRehearsalExecutor({
			checkpoints,
			executions: { send: async () => okResponse(200) },
			abortEvaluator: continueEvaluator,
			newExecutionId: (() => {
				let n = 0;
				return () => `exec-${(n += 1)}`;
			})(),
		});
		const report = await executor.run(PROFILE, executorInput({ maxSteps: 1 }));
		expect(report.stopReason).toBe(EXECUTOR_STOP_REASONS.STEP_BUDGET);
		expect(report.executedStepIds).toHaveLength(1);
		expect(checkpoints.calls.pauseRun).toBe(1);
	});
});
