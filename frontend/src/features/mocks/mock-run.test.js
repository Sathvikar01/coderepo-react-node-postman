import { describe, expect, test } from "bun:test";
import { isMockResult, mockIndicator, mockResolveInput, mockRouteUrl, runMockSend } from "./mock-run.js";

function fakeApi() {
	const calls = { resolve: 0, send: 0 };
	return {
		calls,
		api: {
			async resolve(input) {
				calls.resolve += 1;
				return { matched: true, input, result: { outcome: "mock" } };
			},
			async send() {
				calls.send += 1;
				throw new Error("Mock Send must never use the execution API");
			},
		},
	};
}

describe("mock runs", () => {
	test("builds a resolve payload with only the context that exists", () => {
		expect(mockResolveInput({ request: { id: "r" } })).toEqual({ request: { id: "r" } });
		expect(mockResolveInput({ request: { id: "r" }, environmentId: "env-1", executionId: "exec-1" })).toEqual({
			request: { id: "r" },
			environmentId: "env-1",
			executionId: "exec-1",
		});
	});

	test("resolves through the mock API only", async () => {
		const { calls, api } = fakeApi();
		const data = await runMockSend({ request: { id: "r" }, executionId: "exec-1", api });
		expect(calls).toEqual({ resolve: 1, send: 0 });
		expect(data.matched).toBe(true);
	});
	test("recognizes mock results and describes matched and missed runs", () => {
		expect(isMockResult({ outcome: "mock" })).toBe(false);
		expect(isMockResult({ mock: { matched: true } })).toBe(true);
		expect(mockIndicator(null)).toBeNull();
		expect(mockIndicator({ matched: true, exampleName: "Orders" })).toMatchObject({ tone: "info", title: "Mock response" });
		const miss = mockIndicator({ matched: false, target: { method: "GET", path: "/orders" }, considered: 2 });
		expect(miss.tone).toBe("danger");
		expect(miss.detail).toContain("GET /orders");
		expect(miss.detail).toContain("2 example(s)");
	});

	test("builds the copyable mock route URL", () => {
		expect(mockRouteUrl("")).toBe("");
		expect(mockRouteUrl("/api/v1/mocks/a/b")).toBe("/api/v1/mocks/a/b");
	});
});
