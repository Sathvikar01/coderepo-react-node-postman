import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { ExecutionHistory } from "../history/history.model.js";
import { historyRepository } from "../history/history.repository.js";

const MONGO_URI = "mongodb://127.0.0.1:27017/request_desk_phase2_test";
const databaseName = new URL(MONGO_URI).pathname.slice(1);

let connected = false;
if (databaseName.endsWith("_test")) {
	try {
		await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 750 });
		connected = true;
	} catch {
		connected = false;
	}
}

const profileId = new mongoose.Types.ObjectId();

function admission(executionId = randomUUID(), ownerProfileId = profileId) {
	return {
		ownerProfileId,
		executionId,
		fingerprint: `fp-${executionId}`,
		fingerprintKeyId: "v1",
		instanceId: "test-instance",
		status: "running",
		effectCertainty: "not_dispatched",
		persistence: { state: "saved" },
		request: { name: "Probe", method: "GET" },
		context: { tabId: "tab-1", draftVersion: 1 },
		snapshot: { displayUrl: "https://example.test/probe" },
		startedAt: new Date(),
	};
}

describe.skipIf(!connected)("history terminal compare-and-set", () => {
	beforeAll(async () => {
		await ExecutionHistory.init();
	});
	beforeEach(async () => {
		await ExecutionHistory.deleteMany({ ownerProfileId: profileId });
	});
	afterAll(async () => {
		if (mongoose.connection.readyState !== 0) {
			await ExecutionHistory.deleteMany({ ownerProfileId: profileId }).catch(() => {});
			await mongoose.disconnect();
		}
	});

	test(
		"exactly one of two concurrent terminal writes wins",
		async () => {
			const executionId = randomUUID();
			await historyRepository.insertAdmission(admission(executionId));
			const expiresAt = new Date(Date.now() + 60_000);

			const [first, second] = await Promise.all([
				historyRepository.finalize(profileId, executionId, { status: "terminal", outcome: "response", expiresAt }),
				historyRepository.finalize(profileId, executionId, { status: "terminal", outcome: "cancelled", expiresAt }),
			]);

			const winners = [first, second].filter(Boolean);
			expect(winners).toHaveLength(1);
			const stored = await historyRepository.findByExecutionId(profileId, executionId);
			expect(stored.status).toBe("terminal");
			expect(stored.outcome).toBe(winners[0].outcome);

			const late = await historyRepository.finalize(profileId, executionId, { status: "terminal", outcome: "timeout", expiresAt });
			expect(late).toBeNull();
			const unchanged = await historyRepository.findByExecutionId(profileId, executionId);
			expect(unchanged.outcome).toBe(winners[0].outcome);
		},
		15000,
	);

	test(
		"finalization is scoped to the owning profile",
		async () => {
			const executionId = randomUUID();
			await historyRepository.insertAdmission(admission(executionId));
			const otherProfile = new mongoose.Types.ObjectId();
			const stolen = await historyRepository.finalize(otherProfile, executionId, { status: "terminal", outcome: "response" });
			expect(stolen).toBeNull();
			const stored = await historyRepository.findByExecutionId(profileId, executionId);
			expect(stored.status).toBe("running");
		},
		15000,
	);
});

if (!connected) {
	test.skip("history terminal compare-and-set requires a local MongoDB", () => {});
}
