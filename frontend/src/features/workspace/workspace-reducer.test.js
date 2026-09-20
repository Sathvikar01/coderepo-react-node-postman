import { describe, expect, test } from "bun:test";
import { createDraftTab, createInitialState, workspaceReducer } from "./workspace-reducer.js";

const request = (overrides = {}) => ({
	schemaVersion: 1,
	id: "req-1",
	folderId: null,
	name: "Probe",
	method: "GET",
	urlTemplate: "http://127.0.0.1:8000/demo/v1/echo",
	query: [],
	headers: [],
	body: { mode: "none" },
	auth: { mode: "none" },
	settings: { timeoutMs: 15000 },
	...overrides,
});

const result = (outcome = "response") => ({
	executionId: "exec",
	outcome,
	response: { statusCode: 200 },
	error: null,
});

function openTab(state, definition = request()) {
	const tab = createDraftTab({ request: definition });
	return { tab, state: workspaceReducer(state, { type: "draft/open", tab }) };
}

function tabById(state, tabId) {
	return state.tabs.find((tab) => tab.id === tabId);
}

describe("tab drafts", () => {
	test("keeps independent drafts and results per tab", () => {
		let state = createInitialState();
		const first = openTab(state);
		state = first.state;
		const second = openTab(state, request({ id: "req-2", name: "Second" }));
		state = second.state;

		state = workspaceReducer(state, { type: "draft/update", tabId: first.tab.id, patch: { name: "Edited first" } });
		state = workspaceReducer(state, {
			type: "draft/result",
			tabId: second.tab.id,
			executionId: "exec-second",
			result: { ...result(), executionId: "exec-second" },
		});

		expect(tabById(state, first.tab.id).request.name).toBe("Edited first");
		expect(tabById(state, first.tab.id).result).toBeNull();
		expect(tabById(state, second.tab.id).request.name).toBe("Second");
		expect(tabById(state, second.tab.id).result.executionId).toBe("exec-second");
	});

	test("focusing a tab does not disturb drafts or results", () => {
		let state = createInitialState();
		const first = openTab(state);
		state = first.state;
		const second = openTab(state, request({ id: "req-2" }));
		state = second.state;

		state = workspaceReducer(state, { type: "draft/update", tabId: first.tab.id, patch: { method: "POST" } });
		state = workspaceReducer(state, { type: "draft/focus", tabId: first.tab.id });

		expect(state.activeTabId).toBe(first.tab.id);
		expect(tabById(state, first.tab.id).request.method).toBe("POST");
		expect(tabById(state, second.tab.id).request.method).toBe("GET");
	});

	test("closing the active tab activates the last remaining tab", () => {
		let state = createInitialState();
		const first = openTab(state);
		state = first.state;
		const second = openTab(state, request({ id: "req-2" }));
		state = second.state;

		state = workspaceReducer(state, { type: "draft/close", tabId: second.tab.id });

		expect(state.tabs).toHaveLength(1);
		expect(state.activeTabId).toBe(first.tab.id);
	});

	test("session/clear drops every tab and preference", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;
		state = workspaceReducer(state, { type: "preferences/set", preferences: { activeEnvironmentId: "env-1", collectionOrder: ["c1"] } });

		state = workspaceReducer(state, { type: "session/clear" });

		expect(state).toEqual(createInitialState());
	});
});

describe("send lifecycle", () => {
	test("dispatching marks the tab running with the execution id", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;

		state = workspaceReducer(state, { type: "draft/dispatched", tabId: opened.tab.id, executionId: "exec-1" });

		expect(tabById(state, opened.tab.id)).toMatchObject({ executionId: "exec-1", status: "running", error: null });
	});

	test("edits during a send survive and the result attaches to the same attempt", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;
		state = workspaceReducer(state, { type: "draft/dispatched", tabId: opened.tab.id, executionId: "exec-1" });

		state = workspaceReducer(state, { type: "draft/update", tabId: opened.tab.id, patch: { name: "Edited while running" } });
		state = workspaceReducer(state, {
			type: "draft/result",
			tabId: opened.tab.id,
			executionId: "exec-1",
			result: { ...result(), executionId: "exec-1" },
		});

		expect(tabById(state, opened.tab.id).request.name).toBe("Edited while running");
		expect(tabById(state, opened.tab.id).status).toBe("settled");
		expect(tabById(state, opened.tab.id).result.executionId).toBe("exec-1");
	});

	test("a late result from an older attempt cannot overwrite a newer attempt", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;
		state = workspaceReducer(state, { type: "draft/dispatched", tabId: opened.tab.id, executionId: "exec-1" });
		state = workspaceReducer(state, { type: "draft/dispatched", tabId: opened.tab.id, executionId: "exec-2" });

		state = workspaceReducer(state, {
			type: "draft/result",
			tabId: opened.tab.id,
			executionId: "exec-1",
			result: { ...result(), executionId: "exec-1" },
		});

		expect(tabById(state, opened.tab.id)).toMatchObject({ executionId: "exec-2", status: "running", result: null });
	});

	test("status updates from an older attempt are ignored", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;
		state = workspaceReducer(state, { type: "draft/dispatched", tabId: opened.tab.id, executionId: "exec-1" });
		state = workspaceReducer(state, { type: "draft/dispatched", tabId: opened.tab.id, executionId: "exec-2" });

		state = workspaceReducer(state, { type: "draft/status", tabId: opened.tab.id, executionId: "exec-1", status: "error", error: "old" });

		expect(tabById(state, opened.tab.id)).toMatchObject({ status: "running", error: null });
	});

	test("reconciling and cancelled states map correctly", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;
		state = workspaceReducer(state, { type: "draft/dispatched", tabId: opened.tab.id, executionId: "exec-1" });
		state = workspaceReducer(state, { type: "draft/status", tabId: opened.tab.id, executionId: "exec-1", status: "reconciling", error: "drop" });
		expect(tabById(state, opened.tab.id).status).toBe("reconciling");

		state = workspaceReducer(state, {
			type: "draft/result",
			tabId: opened.tab.id,
			executionId: "exec-1",
			result: { ...result("cancelled"), executionId: "exec-1" },
		});
		expect(tabById(state, opened.tab.id).status).toBe("cancelled");
	});

	test("closing a tab drops it and a late result is a no-op", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;
		state = workspaceReducer(state, { type: "draft/dispatched", tabId: opened.tab.id, executionId: "exec-1" });
		state = workspaceReducer(state, { type: "draft/close", tabId: opened.tab.id });

		const after = workspaceReducer(state, {
			type: "draft/result",
			tabId: opened.tab.id,
			executionId: "exec-1",
			result: { ...result(), executionId: "exec-1" },
		});

		expect(after.tabs).toHaveLength(0);
		expect(after.activeTabId).toBeNull();
	});

	test("inspecting history on a running tab preserves the active attempt", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;
		state = workspaceReducer(state, { type: "draft/dispatched", tabId: opened.tab.id, executionId: "exec-1" });

		state = workspaceReducer(state, { type: "draft/inspect", tabId: opened.tab.id, result: { ...result(), fromHistory: true } });

		expect(tabById(state, opened.tab.id)).toMatchObject({ status: "running", executionId: "exec-1" });
		expect(tabById(state, opened.tab.id).result.fromHistory).toBe(true);

		state = workspaceReducer(state, {
			type: "draft/result",
			tabId: opened.tab.id,
			executionId: "exec-1",
			result: { ...result(), executionId: "exec-1" },
		});
		expect(tabById(state, opened.tab.id).status).toBe("settled");
		expect(tabById(state, opened.tab.id).result.fromHistory).toBeUndefined();
	});

	test("inspecting history on an idle tab settles it", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;

		state = workspaceReducer(state, { type: "draft/inspect", tabId: opened.tab.id, result: { ...result(), fromHistory: true } });

		expect(tabById(state, opened.tab.id)).toMatchObject({ status: "settled", executionId: null });
	});
});

describe("save lifecycle", () => {
	test("draft/saved clears dirty and adopts the collection revision", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;
		state = workspaceReducer(state, { type: "draft/update", tabId: opened.tab.id, patch: { name: "Edited" } });

		state = workspaceReducer(state, {
			type: "draft/saved",
			tabId: opened.tab.id,
			request: request({ name: "Edited" }),
			savedDraftVersion: tabById(state, opened.tab.id).draftVersion,
			collectionId: "col-1",
			collectionName: "Orders",
			collectionRevision: 4,
		});

		expect(tabById(state, opened.tab.id)).toMatchObject({
			collectionId: "col-1",
			collectionRevision: 4,
			dirty: false,
			status: "idle",
		});
		expect(tabById(state, opened.tab.id).baseRequest.name).toBe("Edited");
	});

	test("edits made while a save was in flight are kept", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;
		const savedDraftVersion = tabById(state, opened.tab.id).draftVersion;
		state = workspaceReducer(state, { type: "draft/update", tabId: opened.tab.id, patch: { name: "Saved name" } });
		state = workspaceReducer(state, { type: "draft/update", tabId: opened.tab.id, patch: { name: "Later edit" } });

		state = workspaceReducer(state, {
			type: "draft/saved",
			tabId: opened.tab.id,
			request: request({ name: "Saved name" }),
			savedDraftVersion,
			collectionId: "col-1",
			collectionName: "Orders",
			collectionRevision: 4,
		});

		expect(tabById(state, opened.tab.id).request.name).toBe("Later edit");
		expect(tabById(state, opened.tab.id).baseRequest.name).toBe("Saved name");
		expect(tabById(state, opened.tab.id).dirty).toBe(true);
	});

	test("save-as keeps later edits and adopts the saved identity", () => {
		let state = createInitialState();
		const opened = openTab(state);
		state = opened.state;
		const savedDraftVersion = tabById(state, opened.tab.id).draftVersion;
		state = workspaceReducer(state, { type: "draft/update", tabId: opened.tab.id, patch: { name: "Later edit" } });

		state = workspaceReducer(state, {
			type: "draft/saved",
			tabId: opened.tab.id,
			request: request({ id: "req-copy", name: "Copy" }),
			savedDraftVersion,
			collectionId: "col-1",
			collectionName: "Orders",
			collectionRevision: 5,
		});

		const tab = tabById(state, opened.tab.id);
		expect(tab.request.name).toBe("Later edit");
		expect(tab.request.id).toBe("req-copy");
		expect(tab.baseRequest.id).toBe("req-copy");
		expect(tab.dirty).toBe(true);
	});

	test("draft/saved only touches the originating tab", () => {
		let state = createInitialState();
		const first = openTab(state);
		state = first.state;
		const second = openTab(state, request({ id: "req-2" }));
		state = second.state;

		state = workspaceReducer(state, {
			type: "draft/saved",
			tabId: second.tab.id,
			request: request({ id: "req-2" }),
			savedDraftVersion: tabById(state, second.tab.id).draftVersion,
			collectionId: "col-1",
			collectionName: "Orders",
			collectionRevision: 3,
		});

		expect(tabById(state, first.tab.id).collectionId).toBeNull();
		expect(tabById(state, second.tab.id).collectionRevision).toBe(3);
	});
});

describe("collection reconciliation", () => {
	test("collection/reconciled refreshes matching tabs without touching drafts", () => {
		let state = createInitialState();
		const first = openTab(state, request({ id: "req-1" }));
		state = first.state;
		state = workspaceReducer(state, {
			type: "draft/saved",
			tabId: first.tab.id,
			request: request({ id: "req-1" }),
			savedDraftVersion: tabById(state, first.tab.id).draftVersion,
			collectionId: "col-1",
			collectionName: "Orders",
			collectionRevision: 3,
		});
		state = workspaceReducer(state, { type: "draft/update", tabId: first.tab.id, patch: { name: "Local edit" } });

		state = workspaceReducer(state, { type: "collection/reconciled", collectionId: "col-1", name: "Orders renamed", revision: 9 });

		const tab = tabById(state, first.tab.id);
		expect(tab.collectionName).toBe("Orders renamed");
		expect(tab.collectionRevision).toBe(9);
		expect(tab.request.name).toBe("Local edit");
		expect(tab.dirty).toBe(true);
	});

	test("collection/reconciled leaves other collections alone", () => {
		let state = createInitialState();
		const opened = openTab(state, request({ id: "req-1" }));
		state = opened.state;
		state = workspaceReducer(state, {
			type: "draft/saved",
			tabId: opened.tab.id,
			request: request({ id: "req-1" }),
			savedDraftVersion: tabById(state, opened.tab.id).draftVersion,
			collectionId: "col-1",
			collectionName: "Orders",
			collectionRevision: 3,
		});

		state = workspaceReducer(state, { type: "collection/reconciled", collectionId: "col-2", name: "Other", revision: 12 });

		expect(tabById(state, opened.tab.id)).toMatchObject({ collectionId: "col-1", collectionRevision: 3 });
	});
});
