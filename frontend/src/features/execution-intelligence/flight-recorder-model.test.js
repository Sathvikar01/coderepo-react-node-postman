import { describe, expect, test } from "bun:test";
import {
	capsuleDraftRequest,
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
			],
		});

		expect(groups.map((group) => group.category)).toEqual(["source", "auth", "target", "response"]);
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
