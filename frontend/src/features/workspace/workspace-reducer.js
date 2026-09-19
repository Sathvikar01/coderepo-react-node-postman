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
    auth: { mode: "inherit" },
    settings: { timeoutMs: 15000 },
});

export function createInitialState() {
    return {
        tabs: [],
        activeTabId: null,
        collections: {},
        environments: {},
        activeEnvironmentId: null,
        collectionOrder: [],
        responseView: "pretty",
    };
}

export function createDraftTab({ collectionId = null, collectionName = null, collectionRevision = null, folderId = null, request = null } = {}) {
    const definition = request ? structuredClone(request) : EMPTY_REQUEST();
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
        authOverride: null,
    };
}

function updateTab(state, tabId, updater) {
    return { ...state, tabs: state.tabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)) };
}

export function workspaceReducer(state, action) {
    switch (action.type) {
        case "draft/open": {
            const existing = state.tabs.find((tab) => action.tab.collectionId && tab.request.id === action.tab.request.id && tab.collectionId === action.tab.collectionId);
            if (existing) return { ...state, activeTabId: existing.id };
            if (state.tabs.length >= MAX_TABS) return state;
            return { ...state, tabs: [...state.tabs, action.tab], activeTabId: action.tab.id };
        }
        case "draft/focus":
            return { ...state, activeTabId: action.tabId };
        case "draft/close": {
            const remaining = state.tabs.filter((tab) => tab.id !== action.tabId);
            const nextActive = state.activeTabId === action.tabId ? remaining[remaining.length - 1]?.id ?? null : state.activeTabId;
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
            return updateTab(state, action.tabId, (tab) => ({
                ...tab,
                name: action.request.name,
                request: structuredClone(action.request),
                baseRequest: structuredClone(action.request),
                collectionId: action.collectionId,
                collectionName: action.collectionName,
                collectionRevision: action.collectionRevision,
                dirty: false,
            }));
        case "draft/replay":
            return updateTab(state, action.tabId, (tab) => ({ ...tab, replayHistoryId: action.replayHistoryId }));
        case "draft/status":
            return updateTab(state, action.tabId, (tab) => ({ ...tab, status: action.status, error: action.error ?? null, authOverride: action.status === "idle" ? null : tab.authOverride }));
        case "draft/dispatched":
            return updateTab(state, action.tabId, (tab) => ({ ...tab, executionId: action.executionId, status: "running", error: null, startedAt: Date.now() }));
        case "draft/result":
            return updateTab(state, action.tabId, (tab) => {
                if (action.executionId && tab.executionId && action.executionId !== tab.executionId) return tab;
                return { ...tab, status: action.result.outcome === "cancelled" ? "cancelled" : "settled", result: action.result, error: action.result.error ?? null };
            });
        case "collection/loaded":
            return { ...state, collections: { ...state.collections, [action.collection._id]: action.collection } };
        case "collection/removed": {
            const collections = { ...state.collections };
            delete collections[action.collectionId];
            return { ...state, collections };
        }
        case "environment/loaded":
            return { ...state, environments: { ...state.environments, [action.environment._id]: action.environment } };
        case "environment/removed": {
            const environments = { ...state.environments };
            delete environments[action.environmentId];
            return { ...state, environments, activeEnvironmentId: state.activeEnvironmentId === action.environmentId ? null : state.activeEnvironmentId };
        }
        case "environment/select":
            return { ...state, activeEnvironmentId: action.environmentId };
        case "preferences/set":
            return { ...state, activeEnvironmentId: action.preferences.activeEnvironmentId ?? null, collectionOrder: action.preferences.collectionOrder ?? [], responseView: action.preferences.responseView ?? "pretty" };
        case "session/clear":
            return createInitialState();
        default:
            return state;
    }
}
