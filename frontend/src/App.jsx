import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { WorkspaceLogin } from "./features/auth/WorkspaceLogin.jsx";
import { authApi } from "./features/auth/auth.api.js";
import { CollectionsSidebar } from "./features/collections/CollectionsSidebar.jsx";
import { collectionApi } from "./features/collections/collection.api.js";
import { CollectionRunnerDialog } from "./features/collection-runner/CollectionRunnerDialog.jsx";
import { CookiePanel } from "./features/cookies/CookiePanel.jsx";
import {
	addFolder,
	addRequest,
	deleteFolder,
	duplicateFolder,
	duplicateRequest,
	hasRequest,
	moveFolder,
	moveRequest,
	moveRequestToFolder,
	removeRequest,
	renameFolder,
	updateRequest,
} from "./features/collections/collection-edit.js";
import { DocsView } from "./features/docs/DocsView.jsx";
import { EnvironmentsDrawer } from "./features/environments/EnvironmentsDrawer.jsx";
import { environmentApi } from "./features/environments/environment.api.js";
import { executionApi } from "./features/executions/execution.api.js";
import { FlightRecorderDialog } from "./features/execution-intelligence/FlightRecorderDialog.jsx";
import { InvestigationDialog } from "./features/execution-intelligence/InvestigationDialog.jsx";
import { VerificationProofDialog } from "./features/verification-proof/VerificationProofDialog.jsx";
import { WhyInspectorDialog } from "./features/why-inspector/WhyInspectorDialog.jsx";
import { capsuleDraftTab } from "./features/execution-intelligence/flight-recorder-model.js";
import { exampleApi } from "./features/examples/example.api.js";
import { ExampleActions } from "./features/examples/ExampleActions.jsx";
import { ExampleDialog } from "./features/examples/ExampleDialog.jsx";
import { ExamplesPanel } from "./features/examples/ExamplesPanel.jsx";
import { mockApi } from "./features/mocks/mock.api.js";
import { MockResultBanner } from "./features/mocks/MockResultBanner.jsx";
import { runMockSend } from "./features/mocks/mock-run.js";
import { resolveRedirectUrl } from "./features/executions/redirect.js";
import { ResponseViewer } from "./features/executions/ResponseViewer.jsx";
import { HistoryPanel } from "./features/history/HistoryPanel.jsx";
import { historyApi } from "./features/history/history.api.js";
import { materializeReplayRequest, replayContext } from "./features/history/history-replay.js";
import { buildImportedTab } from "./features/import/import-draft.js";
import { LocalRuntimeDialog } from "./features/local-runtime/LocalRuntimeDialog.jsx";
import { localRuntimeApi } from "./features/local-runtime/local-runtime.api.js";
import { approvedHostForUrl, EMPTY_LOCAL_RUNTIME } from "./features/local-runtime/local-runtime.js";
import { ProfilePicker } from "./features/profiles/ProfilePicker.jsx";
import { profileApi } from "./features/profiles/profile.api.js";
import { ProductDialog } from "./features/product/ProductDialog.jsx";
import { DEFAULT_PRODUCT_SURFACE } from "./features/product/product-content.js";
import { RequestBuilder } from "./features/requests/RequestBuilder.jsx";
import { MaterialIcon } from "./shared/components/MaterialIcon.jsx";
import {
	clearProfileSession,
	clearSession,
	hasProfileToken,
	hasSessionToken,
	readActiveWorkspaceId,
	readStoredProfileId,
	setActiveWorkspaceId,
	setProfileToken,
	setSessionToken,
	setStoredProfileId,
} from "./shared/api/client.js";
import { OUTCOME_LABELS } from "./shared/utils/format.js";
import { applyTheme, readTheme } from "./shared/utils/theme.js";
import {
	createDraftTab,
	createInitialState,
	findOpenTab,
	MAX_TABS,
	workspaceReducer,
} from "./features/workspace/workspace-reducer.js";
import { useExecutionReconciliation } from "./features/workspace/useExecutionReconciliation.js";
import { isExecutionActive, tabKeyIntent, workspaceHasUnsettledWork } from "./features/workspace/workspace-workflow.js";
import { WorkspaceDialogs } from "./features/workspace/WorkspaceDialogs.jsx";
import { WorkspaceHeader } from "./features/workspace/WorkspaceHeader.jsx";
import { WorkspaceActivityPanel } from "./features/workspaces/WorkspaceActivityPanel.jsx";
import { WorkspaceDialog } from "./features/workspaces/WorkspaceDialog.jsx";
import { WorkspaceSwitcher } from "./features/workspaces/WorkspaceSwitcher.jsx";
import { workspaceApi } from "./features/workspaces/workspace.api.js";
import { resolveCapabilities } from "./features/workspaces/workspace-permissions.js";
import { TracerSymbol } from "./shared/components/TracerBrand.jsx";
import { useRovingTabs } from "./shared/hooks/useRovingTabs.js";
import { useSplitPane } from "./shared/hooks/useSplitPane.js";

function BootScreen() {
	return (
		<main aria-label="Opening Tracer" className="app-boot" role="status">
			<div className="app-boot-brand">
				<span className="brand-mark">
					<TracerSymbol size={26} />
				</span>
				<strong>Tracer</strong>
			</div>
			<div aria-hidden="true" className="app-boot-progress">
				<span />
			</div>
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
	const [docsCollectionId, setDocsCollectionId] = useState(null);
	const [busy, setBusy] = useState(false);
	const [dialogError, setDialogError] = useState("");
	const [toasts, setToasts] = useState([]);
	const [historyRefresh, setHistoryRefresh] = useState(0);
	const [flightRecorder, setFlightRecorder] = useState(null);
	const [proofOpen, setProofOpen] = useState(false);
	const [productSurface, setProductSurface] = useState(null);
	const [investigation, setInvestigation] = useState(null);
	const [whyInspector, setWhyInspector] = useState(null);
	const [runner, setRunner] = useState(null);
	const [comparisonBaseId, setComparisonBaseId] = useState(null);
	const [examplesVersion, setExamplesVersion] = useState(0);
	const [exampleDialog, setExampleDialog] = useState(null);
	const [mockMeta, setMockMeta] = useState(null);
	const [mockBusy, setMockBusy] = useState(false);
	const [authOverrides, setAuthOverrides] = useState({});
	const [executionPolicy, setExecutionPolicy] = useState(null);
	const [localRuntime, setLocalRuntime] = useState(EMPTY_LOCAL_RUNTIME);
	const [localRuntimeBusy, setLocalRuntimeBusy] = useState(false);
	const [localRuntimeError, setLocalRuntimeError] = useState("");
	// Phase 24 — collaboration state. `workspaces` is the membership list for the
	// signed-in profile; `workspaceDetail` is the fully expanded active workspace
	// (members included) used by the Manage dialog.
	const [workspaces, setWorkspaces] = useState([]);
	const [activeWorkspaceId, setActiveWorkspace] = useState(readActiveWorkspaceId());
	const [workspaceDetail, setWorkspaceDetail] = useState(null);
	const [workspaceDialog, setWorkspaceDialog] = useState(null);
	const [workspaceError, setWorkspaceError] = useState("");
	const [workspaceActivityVersion, setWorkspaceActivityVersion] = useState(0);
	const tabs = useRovingTabs();
	const sidebarTabs = useRovingTabs();
	const splitContainer = useRef(null);
	const split = useSplitPane(splitContainer);
	const toastTimers = useRef(new Set());
	const focusTabAfterClose = useRef(false);
	const maxTabs = executionPolicy?.maxOpenTabs ?? MAX_TABS;

	const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
	const activeCollection = activeTab?.collectionId
		? (collections.find((collection) => collection._id === activeTab.collectionId) ?? null)
		: null;
	const activeLocalHost = activeTab
		? approvedHostForUrl(activeTab.request?.urlTemplate, localRuntime.targets.map((target) => target.host))
		: null;
	// Phase 24 — the active workspace, the caller's role in it, and the effective
	// capability set. Capabilities are fail-closed: before the membership list
	// arrives nothing is granted, so a write control can never enable optimistically.
	const activeWorkspace = workspaces.find((entry) => entry._id === activeWorkspaceId) ?? null;
	const workspaceRole = activeWorkspace?.role ?? null;
	const workspaceCapabilities = resolveCapabilities(activeWorkspace);

	const toast = useCallback((message, tone = "info") => {
		const id = crypto.randomUUID();
		setToasts((current) => [...current, { id, message, tone }]);
		const timer = setTimeout(() => {
			toastTimers.current.delete(timer);
			setToasts((current) => current.filter((item) => item.id !== id));
		}, 5200);
		toastTimers.current.add(timer);
	}, []);

	useEffect(
		() => () => {
			toastTimers.current.forEach((timer) => clearTimeout(timer));
		},
		[],
	);

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

	const loadWorkspace = useCallback(async (requestedWorkspaceId = null) => {
		setLoadingCollections(true);
		try {
			// The workspace list is resolved first because every subsequent request
			// carries the chosen workspace in the `x-workspace-id` header. Switching
			// workspaces must therefore never leave a stale header behind.
			const membership = await workspaceApi.list();
			setWorkspaces(membership);
			const requested = requestedWorkspaceId || readActiveWorkspaceId();
			const resolved =
				(requested && membership.some((entry) => entry._id === requested) ? requested : null) ??
				membership.find((entry) => entry.isActive)?._id ??
				membership[0]?._id ??
				"";
			setActiveWorkspace(resolved);
			setActiveWorkspaceId(resolved);
			const [summaries, environmentSummaries, preferences, localRuntimeSettings] = await Promise.all([
				collectionApi.list(),
				environmentApi.list(),
				profileApi.preferences(),
				localRuntimeApi.get(),
			]);
			const aggregates = await Promise.all(summaries.map((summary) => collectionApi.get(summary._id)));
			setCollections(aggregates);
			setEnvironments(environmentSummaries);
			setLocalRuntime(localRuntimeSettings);
			setLocalRuntimeError("");
			if (preferences.preferences?.theme) setTheme(preferences.preferences.theme);
			dispatch({ type: "preferences/set", preferences: preferences.preferences });
			setExecutionPolicy(preferences.executionPolicy ?? null);
		} catch (error) {
			toast(error.message, "error");
		} finally {
			setLoadingCollections(false);
		}
	}, [toast]);

	useEffect(() => {
		if (!profile) {
			setMockMeta(null);
			return;
		}
		let active = true;
		mockApi
			.meta()
			.then((meta) => {
				if (active) setMockMeta(meta);
			})
			.catch(() => {
				if (active) setMockMeta(null);
			});
		return () => {
			active = false;
		};
	}, [profile, examplesVersion]);

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
				if (active) {
					clearSession();
					setBootstrapping(false);
				}
				return;
			}
			if (!active) return;
			setAccount(restoredAccount.account);
			if (!hasProfileToken()) {
				const list = await profileApi.list();
				if (active) {
					setProfiles(list);
					setBootstrapping(false);
				}
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
		return () => {
			active = false;
		};
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

	const resetWorkspaceState = useCallback(() => {
		dispatch({ type: "session/clear" });
		setProfile(null);
		setCollections([]);
		setEnvironments([]);
		setAuthOverrides({});
		setExecutionPolicy(null);
		setLocalRuntime(EMPTY_LOCAL_RUNTIME);
		setLocalRuntimeBusy(false);
		setLocalRuntimeError("");
		setWorkspaces([]);
		setActiveWorkspace("");
		setWorkspaceDetail(null);
		setWorkspaceDialog(null);
		setWorkspaceError("");
		setDialog(null);
		setDialogError("");
		setSidebarOpen(false);
		setHistoryRefresh(0);
		setExamplesVersion(0);
		setExampleDialog(null);
		setMockMeta(null);
	}, []);

	const signOut = async () => {
		try {
			await authApi.logout();
		} catch {
			// The stateless token is discarded locally regardless of the response.
		}
		releaseAllExecutions();
		clearSession();
		resetWorkspaceState();
		setAccount(null);
		setProfiles(null);
	};

	const performProfileSwitch = () => {
		releaseAllExecutions();
		clearProfileSession();
		resetWorkspaceState();
	};

	const switchProfile = async () => {
		if (!account) return;
		try {
			setProfiles(await profileApi.list());
		} catch (error) {
			toast(error.message, "error");
			return;
		}
		if (workspaceHasUnsettledWork(state.tabs)) {
			openDialog({ kind: "switch-profile" });
			return;
		}
		performProfileSwitch();
	};

	const savePreferences = async (patch) => {
		try {
			const result = await profileApi.updatePreferences(patch);
			dispatch({ type: "preferences/set", preferences: result.preferences });
		} catch (error) {
			toast(error.message, "error");
		}
	};

	const saveLocalRuntime = async ({ enabled, targets }) => {
		setLocalRuntimeBusy(true);
		setLocalRuntimeError("");
		try {
			const updated = await localRuntimeApi.update({ expectedRevision: localRuntime.revision, enabled, targets });
			setLocalRuntime(updated);
		} catch (error) {
			setLocalRuntimeError(error.message);
			if (error.status === 409) {
				try {
					setLocalRuntime(await localRuntimeApi.get());
				} catch {
					// Keep the current view; the error message already explains the conflict.
				}
			}
		} finally {
			setLocalRuntimeBusy(false);
		}
	};

	// Phase 24 — workspace collaboration handlers. Every mutation refreshes the
	// workspace detail (so member/revision state stays truthful) and bumps the
	// activity feed. Nothing here resolves or displays a secret value.
	const reloadWorkspaceDetail = useCallback(async (workspaceId = activeWorkspaceId) => {
		if (!workspaceId) {
			setWorkspaceDetail(null);
			return null;
		}
		try {
			const detail = await workspaceApi.get(workspaceId);
			setWorkspaceDetail(detail);
			setWorkspaceError("");
			return detail;
		} catch (error) {
			setWorkspaceError(error.message);
			return null;
		}
	}, [activeWorkspaceId]);

	const openWorkspaceDialog = useCallback(
		async (mode) => {
			setWorkspaceError("");
			setWorkspaceDialog(mode);
			if (mode === "manage") await reloadWorkspaceDetail();
		},
		[reloadWorkspaceDetail],
	);

	// Not memoized: the body is only evaluated on user action, by which point
	// `releaseAllExecutions` (declared later in this component) is initialized.
	const performWorkspaceSwitch = async (workspaceId) => {
		releaseAllExecutions();
		dispatch({ type: "session/clear" });
		setCollections([]);
		setEnvironments([]);
		setWorkspaceDetail(null);
		setActiveWorkspace(workspaceId);
		setActiveWorkspaceId(workspaceId);
		await loadWorkspace(workspaceId);
		await savePreferences({ activeWorkspaceId: workspaceId });
	};

	const selectWorkspace = (workspaceId) => {
		if (!workspaceId || workspaceId === activeWorkspaceId) return;
		if (workspaceHasUnsettledWork(state.tabs)) {
			setDialogError("");
			setDialog({ kind: "switch-workspace", workspaceId });
			return;
		}
		performWorkspaceSwitch(workspaceId);
	};

	const createWorkspace = async (name) => {
		setBusy(true);
		try {
			const created = await workspaceApi.create(name);
			setWorkspaceDialog(null);
			setWorkspaceError("");
			toast(`Workspace “${created.name}” created.`);
			await performWorkspaceSwitch(created._id);
		} catch (error) {
			setWorkspaceError(error.message);
		} finally {
			setBusy(false);
		}
	};

	const runWorkspaceMutation = async (operation) => {
		setBusy(true);
		try {
			const updated = await operation();
			setWorkspaceDetail(updated);
			setWorkspaceError("");
			setWorkspaceActivityVersion((current) => current + 1);
			setWorkspaces((current) =>
				current.map((entry) =>
					entry._id === updated._id
						? { ...entry, name: updated.name, revision: updated.revision, memberCount: updated.members.length, role: updated.role, isPersonal: updated.isPersonal, capabilities: updated.capabilities }
						: entry,
				),
			);
			return true;
		} catch (error) {
			setWorkspaceError(error.message);
			if (error.status === 409) await reloadWorkspaceDetail();
			return false;
		} finally {
			setBusy(false);
		}
	};

	const addWorkspaceMember = (email, role) =>
		runWorkspaceMutation(() => workspaceApi.addMember(workspaceDetail._id, workspaceDetail.revision, email, role));

	const changeWorkspaceMemberRole = (profileId, role) => {
		runWorkspaceMutation(() => workspaceApi.changeRole(workspaceDetail._id, workspaceDetail.revision, profileId, role));
	};

	const removeWorkspaceMember = (profileId) => {
		runWorkspaceMutation(() => workspaceApi.removeMember(workspaceDetail._id, workspaceDetail.revision, profileId));
	};

	const renameWorkspace = (name) => {
		runWorkspaceMutation(() => workspaceApi.rename(workspaceDetail._id, workspaceDetail.revision, name));
	};

	const openCollection = useCallback(
		async (summary) => {
			try {
				const aggregate = await collectionApi.get(summary._id);
				setCollections((current) => current.map((item) => (item._id === aggregate._id ? aggregate : item)));
				dispatch({ type: "collection/reconciled", collectionId: aggregate._id, name: aggregate.name, revision: aggregate.revision });
				return aggregate;
			} catch (error) {
				toast(error.message, "error");
				return null;
			}
		},
		[toast],
	);

	const openRequest = (collection, request) => {
		openDraftTab(
			createDraftTab({
				collectionId: collection._id,
				collectionName: collection.name,
				collectionRevision: collection.revision,
				request,
			}),
		);
		setSidebarOpen(false);
	};

	const updateDraft = (patch) => {
		if (!activeTab) return;
		dispatch({ type: "draft/update", tabId: activeTab.id, patch });
	};

	const openDialog = useCallback((next) => {
		setDialogError("");
		setDialog(next);
	}, []);

	const closeTab = (tabId) => {
		const tab = state.tabs.find((item) => item.id === tabId);
		if (!tab) return;
		const focusWasInTabList = Boolean(tabs.listRef.current?.contains(document.activeElement));
		if (tab.dirty) {
			focusTabAfterClose.current = focusWasInTabList;
			openDialog({
				kind: "close-tab",
				tabId,
				title: "Discard unsaved changes?",
				message: `${tab.name} has unsaved changes. Closing this tab discards them.`,
			});
			return;
		}
		focusTabAfterClose.current = focusWasInTabList;
		releaseTabExecution(tab);
		forgetTabOverride(tabId);
		dispatch({ type: "draft/close", tabId });
	};

	const activeEnvironmentRevision = state.activeEnvironmentId
		? environments.find((environment) => environment._id === state.activeEnvironmentId)?.revision
		: undefined;

	const {
		reconcile: startReconciliation,
		cancel: cancelExecution,
		clearTimer: clearExecutionTimer,
		clearAllTimers: clearExecutionTimers,
	} = useExecutionReconciliation({
		dispatch,
		onTerminal: useCallback(() => setHistoryRefresh((current) => current + 1), []),
		onStatus: useCallback(
			(tabId, status, executionId) => dispatch({ type: "draft/status", tabId, executionId, status, error: null }),
			[dispatch],
		),
	});

	const forgetTabOverride = useCallback((tabId) => {
		setAuthOverrides((current) => {
			if (!(tabId in current)) return current;
			const next = { ...current };
			delete next[tabId];
			return next;
		});
	}, []);

	// A closed tab must not leave an execution polling or a backend send running.
	const releaseTabExecution = useCallback(
		(tab) => {
			if (!tab) return;
			if (tab.executionId) clearExecutionTimer(tab.executionId);
			if (isExecutionActive(tab)) executionApi.cancel(tab.executionId).catch(() => {});
		},
		[clearExecutionTimer],
	);

	const releaseAllExecutions = useCallback(() => {
		state.tabs.forEach((tab) => {
			if (isExecutionActive(tab)) executionApi.cancel(tab.executionId).catch(() => {});
		});
		clearExecutionTimers();
	}, [clearExecutionTimers, state.tabs]);

	// Signing out, switching profiles, or expiring a session abandons every in-flight
	// reconciliation poll; the timers must not survive into the next profile.
	useEffect(() => {
		if (!profile) clearExecutionTimers();
	}, [profile, clearExecutionTimers]);

	// Restore keyboard focus to the selected tab after a keyboard close.
	useEffect(() => {
		if (!focusTabAfterClose.current) return;
		focusTabAfterClose.current = false;
		tabs.listRef.current?.querySelector('[role="tab"][aria-selected="true"]')?.focus();
	}, [state.tabs]);

	useEffect(() => {
		const warnAboutDrafts = (event) => {
			if (!state.tabs.some((tab) => tab.dirty)) return;
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warnAboutDrafts);
		return () => window.removeEventListener("beforeunload", warnAboutDrafts);
	}, [state.tabs]);

	const copyResolvedUrl = async (response) => {
		const location = response.headers.find((header) => header.name.toLowerCase() === "location")?.value;
		if (!location) return;
		const resolved = resolveRedirectUrl(location, response.executedUrl);
		if (!resolved.ok) {
			toast(resolved.reason === "scheme" ? "This redirect is not an HTTP(S) URL." : "This redirect URL is invalid.", "warning");
			return;
		}
		try {
			if (!navigator.clipboard) throw new Error("clipboard unavailable");
			await navigator.clipboard.writeText(resolved.url);
			toast("Resolved URL copied.");
		} catch {
			toast("The clipboard is not available in this browser.", "warning");
		}
	};

	const responsePanel = (result) =>
		result ? (
			<ResponseViewer onCopyUrl={copyResolvedUrl} onInvestigate={(executionId) => openInvestigation(executionId)} result={result} />
		) : (
			<section aria-label="Response" className="response-area">
				<div className="response-placeholder">
					<MaterialIcon size={30}>send</MaterialIcon>
					<span>Send a request to inspect its status, timing, headers, and body.</span>
					<span className="field-hint">
						Ctrl/Cmd+Enter sends without saving. Every send is recorded in History with a redacted snapshot.
					</span>
				</div>
			</section>
		);

	const send = async () => {
		if (!activeTab || ["running", "reconciling"].includes(activeTab.status)) return;
		const executionId = crypto.randomUUID();
		dispatch({ type: "draft/dispatched", tabId: activeTab.id, executionId });
		forgetTabOverride(activeTab.id);
		const input = {
			executionId,
			tabId: activeTab.id,
			draftVersion: activeTab.draftVersion,
			request: activeTab.request,
			context: {
				...(activeTab.collectionId
					? {
							collectionId: activeTab.collectionId,
							requestId: activeTab.request.id,
							collectionRevision: activeTab.collectionRevision,
						}
					: {}),
				...(state.activeEnvironmentId
					? { environmentId: state.activeEnvironmentId, environmentRevision: activeEnvironmentRevision }
					: {}),
				...(activeTab.replayHistoryId ? { replayHistoryId: activeTab.replayHistoryId } : {}),
			},
			...(authOverrides[activeTab.id] ? { authOverride: authOverrides[activeTab.id] } : {}),
		};
		try {
			const result = await executionApi.send(input);
			dispatch({ type: "draft/result", tabId: activeTab.id, executionId, result });
			setHistoryRefresh((current) => current + 1);
			if (result.outcome === "validation_error") toast(result.error?.message ?? "The request could not be sent.", "error");
		} catch (error) {
			if (error.status && error.status < 500) {
				dispatch({ type: "draft/status", tabId: activeTab.id, executionId, status: "error", error: error.message });
				toast(error.message, "error");
				return;
			}
			dispatch({
				type: "draft/status",
				tabId: activeTab.id,
				executionId,
				status: "reconciling",
				error: error.message,
			});
			startReconciliation(activeTab.id, executionId);
		}
	};

	const copyMockUrl = async () => {
		if (!mockMeta?.route) return;
		const url = `${window.location.origin}${mockMeta.route}`;
		try {
			if (!navigator.clipboard) throw new Error("clipboard unavailable");
			await navigator.clipboard.writeText(url);
			toast("Mock URL copied. Requests to it match saved examples for this profile.");
		} catch {
			toast("The clipboard is not available in this browser.", "warning");
		}
	};

	// Mock Send is a separate, explicit control. It resolves the current request against saved
	// examples on the server and never calls the execution pipeline.
	const mockSend = async () => {
		if (!activeTab || ["running", "reconciling"].includes(activeTab.status) || mockBusy) return;
		const executionId = crypto.randomUUID();
		dispatch({ type: "draft/dispatched", tabId: activeTab.id, executionId });
		setMockBusy(true);
		try {
			const data = await runMockSend({
				api: mockApi,
				request: activeTab.request,
				environmentId: state.activeEnvironmentId,
				executionId,
			});
			dispatch({ type: "draft/result", tabId: activeTab.id, executionId, result: data.result });
			toast(data.matched ? `Mock response served from "${data.example.name}".` : "Mock miss: no saved example matched.", data.matched ? "info" : "warning");
		} catch (error) {
			dispatch({ type: "draft/status", tabId: activeTab.id, executionId, status: "error", error: error.message });
			toast(error.message, "error");
		} finally {
			setMockBusy(false);
		}
	};

	const submitExample = async (payload) => {
		setBusy(true);
		setDialogError("");
		try {
			if (exampleDialog?.example) await exampleApi.update(exampleDialog.example._id, payload);
			else await exampleApi.create(payload);
			setExampleDialog(null);
			setExamplesVersion((current) => current + 1);
			toast(exampleDialog?.example ? "Example updated." : "Example saved.");
		} catch (error) {
			setDialogError(error.message);
		} finally {
			setBusy(false);
		}
	};

	const deleteExample = async (example) => {
		try {
			await exampleApi.remove(example._id);
			setExamplesVersion((current) => current + 1);
			toast("Example deleted.");
		} catch (error) {
			toast(error.message, "error");
		}
	};

	const cancel = async () => {
		if (!activeTab?.executionId) return;
		await cancelExecution(activeTab.id, activeTab.executionId);
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
		setCollections((current) => current.map((item) => (item._id === updated._id ? updated : item)));
		dispatch({ type: "collection/reconciled", collectionId: updated._id, name: updated.name, revision: updated.revision });
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
		const saveTabId = activeTab.id;
		const saveDraftVersion = activeTab.draftVersion;
		const saveRequest = structuredClone(activeTab.request);
		if (!activeTab.collectionId) {
			openDialog({ kind: "save-request", tabId: saveTabId, request: saveRequest });
			return;
		}
		const collection = collections.find((item) => item._id === activeTab.collectionId);
		if (!collection) {
			openDialog({ kind: "save-request", tabId: saveTabId, request: saveRequest });
			return;
		}
		if (!hasRequest(collection, saveRequest.id)) {
			toast("This request no longer exists in the collection. Save it as a copy to keep your draft.", "warning");
			openDialog({ kind: "save-request", tabId: saveTabId, request: saveRequest });
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
				requests: updateRequest(collection, saveRequest).requests,
			});
			setCollections((current) => current.map((item) => (item._id === result._id ? result : item)));
			dispatch({ type: "collection/reconciled", collectionId: result._id, name: result.name, revision: result.revision });
			dispatch({
				type: "draft/saved",
				tabId: saveTabId,
				request: saveRequest,
				savedDraftVersion: saveDraftVersion,
				collectionId: result._id,
				collectionName: result.name,
				collectionRevision: result.revision,
			});
			toast("Request saved.");
		} catch (error) {
			if (error.code === "COLLECTION_REVISION_CONFLICT") {
				setDialogError("");
				openDialog({ kind: "conflict", tabId: activeTab.id, collectionId: collection._id });
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
		const savedDraftVersion = tabId ? state.tabs.find((tab) => tab.id === tabId)?.draftVersion : undefined;
		setBusy(true);
		try {
			const next = addRequest({ ...collection, requests: collection.requests }, { ...draftRequest, name }, folderId).aggregate;
			const updated = await applyAggregate(collection, next);
			if (tabId) {
				dispatch({
					type: "draft/saved",
					tabId,
					request: { ...draftRequest, name, id: next.requests[next.requests.length - 1].id, folderId },
					savedDraftVersion,
					collectionId: updated._id,
					collectionName: updated.name,
					collectionRevision: updated.revision,
				});
			}
			toast("Request saved.");
		} catch (error) {
			setDialogError(error.message);
		} finally {
			setBusy(false);
		}
	};

	const reloadCollection = async (collectionId, tabId) => {
		const summary = collections.find((item) => item._id === collectionId);
		if (!summary) return;
		const aggregate = await openCollection(summary);
		setDialog(null);
		if (!aggregate) return;
		const tab = state.tabs.find((item) => item.id === tabId);
		if (!tab) return;
		const fresh = aggregate.requests.find((item) => item.id === tab.request.id);
		if (!fresh) {
			toast("This request no longer exists in the collection. Your draft was kept; save it as a copy to keep it.", "warning");
			return;
		}
		dispatch({
			type: "draft/saved",
			tabId: tab.id,
			request: fresh,
			savedDraftVersion: tab.draftVersion,
			collectionId: aggregate._id,
			collectionName: aggregate.name,
			collectionRevision: aggregate.revision,
		});
	};

	// History results belong in a request tab: reuse the active tab, or open the
	// recorded request in a new one when the workspace is empty.
	const showInWorkspace = (result, request) => {
		if (activeTab) {
			dispatch({ type: "draft/inspect", tabId: activeTab.id, result });
			return;
		}
		if (!request) {
			toast("This history entry was recorded before replayable request snapshots and cannot be shown.", "error");
			return;
		}
		const tab = createDraftTab({ request });
		if (!openDraftTab(tab)) return;
		dispatch({ type: "draft/inspect", tabId: tab.id, result });
	};

	const openHistoryEntry = async (executionId, { reopen = false } = {}) => {
		try {
			const record = await historyApi.get(executionId);
			if (reopen) {
				const request = materializeReplayRequest(record);
				if (!request) {
					toast("This history entry was recorded before replayable request snapshots and cannot be reopened.", "error");
					return;
				}
				const tab = createDraftTab({ request });
				if (!openDraftTab(tab)) return;
				dispatch({ type: "draft/replay", tabId: tab.id, replayHistoryId: executionId });
				toast("Opened a copy from history. Editing it does not change the saved request.");
				setSidebarOpen(false);
				return;
			}
			const inspected = {
				executionId,
				outcome: record.outcome,
				response: record.response,
				error: record.error,
				scriptResults: record.scriptResults ?? record.snapshot?.scriptResults ?? null,
				effectCertainty: record.effectCertainty,
				executedUrl: record.snapshot?.executedUrl ?? record.executedUrl ?? null,
				persistence: record.persistence,
				startedAt: record.startedAt,
				finishedAt: record.finishedAt,
				compileTrace: record.compileTrace ?? [],
				warnings: record.warnings ?? [],
				historyId: record.executionId,
				fromHistory: true,
			};
			showInWorkspace(inspected, materializeReplayRequest(record));
			setSidebarOpen(false);
		} catch (error) {
			toast(error.message, "error");
		}
	};

	const resendHistoryEntry = async (executionId) => {
		try {
			const record = await historyApi.get(executionId);
			const request = materializeReplayRequest(record);
			if (!request) {
				toast("This history entry was recorded before replayable request snapshots and cannot be resent.", "error");
				return;
			}
			const result = await executionApi.send({
				executionId: crypto.randomUUID(),
				tabId: "history",
				draftVersion: 1,
				request,
				context: replayContext(record, {
					environmentId: state.activeEnvironmentId,
					environmentRevision: activeEnvironmentRevision,
				}),
			});
			showInWorkspace(result, request);
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
		openDialog({ kind: "clear-history" });
	};

	const analyzeHistoryEntry = (executionId) => {
		setFlightRecorder({ executionId, comparisonIds: null });
		setSidebarOpen(false);
	};

	const openInvestigation = (failingExecutionId, goodExecutionId = null) => {
		setInvestigation({ failingExecutionId, goodExecutionId });
		setSidebarOpen(false);
	};

	// Phase 49 — "Why?" Inspector. A read-model view only: it opens a dialog that
	// asks the backend to explain one execution. It never sends, saves, or mutates.
	const openWhyInspector = (executionId) => {
		setWhyInspector({ executionId });
		setSidebarOpen(false);
	};

	const compareHistoryEntry = (executionId) => {
		if (!comparisonBaseId) {
			setComparisonBaseId(executionId);
			toast("Comparison baseline selected. Choose Compare on a second execution.");
			return;
		}
		if (comparisonBaseId === executionId) {
			setComparisonBaseId(null);
			toast("Comparison selection cleared.");
			return;
		}
		setFlightRecorder({
			executionId,
			comparisonIds: { baseExecutionId: comparisonBaseId, candidateExecutionId: executionId },
		});
		setComparisonBaseId(null);
		setSidebarOpen(false);
	};

	const openCapsuleDraft = (imported) => {
		let tab = null;
		try {
			// Malformed or unsupported capsules fail closed here: nothing opens,
			// nothing sends, nothing saves.
			tab = capsuleDraftTab(imported);
		} catch {
			tab = null;
		}
		if (!tab) {
			toast("This capsule preview cannot be opened safely.", "error");
			return false;
		}
		if (!openDraftTab(tab)) return false;
		setFlightRecorder(null);
		setInvestigation(null);
		toast("Opened an unsent, unsaved reproduction draft.");
		return true;
	};

	const shortcutHandlers = useRef({ send: null, saveDraft: null, dialogOpen: false });
	shortcutHandlers.current = { send, saveDraft, dialogOpen: Boolean(dialog || flightRecorder || investigation || whyInspector || runner || proofOpen || productSurface) };

	useEffect(() => {
		const onKeyDown = (event) => {
			const meta = event.metaKey || event.ctrlKey;
			if (!meta || shortcutHandlers.current.dialogOpen) return;
			if (event.key === "Enter") {
				event.preventDefault();
				shortcutHandlers.current.send?.();
			}
			if (event.key.toLowerCase() === "s") {
				event.preventDefault();
				shortcutHandlers.current.saveDraft?.();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const activeCollectionAuth = activeCollection?.auth ?? null;

	if (bootstrapping) return <BootScreen />;
	if (!account) return <WorkspaceLogin error={authError} loading={loginBusy} onLogin={login} />;
	if (!profile)
		return (
			<ProfilePicker
				error={authError}
				loading={!profiles}
				onLogout={signOut}
				onRetry={async () => setProfiles(await profileApi.list())}
				onSelect={chooseProfile}
				profiles={profiles ?? []}
				switchingFrom={null}
			/>
		);

	const dialogActions = {
		importCurl(parsed) {
			const imported = buildImportedTab(parsed);
			if (!imported) return;
			if (!openDraftTab(imported.tab)) return;
			if (imported.authOverride)
				setAuthOverrides((current) => ({ ...current, [imported.tab.id]: imported.authOverride }));
			setDialog(null);
			toast(`Imported ${imported.tab.request.method} ${imported.tab.request.name} as an unsaved draft.`, "success");
			setSidebarOpen(false);
		},
		async deleteCollection(collection) {
			setBusy(true);
			try {
				await collectionApi.remove(collection._id, collection.revision);
				setCollections((current) => current.filter((item) => item._id !== collection._id));
				setDialog(null);
				toast("Collection deleted.");
			} catch (error) {
				setDialogError(error.message);
			} finally {
				setBusy(false);
			}
		},
		async duplicateCollection(collection, name) {
			setBusy(true);
			try {
				await collectionApi.duplicate(collection._id, collection.revision, name);
				const summaries = await collectionApi.list();
				const aggregates = await Promise.all(summaries.map((summary) => collectionApi.get(summary._id)));
				setCollections(aggregates);
				setDialog(null);
				toast("Collection duplicated.");
			} catch (error) {
				setDialogError(error.message);
			} finally {
				setBusy(false);
			}
		},
		async createCollection({ name, description }) {
			setBusy(true);
			try {
				const created = await collectionApi.create({ name, description });
				const aggregate = await collectionApi.get(created._id);
				setCollections((current) => [...current, aggregate]);
				savePreferences({ collectionOrder: [...state.collectionOrder, aggregate._id] });
				setDialog(null);
				toast("Collection created.");
			} catch (error) {
				setDialogError(error.message);
			} finally {
				setBusy(false);
			}
		},
		async saveCollectionDefaults(collection, payload) {
			const ok = await runAggregateEdit(collection, (current) => ({
				...current,
				variables: payload.variables,
				auth: payload.auth,
			}));
			if (ok) {
				setDialog(null);
				toast("Collection defaults saved.");
			}
		},
		renameCollection(collection, name) {
			return runAggregateEdit(collection, (current) => ({ ...current, name })).then((ok) => {
				if (ok) toast("Collection renamed.");
			});
		},
		createFolder(collection, name) {
			return runAggregateEdit(collection, (current) => addFolder(current, name).aggregate).then((ok) => {
				if (ok) toast("Folder created.");
			});
		},
		renameFolder(collection, folder, name) {
			return runAggregateEdit(collection, (current) => renameFolder(current, folder.id, name));
		},
		saveAsCopy(tabId) {
			const tab = state.tabs.find((item) => item.id === tabId) ?? null;
			openDialog({ kind: "save-request", tabId, request: tab ? structuredClone(tab.request) : null });
		},
		discardTab(tabId) {
			releaseTabExecution(state.tabs.find((item) => item.id === tabId) ?? null);
			forgetTabOverride(tabId);
			dispatch({ type: "draft/close", tabId });
			setDialog(null);
		},
		confirmProfileSwitch() {
			setDialog(null);
			performProfileSwitch();
		},
		confirmWorkspaceSwitch() {
			const pendingWorkspaceId = dialog?.workspaceId ?? null;
			setDialog(null);
			if (pendingWorkspaceId) performWorkspaceSwitch(pendingWorkspaceId);
		},
		async clearHistory() {
			setBusy(true);
			try {
				await historyApi.clear();
				setHistoryRefresh((current) => current + 1);
				setDialog(null);
				toast("History cleared.");
			} catch (error) {
				setDialogError(error.message);
			} finally {
				setBusy(false);
			}
		},
		async deleteFolder(collection, folderId) {
			const ok = await runAggregateEdit(collection, (item) => deleteFolder(item, folderId));
			if (ok) {
				setDialog(null);
				toast("Folder deleted.");
			}
		},
		reloadCollection,
		saveAsNewRequest,
	};

	const docsCollection = docsCollectionId ? collections.find((item) => item._id === docsCollectionId) ?? null : null;

	const dialogNode = (
		<WorkspaceDialogs
			actions={dialogActions}
			activeTab={activeTab}
			busy={busy}
			collectionAuth={activeCollectionAuth}
			collections={collections}
			dialog={dialog}
			dialogError={dialogError}
			onClose={() => setDialog(null)}
		/>
	);

	const exampleDialogNode = exampleDialog ? (
		<ExampleDialog
			busy={busy}
			collectionId={activeTab?.collectionId ?? null}
			environmentId={state.activeEnvironmentId}
			error={dialogError}
			example={exampleDialog.example}
			mode={exampleDialog.mode}
			request={activeTab?.request ?? null}
			result={activeTab?.result ?? null}
			onCancel={() => {
				setExampleDialog(null);
				setDialogError("");
			}}
			onSubmit={submitExample}
		/>
	) : null;

	const flightRecorderNode = flightRecorder ? (
		<FlightRecorderDialog
			comparisonIds={flightRecorder.comparisonIds}
			executionId={flightRecorder.executionId}
			onClose={() => setFlightRecorder(null)}
			onOpenDraft={openCapsuleDraft}
			onWhy={(executionId) => {
				setFlightRecorder(null);
				openWhyInspector(executionId);
			}}
		/>
	) : null;

	const proofNode = proofOpen ? <VerificationProofDialog onClose={() => setProofOpen(false)} onOpenHelp={() => setProductSurface("help")} /> : null;

	const productNode = productSurface ? (
		<ProductDialog initialSurface={productSurface} onClose={() => setProductSurface(null)} />
	) : null;

	const runnerNode = runner ? (
		<CollectionRunnerDialog
			activeEnvironmentId={state.activeEnvironmentId}
			collection={runner.collection}
			environments={environments}
			folderId={runner.folderId}
			onClose={() => setRunner(null)}
			onCompare={(baseExecutionId, candidateExecutionId) => {
				setFlightRecorder({ executionId: candidateExecutionId, comparisonIds: { baseExecutionId, candidateExecutionId } });
			}}
			onInvestigate={(executionId) => openInvestigation(executionId)}
			onOpenPassport={(executionId) => setFlightRecorder({ executionId, comparisonIds: null })}
		/>
	) : null;

	const investigationNode = investigation ? (
		<InvestigationDialog
			failingExecutionId={investigation.failingExecutionId}
			goodExecutionId={investigation.goodExecutionId}
			onClose={() => setInvestigation(null)}
			onOpenComparison={(baseExecutionId, candidateExecutionId) => {
				setFlightRecorder({ executionId: candidateExecutionId, comparisonIds: { baseExecutionId, candidateExecutionId } });
			}}
			onOpenDraft={openCapsuleDraft}
			onOpenPassport={(executionId) => setFlightRecorder({ executionId, comparisonIds: null })}
			onWhy={(executionId) => {
				setInvestigation(null);
				openWhyInspector(executionId);
			}}
		/>
	) : null;

	const whyInspectorNode = whyInspector ? (
		<WhyInspectorDialog
			executionId={whyInspector.executionId}
			onClose={() => setWhyInspector(null)}
			onInvestigate={(executionId) => {
				setWhyInspector(null);
				openInvestigation(executionId);
			}}
			onOpenPassport={(executionId) => {
				setWhyInspector(null);
				setFlightRecorder({ executionId, comparisonIds: null });
			}}
		/>
	) : null;

	const workspaceDialogNode = workspaceDialog ? (
		<WorkspaceDialog
			activityRefreshToken={workspaceActivityVersion}
			busy={busy}
			capabilities={workspaceCapabilities}
			detail={workspaceDetail}
			error={workspaceError}
			mode={workspaceDialog}
			role={workspaceRole}
			onAddMember={addWorkspaceMember}
			onCancel={() => {
				setWorkspaceDialog(null);
				setWorkspaceError("");
			}}
			onChangeRole={changeWorkspaceMemberRole}
			onCreate={createWorkspace}
			onReload={() => reloadWorkspaceDetail()}
			onRemoveMember={removeWorkspaceMember}
			onRename={renameWorkspace}
		/>
	) : null;

	return (
		<div className="app-shell">
			{exampleDialogNode}
			{productNode}
			{proofNode}
			{flightRecorderNode}
			{runnerNode}
			{investigationNode}
			{whyInspectorNode}
			{workspaceDialogNode}
			<WorkspaceHeader
				account={account}
				activeEnvironmentId={state.activeEnvironmentId}
				environments={environments}
				localRuntime={localRuntime}
				profile={profile}
				theme={theme}
				workspaceSwitcher={
					<WorkspaceSwitcher
						activeWorkspaceId={activeWorkspaceId}
						capabilities={workspaceCapabilities}
						role={workspaceRole}
						workspaces={workspaces}
						onCreate={() => openWorkspaceDialog("create")}
						onManage={() => openWorkspaceDialog("manage")}
						onOpenActivity={() => {
							setWorkspaceActivityVersion((current) => current + 1);
							setSidebarTab("activity");
							setSidebarOpen(true);
						}}
						onSelectWorkspace={selectWorkspace}
					/>
				}
				onEnvironmentChange={(environmentId) => {
					savePreferences({ activeEnvironmentId: environmentId || null });
					if (environmentId) dispatch({ type: "environment/select", environmentId });
				}}
				onLogout={switchProfile}
				onOpenEnvironments={() => openDialog({ kind: "environments" })}
				onOpenImport={() => openDialog({ kind: "import-curl" })}
				onOpenLocalRuntime={() => openDialog({ kind: "local-runtime" })}
				onOpenProof={() => setProofOpen(true)}
				onOpenProduct={(surfaceId) => setProductSurface(surfaceId || DEFAULT_PRODUCT_SURFACE)}
				onToggleSidebar={() => {
					setSidebarTab("collections");
					setSidebarOpen(true);
				}}
				onToggleTheme={() =>
					setTheme((current) => {
						const next = current === "dark" ? "light" : "dark";
						savePreferences({ theme: next });
						return next;
					})
				}
			/>
			<div className="app-body">
				{sidebarOpen && <div aria-hidden="true" className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
				<aside
					aria-label="Workspace panel"
					className={`sidebar ${sidebarOpen ? "open" : ""}`}
					onKeyDown={(event) => {
						if (event.key === "Escape" && sidebarOpen) setSidebarOpen(false);
					}}
				>
					<div
						aria-label="Sidebar sections"
						className="sidebar-tabs"
						onKeyDown={sidebarTabs.onKeyDown}
						ref={sidebarTabs.listRef}
						role="tablist"
					>
						<button
							aria-selected={sidebarTab === "collections"}
							className="sidebar-tab"
							role="tab"
							tabIndex={sidebarTab === "collections" ? 0 : -1}
							type="button"
							onClick={() => setSidebarTab("collections")}
						>
							<MaterialIcon size={18}>folder_open</MaterialIcon> Collections
						</button>
						<button
							aria-selected={sidebarTab === "history"}
							className="sidebar-tab"
							role="tab"
							tabIndex={sidebarTab === "history" ? 0 : -1}
							type="button"
							onClick={() => setSidebarTab("history")}
						>
							<MaterialIcon size={18}>history</MaterialIcon> History
						</button>
						<button
							aria-selected={sidebarTab === "cookies"}
							className="sidebar-tab"
							role="tab"
							tabIndex={sidebarTab === "cookies" ? 0 : -1}
							type="button"
							onClick={() => setSidebarTab("cookies")}
						>
							<MaterialIcon size={18}>cookie</MaterialIcon> Cookies
						</button>
						<button
							aria-selected={sidebarTab === "examples"}
							className="sidebar-tab"
							role="tab"
							tabIndex={sidebarTab === "examples" ? 0 : -1}
							type="button"
							onClick={() => setSidebarTab("examples")}
						>
							<MaterialIcon size={18}>bookmark</MaterialIcon> Examples
						</button>
						<button
							aria-selected={sidebarTab === "activity"}
							className="sidebar-tab"
							role="tab"
							tabIndex={sidebarTab === "activity" ? 0 : -1}
							type="button"
							onClick={() => {
								setWorkspaceActivityVersion((current) => current + 1);
								setSidebarTab("activity");
							}}
						>
							<MaterialIcon size={18}>history</MaterialIcon> Activity
						</button>
					</div>
					{workspaceRole === "VIEWER" && (
						<p className="workspace-readonly-banner" role="status">
							<MaterialIcon size={16}>visibility</MaterialIcon>
							You have read-only access to {activeWorkspace?.name ?? "this workspace"}. You can inspect shared definitions and
							requests, but you cannot change or run them.
						</p>
					)}
					{sidebarTab === "collections" ? (
						<CollectionsSidebar
							activeCollectionId={activeTab?.collectionId ?? null}
							activeRequestId={activeTab?.request.id ?? null}
							can={workspaceCapabilities}
							collections={collections}
							collectionOrder={state.collectionOrder}
							loading={loadingCollections}
							onDeleteCollection={(collection) => openDialog({ kind: "delete-collection", collection })}
							onDeleteFolder={(collection, folder) =>
								openDialog({
									kind: "delete-folder",
									collection,
									folder,
									message: `Delete "${folder.name}"? Requests inside it will move to the collection root.`,
								})
							}
							onDeleteRequest={(collection, requestId) =>
								runAggregateEdit(collection, (item) => removeRequest(item, requestId))
							}
							onDuplicateCollection={(collection) => openDialog({ kind: "duplicate-collection", collection })}
							onEditCollection={(collection) => openDialog({ kind: "collection-settings", collection })}
							onDuplicateFolder={(collection, folder) =>
								runAggregateEdit(collection, (item) => duplicateFolder(item, folder.id)).then((ok) => {
									if (ok) toast("Folder duplicated.");
								})
							}
							onDuplicateRequest={(collection, requestId) =>
								runAggregateEdit(collection, (item) => duplicateRequest(item, requestId)).then((ok) => {
									if (ok) toast("Request duplicated.");
								})
							}
							onMoveFolder={(collection, folderId, delta) =>
								runAggregateEdit(collection, (item) => moveFolder(item, folderId, delta))
							}
							onMoveRequest={(collection, requestId, delta) =>
								runAggregateEdit(collection, (item) => moveRequest(item, requestId, delta))
							}
							onMoveRequestToFolder={(collection, requestId, folderId) =>
								runAggregateEdit(collection, (item) => moveRequestToFolder(item, requestId, folderId))
							}
							onNewCollection={() => openDialog({ kind: "new-collection" })}
							onNewFolder={(collection) => openDialog({ kind: "new-folder", collection })}
							onOpenCollection={openCollection}
							onOpenDocs={(collection) => setDocsCollectionId(collection._id)}
							onOpenRequest={openRequest}
							onRenameCollection={(collection) => openDialog({ kind: "rename-collection", collection })}
							onRenameFolder={(collection, folder) => openDialog({ kind: "rename-folder", collection, folder })}
							onReorderCollection={(collectionId, delta) => {
								const order = [...state.collectionOrder];
								const index = order.indexOf(collectionId);
								const target = index + delta;
								if (index === -1 || target < 0 || target >= order.length) return;
								[order[index], order[target]] = [order[target], order[index]];
								savePreferences({ collectionOrder: order });
							}}
							onRunCollection={(collection) => {
								setRunner({ collection, folderId: null });
								setSidebarOpen(false);
							}}
							onRunFolder={(collection, folder) => {
								setRunner({ collection, folderId: folder.id });
								setSidebarOpen(false);
							}}
						/>
					) : sidebarTab === "history" ? (
						<HistoryPanel
							compareBaseId={comparisonBaseId}
							refreshToken={historyRefresh}
							onAnalyze={analyzeHistoryEntry}
							onClear={clearHistory}
							onCompare={compareHistoryEntry}
							onDelete={deleteHistoryEntry}
							onInvestigate={(executionId) => openInvestigation(executionId)}
							onWhy={openWhyInspector}
							onOpen={openHistoryEntry}
							onResend={resendHistoryEntry}
							onSaveAs={(executionId) =>
								historyApi
									.get(executionId)
									.then((record) => {
										const request = materializeReplayRequest(record);
										if (!request) {
											toast(
												"This history entry was recorded before replayable request snapshots and cannot be saved.",
												"error",
											);
											return;
										}
										openDialog({ kind: "save-request", tabId: null, request });
									})
									.catch((error) => toast(error.message, "error"))
							}
						/>
					) : sidebarTab === "cookies" ? (
						<CookiePanel refreshToken={historyRefresh} />
					) : sidebarTab === "activity" ? (
						<div className="sidebar-panel">
							<div className="sidebar-section-label">
								<span>Workspace activity</span>
							</div>
							<div className="sidebar-scroll">
								<WorkspaceActivityPanel refreshToken={workspaceActivityVersion} workspaceId={activeWorkspaceId} />
							</div>
						</div>
					) : (
						<ExamplesPanel
							refreshToken={examplesVersion}
							onChanged={() => setExamplesVersion((current) => current + 1)}
							onCopyMockUrl={copyMockUrl}
							onCreate={() => setExampleDialog({ mode: "manual", example: null })}
							onDelete={deleteExample}
							onEdit={(example) => setExampleDialog({ mode: "edit", example })}
						/>
					)}
				</aside>
				<main className="workspace">
					<div className="request-tabs">
						<div
							aria-label="Open requests"
							className="request-tab-list"
							onKeyDown={tabs.onKeyDown}
							ref={tabs.listRef}
							role="tablist"
						>
							{state.tabs.map((tab) => (
								<div
									aria-selected={tab.id === state.activeTabId}
									className="request-tab"
									key={tab.id}
									role="tab"
									tabIndex={tab.id === state.activeTabId ? 0 : -1}
									onClick={() => dispatch({ type: "draft/focus", tabId: tab.id })}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											dispatch({ type: "draft/focus", tabId: tab.id });
											return;
										}
										if (tabKeyIntent(event.key) === "close") {
											event.preventDefault();
											closeTab(tab.id);
										}
									}}
								>
									<span className={`method-tag ${tab.request.method.toLowerCase()}`}>{tab.request.method}</span>
									<span>{tab.name}</span>
									{tab.dirty && <span aria-label="Unsaved changes" className="dirty-dot" />}
									<button
										aria-label={`Close ${tab.name}`}
										className="request-tab-close"
										tabIndex={-1}
										type="button"
										onClick={(event) => {
											event.stopPropagation();
											closeTab(tab.id);
										}}
									>
										<MaterialIcon size={14}>close</MaterialIcon>
									</button>
								</div>
							))}
						</div>
						<button
							aria-label="New request"
							className="icon-button"
							type="button"
							onClick={() => openDraftTab(createDraftTab())}
						>
							<MaterialIcon size={20}>add</MaterialIcon>
						</button>
					</div>
					{activeTab ? (
						<div className="request-pane" ref={splitContainer}>
							<div className="request-pane-top" style={{ flexBasis: `${split.ratio * 100}%` }}>
								<RequestBuilder
									authOverride={authOverrides[activeTab.id] ?? null}
									canExecute={workspaceCapabilities.execute === true}
									canWrite={workspaceCapabilities.writeCollections === true}
									collectionAuth={activeCollectionAuth}
									draftVersion={activeTab.draftVersion}
									environments={environments}
									executionPolicy={executionPolicy}
									hasCollection={Boolean(activeTab.collectionId)}
									request={activeTab.request}
									running={["running", "reconciling"].includes(activeTab.status)}
									savedName={activeTab.collectionName}
									onCancel={() => {
										openDraftTab(createDraftTab());
									}}
									onChange={updateDraft}
									onExport={() => openDialog({ kind: "code-snippet" })}
									onOverrideChange={(override) =>
										setAuthOverrides((current) => ({ ...current, [activeTab.id]: override }))
									}
									onSave={saveDraft}
									onSend={["running", "reconciling"].includes(activeTab.status) ? cancel : send}
								/>
								{localRuntime.enabled && (
									<div className="status-banner warning" role="status">
										<MaterialIcon size={16}>warning</MaterialIcon>
										{activeLocalHost
											? `This request targets ${activeLocalHost}, an approved Local Runtime host, and is sent from this server.`
											: "Local Runtime is on. Only requests to approved local hosts use local access."}
									</div>
								)}
								{activeTab.status === "reconciling" && (
									<div className="status-banner warning" role="status">
										<span className="spinner" />
										Checking whether this send was recorded before the connection dropped…
									</div>
								)}
								{activeTab.dirty && (
									<div className="status-banner" role="status">
										<MaterialIcon size={16}>edit</MaterialIcon>Unsaved changes. Ctrl/Cmd+S saves into the collection.
									</div>
								)}
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
								<ExampleActions
									busy={mockBusy}
									canSave={Boolean(activeTab.result?.response)}
									mockRoute={mockMeta?.route ?? ""}
									onCopyMockUrl={copyMockUrl}
									onMockSend={mockSend}
									onSaveExample={() => {
										setDialogError("");
										setExampleDialog({ mode: "from-response", example: null });
									}}
								/>
								<MockResultBanner mock={activeTab.result?.mock ?? null} onCopyMockUrl={copyMockUrl} />
								{responsePanel(activeTab.result)}
							</div>
						</div>
					) : (
						<section className="workspace-empty">
							<span className="empty-illustration">
								<MaterialIcon size={30}>send</MaterialIcon>
							</span>
							<h2>Start a request</h2>
							<p>
								Open a saved request from a collection, or create a scratch request to explore the seeded local demo target
								at <code>http://127.0.0.1:8000/demo/v1</code>.
							</p>
							<div>
								<button className="primary-button" type="button" onClick={() => openDraftTab(createDraftTab())}>
									New request
								</button>
							</div>
						</section>
					)}
				</main>
			</div>
			{dialogNode}
			{docsCollection && <DocsView collection={docsCollection} onClose={() => setDocsCollectionId(null)} />}
			{dialog?.kind === "environments" && (
				<EnvironmentsDrawer
					activeEnvironmentId={state.activeEnvironmentId}
					canWrite={workspaceCapabilities.writeEnvironments === true}
					onClose={() => setDialog(null)}
					onDeleted={(environmentId) => {
						setEnvironments((current) => current.filter((item) => item._id !== environmentId));
						if (state.activeEnvironmentId === environmentId) savePreferences({ activeEnvironmentId: null });
					}}
					onSaved={(environment) => {
						setEnvironments((current) => {
							const summary = { _id: environment._id, name: environment.name, revision: environment.revision };
							return current.some((item) => item._id === environment._id)
								? current.map((item) => (item._id === environment._id ? { ...item, ...summary } : item))
								: [...current, summary];
						});
						toast("Environment saved.");
					}}
					onSelect={(environmentId) => savePreferences({ activeEnvironmentId: environmentId })}
				/>
			)}
			{dialog?.kind === "local-runtime" && (
				<LocalRuntimeDialog
					busy={localRuntimeBusy}
					error={localRuntimeError}
					localRuntime={localRuntime}
					onClose={() => setDialog(null)}
					onSave={saveLocalRuntime}
				/>
			)}
			<div aria-live="polite" className="toast-region">
				{toasts.map((item) => (
					<div className={`toast ${item.tone}`} key={item.id}>
						<MaterialIcon size={16}>
							{item.tone === "error"
								? "error"
								: item.tone === "warning"
									? "warning"
									: item.tone === "success"
										? "check"
										: "info"}
						</MaterialIcon>
						<span>{item.message}</span>
					</div>
				))}
			</div>
		</div>
	);
}
