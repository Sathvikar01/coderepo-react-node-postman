import { describe, expect, test } from "bun:test";
import {
	buildRegressionTimeline,
	evaluatePredicate,
	lineageOf,
	orderRecords,
	parseFailurePredicate,
	REGRESSION_TIMELINE_CAVEAT,
	REGRESSION_TIMELINE_KIND,
	REGRESSION_TIMELINE_VERSION,
	selectFailurePredicate,
} from "./regression-timeline.js";

const STATUS_PREDICATE = { type: "status", equals: 500 };
const LINEAGE = { type: "collection", collectionId: "col-1", collectionRevision: 3, name: "Orders", requestId: "req-1" };

function receiptFor(id, { status = 200, body = "same-body" } = {}) {
	return {
		schemaVersion: 1,
		kind: "tracer.execution-receipt",
		executionId: id,
		outcome: "response",
		request: { authoredFingerprint: "authored", compiledFingerprint: "compiled", auth: { mode: "none", source: "request", referenceKeys: [] } },
		source: { type: "collection", collectionId: "col-1", collectionRevision: 3, requestId: "req-1" },
		policy: { decision: "allowed", version: "v1", local: false },
		target: { hostname: "api.test", address: "203.0.113.9" },
		response: {
			bodyFingerprint: `body-${body}`,
			truncated: false,
			binary: false,
			contract: { status, headers: [{ name: "content-type", count: 1 }], bodyShape: [{ path: "$", type: "object" }] },
		},
		tests: { counts: { passed: 0, failed: 0, error: 0 }, failureFingerprint: "none" },
	};
}

// httpStatus maps to the recorded response; any other override replaces a whole field
// (use undefined to simulate a record that lacks that evidence).
function execution(id, second, overrides = {}) {
	const { httpStatus = 200, ...rest } = overrides;
	const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, second));
	const record = {
		executionId: id,
		ownerProfileId: "profile-a",
		status: "terminal",
		visible: true,
		expiresAt: null,
		outcome: "response",
		startedAt,
		finishedAt: new Date(startedAt.getTime() + 250),
		response: { status: httpStatus },
		snapshot: { scriptResults: null },
		context: { source: { ...LINEAGE } },
		receipt: receiptFor(id, { status: httpStatus }),
	};
	for (const [key, value] of Object.entries(rest)) {
		if (value === undefined) delete record[key];
		else record[key] = value;
	}
	return record;
}

function timeline(records, anchor, predicate = STATUS_PREDICATE, window = {}) {
	return buildRegressionTimeline({ anchor, records, predicate, window: { limit: 50, ...window }, now: Date.UTC(2026, 0, 2) });
}

describe("RegressionTimelineV1 boundary detection", () => {
	test("clean pass to fail transition finds an adjacent boundary with comparison evidence", () => {
		const [e1, e2, e3] = [execution("e1", 10), execution("e2", 20), execution("e3", 30, { httpStatus: 500 })];
		const model = timeline([e1, e2, e3], e3);

		expect(model.schemaVersion).toBe(REGRESSION_TIMELINE_VERSION);
		expect(model.kind).toBe(REGRESSION_TIMELINE_KIND);
		expect(model.lineage).toEqual({ collectionId: "col-1", requestId: "req-1", key: "col-1:req-1" });
		expect(model.examinedExecutionIds).toEqual(["e1", "e2", "e3"]);
		expect(model.examined.map((entry) => entry.predicateMatched)).toEqual([false, false, true]);
		expect(model.lastKnownGood).toEqual({ executionId: "e2", startedAt: e2.startedAt.toISOString() });
		expect(model.firstKnownBad).toEqual({ executionId: "e3", startedAt: e3.startedAt.toISOString() });
		expect(model.unresolved).toBeNull();
		expect(model.boundary.lastKnownGoodExecutionId).toBe("e2");
		expect(model.boundary.firstKnownBadExecutionId).toBe("e3");
		expect(model.boundary.comparisonUnavailableReason).toBeNull();
		expect(model.boundary.comparison.kind).toBe("tracer.run-comparison");
		expect(model.boundary.comparison.baseExecutionId).toBe("e2");
		expect(model.boundary.comparison.candidateExecutionId).toBe("e3");
		expect(model.boundary.comparison.contract.breaking).toBe(true);
		expect(model.boundary.comparison.contract.changes[0]).toMatchObject({ kind: "status_changed", before: 200, after: 500 });
		expect(model.caveat).toBe(REGRESSION_TIMELINE_CAVEAT);
	});

	test("multiple failures pin the boundary at the streak start, not at the anchor", () => {
		const [e1, e2, e3, e4] = [
			execution("e1", 10),
			execution("e2", 20, { httpStatus: 500 }),
			execution("e3", 30, { httpStatus: 500 }),
			execution("e4", 40, { httpStatus: 500 }),
		];
		const model = timeline([e1, e2, e3, e4], e4);

		expect(model.firstKnownBad.executionId).toBe("e2");
		expect(model.lastKnownGood.executionId).toBe("e1");
		expect(model.boundary.lastKnownGoodExecutionId).toBe("e1");
		expect(model.boundary.firstKnownBadExecutionId).toBe("e2");
		expect(model.unresolved).toBeNull();
	});

	test("recovery after an earlier failure keeps the boundary at the latest transition", () => {
		const [e1, e2, e3] = [
			execution("e1", 10, { httpStatus: 500 }),
			execution("e2", 20),
			execution("e3", 30, { httpStatus: 500 }),
		];
		const model = timeline([e1, e2, e3], e3);

		// The recovered failure stays visible in the timeline but is not the current boundary.
		expect(model.examined[0]).toMatchObject({ executionId: "e1", predicateMatched: true });
		expect(model.firstKnownBad.executionId).toBe("e3");
		expect(model.lastKnownGood.executionId).toBe("e2");
		expect(model.boundary.lastKnownGoodExecutionId).toBe("e2");
		expect(model.boundary.firstKnownBadExecutionId).toBe("e3");
		expect(model.unresolved).toBeNull();
	});

	test("all-pass history leaves the timeline unresolved", () => {
		const [e1, e2] = [execution("e1", 10), execution("e2", 20)];
		const model = timeline([e1, e2], e2);

		expect(model.examinedExecutionIds).toEqual(["e1", "e2"]);
		expect(model.examined.every((entry) => entry.predicateMatched === false)).toBe(true);
		expect(model.firstKnownBad).toBeNull();
		expect(model.lastKnownGood).toBeNull();
		expect(model.boundary).toBeNull();
		expect(model.unresolved).toMatchObject({ reason: "ANCHOR_NOT_FAILING" });
	});

	test("all-fail history reports no trustworthy boundary", () => {
		const [e1, e2] = [execution("e1", 10, { httpStatus: 500 }), execution("e2", 20, { httpStatus: 500 })];
		const model = timeline([e1, e2], e2);

		expect(model.lastKnownGood).toBeNull();
		expect(model.firstKnownBad.executionId).toBe("e1");
		expect(model.boundary).toBeNull();
		expect(model.unresolved).toMatchObject({ reason: "NO_KNOWN_GOOD" });
	});

	test("a truncated all-fail window says so instead of claiming completeness", () => {
		const [e1, e2] = [execution("e1", 10, { httpStatus: 500 }), execution("e2", 20, { httpStatus: 500 })];
		const model = timeline([e1, e2], e2, STATUS_PREDICATE, { limit: 2, truncated: true });

		expect(model.window).toEqual({ limit: 2, truncated: true });
		expect(model.unresolved.reason).toBe("NO_KNOWN_GOOD");
		expect(model.unresolved.message).toContain("truncated at 2 executions");
	});

	test("missing history resolves to NO_HISTORY", () => {
		const anchor = execution("e1", 10, { httpStatus: 500 });
		const model = timeline([], anchor);

		expect(model.examinedExecutionIds).toEqual(["e1"]);
		expect(model.skipped).toEqual([]);
		expect(model.firstKnownBad.executionId).toBe("e1");
		expect(model.lastKnownGood).toBeNull();
		expect(model.boundary).toBeNull();
		expect(model.unresolved).toMatchObject({ reason: "NO_HISTORY" });
	});

	test("the timeline never claims a root cause", () => {
		const anchor = execution("e1", 10, { httpStatus: 500 });
		const model = timeline([], anchor);

		expect(model.caveat).toContain("not a proven root cause");
	});
});

describe("RegressionTimelineV1 lineage", () => {
	test("unrelated requests are excluded and do not break adjacency", () => {
		const anchor = execution("e2", 30, { httpStatus: 500 });
		const good = execution("e1", 10);
		const sameUrlOtherRequest = execution("u1", 15, {
			httpStatus: 500,
			context: { source: { ...LINEAGE, requestId: "req-2" } },
		});
		const scratchSameUrl = execution("u2", 18, { httpStatus: 500, context: { source: { type: "scratch" } } });
		const otherCollection = execution("u3", 22, {
			httpStatus: 500,
			context: { source: { ...LINEAGE, collectionId: "col-2", name: "Other" } },
		});
		const noSource = execution("u4", 25, { httpStatus: 500, context: { tabId: "tab" } });

		const model = timeline([sameUrlOtherRequest, scratchSameUrl, noSource, anchor, good, otherCollection], anchor);

		expect(model.examinedExecutionIds).toEqual(["e1", "e2"]);
		expect(model.skipped).toEqual([]);
		for (const id of ["u1", "u2", "u3", "u4"]) {
			expect(model.examinedExecutionIds).not.toContain(id);
			expect(model.skipped.map((entry) => entry.executionId)).not.toContain(id);
		}
		expect(model.boundary).toMatchObject({ lastKnownGoodExecutionId: "e1", firstKnownBadExecutionId: "e2" });
		expect(model.unresolved).toBeNull();
	});

	test("ambiguous lineage fails closed without grouping anything", () => {
		const ambiguous = [
			execution("a1", 30, { httpStatus: 500, context: { source: { type: "scratch" } } }),
			execution("a2", 30, { httpStatus: 500, context: { source: { type: "history", historyId: "h1" } } }),
			execution("a3", 30, { httpStatus: 500, context: { source: { ...LINEAGE, requestId: null } } }),
			execution("a4", 30, { httpStatus: 500, context: { tabId: "tab-1" } }),
		];
		for (const anchor of ambiguous) {
			const model = timeline([execution("e1", 10), execution("e2", 20, { httpStatus: 500 })], anchor);
			expect(model.lineage).toBeNull();
			expect(model.examinedExecutionIds).toEqual([]);
			expect(model.skipped).toEqual([]);
			expect(model.firstKnownBad).toBeNull();
			expect(model.lastKnownGood).toBeNull();
			expect(model.boundary).toBeNull();
			expect(model.unresolved).toMatchObject({ reason: "AMBIGUOUS_LINEAGE" });
			expect(model.unresolved.message).toContain("Executions were not grouped");
		}
	});

	test("lineageOf accepts only saved collection request identity", () => {
		expect(lineageOf(execution("e1", 10)).ok).toBe(true);
		expect(lineageOf(execution("e1", 10, { context: { source: { type: "scratch" } } })).ok).toBe(false);
		expect(lineageOf(execution("e1", 10, { context: {} })).ok).toBe(false);
		expect(lineageOf({ executionId: "x" }).ok).toBe(false);
	});
});

describe("RegressionTimelineV1 evidence trust", () => {
	test("hidden executions are never evidence and block adjacency claims", () => {
		const good = execution("e1", 10);
		const hidden = execution("h1", 20, { httpStatus: 500, visible: false });
		const anchor = execution("e2", 30, { httpStatus: 500 });

		const blocked = timeline([good, hidden, anchor], anchor);
		expect(blocked.examinedExecutionIds).toEqual(["e1", "e2"]);
		expect(blocked.skipped).toEqual([{ executionId: "h1", startedAt: hidden.startedAt.toISOString(), reason: "hidden" }]);
		expect(blocked.lastKnownGood.executionId).toBe("e1");
		expect(blocked.firstKnownBad.executionId).toBe("e2");
		expect(blocked.boundary).toBeNull();
		expect(blocked.unresolved).toMatchObject({ reason: "BOUNDARY_NOT_ADJACENT" });

		// The same hidden record outside the transition window does not block the boundary.
		const earlier = execution("h1", 5, { httpStatus: 500, visible: false });
		const open = timeline([earlier, good, anchor], anchor);
		expect(open.boundary).toMatchObject({ lastKnownGoodExecutionId: "e1", firstKnownBadExecutionId: "e2" });
		expect(open.unresolved).toBeNull();
	});

	test("expired, running, and evidence-free executions become named gaps", () => {
		const good = execution("e1", 10);
		const expired = execution("x1", 15, { httpStatus: 500, expiresAt: new Date(Date.UTC(2020, 0, 1)) });
		const running = execution("r1", 18, { httpStatus: 500, status: "running", outcome: null });
		const evidenceFree = execution("m1", 22, { response: undefined, outcome: "network_error" });
		const anchor = execution("e2", 30, { httpStatus: 500 });

		const model = timeline([good, expired, running, evidenceFree, anchor], anchor);

		expect(model.examinedExecutionIds).toEqual(["e1", "e2"]);
		expect(model.skipped).toEqual([
			{ executionId: "x1", startedAt: expired.startedAt.toISOString(), reason: "expired" },
			{ executionId: "r1", startedAt: running.startedAt.toISOString(), reason: "not_terminal" },
			{ executionId: "m1", startedAt: evidenceFree.startedAt.toISOString(), reason: "missing_evidence" },
		]);
		expect(model.boundary).toBeNull();
		expect(model.unresolved).toMatchObject({ reason: "BOUNDARY_NOT_ADJACENT" });
	});

	test("an anchor without evaluable evidence is not treated as a failure", () => {
		const anchor = execution("e1", 30, { response: undefined, outcome: "network_error" });
		const model = timeline([execution("e0", 10), execution("e2", 40)], anchor);

		expect(model.unresolved).toMatchObject({ reason: "ANCHOR_NOT_EVALUABLE" });
		expect(model.boundary).toBeNull();
	});

	test("missing receipts keep the boundary but mark the comparison unavailable", () => {
		const good = execution("e1", 10, { receipt: undefined });
		const anchor = execution("e2", 30, { httpStatus: 500 });
		const model = timeline([good, anchor], anchor);

		expect(model.boundary.lastKnownGoodExecutionId).toBe("e1");
		expect(model.boundary.comparison).toBeNull();
		expect(model.boundary.comparisonUnavailableReason).toBe("RECEIPT_UNAVAILABLE");
		expect(model.unresolved).toBeNull();
	});

	test("assertion predicates only evaluate records that ran the assertion", () => {
		const predicate = { type: "assertion", assertionId: "a-1", failureFingerprint: null };
		const withPassing = (id, second, status) =>
			execution(id, second, { snapshot: { scriptResults: { tests: [{ assertionId: "a-1", status }], counts: { passed: 1, failed: 0, error: 0 } } } });
		const good = withPassing("e1", 10, "passed");
		const unrelatedAssertion = execution("m1", 15, {
			snapshot: { scriptResults: { tests: [{ assertionId: "other", status: "failed" }], counts: { passed: 0, failed: 1, error: 0 } } },
		});
		const anchor = withPassing("e2", 30, "failed");

		// The record without the assertion is a named gap, and it blocks the adjacent boundary.
		const model = timeline([good, unrelatedAssertion, anchor], anchor, predicate);
		expect(model.skipped).toEqual([{ executionId: "m1", startedAt: unrelatedAssertion.startedAt.toISOString(), reason: "missing_evidence" }]);
		expect(model.boundary).toBeNull();
		expect(model.unresolved).toMatchObject({ reason: "BOUNDARY_NOT_ADJACENT" });

		const clean = timeline([good, anchor], anchor, predicate);
		expect(clean.unresolved).toBeNull();
		expect(clean.boundary).toMatchObject({ lastKnownGoodExecutionId: "e1", firstKnownBadExecutionId: "e2" });
		expect(clean.boundary.comparison).not.toBeNull();
	});
});

describe("RegressionTimelineV1 determinism", () => {
	test("record order in the input does not change the timeline", () => {
		const records = [
			execution("e1", 10),
			execution("e2", 20, { httpStatus: 500 }),
			execution("e3", 30, { httpStatus: 500 }),
			execution("e4", 40, { httpStatus: 500 }),
			execution("e5", 50),
		];
		const anchor = records[3];
		const permutations = [
			records,
			[...records].reverse(),
			[records[2], records[0], records[4], records[3], records[1]],
			[records[4], records[3], records[2], records[1], records[0]],
		];
		const outputs = permutations.map((input) => JSON.stringify(timeline(input, anchor)));
		for (const output of outputs) expect(output).toBe(outputs[0]);
	});

	test("equal timestamps order by executionId", () => {
		const late = execution("e-b", 20);
		const early = execution("e-a", 20);
		const anchor = execution("e-c", 30, { httpStatus: 500 });
		const model = timeline([late, anchor, early], anchor);

		expect(model.examinedExecutionIds).toEqual(["e-a", "e-b", "e-c"]);
		expect(model.lastKnownGood.executionId).toBe("e-b");
		expect(orderRecords([late, early]).map((record) => record.executionId)).toEqual(["e-a", "e-b"]);
	});
});

describe("failure predicate helpers", () => {
	test("parseFailurePredicate normalizes and rejects", () => {
		expect(parseFailurePredicate({ type: "status", equals: 500 })).toEqual({ ok: true, predicate: { type: "status", equals: 500 } });
		expect(parseFailurePredicate({ type: "assertion", assertionId: "a1" }).predicate).toEqual({
			type: "assertion",
			assertionId: "a1",
			failureFingerprint: null,
		});
		expect(parseFailurePredicate({ type: "status", equals: 99 }).ok).toBe(false);
		expect(parseFailurePredicate({ type: "unknown" }).ok).toBe(false);
		expect(parseFailurePredicate(null).ok).toBe(false);
	});

	test("selectFailurePredicate prefers failing assertions, then status, then outcome", () => {
		const asserted = execution("e1", 10, {
			httpStatus: 500,
			snapshot: { scriptResults: { tests: [{ assertionId: "a-9", status: "failed" }], counts: { passed: 0, failed: 1, error: 0 } } },
			receipt: receiptFor("e1", { status: 500 }),
		});
		expect(selectFailurePredicate(asserted)).toMatchObject({ type: "assertion", assertionId: "a-9" });
		expect(selectFailurePredicate(execution("e2", 10, { httpStatus: 503 }))).toEqual({ type: "status", equals: 503 });
		expect(selectFailurePredicate(execution("e3", 10, { response: undefined, outcome: "timeout" }))).toEqual({
			type: "outcome",
			equals: "timeout",
		});
	});

	test("evaluatePredicate reports gaps conservatively", () => {
		expect(evaluatePredicate(execution("e1", 10, { visible: false }), STATUS_PREDICATE)).toEqual({ evaluable: false, reason: "hidden" });
		expect(evaluatePredicate(execution("e1", 10, { expiresAt: new Date(Date.UTC(2020, 0, 1)) }), STATUS_PREDICATE)).toEqual({
			evaluable: false,
			reason: "expired",
		});
		expect(evaluatePredicate(execution("e1", 10, { status: "running" }), STATUS_PREDICATE)).toEqual({ evaluable: false, reason: "not_terminal" });
		expect(evaluatePredicate(execution("e1", 10, { response: undefined }), STATUS_PREDICATE)).toEqual({
			evaluable: false,
			reason: "missing_evidence",
		});
		expect(evaluatePredicate(execution("e1", 10, { httpStatus: 500 }), STATUS_PREDICATE)).toEqual({ evaluable: true, matched: true });
		expect(evaluatePredicate(execution("e1", 10), STATUS_PREDICATE)).toEqual({ evaluable: true, matched: false });
	});
});
