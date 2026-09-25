import { useCallback, useEffect, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { workspaceApi } from "./workspace.api.js";

const PAGE_SIZE = 25;

function formatWhen(value) {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Human-readable labels for the bounded action vocabulary the backend records.
const ACTION_LABELS = {
	"workspace.created": "Workspace created",
	"workspace.renamed": "Workspace renamed",
	"member.added": "Member added",
	"member.removed": "Member removed",
	"member.role_changed": "Role changed",
	"collection.created": "Collection created",
	"collection.updated": "Collection updated",
	"collection.deleted": "Collection deleted",
	"environment.created": "Environment created",
	"environment.updated": "Environment updated",
	"environment.deleted": "Environment deleted",
};

export function actionLabel(action) {
	return ACTION_LABELS[action] ?? "Workspace change";
}

// Phase 24 — the workspace audit feed.
//
// Pure presentation over `GET /workspaces/:id/activity`. Entries are already
// secret-redacted by the backend; this component renders only what the server
// returned and never fetches a second time for hidden fields.
export function WorkspaceActivityPanel({ refreshToken = 0, workspaceId }) {
	const [entries, setEntries] = useState([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState("");

	const load = useCallback(
		async (before = null) => {
			if (!workspaceId) return;
			if (before) setLoadingMore(true);
			else setLoading(true);
			try {
				const page = await workspaceApi.activity(workspaceId, { limit: PAGE_SIZE, before });
				setTotal(page.total ?? 0);
				setEntries((current) => {
					if (before) {
						const seen = new Set(current.map((entry) => entry.id));
						return [...current, ...(page.entries ?? []).filter((entry) => !seen.has(entry.id))];
					}
					return page.entries ?? [];
				});
				setError("");
			} catch (caught) {
				setError(caught.message);
			} finally {
				setLoading(false);
				setLoadingMore(false);
			}
		},
		[workspaceId],
	);

	useEffect(() => {
		load();
	}, [load, refreshToken]);

	const oldest = entries.length > 0 ? entries[entries.length - 1].createdAt : null;
	const canLoadMore = !loading && entries.length > 0 && entries.length < total && Boolean(oldest);

	return (
		<div className="workspace-activity">
			{loading && <p className="kv-empty">Loading activity…</p>}
			{!loading && error && (
				<p className="dialog-error" role="alert">
					{error}
				</p>
			)}
			{!loading && !error && entries.length === 0 && (
				<p className="kv-empty">No recorded activity in this workspace yet.</p>
			)}
			{!loading && entries.length > 0 && (
				<ol className="activity-list">
					{entries.map((entry) => (
						<li className="activity-entry" key={entry.id}>
							<MaterialIcon size={18}>history</MaterialIcon>
							<div className="activity-entry-body">
								<strong>{actionLabel(entry.action)}</strong>
								<p>{entry.summary}</p>
								<small>
									{entry.actorName}
									{entry.previousRevision != null && entry.newRevision != null
										? ` · revision ${entry.previousRevision} → ${entry.newRevision}`
										: entry.newRevision != null
											? ` · revision ${entry.newRevision}`
											: ""}
									{` · ${formatWhen(entry.createdAt)}`}
								</small>
							</div>
						</li>
					))}
				</ol>
			)}
			{canLoadMore && (
				<button
					className="button"
					disabled={loadingMore}
					type="button"
					onClick={() => load(oldest)}
				>
					{loadingMore ? "Loading…" : "Load older activity"}
				</button>
			)}
		</div>
	);
}
