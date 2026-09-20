import { describe, expect, test } from "bun:test";
import { addRequest, hasRequest, removeRequest, updateRequest } from "./collection-edit.js";

const request = (overrides = {}) => ({
	schemaVersion: 1,
	id: "req-1",
	folderId: null,
	name: "Probe",
	method: "GET",
	urlTemplate: "https://example.com",
	query: [],
	headers: [],
	body: { mode: "none" },
	auth: { mode: "none" },
	settings: { timeoutMs: 15000 },
	...overrides,
});

const aggregate = (requests = [request()]) => ({
	name: "Orders",
	description: "",
	variables: [],
	auth: { mode: "none" },
	folders: [],
	requests,
});

describe("collection request membership", () => {
	test("detects whether a tab's source request still exists", () => {
		const collection = aggregate();
		expect(hasRequest(collection, "req-1")).toBe(true);
		expect(hasRequest(collection, "req-missing")).toBe(false);
		expect(hasRequest({ ...collection, requests: [] }, "req-1")).toBe(false);
		expect(hasRequest(null, "req-1")).toBe(false);
	});

	test("updateRequest is a no-op once the source request was removed", () => {
		const without = removeRequest(aggregate(), "req-1");
		const updated = updateRequest(without, request({ name: "Edited" }));
		expect(updated.requests).toHaveLength(0);
		expect(hasRequest(updated, "req-1")).toBe(false);
	});

	test("updateRequest replaces the matching request in place", () => {
		const updated = updateRequest(aggregate(), request({ name: "Edited" }));
		expect(updated.requests).toHaveLength(1);
		expect(updated.requests[0].name).toBe("Edited");
	});

	test("addRequest returns the saved entry with a fresh id", () => {
		const { aggregate: next, request: saved } = addRequest(aggregate([]), request(), null);
		expect(saved.id).not.toBe("req-1");
		expect(hasRequest(next, saved.id)).toBe(true);
	});
});
