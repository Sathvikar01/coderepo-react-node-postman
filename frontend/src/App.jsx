import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { WorkspaceLogin } from "./features/auth/WorkspaceLogin.jsx";
import { authApi } from "./features/auth/auth.api.js";
import { NewCollectionDialog, RenameDialog, SaveRequestDialog } from "./features/collections/CollectionDialogs.jsx";
import { CollectionsSidebar } from "./features/collections/CollectionsSidebar.jsx";
import { collectionApi } from "./features/collections/collection.api.js";
import { addFolder, addRequest, deleteFolder, duplicateFolder, duplicateRequest, moveRequest, removeRequest, renameFolder, updateRequest } from "./features/collections/collection-edit.js";
import { EnvironmentsDrawer } from "./features/environments/EnvironmentsDrawer.jsx";
import { environmentApi } from "./features/environments/environment.api.js";
import { executionApi } from "./features/executions/execution.api.js";
import { ResponseViewer } from "./features/executions/ResponseViewer.jsx";
import { HistoryPanel } from "./features/history/HistoryPanel.jsx";
import { historyApi } from "./features/history/history.api.js";
import { ProfilePicker } from "./features/profiles/ProfilePicker.jsx";
import { profileApi } from "./features/profiles/profile.api.js";
import { RequestBuilder } from "./features/requests/RequestBuilder.jsx";
import { ConfirmationDialog } from "./shared/components/ConfirmationDialog.jsx";
import { MaterialIcon } from "./shared/components/MaterialIcon.jsx";
import { clearSession, hasProfileToken, hasSessionToken, readStoredProfileId, setProfileToken, setSessionToken, setStoredProfileId } from "./shared/api/client.js";
import { OUTCOME_LABELS } from "./shared/utils/format.js";
import { applyTheme, readTheme } from "./shared/utils/theme.js";
import { createDraftTab, createInitialState, findOpenTab, MAX_TABS, workspaceReducer } from "./features/workspace/workspace-reducer.js";
import { WorkspaceHeader } from "./features/workspace/WorkspaceHeader.jsx";
import { TracerSymbol } from "./shared/components/TracerBrand.jsx";
import { useRovingTabs } from "./shared/hooks/useRovingTabs.js";
import { useSplitPane } from "./shared/hooks/useSplitPane.js";

function BootScreen() {
    return (
        <main aria-label="Opening Tracer" className="app-boot" role="status">
            <div className="app-boot-brand"><span className="brand-mark"><TracerSymbol size={26} /></span><strong>Tracer</strong></div>
            <div aria-hidden="true" className="app-boot-progress"><span /></div>
        </main>
    );
}

export default function App() {
    const [state, dispatch] = useReducer(workspaceReducer, undefined, createInitialState);
    const [theme, setTheme] = useState(readTheme);
    const [bootstrapping, setBootstrapping] = useState(true);
    const [account, setAccount] = useState(null);
    const [profiles, setProfiles] = useState(null);
    const [profile, setProfile] = useState(null);
    const [authError, setAuthError] = useState("");
    const [loginBusy, setLoginBusy] = useState(false);
    const [collections, setCollections] = useState([]);
    const [environments, setEnvironments] = useState([]);
    const [loadingCollections, setLoadingCollections] = useState(false);
    const [sidebarTab, setSidebarTab] = useState("collections");
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [dialog, setDialog] = useState(null);
    const [busy, setBusy] = useState(false);
    const [dialogError, setDialogError] = useState("");
    const [toasts, setToasts] = useState([]);
    const [historyRefresh, setHistoryRefresh] = useState(0);
    const [liveResult, setLiveResult] = useState(null);
    const [authOverrides, setAuthOverrides] = useState({});
    const [executionPolicy, setExecutionPolicy] = useState(null);
    const tabs = useRovingTabs();
    const splitContainer = useRef(null);
    const split = useSplitPane(splitContainer);
    const reconcileTimers = useRef({});
    const toastTimers = useRef(new Set());
    const maxTabs = executionPolicy?.maxOpenTabs ?? MAX_TABS;

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
    const activeCollection = activeTab?.collectionId ? collections.find((collection) => collection._id === activeTab.collectionId) ?? null : null;

    const toast = useCallback((message, tone = "info") => {
        const id = crypto.randomUUID();
        setToasts((current) => [...current, { id, message, tone }]);
        const timer = setTimeout(() => {
            toastTimers.current.delete(timer);
            setToasts((current) => current.filter((item) => item.id !== id));
        }, 5200);
        toastTimers.current.add(timer);
    }, []);

    useEffect(() => () => {
        toastTimers.current.forEach((timer) => clearTimeout(timer));
        Object.values(reconcileTimers.current).forEach((timer) => clearTimeout(timer));
    }, []);

    const openDraftTab = useCallback(
        (tab) => {
            const existing = findOpenTab(state.tabs, tab);
            if (existing) {
                dispatch({ type: "draft/focus", tabId: existing.id });
                return true;
            }
            if (state.tabs.length >= maxTabs) {
                toast(`Close a request tab before opening another. This workspace allows ${maxTabs} open requests.`, "warning");
                return false;
            }
            dispatch({ type: "draft/open", tab });
            return true;
        },
        [maxTabs, state.tabs, toast],
    );

    useEffect(() => {
        applyTheme(theme);
    }, [theme]);

    useEffect(() => {
        const expire = (event) => {
            dispatch({ type: "session/clear" });
            clearSession();
            setAccount(null);
            setProfile(null);
            setProfiles(null);
            setAuthError(event.detail || "Your session has expired. Sign in again.");
        };
        window.addEventListener("request-desk-session-expired", expire);
        return () => window.removeEventListener("request-desk-session-expired", expire);
    }, []);

    const loadWorkspace = useCallback(async () => {
        setLoadingCollections(true);
        try {
            const [summaries, environmentSummaries, preferences] = await Promise.all([collectionApi.list(), environmentApi.list(), profileApi.preferences()]);
            const aggregates = await Promise.all(summaries.map((summary) => collectionApi.get(summary._id)));
            setCollections(aggregates);
            setEnvironments(environmentSummaries);
            dispatch({ type: "preferences/set", preferences: preferences.preferences });
            setExecutionPolicy(preferences.executionPolicy ?? null);
        } catch (error) {
            toast(error.message, "error");
        } finally {
            setLoadingCollections(false);
        }
    }, [toast]);

    useEffect(() => {
        let active = true;
        const restore = async () => {
            if (!hasSessionToken()) {
                if (active) setBootstrapping(false);
                return;
            }
            let restoredAccount = null;
            try {
                restoredAccount = await authApi.session();
            } catch {
                if (active) { clearSession(); setBootstrapping(false); }
                return;
            }
            if (!active) return;
            setAccount(restoredAccount.account);
            if (!hasProfileToken()) {
                const list = await profileApi.list();
                if (active) { setProfiles(list); setBootstrapping(false); }
                return;
            }
            const storedProfileId = readStoredProfileId();
            if (storedProfileId) {
                try {
                    const list = await profileApi.list();
                    const match = list.find((item) => item._id === storedProfileId);
                    if (match) {
                        setProfile(match);
                        await loadWorkspace();
                    }
                } catch (error) {
                    if (active) setAuthError(error.message);
                }
            }
            if (active) setBootstrapping(false);
        };
        restore();
        return () => { active = false; };
    }, [loadWorkspace]);

    const login = async (email, password) => {
        setLoginBusy(true);
        setAuthError("");
        try {
            const result = await authApi.login(email, password);
            setSessionToken(result.token);
            setAccount(result.account);
            setProfiles(await profileApi.list());
        } catch (error) {
            setAuthError(error.message);
        } finally {
            setLoginBusy(false);
        }
    };

    const chooseProfile = async (selected) => {
        setAuthError("");
        try {
            const result = await authApi.switchProfile(selected._id);
            setProfileToken(result.token);
            setStoredProfileId(result.profile._id);
            setProfile(result.profile);
            await loadWorkspace();
        } catch (error) {
            setAuthError(error.message);
        }
    };

    const signOut = async () => {
        try {
            await authApi.logout();
        } catch {
            // The stateless token is discarded locally regardless of the response.
        }
        clearSession();
        dispatch({ type: "session/clear" });
        setAccount(null);
        setProfile(null);
        setProfiles(null);
        setCollections([]);
        setEnvironments([]);
    };

    const switchProfile = async () => {
        if (!account) return;
        try {
            setProfiles(await profileApi.list());
        } catch (error) {
            toast(error.message, "error");
            return;
        }
        clearSession();
        dispatch({ type: "session/clear" });
        setProfile(null);
        setCollections([]);
        setEnvironments([]);
    };

    const savePreferences = async (patch) => {
        try {
            const result = await profileApi.updatePreferences(patch);
            dispatch({ type: "preferences/set", preferences: result.preferences });
        } catch (error) {
            toast(error.message, "error");
        }
    };

    const openCollection = useCallback(async (summary) => {
        try {
            const aggregate = await collectionApi.get(summary._id);
            setCollections((current) => current.map((item) => (item._id === aggregate._id ? aggregate : item)));
            return aggregate;
        } catch (error) {
            toast(error.message, "error");
            return null;
        }
    }, [toast]);

    const openRequest = (collection, request) => {
        openDraftTab(createDraftTab({ collectionId: collection._id, collectionName: collection.name, collectionRevision: collection.revision, request }));
        setSidebarOpen(false);
    };

    const updateDraft = (patch) => {
        if (!activeTab) return;
        dispatch({ type: "draft/update", tabId: activeTab.id, patch });
    };

    const closeTab = (tabId) => {
        const tab = state.tabs.find((item) => item.id === tabId);
        if (tab?.dirty) {
            setDialog({ kind: "close-tab", tabId, title: "Discard unsaved changes?", message: `${tab.name} has unsaved changes. Closing this tab discards them.` });
            return;
        }
        dispatch({ type: "draft/close", tabId });
    };

    const activeEnvironmentRevision = state.activeEnvironmentId ? environments.find((environment) => environment._id === state.activeEnvironmentId)?.revision : undefined;

    const send = async () => {
        if (!activeTab || activeTab.status === "running") return;
        const executionId = crypto.randomUUID();
        dispatch({ type: "draft/dispatched", tabId: activeTab.id, executionId });
        const input = {
            executionId,
            tabId: activeTab.id,
            draftVersion: activeTab.draftVersion,
            request: activeTab.request,
            context: {
                ...(activeTab.collectionId ? { collectionId: activeTab.collectionId, requestId: activeTab.request.id, collectionRevision: activeTab.collectionRevision } : {}),
                ...(state.activeEnvironmentId ? { environmentId: state.activeEnvironmentId, environmentRevision: activeEnvironmentRevision } : {}),
                ...(activeTab.replayHistoryId ? { replayHistoryId: activeTab.replayHistoryId } : {}),
            },
            ...(authOverrides[activeTab.id] ? { authOverride: authOverrides[activeTab.id] } : {}),
        };
        try {
            const result = await executionApi.send(input);
            dispatch({ type: "draft/result", tabId: activeTab.id, executionId, result });
            setLiveResult(result);
            setHistoryRefresh((current) => current + 1);
            if (result.outcome === "validation_error") toast(result.error?.message ?? "The request could not be sent.", "error");
        } catch (error) {
            dispatch({ type: "draft/status", tabId: activeTab.id, status: "reconciling", error: error.message });
            startReconciliation(activeTab.id, executionId);
        }
    };

    const startReconciliation = (tabId, executionId) => {
        let attempts = 0;
        const poll = async () => {
            attempts += 1;
            try {
                const record = await executionApi.status(executionId);
                if (record.status === "terminal") {
                    dispatch({ type: "draft/result", tabId, executionId, result: record });
                    setLiveResult(record);
                    setHistoryRefresh((current) => current + 1);
                    return;
                }
            } catch (error) {
                if (error.code === "EXECUTION_NOT_FOUND" && attempts > 4) {
                    dispatch({ type: "draft/status", tabId, status: "error", error: "The application connection dropped before this send was recorded. It is unknown whether the target was reached." });
                    return;
                }
            }
            if (attempts < 10) reconcileTimers.current[executionId] = setTimeout(poll, Math.min(400 * attempts, 3000));
        };
        poll();
    };

    const cancel = async () => {
        if (!activeTab?.executionId) return;
        let attempt = 0;
        const request = async () => {
            attempt += 1;
            try {
                const result = await executionApi.cancel(activeTab.executionId);
                if (result.status === "terminal") {
                    dispatch({ type: "draft/result", tabId: activeTab.id, executionId: activeTab.executionId, result });
                    setLiveResult(result);
                    setHistoryRefresh((current) => current + 1);
                    return;
                }
            } catch (error) {
                if (error.code === "EXECUTION_NOT_FOUND" && attempt < 3) {
                    setTimeout(request, 250 * attempt);
                    return;
                }
            }
            if (attempt < 4) setTimeout(request, 500 * attempt);
            else dispatch({ type: "draft/status", tabId: activeTab.id, status: "running", error: null });
        };
        request();
    };

    const applyAggregate = async (collection, aggregate, { keepDraft = false, successMessage } = {}) => {
        const updated = await collectionApi.update(collection._id, collection.revision, {
            name: aggregate.name,
            description: aggregate.description ?? "",
            variables: aggregate.variables ?? [],
            auth: aggregate.auth ?? { mode: "none" },
            folders: aggregate.folders ?? [],
            requests: aggregate.requests ?? [],
        });
        dispatch({ type: "collection/loaded", collection: updated });
        setCollections((current) => current.map((item) => (item._id === updated._id ? updated : item)));
        if (!keepDraft) setDialog(null);
        setDialogError("");
        if (successMessage) toast(successMessage);
        return updated;
    };

    const runAggregateEdit = async (collection, edit) => {
        try {
            setBusy(true);
            const aggregate = edit(collection);
            await applyAggregate(collection, aggregate);
            return true;
        } catch (error) {
            if (error.code === "COLLECTION_REVISION_CONFLICT") {
                setDialogError("This collection changed since it was loaded. Reload the latest revision before continuing.");
                toast("This collection changed elsewhere. Reload before continuing.", "error");
            } else {
                setDialogError(error.message);
                toast(error.message, "error");
            }
            return false;
        } finally {
            setBusy(false);
        }
    };

    const saveDraft = async () => {
        if (!activeTab) return;
        if (!activeTab.collectionId) {
            setDialogError("");
            setDialog({ kind: "save-request", tabId: activeTab.id });
            return;
        }
        const collection = collections.find((item) => item._id === activeTab.collectionId);
        if (!collection) {
            setDialogError("");
            setDialog({ kind: "save-request", tabId: activeTab.id });
            return;
        }
        setBusy(true);
        try {
            const result = await collectionApi.update(collection._id, collection.revision, {
                name: collection.name,
                description: collection.description ?? "",
                variables: collection.variables ?? [],
                auth: collection.auth ?? { mode: "none" },
                folders: collection.folders ?? [],
                requests: updateRequest(collection, activeTab.request).requests,
            });
            dispatch({ type: "collection/loaded", collection: result });
            setCollections((current) => current.map((item) => (item._id === result._id ? result : item)));
            dispatch({ type: "draft/saved", tabId: activeTab.id, request: activeTab.request, collectionId: result._id, collectionName: result.name, collectionRevision: result.revision });
            toast("Request saved.");
        } catch (error) {
            if (error.code === "COLLECTION_REVISION_CONFLICT") {
                setDialogError("");
                setDialog({ kind: "conflict", tabId: activeTab.id, collectionId: collection._id });
                return;
            }
            toast(error.message, "error");
        } finally {
            setBusy(false);
        }
    };

    const saveAsNewRequest = async ({ collectionId, folderId, name }, draftRequest = activeTab?.request, tabId = activeTab?.id ?? null) => {
        const collection = collections.find((item) => item._id === collectionId);
        if (!collection || !draftRequest) return;
        setBusy(true);
        try {
            const next = addRequest({ ...collection, requests: collection.requests }, { ...draftRequest, name }, folderId).aggregate;
            const updated = await applyAggregate(collection, next);
            if (tabId) {
                dispatch({ type: "draft/saved", tabId, request: { ...draftRequest, name, id: next.requests[next.requests.length - 1].id, folderId }, collectionId: updated._id, collectionName: updated.name, collectionRevision: updated.revision });
            }
            toast("Request saved.");
        } catch (error) {
            setDialogError(error.message);
        } finally {
            setBusy(false);
        }
    };

    const reloadCollection = async (collectionId) => {
        const summary = collections.find((item) => item._id === collectionId);
        if (!summary) return;
        const aggregate = await openCollection(summary);
        if (aggregate && activeTab) {
            const fresh = aggregate.requests.find((item) => item.id === activeTab.request.id);
            if (fresh) {
                dispatch({ type: "draft/update", tabId: activeTab.id, patch: {} });
                dispatch({ type: "draft/saved", tabId: activeTab.id, request: fresh, collectionId: aggregate._id, collectionName: aggregate.name, collectionRevision: aggregate.revision });
            }
        }
        setDialog(null);
    };

    const openHistoryEntry = async (executionId, { reopen = false } = {}) => {
        try {
            const record = await historyApi.get(executionId);
            if (reopen) {
                if (!record.request?.schemaVersion) {
                    toast("This history entry was recorded before replayable request snapshots and cannot be reopened.", "error");
                    return;
                }
                const request = structuredClone(record.request);
                const effectiveAuth = record.snapshot?.effectiveAuth;
                if (request.auth?.mode === "inherit" && effectiveAuth && effectiveAuth.mode !== "inherit") request.auth = structuredClone(effectiveAuth);
                const tab = createDraftTab({ request });
                if (!openDraftTab(tab)) return;
                dispatch({ type: "draft/replay", tabId: tab.id, replayHistoryId: executionId });
                toast("Opened a copy from history. Editing it does not change the saved request.");
                setSidebarOpen(false);
                return;
            }
            setLiveResult({
                executionId,
                outcome: record.outcome,
                response: record.response,
                error: record.error,
                effectCertainty: record.effectCertainty,
                persistence: record.persistence,
                startedAt: record.startedAt,
                finishedAt: record.finishedAt,
                compileTrace: record.compileTrace ?? [],
                warnings: record.warnings ?? [],
                historyId: record.executionId,
                fromHistory: true,
            });
            setSidebarOpen(false);
        } catch (error) {
            toast(error.message, "error");
        }
    };

    const resendHistoryEntry = async (executionId) => {
        try {
            const record = await historyApi.get(executionId);
            if (!record.request?.schemaVersion) {
                toast("This history entry was recorded before replayable request snapshots and cannot be resent.", "error");
                return;
            }
            const request = structuredClone(record.request);
            const effectiveAuth = record.snapshot?.effectiveAuth;
            if (request.auth?.mode === "inherit" && effectiveAuth && effectiveAuth.mode !== "inherit") request.auth = structuredClone(effectiveAuth);
            const result = await executionApi.send({ executionId: crypto.randomUUID(), tabId: "history", draftVersion: 1, request, context: { ...(state.activeEnvironmentId ? { environmentId: state.activeEnvironmentId, environmentRevision: activeEnvironmentRevision } : {}) } });
            setLiveResult(result);
            setHistoryRefresh((current) => current + 1);
            toast(`Resent as a new execution (${OUTCOME_LABELS[result.outcome] ?? result.outcome}).`);
        } catch (error) {
            toast(error.message, "error");
        }
    };

    const deleteHistoryEntry = async (executionId) => {
        try {
            await historyApi.remove(executionId);
            setHistoryRefresh((current) => current + 1);
            toast("History entry hidden.");
        } catch (error) {
            toast(error.message, "error");
        }
    };

    const clearHistory = async () => {
        setDialog({ kind: "clear-history" });
    };

    useEffect(() => {
        const onKeyDown = (event) => {
            const meta = event.metaKey || event.ctrlKey;
            if (!activeTab) return;
            if (meta && event.key === "Enter") {
                event.preventDefault();
                send();
            }
            if (meta && event.key.toLowerCase() === "s") {
                event.preventDefault();
                saveDraft();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    });

    const activeCollectionAuth = activeCollection?.auth ?? null;

    if (bootstrapping) return <BootScreen />;
    if (!account) return <WorkspaceLogin error={authError} loading={loginBusy} onLogin={login} />;
    if (!profile) return <ProfilePicker error={authError} loading={!profiles} onLogout={signOut} onRetry={async () => setProfiles(await profileApi.list())} onSelect={chooseProfile} profiles={profiles ?? []} switchingFrom={null} />;

    const dialogNode = (() => {
        if (!dialog) return null;
        if (dialog.kind === "save-request") {
            const draftRequest = dialog.request ?? activeTab?.request;
            return <SaveRequestDialog busy={busy} collections={collections} error={dialogError} onCancel={() => setDialog(null)} onSave={(payload) => saveAsNewRequest(payload, draftRequest, dialog.tabId ?? activeTab?.id ?? null)} request={draftRequest} />;
        }
        if (dialog.kind === "delete-collection") {
            return (
                <ConfirmationDialog
                    busy={busy}
                    confirmLabel="Delete collection"
                    message={`Delete "${dialog.collection.name}" and its ${dialog.collection.requests?.length ?? 0} saved request(s)? History entries are kept because they store their own snapshots.`}
                    onCancel={() => setDialog(null)}
                    onConfirm={async () => {
                        setBusy(true);
                        try {
                            await collectionApi.remove(dialog.collection._id, dialog.collection.revision);
                            setCollections((current) => current.filter((item) => item._id !== dialog.collection._id));
                            setDialog(null);
                            toast("Collection deleted.");
                        } catch (error) {
                            setDialogError(error.message);
                        } finally {
                            setBusy(false);
                        }
                    }}
                    title="Delete collection"
                />
            );
        }
        if (dialog.kind === "duplicate-collection") {
            return <RenameDialog busy={busy} error={dialogError} initialValue={`${dialog.collection.name} copy`} label="New collection name" title="Duplicate collection" onCancel={() => setDialog(null)} onSubmit={async (name) => {
                setBusy(true);
                try {
                    await collectionApi.duplicate(dialog.collection._id, dialog.collection.revision, name);
                    const summaries = await collectionApi.list();
                    const aggregates = await Promise.all(summaries.map((summary) => collectionApi.get(summary._id)));
                    setCollections(aggregates);
                    aggregates.forEach((collection) => dispatch({ type: "collection/loaded", collection }));
                    setDialog(null);
                    toast("Collection duplicated.");
                } catch (error) {
                    setDialogError(error.message);
                } finally {
                    setBusy(false);
                }
            }} />;
        }
        if (dialog.kind === "new-collection") {
            return <NewCollectionDialog busy={busy} error={dialogError} onCancel={() => setDialog(null)} onSubmit={async ({ name, description }) => {
                setBusy(true);
                try {
                    const created = await collectionApi.create({ name, description });
                    const aggregate = await collectionApi.get(created._id);
                    setCollections((current) => [...current, aggregate]);
                    dispatch({ type: "collection/loaded", collection: aggregate });
                    savePreferences({ collectionOrder: [...state.collectionOrder, aggregate._id] });
                    setDialog(null);
                    toast("Collection created.");
                } catch (error) {
                    setDialogError(error.message);
                } finally {
                    setBusy(false);
                }
            }} />;
        }
        if (dialog.kind === "rename-collection") {
            return <RenameDialog busy={busy} error={dialogError} initialValue={dialog.collection.name} label="Collection name" title="Rename collection" onCancel={() => setDialog(null)} onSubmit={(name) => runAggregateEdit(dialog.collection, (collection) => ({ ...collection, name })).then((ok) => { if (ok) toast("Collection renamed."); })} />;
        }
        if (dialog.kind === "new-folder") {
            return <RenameDialog busy={busy} error={dialogError} initialValue="" label="Folder name" title="New folder" onCancel={() => setDialog(null)} onSubmit={(name) => runAggregateEdit(dialog.collection, (collection) => addFolder(collection, name).aggregate).then((ok) => { if (ok) toast("Folder created."); })} />;
        }
        if (dialog.kind === "rename-folder") {
            return <RenameDialog busy={busy} error={dialogError} initialValue={dialog.folder.name} label="Folder name" title="Rename folder" onCancel={() => setDialog(null)} onSubmit={(name) => runAggregateEdit(dialog.collection, (collection) => renameFolder(collection, dialog.folder.id, name))} />;
        }
        if (dialog.kind === "conflict") {
            const collection = collections.find((item) => item._id === dialog.collectionId) ?? dialog.collection;
            return (
                <ConfirmationDialog
                    busy={busy}
                    confirmLabel="Save as a copy"
                    message="This collection changed since it was loaded. Reload the latest revision to continue editing, or save your draft as a new request."
                    onCancel={() => setDialog(null)}
                    onConfirm={() => { setDialog({ kind: "save-request", tabId: dialog.tabId }); }}
                    title="Collection changed"
                    error={dialogError}
                    extraFooter={<button className="text-button" type="button" onClick={() => reloadCollection(collection._id)}>Reload</button>}
                />
            );
        }
        if (dialog.kind === "close-tab") {
            return <ConfirmationDialog busy={false} confirmLabel="Discard and close" message={dialog.message} onCancel={() => setDialog(null)} onConfirm={() => { dispatch({ type: "draft/close", tabId: dialog.tabId }); setDialog(null); }} title={dialog.title} />;
        }
        if (dialog.kind === "clear-history") {
            return <ConfirmationDialog busy={busy} confirmLabel="Clear history" message="Visible history entries are hidden and their stored bodies removed. Execution receipts stay until they expire so duplicates are never re-sent." onCancel={() => setDialog(null)} onConfirm={async () => { setBusy(true); try { await historyApi.clear(); setHistoryRefresh((current) => current + 1); setDialog(null); toast("History cleared."); } catch (error) { setDialogError(error.message); } finally { setBusy(false); } }} title="Clear history" />;
        }
        return null;
    })();

    return (
        <div className="app-shell">
            <WorkspaceHeader
                account={account}
                activeEnvironmentId={state.activeEnvironmentId}
                environments={environments}
                profile={profile}
                theme={theme}
                onEnvironmentChange={(environmentId) => { savePreferences({ activeEnvironmentId: environmentId || null }); if (environmentId) dispatch({ type: "environment/select", environmentId }); }}
                onLogout={switchProfile}
                onOpenEnvironments={() => setDialog({ kind: "environments" })}
                onToggleSidebar={() => setSidebarOpen((current) => !current)}
                onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            />
            <div className="app-body">
                {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
                <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
                    <div aria-label="Sidebar sections" className="sidebar-tabs" role="tablist">
                        <button aria-selected={sidebarTab === "collections"} className="sidebar-tab" role="tab" type="button" onClick={() => setSidebarTab("collections")}>
                            <MaterialIcon size={18}>folder_open</MaterialIcon> Collections
                        </button>
                        <button aria-selected={sidebarTab === "history"} className="sidebar-tab" role="tab" type="button" onClick={() => setSidebarTab("history")}>
                            <MaterialIcon size={18}>history</MaterialIcon> History
                        </button>
                    </div>
                    {sidebarTab === "collections" ? (
                        <CollectionsSidebar
                            activeCollectionId={activeTab?.collectionId ?? null}
                            activeRequestId={activeTab?.request.id ?? null}
                            collections={collections}
                            collectionOrder={state.collectionOrder}
                            loading={loadingCollections}
                            onDeleteCollection={(collection) => setDialog({ kind: "delete-collection", collection })}
                            onDeleteFolder={(collection, folder) => runAggregateEdit(collection, (item) => deleteFolder(item, folder.id))}
                            onDeleteRequest={(collection, requestId) => runAggregateEdit(collection, (item) => removeRequest(item, requestId))}
                            onDuplicateCollection={(collection) => setDialog({ kind: "duplicate-collection", collection })}
                            onDuplicateFolder={(collection, folder) => runAggregateEdit(collection, (item) => duplicateFolder(item, folder.id)).then((ok) => { if (ok) toast("Folder duplicated."); })}
                            onDuplicateRequest={(collection, requestId) => runAggregateEdit(collection, (item) => duplicateRequest(item, requestId)).then((ok) => { if (ok) toast("Request duplicated."); })}
                            onMoveRequest={(collection, requestId, delta) => runAggregateEdit(collection, (item) => moveRequest(item, requestId, delta))}
                            onNewCollection={() => { setDialogError(""); setDialog({ kind: "new-collection" }); }}
                            onNewFolder={(collection) => setDialog({ kind: "new-folder", collection })}
                            onOpenCollection={openCollection}
                            onOpenRequest={openRequest}
                            onRenameCollection={(collection) => setDialog({ kind: "rename-collection", collection })}
                            onRenameFolder={(collection, folder) => setDialog({ kind: "rename-folder", collection, folder })}
                            onReorderCollection={(collectionId, delta) => {
                                const order = [...state.collectionOrder];
                                const index = order.indexOf(collectionId);
                                const target = index + delta;
                                if (index === -1 || target < 0 || target >= order.length) return;
                                [order[index], order[target]] = [order[target], order[index]];
                                savePreferences({ collectionOrder: order });
                            }}
                        />
                    ) : (
                        <HistoryPanel
                            refreshToken={historyRefresh}
                            onClear={clearHistory}
                            onDelete={deleteHistoryEntry}
                            onOpen={openHistoryEntry}
                            onResend={resendHistoryEntry}
                            onSaveAs={(executionId) =>
                                historyApi
                                    .get(executionId)
                                    .then((record) => {
                                        if (!record.request?.schemaVersion) {
                                            toast("This history entry was recorded before replayable request snapshots and cannot be saved.", "error");
                                            return;
                                        }
                                        setDialog({ kind: "save-request", tabId: null, request: structuredClone(record.request) });
                                    })
                                    .catch((error) => toast(error.message, "error"))
                            }
                        />
                    )}
                </aside>
                <main className="workspace">
                    <div className="request-tabs">
                        <div aria-label="Open requests" className="request-tab-list" onKeyDown={tabs.onKeyDown} ref={tabs.listRef} role="tablist">
                            {state.tabs.map((tab) => (
                                <div className={`request-tab ${tab.id === state.activeTabId ? "" : ""}`} key={tab.id} role="tab" aria-selected={tab.id === state.activeTabId} tabIndex={tab.id === state.activeTabId ? 0 : -1} onClick={() => dispatch({ type: "draft/focus", tabId: tab.id })} onKeyDown={(event) => { if (event.key === "Enter") dispatch({ type: "draft/focus", tabId: tab.id }); }}>
                                    <span className={`method-tag ${tab.request.method.toLowerCase()}`}>{tab.request.method}</span>
                                    <span>{tab.name}</span>
                                    {tab.dirty && <span aria-label="Unsaved changes" className="dirty-dot" />}
                                    <button aria-label={`Close ${tab.name}`} className="request-tab-close" type="button" onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}>
                                        <MaterialIcon size={14}>close</MaterialIcon>
                                    </button>
                                </div>
                            ))}
                        </div>
                        <button aria-label="New request" className="icon-button" type="button" onClick={() => openDraftTab(createDraftTab())}>
                            <MaterialIcon size={20}>add</MaterialIcon>
                        </button>
                    </div>
                    {activeTab ? (
                        <div className="request-pane" ref={splitContainer}>
                            <div className="request-pane-top" style={{ flexBasis: `${split.ratio * 100}%` }}>
                                <RequestBuilder
                                    authOverride={authOverrides[activeTab.id] ?? null}
                                    collectionAuth={activeCollectionAuth}
                                    draftVersion={activeTab.draftVersion}
                                    environments={environments}
                                    executionPolicy={executionPolicy}
                                    hasCollection={Boolean(activeTab.collectionId)}
                                    request={activeTab.request}
                                    running={activeTab.status === "running"}
                                    savedName={activeTab.collectionName}
                                    onCancel={() => { openDraftTab(createDraftTab()); }}
                                    onChange={updateDraft}
                                    onOverrideChange={(override) => setAuthOverrides((current) => ({ ...current, [activeTab.id]: override }))}
                                    onSave={saveDraft}
                                    onSend={activeTab.status === "running" ? cancel : send}
                                />
                                {activeTab.status === "reconciling" && (
                                    <div className="status-banner warning"><span className="spinner" />Checking whether this send was recorded before the connection dropped…</div>
                                )}
                                {activeTab.dirty && <div className="status-banner"><MaterialIcon size={16}>edit</MaterialIcon>Unsaved changes. Ctrl/Cmd+S saves into the collection.</div>}
                            </div>
                            <div
                                aria-label="Resize request and response panes"
                                aria-orientation="horizontal"
                                className="pane-splitter"
                                onKeyDown={split.onKeyDown}
                                onPointerDown={split.onPointerDown}
                                role="separator"
                                tabIndex={0}
                                title="Drag to resize. Arrow keys adjust; Enter resets."
                            />
                            <div className="request-pane-bottom">
                                {liveResult ? <ResponseViewer result={liveResult} onCopyUrl={async (headers) => { const location = headers.find((header) => header.name.toLowerCase() === "location")?.value; if (location) { await navigator.clipboard?.writeText(location); toast("Resolved URL copied."); } }} /> : (
                                    <section aria-label="Response" className="response-area">
                                        <div className="response-placeholder">
                                            <MaterialIcon size={30}>send</MaterialIcon>
                                            <span>Send a request to inspect its status, timing, headers, and body.</span>
                                            <span className="field-hint">Ctrl/Cmd+Enter sends without saving. Every send is recorded in History with a redacted snapshot.</span>
                                        </div>
                                    </section>
                                )}
                            </div>
                        </div>
                    ) : (
                        <section className="workspace-empty">
                            <span className="empty-illustration"><MaterialIcon size={30}>send</MaterialIcon></span>
                            <h2>Start a request</h2>
                            <p>Open a saved request from a collection, or create a scratch request to explore the seeded local demo target at <code>http://127.0.0.1:8000/demo/v1</code>.</p>
                            <div>
                                <button className="primary-button" type="button" onClick={() => openDraftTab(createDraftTab())}>New request</button>
                            </div>
                        </section>
                    )}
                </main>
            </div>
            {dialogNode}
            {dialog?.kind === "environments" && (
                <EnvironmentsDrawer
                    activeEnvironmentId={state.activeEnvironmentId}
                    onClose={() => setDialog(null)}
                    onDeleted={(environmentId) => { setEnvironments((current) => current.filter((item) => item._id !== environmentId)); if (state.activeEnvironmentId === environmentId) savePreferences({ activeEnvironmentId: null }); }}
                    onSaved={(environment) => { setEnvironments((current) => current.map((item) => (item._id === environment._id ? { ...item, name: environment.name, revision: environment.revision } : item))); toast("Environment saved."); }}
                    onSelect={(environmentId) => savePreferences({ activeEnvironmentId: environmentId })}
                />
            )}
            <div aria-live="polite" className="toast-region">
                {toasts.map((item) => (
                    <div className={`toast ${item.tone}`} key={item.id}>
                        <MaterialIcon size={16}>{item.tone === "error" ? "error" : item.tone === "warning" ? "warning" : item.tone === "success" ? "check" : "info"}</MaterialIcon>
                        <span>{item.message}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
