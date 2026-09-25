import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";

// Phase 24B — conflict-aware remote-change notice for a dirty local draft.
//
// The draft is NEVER overwritten. The user chooses: compare the versions,
// reload the remote (discarding the draft), or keep editing. A later stale save
// still meets the server's attributed 409 — no hidden merge.
export function RemoteChangeBanner({ actorName, onCompare, onKeepEditing, onReload, resourceName, revision }) {
	return (
		<div className="remote-change-banner" role="alert">
			<MaterialIcon size={18}>sync_problem</MaterialIcon>
			<p>
				<strong>{actorName ?? "A collaborator"}</strong> saved {resourceName} · v{revision}. Your draft is based on an older
				revision and was not overwritten.
			</p>
			<div className="remote-change-actions">
				<button type="button" onClick={onCompare}>
					Compare
				</button>
				<button type="button" onClick={onReload}>
					Reload remote
				</button>
				<button type="button" onClick={onKeepEditing}>
					Keep editing
				</button>
			</div>
		</div>
	);
}
