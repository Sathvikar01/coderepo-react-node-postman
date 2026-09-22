import { describe, expect, test } from "bun:test";
import { buildRunPlan, orderedRequests, selectRequests } from "./run-plan.js";
import { RUN_LIMITS } from "./run-limits.js";

const request = (id, name, folderId = null, method = "GET") => ({
	schemaVersion: 1,
	id,
	folderId,
	name,
	method,
	urlTemplate: "http://127.0.0.1:8000/demo/v1/local/orders",
	query: [],
	headers: [],
	body: { mode: "none" },
	auth: { mode: "none" },
	scripts: { preRequest: "", test: "" },
	assertions: [],
	settings: { timeoutMs: 5000 },
});

const FOLDER_A = "11111111-1111-4111-8111-111111111111";
const FOLDER_B = "22222222-2222-4222-8222-222222222222";
const R1 = "33333333-3333-4333-8333-333333333331";
const R2 = "33333333-3333-4333-8333-333333333332";
const R3 = "33333333-3333-4333-8333-333333333333";
const R4 = "33333333-3333-4333-8333-333333333334";

// Stored shape: `requests` interleaves folders and roots; the run order follows the
// sidebar tree (folder A, folder B, then root requests) rather than raw array order.
const collection = {
	_id: "64b000000000000000000001",
	name: "Orders API",
	revision: 3,
	folders: [
		{ id: FOLDER_A, name: "Create flow" },
		{ id: FOLDER_B, name: "Read flow" },
	],
	requests: [
		request(R4, "Root first", null, "DELETE"),
		request(R2, "Second in A", FOLDER_A),
		request(R3, "Only in B", FOLDER_B),
		request(R1, "First in A", FOLDER_A, "POST"),
	],
	auth: { mode: "none" },
	variables: [],
};

describe("run plan ordering", () => {
	test("orders requests in sidebar tree order: folders first, then roots", () => {
		expect(orderedRequests(collection).map((entry) => entry.id)).toEqual([R2, R1, R3, R4]);
	});

	test("collection selection keeps the deterministic tree order", () => {
		const plan = buildRunPlan({ collection, selection: { mode: "collection" }, iterations: 1 });
		expect(plan.steps.map((step) => step.requestId)).toEqual([R2, R1, R3, R4]);
		expect(plan.steps.map((step) => step.name)).toEqual(["Second in A", "First in A", "Only in B", "Root first"]);
		expect(plan.steps.map((step) => step.method)).toEqual(["GET", "POST", "GET", "DELETE"]);
		expect(plan.steps.map((step) => step.index)).toEqual([0, 1, 2, 3]);
		expect(plan.steps.map((step) => step.iteration)).toEqual([1, 1, 1, 1]);
	});

	test("folder selection runs that folder's requests in stored order", () => {
		const plan = buildRunPlan({ collection, selection: { mode: "folder", folderId: FOLDER_A }, iterations: 1 });
		expect(plan.steps.map((step) => step.requestId)).toEqual([R2, R1]);
		expect(plan.requestCount).toBe(2);
	});

	test("explicit request selection runs exactly the listed order", () => {
		const plan = buildRunPlan({
			collection,
			selection: { mode: "requests", requestIds: [R4, R3] },
			iterations: 1,
		});
		expect(plan.steps.map((step) => step.requestId)).toEqual([R4, R3]);
	});

	test("iterations repeat the whole selection in iteration-major order", () => {
		const plan = buildRunPlan({
			collection,
			selection: { mode: "requests", requestIds: [R1, R2] },
			iterations: 3,
		});
		expect(plan.totalSteps).toBe(6);
		expect(plan.steps.map((step) => `${step.iteration}:${step.requestId.slice(-1)}`)).toEqual([
			"1:1",
			"1:2",
			"2:1",
			"2:2",
			"3:1",
			"3:2",
		]);
	});

	test("planning twice produces the identical plan", () => {
		const first = buildRunPlan({ collection, selection: { mode: "collection" }, iterations: 2 });
		const second = buildRunPlan({ collection, selection: { mode: "collection" }, iterations: 2 });
		expect(first).toEqual(second);
	});
});

describe("run plan validation", () => {
	test("rejects an empty selection", () => {
		expect(() =>
			buildRunPlan({
				collection: { ...collection, requests: collection.requests.filter((entry) => entry.folderId !== FOLDER_B) },
				selection: { mode: "folder", folderId: FOLDER_B },
				iterations: 1,
			}),
		).toThrow(expect.objectContaining({ code: "RUN_SELECTION_EMPTY" }));
	});

	test("rejects selections that reference missing requests or folders", () => {
		expect(() =>
			selectRequests(collection, { mode: "requests", requestIds: ["99999999-9999-4999-8999-999999999999"] }),
		).toThrow(expect.objectContaining({ code: "REQUEST_NOT_FOUND" }));
		expect(() =>
			selectRequests(collection, { mode: "folder", folderId: "99999999-9999-4999-8999-999999999999" }),
		).toThrow(expect.objectContaining({ code: "FOLDER_NOT_FOUND" }));
	});

	test("bounds iterations, request counts, and total steps", () => {
		expect(() => buildRunPlan({ collection, selection: { mode: "collection" }, iterations: RUN_LIMITS.iterationsPerRun + 1 })).toThrow(
			expect.objectContaining({ code: "RUN_TOO_LARGE" }),
		);
		const synthetic = (count) =>
			Array.from({ length: count }, (_, index) =>
				request(`44444444-4444-4444-8444-${String(index).padStart(12, "0")}`, `Request ${index}`),
			);
		expect(() =>
			buildRunPlan({
				collection: { ...collection, folders: [], requests: synthetic(9) },
				selection: { mode: "collection" },
				iterations: RUN_LIMITS.iterationsPerRun,
			}),
		).toThrow(expect.objectContaining({ code: "RUN_TOO_LARGE", details: expect.objectContaining({ unit: "steps" }) }));
		expect(() =>
			buildRunPlan({
				collection: { ...collection, folders: [], requests: synthetic(RUN_LIMITS.requestsPerRun + 1) },
				selection: { mode: "collection" },
				iterations: 1,
			}),
		).toThrow(expect.objectContaining({ code: "RUN_TOO_LARGE", details: expect.objectContaining({ unit: "requests" }) }));
	});
});
