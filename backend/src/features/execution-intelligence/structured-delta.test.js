import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	componentRef,
	enumerateComponents,
	isDescendantPath,
	splitChunks,
	withoutComponents,
} from "./structured-delta.js";

function row(key, value = key) {
	return { id: randomUUID(), key, value, enabled: true };
}

describe("structured delta components", () => {
	test("tracks duplicate query and header rows by stable ids", () => {
		const a = row("tag", "a");
		const b = row("tag", "b");
		const disabled = { ...row("tag", "c"), enabled: false };
		const header = row("X-Tag", "x");
		const components = enumerateComponents({ query: [a, b, disabled], headers: [header] });
		expect(components.map((component) => componentRef(component))).toEqual([
			componentRef({ kind: "query", id: a.id }),
			componentRef({ kind: "query", id: b.id }),
			componentRef({ kind: "header", id: header.id }),
		]);
	});

	test("enumerates nested JSON paths parents before children", () => {
		const request = { body: { mode: "json", text: JSON.stringify({ drop: { deep: [1, 2] }, keep: true }) } };
		const components = enumerateComponents(request);
		expect(components.map((component) => component.key)).toEqual([
			"drop",
			"drop.deep",
			"drop.deep.0",
			"drop.deep.1",
			"keep",
		]);
	});

	test("removes rows by id and JSON subtrees by path with subsumption", () => {
		const keep = row("keep", "1");
		const drop = row("drop", "2");
		const request = {
			query: [keep, drop],
			headers: [],
			body: { mode: "json", text: JSON.stringify({ drop: { deep: 1 }, keep: [0, 1, 2] }) },
		};
		const components = enumerateComponents(request);
		const findJson = (key) => components.find((component) => component.kind === "json" && component.key === key);
		const target = [
			components.find((component) => component.kind === "query" && component.id === drop.id),
			findJson("drop"),
			findJson("drop.deep"),
			findJson("keep.1"),
		];
		const candidate = withoutComponents(request, target);
		expect(candidate.query.map((item) => item.id)).toEqual([keep.id]);
		expect(JSON.parse(candidate.body.text)).toEqual({ keep: [0, 2] });
	});

	test("recognizes descendant JSON paths", () => {
		expect(isDescendantPath(["a", "b", 0], ["a"])).toBe(true);
		expect(isDescendantPath(["a", "b"], ["a", "b"])).toBe(false);
		expect(isDescendantPath(["a"], ["b"])).toBe(false);
	});

	test("splits chunks deterministically with remainder on the leading chunks", () => {
		const items = [1, 2, 3, 4, 5, 6, 7];
		expect(splitChunks(items, 3)).toEqual([[1, 2, 3], [4, 5], [6, 7]]);
		expect(splitChunks(items, 2)).toEqual([[1, 2, 3, 4], [5, 6, 7]]);
		expect(splitChunks(items, 1)).toEqual([[1, 2, 3, 4, 5, 6, 7]]);
	});
});
