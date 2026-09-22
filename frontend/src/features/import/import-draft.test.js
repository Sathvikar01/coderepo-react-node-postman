import { describe, expect, test } from "bun:test";
import { requestDefinitionSchema } from "../../../../backend/src/shared/utils/schemas.js";
import { createDraftTab, createInitialState, workspaceReducer } from "../workspace/workspace-reducer.js";
import { parseCurl } from "./curl-parser.js";
import { buildImportedTab } from "./import-draft.js";

const echo = "http://127.0.0.1:8000/demo/v1/echo";

function importedState(command, state = createInitialState()) {
	const parsed = parseCurl(command);
	expect(parsed.ok).toBe(true);
	const imported = buildImportedTab(parsed);
	expect(imported).not.toBeNull();
	return { state: workspaceReducer(state, { type: "draft/open", tab: imported.tab }), imported, parsed };
}

function tabById(state, id) {
	return state.tabs.find((tab) => tab.id === id);
}

describe("import to draft tab", () => {
	test("opens a dirty draft with generated identifiers", () => {
		const { state, imported } = importedState(`curl -X POST ${echo} -H 'Content-Type: application/json' -d '{"a":1}'`);
		const tab = state.tabs[0];
		expect(tab.id).toBe(imported.tab.id);
		expect(tab.dirty).toBe(true);
		expect(tab.status).toBe("idle");
		expect(tab.executionId).toBeNull();
		expect(tab.baseRequest).toEqual(tab.request);
		expect(tab.request.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(tab.request.headers[0].id).toMatch(/^[0-9a-f-]{36}$/i);
		expect(tab.request.body).toEqual({ mode: "json", text: '{"a":1}' });
		expect(tab.request.auth).toEqual({ mode: "none" });
	});

	test("returns null for failed parses", () => {
		expect(buildImportedTab(null)).toBeNull();
		expect(buildImportedTab(parseCurl("curl -d @f " + echo))).toBeNull();
		expect(buildImportedTab(parseCurl(""))).toBeNull();
	});

	test("keeps credentials out of the saved request", () => {
		const { imported } = importedState(`curl -u 'ada:secret' ${echo}`);
		expect(imported.authOverride).toEqual({ mode: "basic", usernameTemplate: "ada", passwordTemplate: "secret" });
		expect(imported.tab.request.auth).toEqual({ mode: "none" });
		expect(JSON.stringify(imported.tab.request)).not.toContain("secret");
	});

	test("normalizes future urlencoded adapters", () => {
		const { imported } = importedState(`curl -d 'a=1' ${echo}`);
		const definition = { ...imported.tab.request, body: { mode: "urlencoded", rows: [{ key: "a", value: "1" }] } };
		const tab = buildImportedTab({ ok: true, request: definition, authOverride: null }).tab;
		expect(tab.request.body.rows[0]).toMatchObject({ key: "a", value: "1", enabled: true });
		expect(tab.request.body.rows[0].id).toBeString();
	});

	test("does not mutate existing tabs", () => {
		let state = createInitialState();
		state = workspaceReducer(state, { type: "draft/open", tab: createDraftTab() });
		state = workspaceReducer(state, { type: "draft/update", tabId: state.tabs[0].id, patch: { urlTemplate: `${echo}?edited=1` } });
		const before = structuredClone(state.tabs);
		const next = importedState(`curl -X PUT ${echo} -d 'x=1'`, state).state;
		expect(next.tabs).toHaveLength(2);
		expect(next.tabs.slice(0, 1)).toEqual(before);
		expect(next.activeTabId).toBe(next.tabs[1].id);
	});
});

describe("import workflows", () => {
	test("import, edit, then send a schema-valid draft", () => {
		let { state } = importedState(`curl -d 'name=Ada' ${echo}`);
		const tabId = state.activeTabId;
		state = workspaceReducer(state, {
			type: "draft/update",
			tabId,
			patch: {
				method: "POST",
				urlTemplate: `${echo}?source=imported`,
				headers: [{ id: crypto.randomUUID(), key: "Content-Type", value: "application/json", enabled: true }],
			},
		});
		state = workspaceReducer(state, { type: "draft/update", tabId, patch: { body: { mode: "json", text: '{"name":"Ada"}' } } });
		const tab = tabById(state, tabId);
		expect(tab.dirty).toBe(true);
		expect(tab.draftVersion).toBe(3);
		const payload = { executionId: crypto.randomUUID(), tabId, draftVersion: tab.draftVersion, request: tab.request, context: {} };
		expect(requestDefinitionSchema.safeParse(payload.request).success).toBe(true);
		expect(payload.request.urlTemplate).toBe(`${echo}?source=imported`);
	});

	test("import, edit, then save settles the draft tab", () => {
		let { state } = importedState(`curl -X PATCH ${echo} -d 'a=1'`);
		const tabId = state.activeTabId;
		state = workspaceReducer(state, { type: "draft/update", tabId, patch: { name: "Save me" } });
		const saved = structuredClone(tabById(state, tabId).request);
		expect(requestDefinitionSchema.safeParse(saved).success).toBe(true);
		state = workspaceReducer(state, {
			type: "draft/saved",
			tabId,
			request: saved,
			savedDraftVersion: tabById(state, tabId).draftVersion,
			collectionId: "c1",
			collectionName: "Imported",
			collectionRevision: 1,
		});
		const tab = tabById(state, tabId);
		expect(tab.dirty).toBe(false);
		expect(tab.name).toBe("Save me");
		expect(tab.collectionId).toBe("c1");
	});

	test("an unedited import is valid for saving", () => {
		const { imported } = importedState(`curl -X POST ${echo} -H 'X-Tag: one' -d '{"ok":true}' -H 'Content-Type: application/json'`);
		expect(requestDefinitionSchema.safeParse(imported.tab.request).success).toBe(true);
	});

	test("the duplicate-header warning matches the backend contract", () => {
		const { imported, parsed } = importedState(`curl ${echo} -H 'X-Tag: one' -H 'X-Tag: two'`);
		expect(parsed.warnings.map((warning) => warning.code)).toContain("DUPLICATE_HEADERS");
		expect(requestDefinitionSchema.safeParse(imported.tab.request).success).toBe(false);
	});
});

describe("import boundary for richer adapters (reproduction capsules)", () => {
	const capsuleRequest = {
		schemaVersion: 1,
		id: "22222222-2222-4222-8222-222222222222",
		folderId: null,
		name: "Failing orders call",
		method: "POST",
		urlTemplate: "{{base_url}}/orders",
		query: [{ id: "33333333-3333-4333-8333-333333333333", key: "status", value: "paid", enabled: true }],
		headers: [{ id: "44444444-4444-4444-8444-444444444444", key: "X-Demo", value: "flight", enabled: true }],
		body: { mode: "json", text: '{"customer":"[REQUIRED_INPUT]"}' },
		auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
		scripts: { preRequest: "", test: "pm.test('status', () => {});" },
		assertions: [
			{
				id: "55555555-5555-4555-8555-555555555555",
				name: "orders are listed",
				enabled: true,
				target: "status",
				operator: "equals",
				path: "",
				expected: "200",
				valueType: "string",
				min: null,
				max: null,
			},
		],
		settings: { timeoutMs: 8000 },
	};

	test("preserves auth, scripts, assertions, and request semantics without drift", () => {
		const built = buildImportedTab({ ok: true, request: structuredClone(capsuleRequest), authOverride: null });

		expect(built.tab.dirty).toBe(true);
		expect(built.tab.status).toBe("idle");
		expect(built.tab.executionId).toBeNull();
		expect(built.tab.request).toMatchObject({
			name: "Failing orders call",
			method: "POST",
			urlTemplate: "{{base_url}}/orders",
			body: { mode: "json", text: '{"customer":"[REQUIRED_INPUT]"}' },
			auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
			scripts: { preRequest: "", test: "pm.test('status', () => {});" },
			settings: { timeoutMs: 8000 },
		});
		expect(built.tab.request.query.map((row) => [row.key, row.value])).toEqual([["status", "paid"]]);
		expect(built.tab.request.headers.map((row) => [row.key, row.value])).toEqual([["X-Demo", "flight"]]);
		expect(built.tab.request.assertions).toHaveLength(1);
		expect(built.tab.request.assertions[0]).toMatchObject({ name: "orders are listed", target: "status", expected: "200" });
		expect(requestDefinitionSchema.safeParse(built.tab.request).success).toBe(true);
	});

	test("cURL imports keep the existing defaults", () => {
		const parsed = parseCurl(`curl ${echo}`);
		const built = buildImportedTab(parsed);

		expect(built.tab.request.auth).toEqual({ mode: "none" });
		expect(built.tab.request.scripts).toEqual({ preRequest: "", test: "" });
		expect(built.tab.request.assertions).toEqual([]);
		expect(requestDefinitionSchema.safeParse(built.tab.request).success).toBe(true);
	});
});
