import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { connectTestDatabase, disconnectTestDatabase } from "../../../shared/utils/test-db.js";
import { ExecutionHistory } from "../../history/history.model.js";
import { regressionRepository } from "./regression.repository.js";

const ready = await (async () => {
	// The shared helper has a tight server-selection window; retry so a cold database start
	// does not silently turn the persistence checks into skips.
	for (let attempt = 0; attempt < 5; attempt += 1) {
		if (await connectTestDatabase()) return true;
	}
	return false;
})();
if (ready) await ExecutionHistory.init();

const profileA = new mongoose.Types.ObjectId();
const profileB = new mongoose.Types.ObjectId();
const LINEAGE = { type: "collection", collectionId: "col-1", collectionRevision: 3, name: "Orders", requestId: "req-1" };

function admission(id, second, { ownerProfileId = profileA, source = LINEAGE, ...overrides } = {}) {
	const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, second));
	const record = {
		ownerProfileId,
		executionId: id,
		fingerprint: `fp-${id}`,
		fingerprintKeyId: "v1",
		instanceId: "test-instance",
		status: "terminal",
		outcome: "response",
		effectCertainty: "may_have_reached_target",
		persistence: { state: "saved" },
		visible: true,
		expiresAt: null,
		request: { name: "List orders", method: "GET" },
		context: { tabId: "tab-1", draftVersion: 1, source },
		snapshot: { displayUrl: "https://api.test/orders" },
		response: { status: 200 },
		startedAt,
		finishedAt: new Date(startedAt.getTime() + 250),
		...overrides,
	};
	return record;
}

describe.skipIf(!ready)("regression repository", () => {
	beforeAll(async () => {
		await connectTestDatabase();
		await ExecutionHistory.init();
	});
	beforeEach(async () => {
		await ExecutionHistory.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } });
	});
	afterAll(async () => {
		if (mongoose.connection.readyState !== 0) {
			await ExecutionHistory.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } }).catch(() => {});
			await disconnectTestDatabase();
		}
	});

	test("findAnchor is scoped to the requesting profile", async () => {
		await ExecutionHistory.create(admission("shared", 10, { request: { name: "A copy" } }));
		await ExecutionHistory.create(admission("shared", 10, { ownerProfileId: profileB, request: { name: "B copy" } }));
		await ExecutionHistory.create(admission("only-b", 20, { ownerProfileId: profileB }));

		const forA = await regressionRepository.findAnchor(profileA, "shared");
		expect(String(forA.ownerProfileId)).toBe(String(profileA));
		expect(forA.request.name).toBe("A copy");
		const forB = await regressionRepository.findAnchor(profileB, "shared");
		expect(forB.request.name).toBe("B copy");
		expect(await regressionRepository.findAnchor(profileA, "only-b")).toBeNull();
		expect(await regressionRepository.findAnchor(profileA, "missing")).toBeNull();
	});

	test("findLineageWindow keeps one saved request lineage, one profile, and the window key bound", async () => {
		const anchor = admission("anchor", 30, { response: { status: 500 } });
		await ExecutionHistory.create(admission("in-1", 10));
		await ExecutionHistory.create(admission("in-2", 20));
		await ExecutionHistory.create(admission("anchor", 30, { response: { status: 500 } }));
		await ExecutionHistory.create(admission("after-anchor", 40));
		await ExecutionHistory.create(admission("other-request", 15, { source: { ...LINEAGE, requestId: "req-2" } }));
		await ExecutionHistory.create(admission("other-collection", 15, { source: { ...LINEAGE, collectionId: "col-2" } }));
		await ExecutionHistory.create(admission("scratch", 15, { source: { type: "scratch" } }));
		await ExecutionHistory.create(admission("other-profile", 12, { ownerProfileId: profileB }));

		const window = await regressionRepository.findLineageWindow(
			profileA,
			{ collectionId: "col-1", requestId: "req-1" },
			{ startedAt: anchor.startedAt, executionId: anchor.executionId },
			10,
		);
		expect(window.map((record) => record.executionId)).toEqual(["anchor", "in-2", "in-1"]);
		expect(window.every((record) => String(record.ownerProfileId) === String(profileA))).toBe(true);
	});

	test("the window counts hidden, expired, and running lineage records as gaps", async () => {
		const anchor = admission("anchor", 40, { response: { status: 500 } });
		await ExecutionHistory.create(admission("hidden", 10, { visible: false }));
		await ExecutionHistory.create(admission("expired", 20, { expiresAt: new Date(Date.now() - 60_000) }));
		await ExecutionHistory.create(admission("running", 30, { status: "running", outcome: null, finishedAt: null, response: null }));
		await ExecutionHistory.create(admission("anchor", 40, { response: { status: 500 } }));

		const window = await regressionRepository.findLineageWindow(
			profileA,
			{ collectionId: "col-1", requestId: "req-1" },
			{ startedAt: anchor.startedAt, executionId: anchor.executionId },
			10,
		);
		expect(window.map((record) => record.executionId).sort()).toEqual(["anchor", "expired", "hidden", "running"]);
	});

	test("the window is bounded to the newest records at or before the anchor", async () => {
		const anchor = admission("anchor", 60, { response: { status: 500 } });
		for (let second = 50; second >= 10; second -= 10) {
			await ExecutionHistory.create(admission(`in-${second}`, second));
		}
		await ExecutionHistory.create(admission("anchor", 60, { response: { status: 500 } }));

		const window = await regressionRepository.findLineageWindow(
			profileA,
			{ collectionId: "col-1", requestId: "req-1" },
			{ startedAt: anchor.startedAt, executionId: anchor.executionId },
			3,
		);
		expect(window.map((record) => record.executionId)).toEqual(["anchor", "in-50", "in-40"]);
	});
});

describe.skipIf(ready)("regression repository without a database", () => {
	test("documents that the persistence checks were skipped", () => {
		expect(ready).toBe(false);
	});
});
