import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { minimizeFailure, matchesFailurePredicate } from "./failure-minimizer.js";

function row(key, value = key) {
	return { id: randomUUID(), key, value, enabled: true };
}

function request(overrides = {}) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name: "Failure",
		method: "POST",
		urlTemplate: "https://api.test/fail",
		query: [row("keep-query"), row("remove-query")],
		headers: [row("X-Keep"), row("X-Remove")],
		body: { mode: "json", text: JSON.stringify({ keepBody: true, removeBody: "unused" }) },
		auth: { mode: "none" },
		scripts: { preRequest: "", test: "" },
		assertions: [],
		settings: { timeoutMs: 15000 },
		...overrides,
	};
}

function stillFails(candidate) {
	const json = candidate.body.mode === "json" ? JSON.parse(candidate.body.text) : {};
	return candidate.query.some((item) => item.key === "keep-query") && Object.hasOwn(json, "keepBody");
}

describe("bounded failure minimization", () => {
	test("removes query rows, headers, and top-level JSON fields that are not required", async () => {
		const attempts = [];
		const result = await minimizeFailure({
			request: request(),
			maxProbes: 12,
			probe: async (candidate) => {
				attempts.push(candidate);
				return { outcome: "response", response: { status: stillFails(candidate) ? 500 : 200 }, scriptResults: null };
			},
			predicate: { type: "status", equals: 500 },
		});

		expect(result.status).toBe("completed");
		expect(result.stable).toBe(true);
		expect(result.probesUsed).toBeLessThanOrEqual(12);
		expect(result.request.query.map((item) => item.key)).toEqual(["keep-query"]);
		expect(result.request.headers).toEqual([]);
		expect(JSON.parse(result.request.body.text)).toEqual({ keepBody: true });
		expect(result.removed.map((item) => `${item.kind}:${item.key}`)).toEqual([
			"query:remove-query",
			"header:X-Keep",
			"header:X-Remove",
			"json:removeBody",
		]);
		expect(attempts).toHaveLength(result.probesUsed);
	});

	test("stops exactly at the configured probe budget", async () => {
		const result = await minimizeFailure({
			request: request(),
			maxProbes: 3,
			probe: async () => ({ outcome: "response", response: { status: 500 }, scriptResults: null }),
			predicate: { type: "status", equals: 500 },
		});

		expect(result.probesUsed).toBe(3);
		expect(result.budgetExhausted).toBe(true);
	});

	test("rejects an unstable baseline before changing the request", async () => {
		let call = 0;
		await expect(
			minimizeFailure({
				request: request(),
				probe: async () => ({ outcome: "response", response: { status: (call += 1) === 1 ? 500 : 200 }, scriptResults: null }),
				predicate: { type: "status", equals: 500 },
			}),
		).rejects.toMatchObject({ code: "MINIMIZATION_FLAKY" });
	});

	test("observes cancellation before the next probe", async () => {
		const controller = new AbortController();
		let calls = 0;
		await expect(
			minimizeFailure({
				request: request(),
				signal: controller.signal,
				probe: async () => {
					calls += 1;
					if (calls === 2) controller.abort();
					return { outcome: "response", response: { status: 500 }, scriptResults: null };
				},
				predicate: { type: "status", equals: 500 },
			}),
		).rejects.toMatchObject({ code: "MINIMIZATION_CANCELLED" });
	});

	test("evaluates outcome, status, and assertion predicates deterministically", () => {
		const result = {
			outcome: "response",
			response: { status: 422 },
			scriptResults: { tests: [{ assertionId: "assert-a", status: "failed" }] },
		};
		expect(matchesFailurePredicate(result, { type: "outcome", equals: "response" })).toBe(true);
		expect(matchesFailurePredicate(result, { type: "status", equals: 422 })).toBe(true);
		expect(matchesFailurePredicate(result, { type: "assertion", assertionId: "assert-a" })).toBe(true);
		expect(matchesFailurePredicate(result, { type: "assertion", assertionId: "assert-b" })).toBe(false);
	});
});
