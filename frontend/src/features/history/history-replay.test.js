import { describe, expect, test } from "bun:test";
import { isReplayable, materializeReplayRequest, replayContext } from "./history-replay.js";

const record = (overrides = {}) => ({
	executionId: "exec-1",
	request: {
		schemaVersion: 1,
		id: "req-1",
		folderId: null,
		name: "Probe",
		method: "GET",
		urlTemplate: "https://example.com",
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "inherit" },
		settings: { timeoutMs: 15000 },
	},
	snapshot: { effectiveAuth: { mode: "bearer", tokenTemplate: "{{token}}" } },
	...overrides,
});

describe("history replay", () => {
	test("rejects records without a replayable request snapshot", () => {
		expect(isReplayable(record())).toBe(true);
		expect(isReplayable({ executionId: "exec-1" })).toBe(false);
		expect(materializeReplayRequest({ executionId: "exec-1" })).toBeNull();
	});

	test("resolves inherited auth from the recorded snapshot", () => {
		const request = materializeReplayRequest(record());
		expect(request.auth).toEqual({ mode: "bearer", tokenTemplate: "{{token}}" });
		expect(request.id).toBe("req-1");
	});

	test("keeps explicit request auth untouched", () => {
		const explicit = record({ request: { ...record().request, auth: { mode: "none" } } });
		expect(materializeReplayRequest(explicit).auth).toEqual({ mode: "none" });
	});

	test("replay context pins the environment revision and history id", () => {
		expect(replayContext(record(), { environmentId: "env-1", environmentRevision: 7 })).toEqual({
			replayHistoryId: "exec-1",
			environmentId: "env-1",
			environmentRevision: 7,
		});
		expect(replayContext(record())).toEqual({ replayHistoryId: "exec-1" });
	});
});
