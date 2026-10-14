import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import mongoose from "mongoose";
import { getConfig, initConfig } from "../../shared/config/index.js";
import { profileRepository } from "../profiles/profile.repository.js";
import { ExecutionHistory } from "./history.model.js";
import { RETENTION_BATCH_SIZE, historyRepository } from "./history.repository.js";
import { historyService } from "./history.service.js";

const MONGO_URI = "mongodb://127.0.0.1:27017/request_desk_history_retention_test";
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

process.env.MONGODB_URI = process.env.MONGODB_URI || MONGO_URI;
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "retention-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "retention-test-jwt-secret";
initConfig();

const PROFILE_A = new mongoose.Types.ObjectId();
const PROFILE_B = new mongoose.Types.ObjectId();
const PROFILE_C = new mongoose.Types.ObjectId();
const TEST_N = 3;
const originalRetained = getConfig().execution.retainedBodyRecords;

function historyDoc(ownerProfileId, startedAt, overrides = {}) {
	return {
		ownerProfileId,
		executionId: randomUUID(),
		fingerprint: `fp-${randomUUID()}`,
		fingerprintKeyId: "v1",
		instanceId: "retention-test",
		status: "terminal",
		outcome: "response",
		effectCertainty: "may_have_reached_target",
		persistence: { state: "saved" },
		request: { name: "Probe", method: "GET" },
		context: { tabId: "tab-1", draftVersion: 1 },
		snapshot: { displayUrl: "https://example.test/probe" },
		response: { status: 200, body: { encoding: "utf8", value: "payload" } },
		startedAt,
		finishedAt: startedAt,
		expiresAt: null,
		visible: true,
		...overrides,
	};
}

// Seeds records oldest-first so index 0 is the oldest and the last index is the newest.
async function seed(ownerProfileId, count, { startMs = 0, overrides = () => ({}) } = {}) {
	const docs = [];
	for (let index = 0; index < count; index += 1) {
		docs.push(historyDoc(ownerProfileId, new Date(startMs + index * 1000), overrides(index)));
	}
	const inserted = await ExecutionHistory.insertMany(docs);
	return inserted;
}

function bodyValue(executionId) {
	return ExecutionHistory.findOne({ executionId }).lean().then((record) => record?.response?.body?.value);
}

describe.skipIf(!connected)("history retention is set-based", () => {
	beforeAll(async () => {
		await ExecutionHistory.init();
	});
	beforeEach(async () => {
		getConfig().execution.retainedBodyRecords = TEST_N;
		await ExecutionHistory.deleteMany({});
	});
	afterAll(async () => {
		getConfig().execution.retainedBodyRecords = originalRetained;
		if (mongoose.connection.readyState !== 0) {
			await ExecutionHistory.deleteMany({}).catch(() => {});
			await mongoose.disconnect();
		}
	});

	test(
		"a profile with fewer than N records trims nothing",
		async () => {
			const docs = await seed(PROFILE_A, TEST_N - 1);
			expect(await historyService.retentionPass()).toBe(0);
			for (const doc of docs) expect(await bodyValue(doc.executionId)).toBe("payload");
		},
		15000,
	);

	test(
		"a profile with N+K records trims only the oldest K",
		async () => {
			const docs = await seed(PROFILE_A, TEST_N + 2);
			expect(await historyService.retentionPass()).toBe(2);

			expect(await bodyValue(docs[0].executionId)).toBe("");
			expect(await bodyValue(docs[1].executionId)).toBe("");
			for (const doc of docs.slice(2)) expect(await bodyValue(doc.executionId)).toBe("payload");

			const trimmed = await ExecutionHistory.find({ "response.body.value": "" }).lean();
			expect(trimmed.map((record) => record.response.body.truncated)).toEqual([true, true]);
			expect(trimmed.map((record) => record.response.body.omittedReason)).toEqual(["retention", "retention"]);
			expect(await ExecutionHistory.countDocuments({ ownerProfileId: PROFILE_A })).toBe(TEST_N + 2);
		},
		15000,
	);

	test(
		"another profile's records do not change a profile's allowance",
		async () => {
			const a = await seed(PROFILE_A, TEST_N + 1);
			const b = await seed(PROFILE_B, TEST_N - 1);

			expect(await historyService.retentionPass()).toBe(1);

			expect(await bodyValue(a[0].executionId)).toBe("");
			for (const doc of a.slice(1)) expect(await bodyValue(doc.executionId)).toBe("payload");
			for (const doc of b) expect(await bodyValue(doc.executionId)).toBe("payload");
		},
		15000,
	);

	test(
		"multiple profiles with excess are handled in a single pass",
		async () => {
			const a = await seed(PROFILE_A, TEST_N + 2);
			const b = await seed(PROFILE_B, TEST_N + 1);
			const c = await seed(PROFILE_C, TEST_N - 1);

			expect(await historyService.retentionPass()).toBe(3);

			expect(await bodyValue(a[0].executionId)).toBe("");
			expect(await bodyValue(a[1].executionId)).toBe("");
			for (const doc of a.slice(2)) expect(await bodyValue(doc.executionId)).toBe("payload");
			expect(await bodyValue(b[0].executionId)).toBe("");
			for (const doc of b.slice(1)) expect(await bodyValue(doc.executionId)).toBe("payload");
			for (const doc of c) expect(await bodyValue(doc.executionId)).toBe("payload");
		},
		15000,
	);

	test(
		"running and hidden records are ignored and do not consume allowance",
		async () => {
			const base = Date.now() - 100_000;
			const running = await seed(PROFILE_A, 1, {
				startMs: base,
				overrides: () => ({ status: "running", outcome: null, finishedAt: null }),
			});
			const hidden = await seed(PROFILE_A, 1, { startMs: base + 1, overrides: () => ({ visible: false }) });
			const visible = await seed(PROFILE_A, TEST_N + 1, { startMs: base + 1000 });

			expect(await historyService.retentionPass()).toBe(1);

			expect(await bodyValue(running[0].executionId)).toBe("payload");
			expect(await bodyValue(hidden[0].executionId)).toBe("payload");
			expect(await bodyValue(visible[0].executionId)).toBe("");
			for (const doc of visible.slice(1)) expect(await bodyValue(doc.executionId)).toBe("payload");
		},
		15000,
	);

	test(
		"already-trimmed and body-less records are ignored",
		async () => {
			const docs = await seed(PROFILE_A, TEST_N + 1);
			await ExecutionHistory.updateOne(
				{ executionId: docs[0].executionId },
				{ $set: { "response.body.value": "", "response.body.truncated": true, "response.body.omittedReason": "retention" } },
			);
			const bodyLess = await seed(PROFILE_A, 1, { startMs: -1000, overrides: () => ({ response: null }) });

			// Eligible records are docs[1..TEST_N] (exactly N). Neither the pre-trimmed
			// oldest nor the body-less record may occupy a rank and push a record out.
			expect(await historyService.retentionPass()).toBe(0);

			expect(await bodyValue(docs[0].executionId)).toBe("");
			for (const doc of docs.slice(1)) expect(await bodyValue(doc.executionId)).toBe("payload");
			expect(await ExecutionHistory.findById(bodyLess[0]._id).lean()).toMatchObject({ response: null });
		},
		15000,
	);

	test(
		"a batch limit bounds one maintenance pass",
		async () => {
			await seed(PROFILE_A, TEST_N + 5);
			const candidates = await historyRepository.selectRetentionCandidates(TEST_N, 2);
			expect(candidates).toHaveLength(2);
			expect(RETENTION_BATCH_SIZE).toBeGreaterThan(0);

			const untrimmed = await ExecutionHistory.countDocuments({ "response.body.value": "payload" });
			expect(untrimmed).toBe(TEST_N + 5);
		},
		15000,
	);

	test(
		"re-running retention is idempotent",
		async () => {
			const docs = await seed(PROFILE_A, TEST_N + 3);

			expect(await historyService.retentionPass()).toBe(3);
			expect(await historyService.retentionPass()).toBe(0);

			const stored = await ExecutionHistory.find({ ownerProfileId: PROFILE_A }).sort({ startedAt: 1 }).lean();
			expect(stored.map((record) => record.response.body.value)).toEqual(["", "", "", "payload", "payload", "payload"]);
			expect(stored.map((record) => record.response.body.value)).toEqual(
				docs.map((doc, index) => (index < 3 ? "" : "payload")),
			);
		},
		15000,
	);

	test(
		"retention no longer enumerates profiles",
		async () => {
			await seed(PROFILE_A, TEST_N + 1);
			const spy = spyOn(profileRepository, "listIds");
			try {
				await historyService.retentionPass();
				expect(spy).not.toHaveBeenCalled();
			} finally {
				spy.mockRestore();
			}
		},
		15000,
	);
});

if (!connected) {
	test.skip("history retention requires a local MongoDB", () => {});
}
