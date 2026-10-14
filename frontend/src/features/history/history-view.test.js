import { describe, expect, test } from "bun:test";
import { historyEmptyMessage } from "./history-view.js";

describe("history empty and loading states", () => {
	test("the first load reads as loading, not as an empty history", () => {
		expect(historyEmptyMessage({ loading: true })).toBe("Loading history…");
	});

	test("an empty filtered result says the filters matched nothing", () => {
		expect(historyEmptyMessage({ filtered: true })).toBe("No sends match these filters.");
		expect(historyEmptyMessage({})).toBe("No history yet. Every send is recorded here.");
	});

	test("rows or an error replace the empty message", () => {
		expect(historyEmptyMessage({ itemCount: 2, loading: true })).toBeNull();
		expect(historyEmptyMessage({ error: "Network error" })).toBeNull();
	});
});
