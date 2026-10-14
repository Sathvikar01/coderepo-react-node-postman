// What the history list says when it has no rows to show. The first page loads
// after a short search debounce, so the panel starts in the loading state rather
// than briefly claiming there is no history.
export function historyEmptyMessage({ error = "", filtered = false, itemCount = 0, loading = false }) {
	if (itemCount > 0 || error) return null;
	if (loading) return "Loading history…";
	return filtered ? "No sends match these filters." : "No history yet. Every send is recorded here.";
}
