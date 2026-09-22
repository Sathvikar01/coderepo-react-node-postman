import { describe, expect, test } from "bun:test";
import {
	capsuleDraftRequest,
	capsuleDraftTab,
	contractBadge,
	groupComparisonChanges,
	minimizationSummary,
	recorderErrorMessage,
} from "./flight-recorder-model.js";

describe("Flight Recorder view model", () => {
	test("groups causal evidence in the product order", () => {
		const groups = groupComparisonChanges({
			changes: [
				{ category: "response", path: "response.bodyFingerprint" },
				{ category: "target", path: "target.address" },
				{ category: "source", path: "source.environmentRevision" },
				{ category: "auth", path: "request.auth" },
				{ category: "tests", path: "tests.counts" },
			],
		});

		expect(groups.map((group) => group.category)).toEqual(["source", "auth", "target", "response", "tests"]);
		expect(groups[0].changes[0].path).toBe("source.environmentRevision");
	});

	test("summarizes contract severity", () => {
		expect(contractBadge({ breaking: true, changes: [{ severity: "breaking" }] })).toEqual({ tone: "danger", label: "Breaking change" });
		expect(contractBadge({ breaking: false, changes: [{ severity: "additive" }] })).toEqual({ tone: "info", label: "Additive change" });
		expect(contractBadge({ breaking: false, changes: [] })).toEqual({ tone: "neutral", label: "No contract drift" });
	});

	test("turns a capsule preview into a fresh draft without mutating the preview", () => {
		const imported = {
			dirty: true,
			autoSend: false,
			autoSave: false,
			draft: { schemaVersion: 1, id: "old-id", folderId: "folder", name: "Repro", method: "GET" },
		};
		const request = capsuleDraftRequest(imported, "new-id");

		expect(request).toMatchObject({ id: "new-id", folderId: null, name: "Repro", method: "GET" });
		expect(imported.draft).toMatchObject({ id: "old-id", folderId: "folder" });
	});

	test("opens capsule imports through the Phase 7 boundary as unsent dirty drafts", () => {
		const imported = {
			dirty: true,
			autoSend: false,
			autoSave: false,
			draft: {
				schemaVersion: 1,
				id: "old-id",
				folderId: null,
				name: "Repro",
				method: "POST",
				urlTemplate: "{{base_url}}/orders",
				query: [{ id: "11111111-1111-4111-8111-111111111111", key: "status", value: "paid", enabled: true }],
				headers: [],
				body: { mode: "json", text: '{"customer":"[REQUIRED_INPUT]"}' },
				auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
				scripts: { preRequest: "", test: "" },
				assertions: [],
				settings: { timeoutMs: 5000 },
			},
		};
		const tab = capsuleDraftTab(imported);

		expect(tab).not.toBeNull();
		expect(tab.dirty).toBe(true);
		expect(tab.status).toBe("idle");
		expect(tab.executionId).toBeNull();
		expect(tab.request).toMatchObject({
			name: "Repro",
			method: "POST",
			urlTemplate: "{{base_url}}/orders",
			body: { mode: "json", text: '{"customer":"[REQUIRED_INPUT]"}' },
			auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
		});
		expect(tab.request.query.map((row) => [row.key, row.value])).toEqual([["status", "paid"]]);
		expect(imported.draft).toMatchObject({ id: "old-id" });
		expect(capsuleDraftTab({ ...imported, autoSend: true })).toBeNull();
		expect(capsuleDraftTab({ ...imported, autoSave: true })).toBeNull();
	});

	test("summarizes running, completed, cancelled, and failed jobs", () => {
		expect(minimizationSummary({ status: "running" }).label).toBe("Probing safely…");
		expect(minimizationSummary({ status: "completed", result: { removed: [{}, {}], probesUsed: 6 } })).toEqual({
			tone: "success",
			label: "Removed 2 inputs in 6 probes.",
		});
		expect(minimizationSummary({ status: "cancelled" }).tone).toBe("warning");
		expect(minimizationSummary({ status: "failed", error: { message: "Unstable" } })).toEqual({ tone: "danger", label: "Unstable" });
	});

	test("explains legacy receipt compatibility without exposing server details", () => {
		expect(recorderErrorMessage({ code: "RECEIPT_UNAVAILABLE" })).toBe("This execution predates Flight Recorder evidence. Send it again to create a passport.");
		expect(recorderErrorMessage({ message: "Network failed" })).toBe("Network failed");
	});
});
