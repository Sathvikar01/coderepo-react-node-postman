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
		expect(result.minimality).toBe("budget_limited");
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

	test("eliminates removable groups before singletons and records the probe trace", async () => {
		const extras = Array.from({ length: 8 }, (_, index) => row(`extra-${index}`));
		const result = await minimizeFailure({
			request: request({ query: [...extras, row("keep-query")], headers: [], body: { mode: "none" } }),
			maxProbes: 12,
			probe: async (candidate) => ({
				outcome: "response",
				response: { status: candidate.query.some((item) => item.key === "keep-query") ? 500 : 200 },
				scriptResults: null,
			}),
			predicate: { type: "status", equals: 500 },
		});

		expect(result.minimality).toBe("one_minimal");
		expect(result.remainingComponentCount).toBe(1);
		expect(result.removed).toHaveLength(8);
		expect(result.probesUsed).toBeLessThanOrEqual(7);
		expect(result.probeTrace).toHaveLength(result.probesUsed);
		expect(result.probeTrace[0]).toMatchObject({ phase: "baseline", removals: [], matched: true });
		expect(result.probeTrace.some((entry) => entry.phase === "group" && entry.removals.length > 1)).toBe(true);
		expect(result.probeTrace.at(-1)).toMatchObject({ phase: "verify", matched: true });
	});

	test("minimizes nested JSON bodies coarse to fine", async () => {
		const result = await minimizeFailure({
			request: request({
				query: [],
				headers: [],
				body: { mode: "json", text: JSON.stringify({ drop: { deep: 1, deeper: [2] }, keep: { deep: 2 } }) },
			}),
			probe: async (candidate) => {
				const json = JSON.parse(candidate.body.text);
				return { outcome: "response", response: { status: json?.keep?.deep === 2 ? 500 : 200 }, scriptResults: null };
			},
			predicate: { type: "status", equals: 500 },
		});

		expect(result.minimality).toBe("one_minimal");
		expect(JSON.parse(result.request.body.text)).toEqual({ keep: { deep: 2 } });
		expect(result.removed.map((item) => item.key)).toEqual(["drop"]);
		expect(result.remainingComponentCount).toBe(2);
	});

	test("removes duplicate-key rows individually by stable id", async () => {
		const keepTag = row("tag", "keep");
		const dropTag = row("tag", "drop");
		const result = await minimizeFailure({
			request: request({ query: [keepTag, dropTag], headers: [], body: { mode: "none" } }),
			probe: async (candidate) => ({
				outcome: "response",
				response: { status: candidate.query.some((item) => item.value === "keep") ? 500 : 200 },
				scriptResults: null,
			}),
			predicate: { type: "status", equals: 500 },
		});

		expect(result.request.query.map((item) => item.id)).toEqual([keepTag.id]);
		expect(result.removed.map((item) => item.id)).toEqual([dropTag.id]);
	});

	test("reports inconclusive when the minimized request stops reproducing", async () => {
		let calls = 0;
		const result = await minimizeFailure({
			request: request({ query: [row("maybe")], headers: [], body: { mode: "none" } }),
			probe: async () => ({ outcome: "response", response: { status: (calls += 1) <= 2 ? 500 : 200 }, scriptResults: null }),
			predicate: { type: "status", equals: 500 },
		});

		expect(result.minimality).toBe("inconclusive");
		expect(result.budgetExhausted).toBe(false);
		expect(result.probesUsed).toBeLessThan(12);
	});
});
