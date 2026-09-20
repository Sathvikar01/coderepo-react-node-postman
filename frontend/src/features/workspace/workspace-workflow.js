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
