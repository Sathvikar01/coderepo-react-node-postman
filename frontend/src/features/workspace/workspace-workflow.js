// Pure workflow decisions shared by App and its regression tests. Keeping these
// here (instead of inline in App.jsx) lets the tab/execution rules be tested
// without a DOM or a React renderer.

const ACTIVE_STATUSES = ["running", "reconciling"];

export function isExecutionActive(tab) {
	return Boolean(tab?.executionId) && ACTIVE_STATUSES.includes(tab?.status);
}

export function workspaceHasUnsettledWork(tabs = []) {
	return tabs.some((tab) => tab.dirty || isExecutionActive(tab));
}

export function tabKeyIntent(key) {
	if (key === "Delete" || key === "Backspace") return "close";
	return null;
}

// Global Ctrl/Cmd+Enter (send) and Ctrl/Cmd+S (save) act on the active request
// tab, so they must stay inert while any modal dialog covers the workbench.
export function workspaceShortcutIntent(event, { dialogOpen = false } = {}) {
	if (!(event?.metaKey || event?.ctrlKey) || dialogOpen) return null;
	if (event.key === "Enter") return "send";
	if (typeof event.key === "string" && event.key.toLowerCase() === "s") return "save";
	return null;
}
