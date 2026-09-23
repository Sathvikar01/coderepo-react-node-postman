import { describe, expect, test } from "bun:test";
import { createRegressionService } from "./regression.service.js";

const LINEAGE = { type: "collection", collectionId: "col-1", collectionRevision: 3, name: "Orders", requestId: "req-1" };
const PROFILE_A = "profile-a";
const PROFILE_B = "profile-b";

function execution(id, second, overrides = {}) {
	const { httpStatus = 200, ownerProfileId = PROFILE_A, ...rest } = overrides;
	const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, second));
	const record = {
		executionId: id,
		ownerProfileId,
		status: "terminal",
		visible: true,
		expiresAt: null,
		outcome: "response",
		startedAt,
		finishedAt: new Date(startedAt.getTime() + 250),
		response: { status: httpStatus },
		snapshot: { scriptResults: null },
		context: { source: { ...LINEAGE } },
		receipt: {
			schemaVersion: 1,
			kind: "tracer.execution-receipt",
			executionId: id,
			outcome: "response",
			request: { authoredFingerprint: "authored", compiledFingerprint: "compiled" },
			response: { bodyFingerprint: "body", truncated: false, binary: false, contract: { status: httpStatus, headers: [], bodyShape: [] } },
			tests: { counts: { passed: 0, failed: 0, error: 0 }, failureFingerprint: "none" },
		},
	};
	for (const [key, value] of Object.entries(rest)) {
		if (value === undefined) delete record[key];
		else record[key] = value;
	}
	return record;
}

// Deliberately leaky store: it returns records from every profile and ignores window bounds,
// so only service-side scoping keeps a timeline inside its profile and lineage.
function leakyRepository(records) {
	const calls = { findAnchor: [], findLineageWindow: [] };
	return {
		calls,
		async findAnchor(profileId, executionId) {
			calls.findAnchor.push({ profileId, executionId });
			return records.find((record) => record.executionId === executionId) ?? null;
		},
		async findLineageWindow(profileId, lineage, anchor, limit) {
			calls.findLineageWindow.push({ profileId, lineage, anchor, limit });
			return records;
		},
	};
}

async function expectFailure(promise, expected) {
	let caught = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toMatchObject(expected);
}

describe("regression service", () => {
	test("a timeline is confined to the requesting profile even against a leaky store", async () => {
		const records = [
			execution("a1", 10, { ownerProfileId: PROFILE_A }),
			execution("b1", 15, { ownerProfileId: PROFILE_B }),
			execution("b2", 25, { ownerProfileId: PROFILE_B, httpStatus: 500 }),
			execution("a2", 30, { ownerProfileId: PROFILE_A, httpStatus: 500 }),
		];
		const service = createRegressionService({ repository: leakyRepository(records) });

		const forA = await service.buildTimeline(PROFILE_A, "a2");
		expect(forA.examinedExecutionIds).toEqual(["a1", "a2"]);
		expect(forA.skipped).toEqual([]);
		expect(forA.boundary).toMatchObject({ lastKnownGoodExecutionId: "a1", firstKnownBadExecutionId: "a2" });

		const forB = await service.buildTimeline(PROFILE_B, "b2");
		expect(forB.examinedExecutionIds).toEqual(["b1", "b2"]);
		expect(forB.examinedExecutionIds).not.toContain("a1");
		expect(forB.examinedExecutionIds).not.toContain("a2");
		expect(forB.boundary).toMatchObject({ lastKnownGoodExecutionId: "b1", firstKnownBadExecutionId: "b2" });
		expect(forB.unresolved).toBeNull();
	});

	test("another profile's execution is never found", async () => {
		const repository = leakyRepository([execution("a1", 10, { ownerProfileId: PROFILE_A })]);
		const service = createRegressionService({ repository });

		await expectFailure(service.buildTimeline(PROFILE_B, "a1"), { statusCode: 404, code: "HISTORY_NOT_FOUND" });
		expect(repository.calls.findLineageWindow).toHaveLength(0);
	});

	test("hidden and expired anchors are not analyzable", async () => {
		const records = [
			execution("h1", 10, { visible: false }),
			execution("x1", 20, { expiresAt: new Date(Date.UTC(2020, 0, 1)) }),
		];
		const service = createRegressionService({ repository: leakyRepository(records) });

		await expectFailure(service.buildTimeline(PROFILE_A, "h1"), { statusCode: 404, code: "HISTORY_NOT_FOUND" });
		await expectFailure(service.buildTimeline(PROFILE_A, "x1"), { statusCode: 404, code: "HISTORY_NOT_FOUND" });
		await expectFailure(service.buildTimeline(PROFILE_A, "missing"), { statusCode: 404, code: "HISTORY_NOT_FOUND" });
	});

	test("ambiguous lineage fails closed before any history query runs", async () => {
		const repository = leakyRepository([
			execution("s1", 30, { httpStatus: 500, context: { source: { type: "scratch" } } }),
			execution("e1", 10),
		]);
		const service = createRegressionService({ repository });

		const model = await service.buildTimeline(PROFILE_A, "s1");
		expect(model.lineage).toBeNull();
		expect(model.unresolved).toMatchObject({ reason: "AMBIGUOUS_LINEAGE" });
		expect(model.boundary).toBeNull();
		expect(repository.calls.findLineageWindow).toHaveLength(0);
	});

	test("the default predicate comes from the recorded failure evidence", async () => {
		const asserted = execution("a1", 30, {
			httpStatus: 500,
			snapshot: { scriptResults: { tests: [{ assertionId: "a-7", status: "failed" }], counts: { passed: 0, failed: 1, error: 0 } } },
		});
		const assertedService = createRegressionService({ repository: leakyRepository([asserted]) });
		const assertedModel = await assertedService.buildTimeline(PROFILE_A, "a1");
		expect(assertedModel.predicate).toEqual({ type: "assertion", assertionId: "a-7", failureFingerprint: "none" });

		const statusService = createRegressionService({ repository: leakyRepository([execution("s1", 30, { httpStatus: 503 })]) });
		const statusModel = await statusService.buildTimeline(PROFILE_A, "s1");
		expect(statusModel.predicate).toEqual({ type: "status", equals: 503 });

		const timedOut = execution("t1", 30, { response: undefined, outcome: "timeout" });
		const outcomeService = createRegressionService({ repository: leakyRepository([timedOut]) });
		const outcomeModel = await outcomeService.buildTimeline(PROFILE_A, "t1");
		expect(outcomeModel.predicate).toEqual({ type: "outcome", equals: "timeout" });
	});

	test("an explicit predicate is validated and applied", async () => {
		const records = [execution("e1", 10), execution("e2", 20, { httpStatus: 500 })];
		const service = createRegressionService({ repository: leakyRepository(records) });

		const model = await service.buildTimeline(PROFILE_A, "e2", { predicate: { type: "outcome", equals: "response" } });
		expect(model.predicate).toEqual({ type: "outcome", equals: "response" });
		// "response" matches every record, so there is no good execution to anchor a boundary.
		expect(model.unresolved).toMatchObject({ reason: "NO_KNOWN_GOOD" });

		await expectFailure(service.buildTimeline(PROFILE_A, "e2", { predicate: { type: "status", equals: 99 } }), {
			statusCode: 422,
			code: "PREDICATE_INVALID",
		});
		await expectFailure(service.buildTimeline(PROFILE_A, "e2", { predicate: { type: "unknown" } }), {
			statusCode: 422,
			code: "PREDICATE_INVALID",
		});
	});

	test("the history window is bounded and reports truncation", async () => {
		const many = Array.from({ length: 5 }, (_, index) => execution(`e${index}`, 10 + index, { httpStatus: 500 }));
		const repository = leakyRepository([...many, execution("good", 1)]);
		const service = createRegressionService({ repository });

		const model = await service.buildTimeline(PROFILE_A, "e4", { limit: 5 });
		expect(repository.calls.findLineageWindow[0].limit).toBe(5);
		expect(model.window).toEqual({ limit: 5, truncated: true });

		const clamped = leakyRepository([execution("e0", 10)]);
		await createRegressionService({ repository: clamped }).buildTimeline(PROFILE_A, "e0", { limit: 100000 });
		expect(clamped.calls.findLineageWindow[0].limit).toBe(100);

		const defaulted = leakyRepository([execution("e0", 10)]);
		await createRegressionService({ repository: defaulted }).buildTimeline(PROFILE_A, "e0", { limit: 0 });
		expect(defaulted.calls.findLineageWindow[0].limit).toBe(50);
	});

	test("the timeline states that correlation is not root cause", async () => {
		const service = createRegressionService({ repository: leakyRepository([execution("e1", 30, { httpStatus: 500 })]) });
		const model = await service.buildTimeline(PROFILE_A, "e1");
		expect(model.caveat).toContain("not a proven root cause");
	});
});
