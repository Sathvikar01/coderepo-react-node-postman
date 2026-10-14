import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { CollectionRun } from "./collection-run.model.js";
import { collectionRunRepository } from "./collection-run.repository.js";

// Issue #75 — collection-run terminal status writes must be atomic compare-and-set
// operations. The shape check proves the production repository builds a single
// conditional findOneAndUpdate keyed on the expected source status; the database suite
// proves the real model rejects stale terminal and terminal → terminal writes.
// Persistence checks skip cleanly when no database is reachable.

describe("collectionRunRepository.transition filter", () => {
	test("issues one conditional findOneAndUpdate that requires the expected source status", async () => {
		const original = CollectionRun.findOneAndUpdate;
		const calls = [];
		CollectionRun.findOneAndUpdate = (filter, update, options) => {
			calls.push({ filter, update, options });
			return { lean: async () => ({ status: "completed" }) };
		};
		try {
			const result = await collectionRunRepository.transition("profile-1", "run-1", "running", {
				status: "completed",
			});
			expect(result).toEqual({ status: "completed" });
			expect(calls).toHaveLength(1);
			expect(calls[0].filter).toEqual({ ownerProfileId: "profile-1", runId: "run-1", status: "running" });
			expect(calls[0].update).toEqual({ $set: { status: "completed" } });
			expect(calls[0].options).toEqual({ new: true });
		} finally {
			CollectionRun.findOneAndUpdate = original;
		}
	});

	test("refuses to leave a terminal state without touching the database", async () => {
		const original = CollectionRun.findOneAndUpdate;
		let called = false;
		CollectionRun.findOneAndUpdate = () => {
			called = true;
			return { lean: async () => ({}) };
		};
		try {
			for (const expectedStatus of ["completed", "cancelled", "failed"]) {
				expect(await collectionRunRepository.transition("profile-1", "run-1", expectedStatus, { status: "failed" })).toBeNull();
			}
			expect(called).toBe(false);
		} finally {
			CollectionRun.findOneAndUpdate = original;
		}
	});
});

const ready = await (async () => {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		if (await connectTestDatabase()) return true;
	}
	return false;
})();
if (ready) await CollectionRun.init();

const profileId = new mongoose.Types.ObjectId();

function runningRun(runId = randomUUID(), ownerProfileId = profileId) {
	return {
		ownerProfileId,
		runId,
		schemaVersion: 1,
		kind: "tracer.collection-run",
		collectionId: "64b000000000000000000001",
		collectionRevision: 1,
		collectionName: "Orders API",
		environmentId: null,
		environmentRevision: null,
		input: { selection: { mode: "collection" }, iterations: 1, stopOnFailure: true, variables: [] },
		status: "running",
		stopReason: null,
		results: [],
		summary: null,
		error: null,
		startedAt: new Date(),
		finishedAt: null,
		expiresAt: new Date(Date.now() + 60_000),
	};
}

const TEST_TIMEOUT_MS = 20000;
const mtest = (name, fn) => test(name, fn, TEST_TIMEOUT_MS);

describe.skipIf(!ready)("collection run terminal compare-and-set", () => {
	beforeAll(async () => {
		await CollectionRun.init();
	});
	beforeEach(async () => {
		await CollectionRun.deleteMany({ ownerProfileId: profileId });
	});
	afterAll(async () => {
		if (mongoose.connection.readyState !== 0) await disconnectTestDatabase();
	});

	mtest("a running run transitions to completed, failed, and cancelled exactly once", async () => {
		for (const status of ["completed", "failed", "cancelled"]) {
			const runId = randomUUID();
			await collectionRunRepository.create(runningRun(runId));
			const applied = await collectionRunRepository.transition(profileId, runId, "running", {
				status,
				finishedAt: new Date(),
			});
			expect(applied.status).toBe(status);
			expect((await collectionRunRepository.get(profileId, runId)).status).toBe(status);
			expect(await collectionRunRepository.transition(profileId, runId, "running", { status: "completed" })).toBeNull();
			expect((await collectionRunRepository.get(profileId, runId)).status).toBe(status);
		}
	});

	mtest("exactly one of concurrent completion and cancellation wins", async () => {
		const runId = randomUUID();
		await collectionRunRepository.create(runningRun(runId));
		const finishedAt = new Date();
		const [first, second] = await Promise.all([
			collectionRunRepository.transition(profileId, runId, "running", {
				status: "completed",
				stopReason: "completed",
				finishedAt,
			}),
			collectionRunRepository.transition(profileId, runId, "running", {
				status: "cancelled",
				stopReason: "cancelled",
				finishedAt,
			}),
		]);

		const winners = [first, second].filter(Boolean);
		expect(winners).toHaveLength(1);
		const persisted = await collectionRunRepository.get(profileId, runId);
		expect(persisted.status).toBe(winners[0].status);

		const late = await collectionRunRepository.transition(profileId, runId, "running", { status: "failed" });
		expect(late).toBeNull();
		expect((await collectionRunRepository.get(profileId, runId)).status).toBe(winners[0].status);
	});

	mtest("recovery cannot overwrite a completed run", async () => {
		const runId = randomUUID();
		await collectionRunRepository.create(runningRun(runId));
		await collectionRunRepository.transition(profileId, runId, "running", { status: "completed", finishedAt: new Date() });

		const recovery = await collectionRunRepository.transition(profileId, runId, "running", {
			status: "failed",
			stopReason: "interrupted",
		});
		expect(recovery).toBeNull();
		expect((await collectionRunRepository.get(profileId, runId)).status).toBe("completed");
	});

	mtest("terminal → terminal is refused and writes stay scoped to the owning profile", async () => {
		const runId = randomUUID();
		await collectionRunRepository.create(runningRun(runId));
		await collectionRunRepository.transition(profileId, runId, "running", { status: "failed", finishedAt: new Date() });

		const otherProfile = new mongoose.Types.ObjectId();
		expect(await collectionRunRepository.transition(otherProfile, runId, "running", { status: "completed" })).toBeNull();
		expect(await collectionRunRepository.transition(profileId, runId, "failed", { status: "completed" })).toBeNull();
		expect(await collectionRunRepository.transition(profileId, runId, "running", { status: "completed" })).toBeNull();
		expect((await collectionRunRepository.get(profileId, runId)).status).toBe("failed");
	});
});

if (!ready) {
	test.skip("collection run terminal compare-and-set requires a local MongoDB", () => {});
}
