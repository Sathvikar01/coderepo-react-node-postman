import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { MinimizationJob } from "./minimization.model.js";
import { minimizationRepository } from "./minimization.repository.js";

// Issue #76 — terminal status writes must be atomic compare-and-set operations.
//
// The shape check proves the production repository builds a single conditional
// findOneAndUpdate keyed on the expected source status; the database suite proves the
// real model rejects stale terminal writes. Persistence checks skip cleanly when no
// database is reachable, matching the rest of the suite.

describe("minimizationRepository.transition filter", () => {
	test("issues one conditional findOneAndUpdate that requires the expected source status", async () => {
		const original = MinimizationJob.findOneAndUpdate;
		const calls = [];
		MinimizationJob.findOneAndUpdate = (filter, update, options) => {
			calls.push({ filter, update, options });
			return { lean: async () => ({ status: "completed" }) };
		};
		try {
			const result = await minimizationRepository.transition("profile-1", "job-1", "running", {
				status: "completed",
			});
			expect(result).toEqual({ status: "completed" });
			expect(calls).toHaveLength(1);
			expect(calls[0].filter).toEqual({ ownerProfileId: "profile-1", jobId: "job-1", status: "running" });
			expect(calls[0].update).toEqual({ $set: { status: "completed" } });
			expect(calls[0].options).toEqual({ new: true });
		} finally {
			MinimizationJob.findOneAndUpdate = original;
		}
	});
});

const ready = await (async () => {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		if (await connectTestDatabase()) return true;
	}
	return false;
})();
if (ready) await MinimizationJob.init();

const profileId = new mongoose.Types.ObjectId();

function runningJob(jobId = randomUUID(), ownerProfileId = profileId) {
	return {
		ownerProfileId,
		jobId,
		schemaVersion: 1,
		kind: "tracer.minimization-job",
		sourceExecutionId: randomUUID(),
		status: "running",
		predicate: { type: "status", equals: 500 },
		targetMode: "execution",
		probeBudget: 12,
		result: null,
		error: null,
		startedAt: new Date(),
		finishedAt: null,
		expiresAt: new Date(Date.now() + 60_000),
	};
}

const TEST_TIMEOUT_MS = 20000;
const mtest = (name, fn) => test(name, fn, TEST_TIMEOUT_MS);

describe.skipIf(!ready)("minimization terminal compare-and-set", () => {
	beforeAll(async () => {
		await MinimizationJob.init();
	});
	beforeEach(async () => {
		await MinimizationJob.deleteMany({ ownerProfileId: profileId });
	});
	afterAll(async () => {
		if (mongoose.connection.readyState !== 0) await disconnectTestDatabase();
	});

	mtest("running transitions to completed, failed, and cancelled exactly once", async () => {
		for (const status of ["completed", "failed", "cancelled"]) {
			const jobId = randomUUID();
			await minimizationRepository.create(runningJob(jobId));
			const applied = await minimizationRepository.transition(profileId, jobId, "running", {
				status,
				finishedAt: new Date(),
			});
			expect(applied.status).toBe(status);
			const persisted = await minimizationRepository.get(profileId, jobId);
			expect(persisted.status).toBe(status);
			expect(await minimizationRepository.transition(profileId, jobId, "running", { status: "completed" })).toBeNull();
			expect((await minimizationRepository.get(profileId, jobId)).status).toBe(status);
		}
	});

	mtest("exactly one of concurrent completion and cancellation wins", async () => {
		const jobId = randomUUID();
		await minimizationRepository.create(runningJob(jobId));
		const finishedAt = new Date();
		const [first, second] = await Promise.all([
			minimizationRepository.transition(profileId, jobId, "running", {
				status: "completed",
				result: { minimal: true },
				error: null,
				finishedAt,
			}),
			minimizationRepository.transition(profileId, jobId, "running", {
				status: "cancelled",
				result: null,
				error: { code: "MINIMIZATION_CANCELLED" },
				finishedAt,
			}),
		]);

		const winners = [first, second].filter(Boolean);
		expect(winners).toHaveLength(1);
		const persisted = await minimizationRepository.get(profileId, jobId);
		expect(persisted.status).toBe(winners[0].status);

		const late = await minimizationRepository.transition(profileId, jobId, "running", { status: "failed" });
		expect(late).toBeNull();
		expect((await minimizationRepository.get(profileId, jobId)).status).toBe(winners[0].status);
	});

	mtest("terminal transitions cannot run and are scoped to the owning profile", async () => {
		const jobId = randomUUID();
		await minimizationRepository.create(runningJob(jobId));
		await minimizationRepository.transition(profileId, jobId, "running", { status: "failed", finishedAt: new Date() });

		const otherProfile = new mongoose.Types.ObjectId();
		expect(await minimizationRepository.transition(otherProfile, jobId, "running", { status: "completed" })).toBeNull();
		expect(await minimizationRepository.transition(profileId, jobId, "running", { status: "completed" })).toBeNull();
		expect((await minimizationRepository.get(profileId, jobId)).status).toBe("failed");
	});
});

if (!ready) {
	test.skip("minimization terminal compare-and-set requires a local MongoDB", () => {});
}
