import { describe, expect, test } from "bun:test";
import { compareCandidates, matchesTarget, normalizeTarget, selectExampleMatch } from "./mock-matcher.js";

function example(overrides = {}) {
	return {
		_id: overrides._id ?? "e1",
		name: overrides.name ?? "Example",
		createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
		match: { method: "GET", path: "/orders", query: [], headers: [], ...(overrides.match ?? {}) },
	};
}

const target = (overrides = {}) => normalizeTarget({ method: "GET", path: "/orders", query: [], headers: [], ...overrides });

describe("mock matching rules", () => {
	test("matches only the exact method and path", () => {
		expect(matchesTarget(example(), target())).toBe(true);
		expect(matchesTarget(example(), target({ method: "POST" }))).toBe(false);
		expect(matchesTarget(example(), target({ path: "/orders/42" }))).toBe(false);
	});

	test("requires every selected query parameter to be present with an exact value", () => {
		const rule = example({ match: { query: [{ key: "status", value: "paid" }] } });
		expect(matchesTarget(rule, target({ query: [{ key: "status", value: "paid" }] }))).toBe(true);
		expect(matchesTarget(rule, target({ query: [{ key: "status", value: "open" }] }))).toBe(false);
		expect(matchesTarget(rule, target())).toBe(false);
		expect(matchesTarget(rule, target({ query: [{ key: "status", value: "paid" }, { key: "page", value: "2" }] }))).toBe(true);
	});

	test("requires every selected header to be present; names are case-insensitive and values exact", () => {
		const rule = example({ match: { headers: [{ key: "X-Tenant", value: "acme" }] } });
		expect(matchesTarget(rule, target({ headers: [{ key: "x-tenant", value: "acme" }] }))).toBe(true);
		expect(matchesTarget(rule, target({ headers: [{ key: "X-Tenant", value: "ACME" }] }))).toBe(false);
		expect(matchesTarget(rule, target({ headers: [{ key: "X-Other", value: "acme" }] }))).toBe(false);
	});

	test("ignores query parameters and headers that the example did not select", () => {
		const rule = example();
		expect(matchesTarget(rule, target({ query: [{ key: "anything", value: "1" }], headers: [{ key: "x-extra", value: "1" }] }))).toBe(true);
	});

	test("prefers the example with more selected rules", () => {
		const generic = example({ _id: "generic", name: "Generic", createdAt: new Date("2026-01-01T00:00:00Z") });
		const specific = example({
			_id: "specific",
			name: "Specific",
			createdAt: new Date("2026-02-01T00:00:00Z"),
			match: { query: [{ key: "status", value: "paid" }], headers: [{ key: "X-Tenant", value: "acme" }] },
		});
		const bothMatch = selectExampleMatch(
			[generic, specific],
			target({ query: [{ key: "status", value: "paid" }], headers: [{ key: "x-tenant", value: "acme" }] }),
		);
		expect(bothMatch.example._id).toBe("specific");
		const onlyGenericMatches = selectExampleMatch([generic, specific], target({ query: [{ key: "status", value: "paid" }] }));
		expect(onlyGenericMatches.example._id).toBe("generic");
		expect(onlyGenericMatches.considered).toBe(2);
	});

	test("breaks specificity ties deterministically by creation order and then identifier", () => {
		const older = example({ _id: "b-older", createdAt: new Date("2026-01-01T00:00:00Z") });
		const newer = example({ _id: "a-newer", createdAt: new Date("2026-03-01T00:00:00Z") });
		expect(selectExampleMatch([newer, older], target()).example._id).toBe("b-older");
		const first = example({ _id: "a-first", createdAt: new Date("2026-01-01T00:00:00Z") });
		const second = example({ _id: "b-second", createdAt: new Date("2026-01-01T00:00:00Z") });
		expect(selectExampleMatch([second, first], target()).example._id).toBe("a-first");
		expect(compareCandidates(first, second)).toBeLessThan(0);
	});

	test("reports an unmatched request without inventing an example", () => {
		const result = selectExampleMatch([example()], target({ path: "/missing" }));
		expect(result.matched).toBe(false);
		expect(result.example).toBeNull();
		expect(result.considered).toBe(1);
		expect(selectExampleMatch([], target()).matched).toBe(false);
	});
});
