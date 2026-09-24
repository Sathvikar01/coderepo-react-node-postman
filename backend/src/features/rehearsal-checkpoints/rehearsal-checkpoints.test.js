import { beforeAll, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { AppError } from "../../shared/errors/app-error.js";
import {
	RUN_STATES,
	STEP_STATES,
	CHECKPOINT_ERROR_CODES as CODES,
} from "./reason-codes.js";
import {
	canTransition,
	canRequestTransition,
	assertTransition,
	isTerminalRunState,
	pendingSteps,
	allStepsTerminal,
} from "./run-lifecycle.js";
import {
	identityFingerprint,
	identityDifferences,
	identitiesMatch,
	canonicalizeJson,
} from "./run-identity.js";
import { checkpointCanonicalForm, checkpointFingerprint, stepCompletionFingerprint, derivedPointers } from "./checkpoint-canonical.js";
import { createRehearsalCheckpointService } from "./rehearsal-checkpoint.service.js";

// Phase 46B — focused checkpoint-core tests.
//
// These exercise the semantics against an in-memory repository that implements the
// same CAS filters as the Mongo repository. They run without a database, so they
// are the fast, deterministic proof of lifecycle, identity, generation, and
// exactly-once behaviour. The Mongo-backed tests in the sibling
// `.persistence.test.js` prove the same guarantees against real atomic operations.

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_p46b_unit_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase46b-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase46b-test-jwt-secret";
initConfig();

// ---------------------------------------------------------------------------
// In-memory repository with the same CAS contract as the Mongo one
// ---------------------------------------------------------------------------

function clone(value) {
	return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

function createMemoryRepository(clock = () => new Date()) {
	const rows = new Map();
	const key = (profileId, runId) => `${profileId}::${runId}`;
	let sequence = 0;

	function active(row) {
		return ["CREATED", "RUNNING", "PAUSED"].includes(row.runState);
	}

	return {
		rows,
		async insertRun(document) {
			const rowKey = key(document.ownerProfileId, document.runId);
			if (rows.has(rowKey)) {
				const error = new Error("duplicate key");
				error.code = 11000;
				throw error;
			}
			sequence += 1;
			const row = { ...clone(document), _id: `mem_${sequence}`, createdAt: clock(), updatedAt: clock() };
			rows.set(rowKey, row);
			return clone(row);
		},
		async findByRunId(profileId, runId) {
			return clone(rows.get(key(profileId, runId)));
		},
		async findById(profileId, id) {
			return clone([...rows.values()].find((row) => row.ownerProfileId === profileId && row._id === id));
		},
		async listForProfile(profileId, { runState } = {}) {
			return [...rows.values()]
				.filter((row) => row.ownerProfileId === profileId && (!runState || row.runState === runState))
				.map(clone);
		},
		async listResumable(profileId) {
			return [...rows.values()].filter((row) => row.ownerProfileId === profileId && active(row)).map(clone);
		},
		async claim(profileId, runId, { from, owner, toState }) {
			const row = rows.get(key(profileId, runId));
			if (!row || row.generation !== from || !active(row)) return null;
			row.generation += 1;
			row.owner = owner;
			row.lastOwnerGeneration = row.generation;
			if (toState) row.runState = toState;
			row.updatedAt = clock();
			return clone(row);
		},
		async checkpointStep(profileId, runId, { generation, owner, stepId, fromStepStates, changes }) {
			const row = rows.get(key(profileId, runId));
			if (!row || row.generation !== generation || row.owner !== owner) return null;
			if (!["CREATED", "RUNNING"].includes(row.runState)) return null;
			const step = row.stepStates.find((entry) => entry.stepId === stepId);
			if (!step || !fromStepStates.includes(step.state)) return null;
			step.state = changes.stepState;
			step.completion = clone(changes.completion);
			step.attempt = clone(changes.attempt);
			step.lastReasonCode = changes.lastReasonCode ?? null;
			// Derived fields are computed from the step array *after* the change, exactly
			// as the Mongo aggregation-pipeline write does, so a concurrent checkpoint of a
			// different step cannot have its progress erased by a stale list.
			row.completedStepIds = row.stepStates
				.filter((entry) => ["COMPLETED", "SKIPPED"].includes(entry.state))
				.map((entry) => entry.stepId)
				.sort();
			const remaining = row.plan.steps.find((planStep) => !row.completedStepIds.includes(planStep.stepId));
			row.nextStepId = remaining ? remaining.stepId : null;
			const active = row.stepStates.find((entry) => entry.state === "IN_PROGRESS");
			row.currentStepId = active ? active.stepId : null;
			row.lastOwnerGeneration = generation;
			row.updatedAt = clock();
			return clone(row);
		},
		async markTerminal(profileId, runId, { generation, owner, fromStates, toState, fields }) {
			const row = rows.get(key(profileId, runId));
			if (!row || row.generation !== generation || row.owner !== owner) return null;
			if (!fromStates.includes(row.runState)) return null;
			row.runState = toState;
			Object.assign(row, clone(fields));
			row.lastOwnerGeneration = generation;
			row.updatedAt = clock();
			return clone(row);
		},
		async pause(profileId, runId, { generation, owner }) {
			const row = rows.get(key(profileId, runId));
			if (!row || row.generation !== generation || row.owner !== owner || row.runState !== "RUNNING") return null;
			row.runState = "PAUSED";
			row.updatedAt = clock();
			return clone(row);
		},
		async findOwnership(profileId, runId) {
			const row = rows.get(key(profileId, runId));
			return row ? clone(row) : null;
		},
		async deleteRun(profileId, runId) {
			const rowKey = key(profileId, runId);
			const row = rows.get(rowKey);
			rows.delete(rowKey);
			return clone(row);
		},
		async deleteTerminalBefore(profileId, cutoff) {
			let deletedCount = 0;
			for (const [rowKey, row] of [...rows.entries()]) {
				if (row.ownerProfileId !== profileId) continue;
				if (!["COMPLETED", "ABORTED", "FAILED"].includes(row.runState)) continue;
				if (row.updatedAt < cutoff) {
					rows.delete(rowKey);
					deletedCount += 1;
				}
			}
			return { deletedCount };
		},
		async countForProfile(profileId) {
			return [...rows.values()].filter((row) => row.ownerProfileId === profileId).length;
		},
		async countByState(profileId) {
			const counts = new Map();
			for (const row of rows.values()) {
				if (row.ownerProfileId !== profileId) continue;
				counts.set(row.runState, (counts.get(row.runState) ?? 0) + 1);
			}
			return [...counts.entries()].map(([state, count]) => ({ _id: state, count }));
		},
		async deleteAllForProfile(profileId) {
			let deletedCount = 0;
			for (const [rowKey, row] of [...rows.entries()]) {
				if (row.ownerProfileId === profileId) {
					rows.delete(rowKey);
					deletedCount += 1;
				}
			}
			return { deletedCount };
		},
	};
}

const PROFILE = "64b00000000000000000a001";
const WORKSPACE = "64b00000000000000000b001";
const ENVIRONMENT = "64b00000000000000000c001";
const SNAPSHOT = "64b00000000000000000d001";
const PLAN = "64b00000000000000000e001";

function identity(overrides = {}) {
	return {
		workspaceId: WORKSPACE,
		snapshotId: SNAPSHOT,
		snapshotFingerprint: "a".repeat(64),
		targetEnvironment: { environmentId: ENVIRONMENT, environmentFingerprint: "b".repeat(64) },
		planId: PLAN,
		planFingerprint: "c".repeat(64),
		...overrides,
	};
}

function planOf(...stepIds) {
	return { steps: stepIds.map((stepId) => ({ stepId })) };
}

let service;
let repository;

beforeAll(() => {
	repository = createMemoryRepository(() => new Date("2026-09-24T00:00:00.000Z"));
	service = createRehearsalCheckpointService({
		repository,
		now: () => new Date("2026-09-24T00:00:00.000Z"),
	});
});

async function freshRun(runId, options = {}) {
	return service.createRun(PROFILE, {
		runId,
		identity: options.identity ?? identity(),
		plan: options.plan ?? planOf("s1", "s2", "s3"),
	});
}

async function expectAppError(promise, expected) {
	let caught = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(AppError);
	expect(caught).toMatchObject(expected);
	return caught;
}

async function interruptedRun(runId) {
	await freshRun(runId);
	const started = await service.startRun(PROFILE, runId, { owner: "w1" });
	await service.checkpointStep(PROFILE, runId, {
		generation: started.generation,
		owner: "w1",
		stepId: "s1",
		state: STEP_STATES.COMPLETED,
		outcome: { outcomeId: "o1" },
		evidenceRefs: ["ev1"],
	});
	return started;
}

describe("Phase 46B — lifecycle vocabulary", () => {
	test("the run state model is closed and includes the required terminal states", () => {
		expect(Object.values(RUN_STATES).sort()).toEqual(["ABORTED", "COMPLETED", "CREATED", "FAILED", "PAUSED", "RUNNING"]);
		expect(isTerminalRunState(RUN_STATES.COMPLETED)).toBe(true);
		expect(isTerminalRunState(RUN_STATES.ABORTED)).toBe(true);
		expect(isTerminalRunState(RUN_STATES.FAILED)).toBe(true);
		expect(isTerminalRunState(RUN_STATES.RUNNING)).toBe(false);
		expect(isTerminalRunState(RUN_STATES.PAUSED)).toBe(false);
	});

	test("every legal transition is enumerated and everything else is refused", () => {
		expect(canTransition(RUN_STATES.CREATED, RUN_STATES.RUNNING)).toBe(true);
		expect(canTransition(RUN_STATES.RUNNING, RUN_STATES.PAUSED)).toBe(true);
		expect(canTransition(RUN_STATES.PAUSED, RUN_STATES.RUNNING)).toBe(true);
		expect(canTransition(RUN_STATES.RUNNING, RUN_STATES.COMPLETED)).toBe(true);
		// No transition leaves a terminal state.
		for (const state of ["COMPLETED", "ABORTED", "FAILED"]) {
			expect(canTransition(state, RUN_STATES.RUNNING)).toBe(false);
			expect(canTransition(state, RUN_STATES.PAUSED)).toBe(false);
			expect(canTransition(state, RUN_STATES.ABORTED)).toBe(false);
			expect(canTransition(state, RUN_STATES.FAILED)).toBe(false);
		}
		// A caller may not request the progress self-loop by name.
		expect(canRequestTransition(RUN_STATES.RUNNING, RUN_STATES.RUNNING)).toBe(false);
		// Unknown states are refused rather than defaulted.
		expect(canTransition("BOGUS", RUN_STATES.RUNNING)).toBe(false);
		expect(canTransition(RUN_STATES.RUNNING, "BOGUS")).toBe(false);
	});

	test("an invalid transition throws a typed invalid-transition error", () => {
		let caught = null;
		try {
			assertTransition(RUN_STATES.PAUSED, RUN_STATES.COMPLETED);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AppError);
		expect(caught.code).toBe(CODES.INVALID_TRANSITION);
	});
});

describe("Phase 46B — run creation and immutable identity", () => {
	test("create run starts in CREATED with a generation, pending steps, and no owner", async () => {
		const run = await freshRun("create-basic");
		expect(run.runState).toBe(RUN_STATES.CREATED);
		expect(run.generation).toBe(1);
		expect(run.owner).toBeNull();
		expect(run.plan.steps.map((step) => step.stepId)).toEqual(["s1", "s2", "s3"]);
		expect(run.stepStates.map((entry) => entry.state)).toEqual(["PENDING", "PENDING", "PENDING"]);
		expect(run.completedStepIds).toEqual([]);
		expect(run.nextStepId).toBe("s1");
		expect(run.identityFingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	test("a run cannot be created without an identity", async () => {
		await expectAppError(service.createRun(PROFILE, { runId: "no-id", plan: planOf("s1") }), {
			code: CODES.MALFORMED_INPUT,
			statusCode: 400,
		});
	});

	test("a policy identity must be supplied whole or not at all", async () => {
		const broken = identity({ policyId: "64b00000000000000000f001" });
		await expectAppError(service.createRun(PROFILE, { runId: "half-policy", identity: broken, plan: planOf("s1") }), {
			code: CODES.MALFORMED_INPUT,
		});
		const whole = identity({ policyId: "64b00000000000000000f001", policyFingerprint: "d".repeat(64) });
		const run = await service.createRun(PROFILE, { runId: "whole-policy", identity: whole, plan: planOf("s1") });
		expect(run.identity.policyId).toBe("64b00000000000000000f001");
		expect(run.identity.policyFingerprint).toBe("d".repeat(64));
	});

	test("identity differences are reported field by field, not as one opaque mismatch", () => {
		const base = identity();
		expect(identityDifferences(base, identity())).toEqual([]);
		expect(identitiesMatch(base, identity())).toBe(true);

		const otherSnapshot = identity({ snapshotFingerprint: "9".repeat(64) });
		expect(identityDifferences(base, otherSnapshot)).toEqual(["snapshotFingerprint"]);

		const otherEnv = identity({ targetEnvironment: { environmentId: ENVIRONMENT, environmentFingerprint: "8".repeat(64) } });
		expect(identityDifferences(base, otherEnv)).toEqual(["environmentFingerprint"]);

		const otherWorkspace = identity({ workspaceId: "64b00000000000000000b009" });
		expect(identityDifferences(base, otherWorkspace)).toEqual(["workspaceId"]);
	});

	test("identity fingerprint is stable across key order and changes when any binding changes", () => {
		const base = identity();
		const reordered = {
			planFingerprint: base.planFingerprint,
			planId: base.planId,
			targetEnvironment: {
				environmentFingerprint: base.targetEnvironment.environmentFingerprint,
				environmentId: base.targetEnvironment.environmentId,
			},
			snapshotFingerprint: base.snapshotFingerprint,
			snapshotId: base.snapshotId,
			workspaceId: base.workspaceId,
		};
		expect(identityFingerprint(reordered)).toBe(identityFingerprint(base));
		expect(identityFingerprint(identity({ planFingerprint: "7".repeat(64) }))).not.toBe(identityFingerprint(base));
	});

	test("a plan may not name the same step twice", async () => {
		await expectAppError(service.createRun(PROFILE, { runId: "dup-step", identity: identity(), plan: planOf("s1", "s1") }), {
			code: CODES.MALFORMED_INPUT,
		});
	});

	test("re-creating the same run id with the same identity is idempotent, with a different identity it is refused", async () => {
		const first = await service.createRun(PROFILE, { runId: "idem", identity: identity(), plan: planOf("s1") });
		const again = await service.ensureRun(PROFILE, { runId: "idem", identity: identity(), plan: planOf("s1") });
		expect(again.created).toBe(false);
		expect(again.run.runId).toBe(first.runId);

		await expectAppError(service.ensureRun(PROFILE, { runId: "idem", identity: identity({ planFingerprint: "1".repeat(64) }), plan: planOf("s1") }), {
			code: CODES.IDENTITY_CONFLICT,
			statusCode: 409,
		});

		let caught = null;
		try {
			await service.createRun(PROFILE, { runId: "idem", identity: identity(), plan: planOf("s1") });
		} catch (error) {
			caught = error;
		}
		expect(caught.code).toBe(CODES.DUPLICATE_RUN);
	});
});

describe("Phase 46B — claim and start", () => {
	test("start transitions CREATED -> RUNNING and advances the generation", async () => {
		await freshRun("claim-start");
		const started = await service.startRun(PROFILE, "claim-start", { owner: "w1" });
		expect(started.runState).toBe(RUN_STATES.RUNNING);
		expect(started.generation).toBe(2);
		expect(started.owner).toBe("w1");
	});

	test("the first claim may present a null expected generation only from CREATED", async () => {
		await freshRun("claim-null");
		const claimed = await service.claimRun(PROFILE, "claim-null", { owner: "w1", expectedGeneration: null });
		expect(claimed.generation).toBe(2);
		expect(claimed.runState).toBe(RUN_STATES.RUNNING);

		// A second null claim must not be able to steal an owned run.
		await expectAppError(service.claimRun(PROFILE, "claim-null", { owner: "w2", expectedGeneration: null }), {
			code: CODES.STALE_GENERATION,
			statusCode: 409,
		});
	});

	test("a competing worker claim with a stale generation is refused", async () => {
		await freshRun("claim-compete");
		const first = await service.claimRun(PROFILE, "claim-compete", { owner: "w1", expectedGeneration: null });
		await expectAppError(service.claimRun(PROFILE, "claim-compete", { owner: "w2", expectedGeneration: null }), {
			code: CODES.STALE_GENERATION,
		});
		// Reclaiming with the current generation is legal and takes ownership.
		const second = await service.claimRun(PROFILE, "claim-compete", { owner: "w2", expectedGeneration: first.generation });
		expect(second.generation).toBe(first.generation + 1);
		expect(second.owner).toBe("w2");
	});

	test("two workers cannot both claim the same run", async () => {
		await freshRun("claim-race");
		const results = await Promise.allSettled([
			service.claimRun(PROFILE, "claim-race", { owner: "wa", expectedGeneration: null }),
			service.claimRun(PROFILE, "claim-race", { owner: "wb", expectedGeneration: null }),
		]);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason.code).toBe(CODES.STALE_GENERATION);
		expect(fulfilled[0].value.owner).toBe("wa");
	});

	test("a terminal run cannot be claimed", async () => {
		await freshRun("claim-terminal");
		const started = await service.startRun(PROFILE, "claim-terminal", { owner: "w1" });
		await service.abortRun(PROFILE, "claim-terminal", { generation: started.generation, owner: "w1", reasonCode: "OPERATOR_REQUESTED" });
		await expectAppError(service.claimRun(PROFILE, "claim-terminal", { owner: "w2", expectedGeneration: started.generation }), {
			code: CODES.TERMINAL_STATE,
			statusCode: 409,
		});
	});
});

describe("Phase 46B — checkpoint step", () => {
	test("checkpointing records completion, advances the pointer, and keeps the run RUNNING", async () => {
		await freshRun("cp-basic");
		const started = await service.startRun(PROFILE, "cp-basic", { owner: "w1" });
		const result = await service.checkpointStep(PROFILE, "cp-basic", {
			generation: started.generation,
			owner: "w1",
			stepId: "s1",
			state: STEP_STATES.COMPLETED,
			outcome: { outcomeId: "outcome-1", metadata: { status: 200 } },
			evidenceRefs: ["exec-1"],
		});
		expect(result.idempotent).toBe(false);
		expect(result.run.runState).toBe(RUN_STATES.RUNNING);
		expect(result.run.completedStepIds).toEqual(["s1"]);
		expect(result.run.nextStepId).toBe("s2");
		const stored = result.run.stepStates.find((entry) => entry.stepId === "s1");
		expect(stored.state).toBe(STEP_STATES.COMPLETED);
		expect(stored.completion.outcomeId).toBe("outcome-1");
		expect(stored.completion.ownerGeneration).toBe(started.generation);
		expect(stored.attempt.attempts).toBe(1);
		expect(stored.attempt.evidenceRefs).toEqual(["exec-1"]);
	});

	test("checkpointing an unknown step is refused", async () => {
		await freshRun("cp-unknown");
		const started = await service.startRun(PROFILE, "cp-unknown", { owner: "w1" });
		await expectAppError(
			service.checkpointStep(PROFILE, "cp-unknown", { generation: started.generation, owner: "w1", stepId: "nope", state: STEP_STATES.COMPLETED }),
			{ code: CODES.STEP_NOT_FOUND, statusCode: 404 },
		);
	});

	test("checkpointing with a stale generation is refused before any step logic runs", async () => {
		await freshRun("cp-stale");
		const started = await service.startRun(PROFILE, "cp-stale", { owner: "w1" });
		await expectAppError(
			service.checkpointStep(PROFILE, "cp-stale", {
				generation: started.generation - 1,
				owner: "w1",
				stepId: "s1",
				state: STEP_STATES.COMPLETED,
			}),
			{ code: CODES.STALE_GENERATION, statusCode: 409 },
		);
	});

	test("checkpointing with the wrong owner is refused even at the right generation", async () => {
		await freshRun("cp-wrong-owner");
		const started = await service.startRun(PROFILE, "cp-wrong-owner", { owner: "w1" });
		await expectAppError(
			service.checkpointStep(PROFILE, "cp-wrong-owner", {
				generation: started.generation,
				owner: "impostor",
				stepId: "s1",
				state: STEP_STATES.COMPLETED,
			}),
			{ code: CODES.LEASE_NOT_HELD, statusCode: 409 },
		);
	});
});

describe("Phase 46B — exactly-once completion accounting", () => {
	test("a duplicate identical completion is an idempotent no-op", async () => {
		await freshRun("dup-identical");
		const started = await service.startRun(PROFILE, "dup-identical", { owner: "w1" });
		const payload = {
			generation: started.generation,
			owner: "w1",
			stepId: "s1",
			state: STEP_STATES.COMPLETED,
			outcome: { outcomeId: "o1", metadata: { status: 200 } },
			evidenceRefs: ["ev1"],
		};
		const first = await service.checkpointStep(PROFILE, "dup-identical", payload);
		const second = await service.checkpointStep(PROFILE, "dup-identical", payload);
		expect(first.idempotent).toBe(false);
		expect(second.idempotent).toBe(true);
		expect(second.run.completedStepIds).toEqual(["s1"]);
		// The attempt counter is not inflated by an idempotent repeat.
		expect(second.run.stepStates.find((entry) => entry.stepId === "s1").attempt.attempts).toBe(1);
	});

	test("evidence ordering does not change completion identity", async () => {
		await freshRun("dup-evidence-order");
		const started = await service.startRun(PROFILE, "dup-evidence-order", { owner: "w1" });
		await service.checkpointStep(PROFILE, "dup-evidence-order", {
			generation: started.generation,
			owner: "w1",
			stepId: "s1",
			state: STEP_STATES.COMPLETED,
			outcome: { outcomeId: "o1" },
			evidenceRefs: ["ev-a", "ev-b"],
		});
		const repeat = await service.checkpointStep(PROFILE, "dup-evidence-order", {
			generation: started.generation,
			owner: "w1",
			stepId: "s1",
			state: STEP_STATES.COMPLETED,
			outcome: { outcomeId: "o1" },
			evidenceRefs: ["ev-b", "ev-a"],
		});
		expect(repeat.idempotent).toBe(true);
	});

	test("a contradictory duplicate completion is rejected and the stored outcome is preserved", async () => {
		await freshRun("dup-contradictory");
		const started = await service.startRun(PROFILE, "dup-contradictory", { owner: "w1" });
		await service.checkpointStep(PROFILE, "dup-contradictory", {
			generation: started.generation,
			owner: "w1",
			stepId: "s1",
			state: STEP_STATES.COMPLETED,
			outcome: { outcomeId: "o1" },
		});
		await expectAppError(
			service.checkpointStep(PROFILE, "dup-contradictory", {
				generation: started.generation,
				owner: "w1",
				stepId: "s1",
				state: STEP_STATES.COMPLETED,
				outcome: { outcomeId: "different" },
			}),
			{ code: CODES.STEP_CONTRADICTORY, statusCode: 409 },
		);
		const run = await service.getRun(PROFILE, "dup-contradictory");
		expect(run.stepStates.find((entry) => entry.stepId === "s1").completion.outcomeId).toBe("o1");
	});

	test("a completed step can never be counted twice under concurrent attempts", async () => {
		await freshRun("dup-concurrent");
		const started = await service.startRun(PROFILE, "dup-concurrent", { owner: "w1" });
		// Two workers holding the same generation complete the same step with the
		// same outcome at the same moment. Exactly one write advances the step; the
		// other is either the idempotent repeat or a refused non-pending write.
		const payload = { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" } };
		const results = await Promise.allSettled([
			service.checkpointStep(PROFILE, "dup-concurrent", payload),
			service.checkpointStep(PROFILE, "dup-concurrent", payload),
		]);
		const advanced = results.filter((result) => result.status === "fulfilled" && result.value.idempotent === false);
		expect(advanced).toHaveLength(1);
		const run = await service.getRun(PROFILE, "dup-concurrent");
		expect(run.completedStepIds).toEqual(["s1"]);
		// Accounting is exactly once regardless of how many callers raced.
		expect(run.stepStates.find((entry) => entry.stepId === "s1").attempt.attempts).toBe(1);
	});

	test("a failed step cannot be silently overwritten by a later completion", async () => {
		await freshRun("dup-after-failure");
		const started = await service.startRun(PROFILE, "dup-after-failure", { owner: "w1" });
		await service.checkpointStep(PROFILE, "dup-after-failure", {
			generation: started.generation,
			owner: "w1",
			stepId: "s1",
			state: STEP_STATES.FAILED,
			evidenceRefs: ["ev-fail"],
		});
		await expectAppError(
			service.checkpointStep(PROFILE, "dup-after-failure", {
				generation: started.generation,
				owner: "w1",
				stepId: "s1",
				state: STEP_STATES.COMPLETED,
				outcome: { outcomeId: "o-late" },
			}),
			{ code: CODES.STEP_CONTRADICTORY },
		);
	});

	test("step completion fingerprints are order-independent and content-sensitive", () => {
		const a = { stepId: "s1", state: "COMPLETED", outcomeId: "o1", metadata: { b: 2, a: 1 }, evidenceRefs: ["x", "y"] };
		const b = { stepId: "s1", state: "COMPLETED", outcomeId: "o1", metadata: { a: 1, b: 2 }, evidenceRefs: ["y", "x"] };
		const c = { stepId: "s1", state: "COMPLETED", outcomeId: "o2", metadata: { a: 1, b: 2 }, evidenceRefs: ["x", "y"] };
		expect(stepCompletionFingerprint(a)).toBe(stepCompletionFingerprint(b));
		expect(stepCompletionFingerprint(a)).not.toBe(stepCompletionFingerprint(c));
	});
});

describe("Phase 46B — resume and pending work", () => {
	test("resume after partial progress excludes completed steps from pending work", async () => {
		await interruptedRun("resume-partial");
		const resumed = await service.resumeRun(PROFILE, "resume-partial", {
			owner: "w2",
			expectedGeneration: 2,
			identity: identity(),
		});
		expect(resumed.resumed).toBe(true);
		expect(resumed.pendingStepIds).toEqual(["s2", "s3"]);
		expect(resumed.run.completedStepIds).toEqual(["s1"]);
	});

	test("resume advances the generation so the previous worker becomes stale", async () => {
		await interruptedRun("resume-gen");
		const resumed = await service.resumeRun(PROFILE, "resume-gen", { owner: "w2", expectedGeneration: 2, identity: identity() });
		expect(resumed.run.generation).toBe(3);
		expect(resumed.run.owner).toBe("w2");
		// The old worker's generation no longer writes.
		await expectAppError(
			service.checkpointStep(PROFILE, "resume-gen", { generation: 2, owner: "w1", stepId: "s2", state: STEP_STATES.COMPLETED }),
			{ code: CODES.STALE_GENERATION },
		);
	});

	test("an already-completed step is not scheduled again after resume", async () => {
		await interruptedRun("resume-no-repeat");
		const resumed = await service.resumeRun(PROFILE, "resume-no-repeat", { owner: "w2", expectedGeneration: 2, identity: identity() });
		expect(resumed.pendingStepIds).not.toContain("s1");
		// Attempting to re-complete s1 with its identical outcome is idempotent, not a
		// new work item.
		const repeat = await service.checkpointStep(PROFILE, "resume-no-repeat", {
			generation: resumed.run.generation,
			owner: "w2",
			stepId: "s1",
			state: STEP_STATES.COMPLETED,
			outcome: { outcomeId: "o1" },
			evidenceRefs: ["ev1"],
		});
		expect(repeat.idempotent).toBe(true);
	});

	test("simultaneous resume attempts produce exactly one winner", async () => {
		await interruptedRun("resume-race");
		const results = await Promise.allSettled([
			service.resumeRun(PROFILE, "resume-race", { owner: "wa", expectedGeneration: 2, identity: identity() }),
			service.resumeRun(PROFILE, "resume-race", { owner: "wb", expectedGeneration: 2, identity: identity() }),
		]);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason.code).toBe(CODES.STALE_GENERATION);
		const run = await service.getRun(PROFILE, "resume-race");
		expect(run.generation).toBe(3);
	});

	test("resume re-entrantly by the current owner does not advance the generation", async () => {
		await interruptedRun("resume-reentrant");
		const first = await service.resumeRun(PROFILE, "resume-reentrant", { owner: "w2", expectedGeneration: 2, identity: identity() });
		const second = await service.resumeRun(PROFILE, "resume-reentrant", {
			owner: "w2",
			expectedGeneration: first.run.generation,
			identity: identity(),
		});
		expect(second.resumed).toBe(false);
		expect(second.run.generation).toBe(first.run.generation);
	});

	test("resume can continue a paused run", async () => {
		await freshRun("resume-paused");
		const started = await service.startRun(PROFILE, "resume-paused", { owner: "w1" });
		const paused = await service.pauseRun(PROFILE, "resume-paused", {
			owner: "w1",
			expectedGeneration: started.generation,
			identity: identity(),
		});
		expect(paused.runState).toBe(RUN_STATES.PAUSED);
		const resumed = await service.resumeRun(PROFILE, "resume-paused", {
			owner: "w2",
			expectedGeneration: paused.generation,
			identity: identity(),
		});
		expect(resumed.run.runState).toBe(RUN_STATES.RUNNING);
	});

	test("pendingSteps and allStepsTerminal are consistent with the lifecycle", () => {
		const plan = { steps: [{ stepId: "s1" }, { stepId: "s2" }] };
		expect(pendingSteps(plan, [{ stepId: "s1", state: "COMPLETED" }, { stepId: "s2", state: "PENDING" }])).toEqual(["s2"]);
		expect(allStepsTerminal(plan, [{ stepId: "s1", state: "COMPLETED" }, { stepId: "s2", state: "SKIPPED" }])).toBe(true);
		expect(allStepsTerminal(plan, [{ stepId: "s1", state: "FAILED" }, { stepId: "s2", state: "COMPLETED" }])).toBe(false);
	});
});

describe("Phase 46B — identity binding protection", () => {
	test("resume with a different snapshot is refused and names the differing field", async () => {
		await interruptedRun("bind-snapshot");
		const caught = await expectAppError(
			service.resumeRun(PROFILE, "bind-snapshot", {
				owner: "w2",
				expectedGeneration: 2,
				identity: identity({ snapshotFingerprint: "9".repeat(64) }),
			}),
			{ code: CODES.IDENTITY_CONFLICT, statusCode: 409 },
		);
		expect(caught.details.differences).toEqual(["snapshotFingerprint"]);
	});

	test("resume with a different environment is refused", async () => {
		await interruptedRun("bind-environment");
		const caught = await expectAppError(
			service.resumeRun(PROFILE, "bind-environment", {
				owner: "w2",
				expectedGeneration: 2,
				identity: identity({ targetEnvironment: { environmentId: "64b00000000000000000c009", environmentFingerprint: "8".repeat(64) } }),
			}),
			{ code: CODES.IDENTITY_CONFLICT },
		);
		expect(caught.details.differences.sort()).toEqual(["environmentFingerprint", "environmentId"]);
	});

	test("resume with a different plan is refused", async () => {
		await interruptedRun("bind-plan");
		const caught = await expectAppError(
			service.resumeRun(PROFILE, "bind-plan", {
				owner: "w2",
				expectedGeneration: 2,
				identity: identity({ planId: "64b00000000000000000e009", planFingerprint: "6".repeat(64) }),
			}),
			{ code: CODES.IDENTITY_CONFLICT },
		);
		expect(caught.details.differences.sort()).toEqual(["planFingerprint", "planId"]);
	});

	test("resume with a different workspace is refused", async () => {
		await interruptedRun("bind-workspace");
		const caught = await expectAppError(
			service.resumeRun(PROFILE, "bind-workspace", {
				owner: "w2",
				expectedGeneration: 2,
				identity: identity({ workspaceId: "64b00000000000000000b009" }),
			}),
			{ code: CODES.IDENTITY_CONFLICT },
		);
		expect(caught.details.differences).toEqual(["workspaceId"]);
	});

	test("checkpoint with a mismatched identity assertion is refused", async () => {
		await interruptedRun("bind-checkpoint");
		const caught = await expectAppError(
			service.checkpointStep(PROFILE, "bind-checkpoint", {
				generation: 2,
				owner: "w1",
				stepId: "s2",
				state: STEP_STATES.COMPLETED,
				identity: identity({ snapshotFingerprint: "9".repeat(64) }),
			}),
			{ code: CODES.IDENTITY_CONFLICT },
		);
		expect(caught.details.differences).toEqual(["snapshotFingerprint"]);
	});

	test("a run created before a policy existed cannot later claim one", async () => {
		await freshRun("bind-policy");
		await expectAppError(
			service.resumeRun(PROFILE, "bind-policy", {
				owner: "w2",
				expectedGeneration: 1,
				identity: identity({ policyId: "64b00000000000000000f001", policyFingerprint: "5".repeat(64) }),
			}),
			{ code: CODES.IDENTITY_CONFLICT },
		);
	});
});

describe("Phase 46B — terminal-state protection", () => {
	async function completedRun(runId) {
		await freshRun(runId, { plan: planOf("s1") });
		const started = await service.startRun(PROFILE, runId, { owner: "w1" });
		await service.checkpointStep(PROFILE, runId, { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" } });
		return service.completeRun(PROFILE, runId, { owner: "w1", expectedGeneration: started.generation, identity: identity() });
	}

	test("a run completes only when every step is terminal", async () => {
		await freshRun("term-incomplete");
		const started = await service.startRun(PROFILE, "term-incomplete", { owner: "w1" });
		const caught = await expectAppError(
			service.completeRun(PROFILE, "term-incomplete", { owner: "w1", expectedGeneration: started.generation, identity: identity() }),
			{ code: CODES.INVALID_TRANSITION, statusCode: 409 },
		);
		expect(caught.details.pendingStepIds).toEqual(["s1", "s2", "s3"]);
	});

	test("a COMPLETED run is terminal and cannot resume, claim, checkpoint, or re-complete", async () => {
		const completed = await completedRun("term-completed");
		expect(completed.runState).toBe(RUN_STATES.COMPLETED);
		expect(completed.terminalReasonCode).toBe("OPERATOR_REQUESTED");

		await expectAppError(service.resumeRun(PROFILE, "term-completed", { owner: "w2", expectedGeneration: completed.generation, identity: identity() }), {
			code: CODES.TERMINAL_STATE,
		});
		await expectAppError(service.claimRun(PROFILE, "term-completed", { owner: "w2", expectedGeneration: completed.generation }), {
			code: CODES.TERMINAL_STATE,
		});
		await expectAppError(
			service.checkpointStep(PROFILE, "term-completed", { generation: completed.generation, owner: "w1", stepId: "s2", state: STEP_STATES.COMPLETED }),
			{ code: CODES.TERMINAL_STATE },
		);
		await expectAppError(service.abortRun(PROFILE, "term-completed", { generation: completed.generation, owner: "w1", reasonCode: "OPERATOR_REQUESTED" }), {
			code: CODES.TERMINAL_STATE,
		});
		await expectAppError(service.failRun(PROFILE, "term-completed", { generation: completed.generation, owner: "w1", reasonCode: "INTERNAL_ERROR" }), {
			code: CODES.TERMINAL_STATE,
		});
	});

	test("an ABORTED run is terminal and cannot return to RUNNING", async () => {
		await freshRun("term-aborted");
		const started = await service.startRun(PROFILE, "term-aborted", { owner: "w1" });
		const aborted = await service.abortRun(PROFILE, "term-aborted", {
			generation: started.generation,
			owner: "w1",
			reasonCode: "BLAST_RADIUS_LIMIT",
			reason: "request limit reached",
		});
		expect(aborted.runState).toBe(RUN_STATES.ABORTED);
		expect(aborted.terminalReasonCode).toBe("BLAST_RADIUS_LIMIT");
		expect(aborted.terminalReason).toBe("request limit reached");

		await expectAppError(service.resumeRun(PROFILE, "term-aborted", { owner: "w2", expectedGeneration: aborted.generation, identity: identity() }), {
			code: CODES.TERMINAL_STATE,
		});
		await expectAppError(
			service.checkpointStep(PROFILE, "term-aborted", { generation: aborted.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED }),
			{ code: CODES.TERMINAL_STATE },
		);
		await expectAppError(service.completeRun(PROFILE, "term-aborted", { owner: "w1", expectedGeneration: aborted.generation, identity: identity() }), {
			code: CODES.TERMINAL_STATE,
		});
	});

	test("a FAILED run is terminal and records its reason code", async () => {
		await freshRun("term-failed");
		const started = await service.startRun(PROFILE, "term-failed", { owner: "w1" });
		const failed = await service.failRun(PROFILE, "term-failed", {
			generation: started.generation,
			owner: "w1",
			reasonCode: "TARGET_UNAVAILABLE",
		});
		expect(failed.runState).toBe(RUN_STATES.FAILED);
		expect(failed.terminalReasonCode).toBe("TARGET_UNAVAILABLE");
		await expectAppError(service.resumeRun(PROFILE, "term-failed", { owner: "w2", expectedGeneration: failed.generation, identity: identity() }), {
			code: CODES.TERMINAL_STATE,
		});
	});

	test("a stale generation cannot terminate a newer generation", async () => {
		await freshRun("term-stale");
		const started = await service.startRun(PROFILE, "term-stale", { owner: "w1" });
		const resumed = await service.resumeRun(PROFILE, "term-stale", { owner: "w2", expectedGeneration: started.generation, identity: identity() });
		await expectAppError(
			service.abortRun(PROFILE, "term-stale", { generation: started.generation, owner: "w1", reasonCode: "OPERATOR_REQUESTED" }),
			{ code: CODES.STALE_GENERATION },
		);
		// The newer generation is unaffected.
		const run = await service.getRun(PROFILE, "term-stale");
		expect(run.runState).toBe(RUN_STATES.RUNNING);
		expect(run.generation).toBe(resumed.run.generation);
	});
});

describe("Phase 46B — deterministic serialization and reconstruction", () => {
	test("the canonical checkpoint form is byte-stable and excludes row metadata", async () => {
		const run = await freshRun("canonical-stable");
		const stored = await service.getRun(PROFILE, "canonical-stable");
		const first = checkpointCanonicalForm(stored);
		const second = checkpointCanonicalForm(stored);
		expect(first).toBe(second);
		expect(first).not.toContain("_id");
		expect(first).not.toContain("createdAt");
		// Key order in the input cannot change the canonical form.
		const shuffled = { ...stored, stepStates: [...stored.stepStates].reverse() };
		expect(checkpointCanonicalForm(shuffled)).toBe(first);
		expect(run.identityFingerprint).toBeTruthy();
	});

	test("the checkpoint fingerprint changes when progress changes", async () => {
		await freshRun("canonical-progress");
		const before = await service.reconstruct(PROFILE, "canonical-progress");
		const started = await service.startRun(PROFILE, "canonical-progress", { owner: "w1" });
		const afterStart = await service.reconstruct(PROFILE, "canonical-progress");
		expect(afterStart.fingerprint).not.toBe(before.fingerprint);
		await service.checkpointStep(PROFILE, "canonical-progress", {
			generation: started.generation,
			owner: "w1",
			stepId: "s1",
			state: STEP_STATES.COMPLETED,
			outcome: { outcomeId: "o1" },
		});
		const afterStep = await service.reconstruct(PROFILE, "canonical-progress");
		expect(afterStep.fingerprint).not.toBe(afterStart.fingerprint);
	});

	test("crash-style reconstruction rebuilds pending work purely from persisted state", async () => {
		await interruptedRun("crash-rebuild");
		// A completely fresh service over the same persisted rows is exactly what a
		// post-restart instance looks like.
		const restarted = createRehearsalCheckpointService({ repository, now: () => new Date("2026-09-25T00:00:00.000Z") });
		const view = await restarted.reconstruct(PROFILE, "crash-rebuild");
		expect(view.terminal).toBe(false);
		expect(view.completedStepIds).toEqual(["s1"]);
		expect(view.pendingStepIds).toEqual(["s2", "s3"]);
		expect(view.run.runState).toBe(RUN_STATES.RUNNING);
		expect(view.run.generation).toBe(2);
		expect(view.fingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	test("reconstruction of an unknown run is a typed not-found", async () => {
		await expectAppError(service.reconstruct(PROFILE, "does-not-exist"), { code: CODES.NOT_FOUND, statusCode: 404 });
	});

	test("derived pointers never point at a completed step", () => {
		const plan = { steps: [{ stepId: "s1" }, { stepId: "s2" }, { stepId: "s3" }] };
		const pointers = derivedPointers(plan, [
			{ stepId: "s1", state: "COMPLETED" },
			{ stepId: "s2", state: "PENDING" },
			{ stepId: "s3", state: "PENDING" },
		]);
		expect(pointers.nextStepId).toBe("s2");
		expect(pointers.currentStepId).toBeNull();
	});

	test("canonicalizeJson drops undefined and sorts keys", () => {
		expect(canonicalizeJson({ b: 1, a: undefined, c: null })).toBe('{"b":1,"c":null}');
	});
});

describe("Phase 46B — data minimization", () => {
	test("credential-shaped identifiers are refused at the boundary", async () => {
		const withBearer = identity({ snapshotFingerprint: `Bearer ${"a".repeat(40)}` });
		await expectAppError(service.createRun(PROFILE, { runId: "leak-snapshot", identity: withBearer, plan: planOf("s1") }), {
			code: CODES.MALFORMED_INPUT,
		});
	});

	test("credential-shaped worker identities and step ids are refused", async () => {
		await freshRun("leak-fields");
		const started = await service.startRun(PROFILE, "leak-fields", { owner: "w1" });
		await expectAppError(
			service.checkpointStep(PROFILE, "leak-fields", {
				generation: started.generation,
				owner: started.owner,
				stepId: "s1",
				state: STEP_STATES.COMPLETED,
				outcome: { outcomeId: "o1", metadata: { token: `ghp_${"a".repeat(20)}` } },
			}),
			{ code: CODES.MALFORMED_INPUT },
		);
	});

	test("nothing persisted contains request bodies, authorization, cookie, or resolved secrets", async () => {
		await freshRun("leak-stored");
		const started = await service.startRun(PROFILE, "leak-stored", { owner: "w1" });
		await service.checkpointStep(PROFILE, "leak-stored", {
			generation: started.generation,
			owner: "w1",
			stepId: "s1",
			state: STEP_STATES.COMPLETED,
			outcome: { outcomeId: "outcome-1", metadata: { status: 200, durationMs: 12, ok: true } },
			evidenceRefs: ["execution-1"],
		});
		const view = await service.reconstruct(PROFILE, "leak-stored");
		const serialized = JSON.stringify(view.run);
		expect(serialized).not.toMatch(/authorization/i);
		expect(serialized).not.toMatch(/\bcookie\b/i);
		expect(serialized).not.toMatch(/bearer\s/i);
		expect(serialized).not.toMatch(/requestBody|"body":/);
		// What is stored is exactly identities, statuses, and bounded evidence refs.
		expect(serialized).toContain("outcome-1");
		expect(serialized).toContain("execution-1");
	});

	test("the stored run document has no payload-bearing field", async () => {
		const run = await freshRun("leak-shape");
		const stored = await repository.findByRunId(PROFILE, run.runId);
		const keys = Object.keys(stored).sort();
		expect(keys).not.toContain("body");
		expect(keys).not.toContain("request");
		expect(keys).not.toContain("headers");
		expect(keys).not.toContain("auth");
	});
});

describe("Phase 46B — tenant isolation and listing", () => {
	test("a profile cannot read another profile's run", async () => {
		await freshRun("tenant-a");
		const other = "64b00000000000000000a002";
		expect(await service.getRun(other, "tenant-a")).toBeNull();
		await expectAppError(service.reconstruct(other, "tenant-a"), { code: CODES.NOT_FOUND });
		await expectAppError(service.checkpointStep(other, "tenant-a", { generation: 1, owner: "x", stepId: "s1", state: STEP_STATES.COMPLETED }), {
			code: CODES.NOT_FOUND,
		});
	});

	test("the same run id can exist independently under two profiles", async () => {
		const other = "64b00000000000000000a003";
		await service.createRun(PROFILE, { runId: "shared-run-id", identity: identity(), plan: planOf("s1") });
		await service.createRun(other, { runId: "shared-run-id", identity: identity(), plan: planOf("s1", "s2") });
		const mine = await service.getRun(PROFILE, "shared-run-id");
		const theirs = await service.getRun(other, "shared-run-id");
		expect(mine.plan.steps).toHaveLength(1);
		expect(theirs.plan.steps).toHaveLength(2);
	});

	test("listResumable returns only non-terminal runs and listing is deterministic", async () => {
		await freshRun("list-created");
		await interruptedRun("list-running");
		await freshRun("list-terminal", { plan: planOf("s1") });
		const terminalStart = await service.startRun(PROFILE, "list-terminal", { owner: "w1" });
		await service.checkpointStep(PROFILE, "list-terminal", {
			generation: terminalStart.generation,
			owner: "w1",
			stepId: "s1",
			state: STEP_STATES.COMPLETED,
			outcome: { outcomeId: "o1" },
		});
		await service.completeRun(PROFILE, "list-terminal", { owner: "w1", expectedGeneration: terminalStart.generation, identity: identity() });

		const resumable = await service.listResumable(PROFILE);
		const ids = resumable.map((run) => run.runId).sort();
		expect(ids).toContain("list-created");
		expect(ids).toContain("list-running");
		expect(ids).not.toContain("list-terminal");
		expect(resumable.every((run) => ["CREATED", "RUNNING", "PAUSED"].includes(run.runState))).toBe(true);
	});

	test("cleanup deletes only terminal runs and never in-flight work", async () => {
		// Cleanup is a retention window measured against a clock, so this test drives
		// its own clock rather than relying on wall time. The window is "terminal runs
		// last touched more than an hour ago"; the in-flight run is recent and must
		// survive regardless.
		const clock = { current: new Date("2026-09-24T00:00:00.000Z") };
		const retention = createMemoryRepository(() => new Date(clock.current));
		const clocked = createRehearsalCheckpointService({ repository: retention, now: () => new Date(clock.current) });

		const oldProfile = "64b00000000000000000a0f1";
		await clocked.createRun(oldProfile, { runId: "cleanup-terminal", identity: identity(), plan: planOf("s1") });
		const started = await clocked.startRun(oldProfile, "cleanup-terminal", { owner: "w1" });
		await clocked.checkpointStep(oldProfile, "cleanup-terminal", {
			generation: started.generation,
			owner: "w1",
			stepId: "s1",
			state: STEP_STATES.COMPLETED,
			outcome: { outcomeId: "o1" },
		});
		await clocked.completeRun(oldProfile, "cleanup-terminal", { owner: "w1", expectedGeneration: started.generation, identity: identity() });

		// An in-flight run created after the stale terminal one.
		clock.current = new Date("2026-09-24T02:00:00.000Z");
		await clocked.createRun(oldProfile, { runId: "cleanup-running", identity: identity(), plan: planOf("s1") });

		// Window opens at the terminal run's timestamp and is bounded before the
		// in-flight run, so exactly the finished one is eligible.
		clock.current = new Date("2026-09-24T02:30:00.000Z");
		const result = await clocked.cleanupTerminal(oldProfile, { olderThanMs: 60 * 60 * 1000 });
		expect(result.deletedCount).toBe(1);
		expect(await clocked.getRun(oldProfile, "cleanup-running")).toBeTruthy();
		expect(await clocked.getRun(oldProfile, "cleanup-terminal")).toBeNull();
	});

	test("cleanup never deletes a run that is merely old but still in flight", async () => {
		const clock = { current: new Date("2026-09-24T00:00:00.000Z") };
		const retention = createMemoryRepository(() => new Date(clock.current));
		const clocked = createRehearsalCheckpointService({ repository: retention, now: () => new Date(clock.current) });
		const profile = "64b00000000000000000a0f2";

		await clocked.createRun(profile, { runId: "ancient-running", identity: identity(), plan: planOf("s1") });
		await clocked.startRun(profile, "ancient-running", { owner: "w1" });

		// A full day later the run is still RUNNING. Retention must not touch it,
		// because deleting it would destroy resumable work.
		clock.current = new Date("2026-09-25T00:00:00.000Z");
		const result = await clocked.cleanupTerminal(profile, { olderThanMs: 60 * 60 * 1000 });
		expect(result.deletedCount).toBe(0);
		expect(await clocked.getRun(profile, "ancient-running")).toBeTruthy();
	});

	test("deleteRun is profile-scoped", async () => {
		await freshRun("delete-scoped");
		expect(await service.deleteRun("64b00000000000000000a009", "delete-scoped")).toBeNull();
		expect(await service.getRun(PROFILE, "delete-scoped")).toBeTruthy();
		expect(await service.deleteRun(PROFILE, "delete-scoped")).toBeTruthy();
		expect(await service.getRun(PROFILE, "delete-scoped")).toBeNull();
	});
});
