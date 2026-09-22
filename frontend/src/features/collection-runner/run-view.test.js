import { describe, expect, test } from "bun:test";
import {
	assertionLine,
	buildRunInput,
	cleanRunVariables,
	planLimitError,
	plannedRequests,
	previousExecutedStep,
	runProgress,
	selectionLabel,
	stepTone,
	stopReasonLine,
	summaryLine,
} from "./run-view.js";

const FOLDER_A = "11111111-1111-4111-8111-111111111111";
const R1 = "33333333-3333-4333-8333-333333333331";
const R2 = "33333333-3333-4333-8333-333333333332";
const R3 = "33333333-3333-4333-8333-333333333333";

const request = (id, name, folderId = null, method = "GET") => ({ id, name, folderId, method });

const collection = {
	_id: "64b000000000000000000001",
	revision: 4,
	folders: [{ id: FOLDER_A, name: "Flow" }],
	requests: [request(R3, "Root", null, "DELETE"), request(R2, "Second", FOLDER_A), request(R1, "First", FOLDER_A, "POST")],
};

describe("runner planning", () => {
	test("previews the run order the backend executes", () => {
		expect(plannedRequests(collection, { mode: "collection" }).map((entry) => entry.id)).toEqual([R2, R1, R3]);
		expect(plannedRequests(collection, { mode: "folder", folderId: FOLDER_A }).map((entry) => entry.id)).toEqual([R2, R1]);
		expect(
			plannedRequests(collection, { mode: "requests", requestIds: [R3, R1] }).map((entry) => entry.id),
		).toEqual([R3, R1]);
	});

	test("labels selections", () => {
		expect(selectionLabel({ mode: "collection" }, collection)).toBe("Whole collection");
		expect(selectionLabel({ mode: "folder", folderId: FOLDER_A }, collection)).toBe("Folder “Flow”");
		expect(selectionLabel({ mode: "requests", requestIds: [R1, R2] }, collection)).toBe("2 selected request(s)");
	});

	test("enforces run bounds before starting", () => {
		expect(planLimitError(1, 3)).toBe("");
		expect(planLimitError(1, 0)).toContain("does not include any requests");
		expect(planLimitError(26, 3)).toContain("between 1 and 25");
		expect(planLimitError(2, 3)).toBe("");
		expect(planLimitError(25, 9)).toContain("at most 200");
	});

	test("cleans and validates run variables", () => {
		expect(cleanRunVariables([{ key: "seed", value: "1" }, { key: "", value: "x" }])).toEqual({
			ok: true,
			error: "",
			variables: [{ key: "seed", value: "1" }],
		});
		expect(cleanRunVariables([{ key: "bad key", value: "1" }]).ok).toBe(false);
		expect(cleanRunVariables([{ key: "a", value: "1" }, { key: "a", value: "2" }]).ok).toBe(false);
	});

	test("builds the run input with pinned revisions", () => {
		const input = buildRunInput({
			collection,
			selection: { mode: "collection" },
			environment: { _id: "64b000000000000000000002", revision: 2 },
			iterations: 3,
			stopOnFailure: false,
			variables: [{ key: "seed", value: "1" }],
		});
		expect(input).toEqual({
			collectionId: "64b000000000000000000001",
			collectionRevision: 4,
			selection: { mode: "collection" },
			environmentId: "64b000000000000000000002",
			environmentRevision: 2,
			iterations: 3,
			stopOnFailure: false,
			variables: [{ key: "seed", value: "1" }],
		});
		const withoutEnvironment = buildRunInput({
			collection,
			selection: { mode: "collection" },
			environment: null,
			iterations: 1,
			stopOnFailure: true,
			variables: [],
		});
		expect(withoutEnvironment.environmentId).toBeUndefined();
	});
});

describe("runner progress and results", () => {
	test("computes progress and the current request", () => {
		const run = {
			progress: { total: 3, completed: 1 },
			results: [
				{ status: "passed", executionId: "a" },
				{ status: "running", executionId: null },
				{ status: "pending", executionId: null },
			],
		};
		expect(runProgress(run)).toMatchObject({ total: 3, completed: 1, percent: 33 });
		expect(runProgress(run).current).toBe(run.results[1]);
	});

	test("labels steps, tones, assertions, and stop reasons", () => {
		expect(stepTone({ status: "passed" })).toBe("success");
		expect(stepTone({ status: "failed" })).toBe("danger");
		expect(stepTone({ status: "cancelled" })).toBe("warning");
		expect(stepTone({ status: "pending" })).toBe("unknown");
		expect(assertionLine({ assertions: { passed: 2, failed: 1, errors: 0 } })).toBe("2/3 checks");
		expect(assertionLine({ assertions: { passed: 0, failed: 0, errors: 0 } })).toBe("");
		expect(stopReasonLine("stop_on_failure")).toContain("first failure");
		expect(stopReasonLine(null)).toBe("");
	});

	test("summarizes the run outcome", () => {
		expect(
			summaryLine({
				passed: 2,
				failed: 1,
				cancelled: 1,
				skipped: 3,
				assertions: { passed: 5, failed: 1, errors: 0 },
			}),
		).toBe("2 passed · 1 failed · 1 cancelled · 3 skipped · 5 check(s) passed");
		expect(summaryLine({ passed: 1, failed: 0, cancelled: 0, skipped: 0, assertions: { passed: 0 } })).toBe("1 passed · 0 failed");
	});

	test("finds the previous executed step for causal comparison", () => {
		const results = [
			{ status: "passed", executionId: "a" },
			{ status: "skipped", executionId: null },
			{ status: "failed", executionId: "b" },
		];
		expect(previousExecutedStep(results, 2)?.executionId).toBe("a");
		expect(previousExecutedStep(results, 0)).toBeNull();
	});
});
