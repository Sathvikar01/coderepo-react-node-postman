export const MAX_TABS = 10;

const EMPTY_REQUEST = () => ({
	schemaVersion: 1,
	id: crypto.randomUUID(),
	folderId: null,
	name: "Untitled request",
	method: "GET",
	urlTemplate: "http://127.0.0.1:8000/demo/v1/echo",
	query: [],
	headers: [],
	body: { mode: "none" },
	auth: { mode: "none" },
	scripts: { preRequest: "", test: "" },
	settings: { timeoutMs: 15000 },
});

export function createInitialState() {
	return {
		tabs: [],
		activeTabId: null,
		activeEnvironmentId: null,
		collectionOrder: [],
	};
}

export function findOpenTab(tabs, candidate) {
	return tabs.find((tab) => tab.request.id === candidate.request.id && tab.collectionId === candidate.collectionId) ?? null;
}

export function createDraftTab({
	collectionId = null,
	collectionName = null,
	collectionRevision = null,
	folderId = null,
	request = null,
} = {}) {
	const definition = request ? structuredClone(request) : EMPTY_REQUEST();
	const scripts = definition.scripts ?? {};
	definition.scripts = { preRequest: String(scripts.preRequest ?? ""), test: String(scripts.test ?? "") };
	if (folderId) definition.folderId = folderId;
	return {
		id: crypto.randomUUID(),
		name: definition.name,
		request: definition,
		baseRequest: structuredClone(definition),
		collectionId,
		collectionName,
		collectionRevision,
		replayHistoryId: null,
		dirty: false,
		draftVersion: 1,
		executionId: null,
		status: "idle",
		result: null,
		error: null,
		startedAt: null,
	};
}

function updateTab(state, tabId, updater) {
	return { ...state, tabs: state.tabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)) };
}

export function workspaceReducer(state, action) {
	switch (action.type) {
		case "draft/open": {
			return { ...state, tabs: [...state.tabs, action.tab], activeTabId: action.tab.id };
		}
		case "draft/focus":
			return { ...state, activeTabId: action.tabId };
		case "draft/close": {
			const remaining = state.tabs.filter((tab) => tab.id !== action.tabId);
			const nextActive = state.activeTabId === action.tabId ? (remaining[remaining.length - 1]?.id ?? null) : state.activeTabId;
			return { ...state, tabs: remaining, activeTabId: nextActive };
		}
		case "draft/update":
			return updateTab(state, action.tabId, (tab) => ({
				...tab,
				request: { ...tab.request, ...action.patch },
				dirty: true,
				draftVersion: tab.draftVersion + 1,
			}));
		case "draft/saved":
			return updateTab(state, action.tabId, (tab) => {
				const savedRequest = structuredClone(action.request);
				const editedSinceSave =
					action.savedDraftVersion !== undefined && tab.draftVersion !== action.savedDraftVersion;
				return {
					...tab,
					name: editedSinceSave ? tab.request.name : savedRequest.name,
					request: editedSinceSave
						? { ...tab.request, id: savedRequest.id, folderId: savedRequest.folderId }
						: savedRequest,
					baseRequest: savedRequest,
					collectionId: action.collectionId,
					collectionName: action.collectionName,
					collectionRevision: action.collectionRevision,
					replayHistoryId: null,
					dirty: editedSinceSave,
				};
			});
		case "draft/replay":
			return updateTab(state, action.tabId, (tab) => ({ ...tab, replayHistoryId: action.replayHistoryId }));
		case "draft/status":
			return updateTab(state, action.tabId, (tab) => {
				if (action.executionId && tab.executionId && action.executionId !== tab.executionId) return tab;
				return { ...tab, status: action.status, error: action.error ?? null };
			});
		case "draft/dispatched":
			return updateTab(state, action.tabId, (tab) => ({
				...tab,
				executionId: action.executionId,
				status: "running",
				error: null,
				startedAt: Date.now(),
			}));
		case "draft/result":
			return updateTab(state, action.tabId, (tab) => {
				if (action.executionId && tab.executionId && action.executionId !== tab.executionId) return tab;
				return {
					...tab,
					status: action.result.outcome === "cancelled" ? "cancelled" : "settled",
					result: action.result,
					error: action.result.error ?? null,
				};
			});
		case "draft/inspect":
			return updateTab(state, action.tabId, (tab) => {
				const active = tab.status === "running" || tab.status === "reconciling";
				return {
					...tab,
					status: active ? tab.status : "settled",
					result: action.result,
					error: active ? tab.error : (action.result.error ?? null),
				};
			});
		case "collection/reconciled":
			return {
				...state,
				tabs: state.tabs.map((tab) =>
					tab.collectionId === action.collectionId
						? { ...tab, collectionName: action.name, collectionRevision: action.revision }
						: tab,
				),
			};
		case "environment/select":
			return { ...state, activeEnvironmentId: action.environmentId };
		case "preferences/set":
			return {
				...state,
				activeEnvironmentId: action.preferences.activeEnvironmentId ?? null,
				collectionOrder: action.preferences.collectionOrder ?? [],
			};
		case "session/clear":
			return createInitialState();
		default:
			return state;
	}
}
