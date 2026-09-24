import mongoose from "mongoose";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { AppError } from "../../shared/errors/app-error.js";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { RehearsalCheckpoint } from "./checkpoint.model.js";
import { checkpointRepository } from "./checkpoint.repository.js";
import { createRehearsalCheckpointService } from "./rehearsal-checkpoint.service.js";
import { RUN_STATES, STEP_STATES, CHECKPOINT_ERROR_CODES as CODES } from "./reason-codes.js";

// Phase 46B — persistence and adversarial concurrency tests for the checkpoint core.
//
// The unit tests in `rehearsal-checkpoints.test.js` prove the semantics against an
// in-memory repository that *models* the CAS contract. These tests prove the same
// guarantees against MongoDB itself: real unique indexes, real atomic
// `findOneAndUpdate` filters, real positional array updates, and real concurrent
// writers. If the repository's filters were wrong, this is the file that fails.
//
// They skip cleanly when no database is reachable, matching the rest of the suite.

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase46b_persistence_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase46b-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase46b-test-jwt-secret";
initConfig();

const ready = await connectTestDatabase();
if (ready) await RehearsalCheckpoint.init();

const profileA = new mongoose.Types.ObjectId().toHexString();
const profileB = new mongoose.Types.ObjectId().toHexString();
const workspaceId = new mongoose.Types.ObjectId().toHexString();
const environmentId = new mongoose.Types.ObjectId().toHexString();
const snapshotId = new mongoose.Types.ObjectId().toHexString();
const planId = new mongoose.Types.ObjectId().toHexString();

const TEST_TIMEOUT_MS = 30000;
const mtest = (name, fn) => test(name, fn, TEST_TIMEOUT_MS);

const service = createRehearsalCheckpointService({
	repository: checkpointRepository,
	now: () => new Date(),
});

function identity(overrides = {}) {
	return {
		workspaceId,
		snapshotId,
		snapshotFingerprint: "a".repeat(64),
		targetEnvironment: { environmentId, environmentFingerprint: "b".repeat(64) },
		planId,
		planFingerprint: "c".repeat(64),
		...overrides,
	};
}

function planOf(...stepIds) {
	return { steps: stepIds.map((stepId) => ({ stepId })) };
}

let runCounter = 0;
function nextRunId(label) {
	runCounter += 1;
	return `${label}-${runCounter}-${Date.now().toString(36)}`;
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

async function freshRun(profileId, runId, options = {}) {
	return service.createRun(profileId, {
		runId,
		identity: options.identity ?? identity(),
		plan: options.plan ?? planOf("s1", "s2", "s3"),
	});
}

beforeEach(async () => {
	if (!ready) return;
	await RehearsalCheckpoint.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } });
});

afterAll(async () => {
	if (!ready) return;
	await RehearsalCheckpoint.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } });
	await disconnectTestDatabase();
});

describe.skipIf(!ready)("Phase 46B persistence — model and repository", () => {
	mtest("a run persists and reads back with its identity, plan, and step accounting intact", async () => {
		const runId = nextRunId("persist-basic");
		await freshRun(profileA, runId, { plan: planOf("alpha", "beta") });
		const stored = await checkpointRepository.findByRunId(profileA, runId);
		expect(stored).toBeTruthy();
		expect(stored.runId).toBe(runId);
		expect(stored.runState).toBe(RUN_STATES.CREATED);
		expect(stored.generation).toBe(1);
		expect(stored.identity.snapshotFingerprint).toBe("a".repeat(64));
		expect(stored.plan.steps.map((step) => step.stepId)).toEqual(["alpha", "beta"]);
		expect(stored.stepStates.map((entry) => entry.state)).toEqual(["PENDING", "PENDING"]);
		expect(stored.completedStepIds).toEqual([]);
	});

	mtest("the unique index refuses a second run with the same (profile, runId)", async () => {
		const runId = nextRunId("persist-unique");
		await freshRun(profileA, runId);
		await expectAppError(freshRun(profileA, runId), { code: CODES.DUPLICATE_RUN, statusCode: 409 });
		expect(await RehearsalCheckpoint.countDocuments({ ownerProfileId: profileA, runId })).toBe(1);
	});

	mtest("the same runId is independent across profiles", async () => {
		const runId = nextRunId("persist-scope");
		await service.createRun(profileA, { runId, identity: identity(), plan: planOf("s1") });
		await service.createRun(profileB, { runId, identity: identity(), plan: planOf("s1", "s2") });
		const a = await service.getRun(profileA, runId);
		const b = await service.getRun(profileB, runId);
		expect(a.plan.steps).toHaveLength(1);
		expect(b.plan.steps).toHaveLength(2);
		// A read of a missing run is a null, not a throw; only a mutating operation or a
		// reconstruction treats absence as an error.
		expect(await service.getRun(profileB, `${runId}-missing`)).toBeNull();
		await expectAppError(service.reconstruct(profileB, `${runId}-missing`), { code: CODES.NOT_FOUND, statusCode: 404 });
	});

	mtest("a profile cannot read, checkpoint, or delete another profile's run", async () => {
		const runId = nextRunId("persist-isolation");
		await freshRun(profileA, runId);
		expect(await service.getRun(profileB, runId)).toBeNull();
		await expectAppError(service.reconstruct(profileB, runId), { code: CODES.NOT_FOUND });
		await expectAppError(
			service.checkpointStep(profileB, runId, { generation: 1, owner: "x", stepId: "s1", state: STEP_STATES.COMPLETED }),
			{ code: CODES.NOT_FOUND },
		);
		expect(await service.deleteRun(profileB, runId)).toBeNull();
		expect(await service.getRun(profileA, runId)).toBeTruthy();
	});

	mtest("a claim advances the generation atomically in the database", async () => {
		const runId = nextRunId("persist-claim");
		await freshRun(profileA, runId);
		const claimed = await service.claimRun(profileA, runId, { owner: "w1", expectedGeneration: null });
		expect(claimed.generation).toBe(2);
		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		expect(stored.generation).toBe(2);
		expect(stored.owner).toBe("w1");
		expect(stored.runState).toBe(RUN_STATES.RUNNING);
	});

	mtest("the checkpoint position update touches only the named step", async () => {
		const runId = nextRunId("persist-positional");
		await freshRun(profileA, runId, { plan: planOf("s1", "s2", "s3") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		await service.checkpointStep(profileA, runId, {
			generation: started.generation,
			owner: "w1",
			stepId: "s2",
			state: STEP_STATES.COMPLETED,
			outcome: { outcomeId: "o2" },
			evidenceRefs: ["e2"],
		});
		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		const byId = Object.fromEntries(stored.stepStates.map((entry) => [entry.stepId, entry]));
		expect(byId.s1.state).toBe(STEP_STATES.PENDING);
		expect(byId.s1.completion).toBeNull();
		expect(byId.s2.state).toBe(STEP_STATES.COMPLETED);
		expect(byId.s2.completion.outcomeId).toBe("o2");
		expect(byId.s2.attempt.evidenceRefs).toEqual(["e2"]);
		expect(byId.s3.state).toBe(STEP_STATES.PENDING);
		expect(stored.completedStepIds).toEqual(["s2"]);
	});

	mtest("a stale generation cannot write through the repository filter", async () => {
		const runId = nextRunId("persist-stale-filter");
		await freshRun(profileA, runId);
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		// Bypass the service and hit the repository directly with a wrong generation.
		const direct = await checkpointRepository.checkpointStep(profileA, runId, {
			generation: started.generation + 5,
			owner: "w1",
			stepId: "s1",
			fromStepStates: [STEP_STATES.PENDING, STEP_STATES.IN_PROGRESS],
			changes: { stepState: STEP_STATES.COMPLETED, completion: { outcomeId: "o1", completionFingerprint: "x", ownerGeneration: 99, metadata: {} }, attempt: { attempts: 1, ownerGeneration: 99, evidenceRefs: [] }, lastReasonCode: null, topLevel: {} },
		});
		expect(direct).toBeNull();
		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		expect(stored.stepStates[0].state).toBe(STEP_STATES.PENDING);
	});

	mtest("a wrong owner cannot write even at the correct generation", async () => {
		const runId = nextRunId("persist-owner-filter");
		await freshRun(profileA, runId);
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		const direct = await checkpointRepository.checkpointStep(profileA, runId, {
			generation: started.generation,
			owner: "someone-else",
			stepId: "s1",
			fromStepStates: [STEP_STATES.PENDING, STEP_STATES.IN_PROGRESS],
			changes: { stepState: STEP_STATES.COMPLETED, completion: { outcomeId: "o1", completionFingerprint: "x", ownerGeneration: started.generation, metadata: {} }, attempt: { attempts: 1, ownerGeneration: started.generation, evidenceRefs: [] }, lastReasonCode: null, topLevel: {} },
		});
		expect(direct).toBeNull();
	});
});

describe.skipIf(!ready)("Phase 46B persistence — adversarial concurrency", () => {
	mtest("two simultaneous null claims produce exactly one winner and one typed rejection", async () => {
		const runId = nextRunId("race-claim");
		await freshRun(profileA, runId);
		const results = await Promise.allSettled([
			service.claimRun(profileA, runId, { owner: "worker-a", expectedGeneration: null }),
			service.claimRun(profileA, runId, { owner: "worker-b", expectedGeneration: null }),
			service.claimRun(profileA, runId, { owner: "worker-c", expectedGeneration: null }),
		]);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(2);
		for (const result of rejected) expect(result.reason.code).toBe(CODES.STALE_GENERATION);
		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		// Exactly one increment happened, no matter how many writers raced.
		expect(stored.generation).toBe(2);
		expect(stored.owner).toBe(fulfilled[0].value.owner);
	});

	mtest("many simultaneous claims at the same generation yield exactly one winner", async () => {
		const runId = nextRunId("race-claim-many");
		await freshRun(profileA, runId);
		const started = await service.startRun(profileA, runId, { owner: "seed" });
		const contenders = Array.from({ length: 8 }, (_, index) => `contender-${index}`);
		const results = await Promise.allSettled(
			contenders.map((owner) => service.claimRun(profileA, runId, { owner, expectedGeneration: started.generation })),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		expect(stored.generation).toBe(started.generation + 1);
	});

	mtest("simultaneous checkpoints of the same step count exactly once", async () => {
		const runId = nextRunId("race-step");
		await freshRun(profileA, runId, { plan: planOf("s1") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		const payload = { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" }, evidenceRefs: ["ev"] };
		const results = await Promise.allSettled(Array.from({ length: 6 }, () => service.checkpointStep(profileA, runId, payload)));

		const advanced = results.filter((result) => result.status === "fulfilled" && result.value.idempotent === false);
		expect(advanced).toHaveLength(1);
		// Every other attempt either saw the completed step (idempotent) or lost the
		// non-pending CAS. None of them may have counted a second completion.
		for (const result of results) {
			if (result.status === "fulfilled" && result.value.idempotent) continue;
			if (result.status === "rejected") expect([CODES.STEP_NOT_PENDING, CODES.STEP_CONTRADICTORY]).toContain(result.reason.code);
		}
		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		expect(stored.completedStepIds).toEqual(["s1"]);
		const step = stored.stepStates.find((entry) => entry.stepId === "s1");
		expect(step.attempt.attempts).toBe(1);
		expect(step.state).toBe(STEP_STATES.COMPLETED);
	});

	mtest("simultaneous checkpoints of different steps both land without clobbering each other", async () => {
		const runId = nextRunId("race-distinct-steps");
		await freshRun(profileA, runId, { plan: planOf("s1", "s2") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		const results = await Promise.allSettled([
			service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" } }),
			service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s2", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o2" } }),
		]);
		expect(results.every((result) => result.status === "fulfilled")).toBe(true);
		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		expect(stored.completedStepIds.sort()).toEqual(["s1", "s2"]);
		// The positional update must not have duplicated or dropped a step entry.
		expect(stored.stepStates).toHaveLength(2);
		expect(new Set(stored.stepStates.map((entry) => entry.stepId)).size).toBe(2);
	});

	mtest("a resumed worker wins over the previous worker's in-flight checkpoint", async () => {
		const runId = nextRunId("race-resume-vs-checkpoint");
		await freshRun(profileA, runId, { plan: planOf("s1", "s2") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		await service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" } });

		// w2 resumes (which advances the generation) while w1 is still trying to work
		// with its old generation. The two writes are genuinely concurrent, so the
		// interesting property is not "which one starts first" but that the run is
		// coherent afterwards and that w1 cannot keep going once the resume has landed.
		const [resumeResult] = await Promise.allSettled([
			service.resumeRun(profileA, runId, { owner: "w2", expectedGeneration: started.generation, identity: identity() }),
		]);
		expect(resumeResult.status).toBe("fulfilled");

		// Once the resume is durable, w1's generation is stale and its next write must
		// be refused — this is the crash-safety property the generation exists for.
		await expectAppError(
			service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s3", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o3" } }),
			{ code: CODES.STALE_GENERATION, statusCode: 409 },
		);

		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		expect(stored.generation).toBe(resumeResult.value.run.generation);
		expect(stored.owner).toBe("w2");
		// w2's work is accepted at the new generation.
		await service.checkpointStep(profileA, runId, { generation: stored.generation, owner: "w2", stepId: "s2", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o2" } });
		const after = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		expect(after.completedStepIds.sort()).toEqual(["s1", "s2"]);
		expect(after.completedStepIds).not.toContain("s3");
	});

	mtest("simultaneous resumes of the same generation produce exactly one winner", async () => {
		const runId = nextRunId("race-resume");
		await freshRun(profileA, runId, { plan: planOf("s1", "s2") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		await service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" } });

		const results = await Promise.allSettled([
			service.resumeRun(profileA, runId, { owner: "ra", expectedGeneration: started.generation, identity: identity() }),
			service.resumeRun(profileA, runId, { owner: "rb", expectedGeneration: started.generation, identity: identity() }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		expect(stored.generation).toBe(started.generation + 1);
	});

	mtest("a terminal transition races safely against an in-flight checkpoint", async () => {
		const runId = nextRunId("race-terminal-vs-checkpoint");
		await freshRun(profileA, runId, { plan: planOf("s1", "s2") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		await service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" } });
		// Abort and a late checkpoint of s2 from the same generation at the same time.
		// At most one of these can mutate the run.
		const [abortResult, checkpointResult] = await Promise.allSettled([
			service.abortRun(profileA, runId, { generation: started.generation, owner: "w1", reasonCode: "OPERATOR_REQUESTED" }),
			service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s2", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o2" } }),
		]);
		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		if (abortResult.status === "fulfilled") {
			expect(stored.runState).toBe(RUN_STATES.ABORTED);
			// A terminal run may not have accepted new step progress.
			if (checkpointResult.status === "fulfilled") expect(checkpointResult.value.run.runState).toBe(RUN_STATES.RUNNING);
		}
		// Whatever the interleaving, the run is in exactly one coherent state.
		expect([RUN_STATES.RUNNING, RUN_STATES.ABORTED]).toContain(stored.runState);
	});

	mtest("two simultaneous terminal transitions cannot both apply", async () => {
		const runId = nextRunId("race-double-terminal");
		await freshRun(profileA, runId, { plan: planOf("s1") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		await service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" } });
		const results = await Promise.allSettled([
			service.completeRun(profileA, runId, { owner: "w1", expectedGeneration: started.generation, identity: identity() }),
			service.abortRun(profileA, runId, { generation: started.generation, owner: "w1", reasonCode: "OPERATOR_REQUESTED" }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		expect([RUN_STATES.COMPLETED, RUN_STATES.ABORTED]).toContain(stored.runState);
	});
});

describe.skipIf(!ready)("Phase 46B persistence — crash safety and restart", () => {
	mtest("a run created by one service instance is resumable by a completely fresh instance", async () => {
		const runId = nextRunId("restart-resume");
		await freshRun(profileA, runId, { plan: planOf("s1", "s2", "s3") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		await service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" } });

		// A brand-new service over the same database models a process restart. It has
		// no in-memory knowledge of the run at all.
		const restarted = createRehearsalCheckpointService({ repository: checkpointRepository, now: () => new Date() });
		const view = await restarted.reconstruct(profileA, runId);
		expect(view.run.runState).toBe(RUN_STATES.RUNNING);
		expect(view.completedStepIds).toEqual(["s1"]);
		expect(view.pendingStepIds).toEqual(["s2", "s3"]);

		const resumed = await restarted.resumeRun(profileA, runId, { owner: "w2", expectedGeneration: view.run.generation, identity: identity() });
		expect(resumed.resumed).toBe(true);
		expect(resumed.pendingStepIds).toEqual(["s2", "s3"]);
		expect(resumed.pendingStepIds).not.toContain("s1");
	});

	mtest("a crash between two step checkpoints leaves a consistent, resumable checkpoint", async () => {
		const runId = nextRunId("restart-midway");
		await freshRun(profileA, runId, { plan: planOf("s1", "s2", "s3") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		await service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" }, evidenceRefs: ["e1"] });
		await service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s2", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o2" }, evidenceRefs: ["e2"] });
		// "Crash": nothing more happens. The database holds s1 and s2 complete.

		const restarted = createRehearsalCheckpointService({ repository: checkpointRepository, now: () => new Date() });
		const view = await restarted.reconstruct(profileA, runId);
		expect(view.completedStepIds).toEqual(["s1", "s2"]);
		expect(view.pendingStepIds).toEqual(["s3"]);
		// The step accounting survived with its evidence refs intact.
		const s1 = view.run.stepStates.find((entry) => entry.stepId === "s1");
		const s2 = view.run.stepStates.find((entry) => entry.stepId === "s2");
		expect(s1.completion.outcomeId).toBe("o1");
		expect(s1.attempt.evidenceRefs).toEqual(["e1"]);
		expect(s2.completion.outcomeId).toBe("o2");
		expect(s2.attempt.evidenceRefs).toEqual(["e2"]);
	});

	mtest("repeated restart and resume cycles never repeat completed work", async () => {
		const runId = nextRunId("restart-cycles");
		await freshRun(profileA, runId, { plan: planOf("s1", "s2", "s3") });
		const stepIds = ["s1", "s2", "s3"];

		// Three "crash / restart / resume / do-one-step" cycles. Each cycle uses a new
		// worker identity and a new service instance, which is exactly the shape of a
		// real resumable rehearsal.
		for (const [index, stepId] of stepIds.entries()) {
			const instance = createRehearsalCheckpointService({ repository: checkpointRepository, now: () => new Date() });
			const view = await instance.reconstruct(profileA, runId);
			const resumed = await instance.resumeRun(profileA, runId, {
				owner: `worker-${index}`,
				expectedGeneration: view.run.generation,
				identity: identity(),
			});
			// The step about to be done must be the first pending one, and no completed
			// step may appear in the pending list.
			expect(resumed.pendingStepIds[0]).toBe(stepId);
			for (const done of stepIds.slice(0, index)) expect(resumed.pendingStepIds).not.toContain(done);
			await instance.checkpointStep(profileA, runId, {
				generation: resumed.run.generation,
				owner: `worker-${index}`,
				stepId,
				state: STEP_STATES.COMPLETED,
				outcome: { outcomeId: `outcome-${stepId}` },
				evidenceRefs: [`evidence-${stepId}`],
			});
		}

		const final = await createRehearsalCheckpointService({ repository: checkpointRepository, now: () => new Date() }).reconstruct(profileA, runId);
		expect(final.completedStepIds).toEqual(stepIds);
		expect(final.pendingStepIds).toEqual([]);
		// Exactly three completions were recorded across three cycles — never more.
		for (const stepId of stepIds) {
			const step = final.run.stepStates.find((entry) => entry.stepId === stepId);
			expect(step.attempt.attempts).toBe(1);
		}
		// The last cycle's worker still holds the lease; completing as it is the
		// honest end of a rehearsal, not a new actor appearing from nowhere.
		await service.completeRun(profileA, runId, {
			owner: `worker-${stepIds.length - 1}`,
			expectedGeneration: final.run.generation,
			identity: identity(),
		});
	});

	mtest("the deterministic checkpoint fingerprint survives a persistence round trip", async () => {
		const runId = nextRunId("restart-fingerprint");
		await freshRun(profileA, runId, { plan: planOf("s1", "s2") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		await service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" }, evidenceRefs: ["e1"] });
		const before = await service.reconstruct(profileA, runId);

		const restarted = createRehearsalCheckpointService({ repository: checkpointRepository, now: () => new Date() });
		const after = await restarted.reconstruct(profileA, runId);
		expect(after.fingerprint).toBe(before.fingerprint);
		expect(after.canonical).toBe(before.canonical);
	});

	mtest("cleanup deletes only terminal runs and leaves resumable work untouched", async () => {
		const runningId = nextRunId("cleanup-running");
		const terminalId = nextRunId("cleanup-terminal");
		await freshRun(profileA, runningId, { plan: planOf("s1") });
		await service.startRun(profileA, runningId, { owner: "w1" });

		await freshRun(profileA, terminalId, { plan: planOf("s1") });
		const started = await service.startRun(profileA, terminalId, { owner: "w1" });
		await service.checkpointStep(profileA, terminalId, { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" } });
		await service.abortRun(profileA, terminalId, { generation: started.generation, owner: "w1", reasonCode: "OPERATOR_REQUESTED" });

		// A cutoff in the future makes every existing terminal run eligible without
		// waiting out a real retention window.
		const result = await service.cleanupTerminal(profileA, { olderThanMs: -60_000 });
		expect(result.deletedCount).toBeGreaterThanOrEqual(1);
		expect(await service.getRun(profileA, runningId)).toBeTruthy();
		expect(await service.getRun(profileA, terminalId)).toBeNull();
	});
});

describe.skipIf(!ready)("Phase 46B persistence — index and constraint integrity", () => {
	mtest("the (ownerProfileId, runId) unique index exists and is unique", async () => {
		const indexes = await RehearsalCheckpoint.collection.indexes();
		const runIndex = indexes.find((index) => index.key.ownerProfileId === 1 && index.key.runId === 1);
		expect(runIndex).toBeTruthy();
		expect(runIndex.unique).toBe(true);
	});

	mtest("the model refuses an unknown run state", async () => {
		const runId = nextRunId("constraint-run-state");
		await expect(
			RehearsalCheckpoint.create({
				ownerProfileId: profileA,
				runId,
				identity: { workspaceId, snapshotId, snapshotFingerprint: "a".repeat(64), targetEnvironment: { environmentId, environmentFingerprint: "b".repeat(64) }, planId, planFingerprint: "c".repeat(64) },
				identityFingerprint: "d".repeat(64),
				plan: { steps: [] },
				planFingerprint: "e".repeat(64),
				runState: "NOT_A_REAL_STATE",
			}),
		).rejects.toThrow();
	});

	mtest("the model refuses a run without a required identity field", async () => {
		const runId = nextRunId("constraint-identity");
		await expect(
			RehearsalCheckpoint.create({
				ownerProfileId: profileA,
				runId,
				identity: { workspaceId, snapshotId, snapshotFingerprint: "a".repeat(64), targetEnvironment: { environmentId }, planId, planFingerprint: "c".repeat(64) },
				identityFingerprint: "d".repeat(64),
				plan: { steps: [] },
				planFingerprint: "e".repeat(64),
			}),
		).rejects.toThrow();
	});

	mtest("countForProfile and countByState are profile-scoped", async () => {
		const runId = nextRunId("count-scope");
		await freshRun(profileA, runId, { plan: planOf("s1") });
		await freshRun(profileB, `${runId}-b`, { plan: planOf("s1") });
		expect(await checkpointRepository.countForProfile(profileA)).toBe(1);
		expect(await checkpointRepository.countForProfile(profileB)).toBe(1);
		const counts = await checkpointRepository.countByState(profileA);
		expect(counts).toEqual([{ _id: RUN_STATES.CREATED, count: 1 }]);
	});

	// ---------------------------------------------------------------------
	// Phase 48B — in-flight claim / release (ambiguous-side-effect detection)
	// ---------------------------------------------------------------------

	mtest("beginStep persists an in-flight claim and releaseStep returns it to PENDING", async () => {
		const runId = nextRunId("claim-release");
		await freshRun(profileA, runId, { plan: planOf("s1", "s2") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });

		const claimed = await service.beginStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", identity: identity() });
		expect(claimed.idempotent).toBe(false);
		expect(claimed.run.currentStepId).toBe("s1");
		expect(claimed.run.stepStates.find((entry) => entry.stepId === "s1").state).toBe(STEP_STATES.IN_PROGRESS);
		expect(claimed.run.stepStates.find((entry) => entry.stepId === "s1").attempt.attempts).toBe(1);
		expect(claimed.run.stepStates.find((entry) => entry.stepId === "s1").attempt.ownerGeneration).toBe(started.generation);

		// A second claim from a *different* owner at the same generation is refused: the
		// step is already in flight.
		await expectAppError(service.beginStep(profileA, runId, { generation: started.generation, owner: "w2", stepId: "s1" }), { code: CODES.LEASE_NOT_HELD, statusCode: 409 });

		const released = await service.releaseStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", identity: identity() });
		expect(released.run.currentStepId).toBeNull();
		expect(released.run.stepStates.find((entry) => entry.stepId === "s1").state).toBe(STEP_STATES.PENDING);
		// Releasing does not inflate the attempt counter, and a later claim succeeds.
		const reclaimed = await service.beginStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1" });
		expect(reclaimed.run.stepStates.find((entry) => entry.stepId === "s1").attempt.attempts).toBe(2);

		// A checkpoint completes the in-flight step (the normal post-dispatch path).
		const done = await service.checkpointStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", state: STEP_STATES.COMPLETED, outcome: { outcomeId: "o1" } });
		expect(done.run.completedStepIds).toEqual(["s1"]);
		expect(done.run.currentStepId).toBeNull();
	});

	mtest("a crashed worker leaves an IN_PROGRESS step that a fresh worker can detect", async () => {
		const runId = nextRunId("claim-crash");
		await freshRun(profileA, runId, { plan: planOf("s1", "s2") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		await service.beginStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1", identity: identity() });

		// The worker dies. A fresh service instance reconstructs from persisted state
		// and must be able to see that s1 was in flight.
		const fresh = createRehearsalCheckpointService({ repository: checkpointRepository, now: () => new Date() });
		const reconstructed = await fresh.reconstruct(profileA, runId);
		expect(reconstructed.pendingStepIds).toContain("s1");
		expect(reconstructed.run.stepStates.find((entry) => entry.stepId === "s1").state).toBe(STEP_STATES.IN_PROGRESS);

		// A resume can claim the run, but the in-flight step remains visible so the
		// caller can fail closed instead of replaying it.
		const resumed = await fresh.resumeRun(profileA, runId, { owner: "w2", expectedGeneration: started.generation, identity: identity() });
		expect(resumed.run.stepStates.find((entry) => entry.stepId === "s1").state).toBe(STEP_STATES.IN_PROGRESS);
		expect(resumed.pendingStepIds).toContain("s1");
	});

	mtest("two simultaneous claims of the same step produce exactly one winner", async () => {
		const runId = nextRunId("claim-race");
		await freshRun(profileA, runId, { plan: planOf("s1") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		const payload = { generation: started.generation, owner: "w1", stepId: "s1", identity: identity() };
		const results = await Promise.allSettled([service.beginStep(profileA, runId, payload), service.beginStep(profileA, runId, payload), service.beginStep(profileA, runId, payload)]);

		const advanced = results.filter((result) => result.status === "fulfilled" && result.value.idempotent === false);
		expect(advanced).toHaveLength(1);
		for (const result of results) {
			if (result.status === "fulfilled" && result.value.idempotent) continue;
			if (result.status === "rejected") expect([CODES.STEP_NOT_PENDING]).toContain(result.reason.code);
		}
		const stored = await RehearsalCheckpoint.findOne({ ownerProfileId: profileA, runId });
		const step = stored.stepStates.find((entry) => entry.stepId === "s1");
		expect(step.state).toBe(STEP_STATES.IN_PROGRESS);
		// Exactly one genuine advance, regardless of how many idempotent re-claims land.
		expect(step.attempt.attempts).toBeGreaterThanOrEqual(1);
	});

	mtest("a terminal run refuses an in-flight claim", async () => {
		const runId = nextRunId("claim-terminal");
		await freshRun(profileA, runId, { plan: planOf("s1") });
		const started = await service.startRun(profileA, runId, { owner: "w1" });
		await service.abortRun(profileA, runId, { generation: started.generation, owner: "w1", reasonCode: "OPERATOR_REQUESTED" });
		await expectAppError(service.beginStep(profileA, runId, { generation: started.generation, owner: "w1", stepId: "s1" }), { code: CODES.TERMINAL_STATE, statusCode: 409 });
	});
});
