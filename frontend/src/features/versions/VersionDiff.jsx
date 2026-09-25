import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";

const CHANGE_ICON = { added: "add_circle", removed: "remove_circle", changed: "edit" };

function ChangeRow({ change }) {
	return (
		<li className={`version-diff-row ${change.change}`}>
			<MaterialIcon size={16}>{CHANGE_ICON[change.change] ?? "edit"}</MaterialIcon>
			<div className="version-diff-body">
				<code className="version-diff-path">{change.path}</code>
				{change.change === "changed" ? (
					<p className="version-diff-values">
						<span className="version-diff-before">{String(change.before ?? "—")}</span>
						<span aria-hidden="true"> → </span>
						<span className="version-diff-after">{String(change.after ?? "—")}</span>
					</p>
				) : (
					<p className="version-diff-values">
						<span className={change.change === "added" ? "version-diff-after" : "version-diff-before"}>
							{String(change.change === "added" ? (change.after ?? "—") : (change.before ?? "—"))}
						</span>
					</p>
				)}
			</div>
		</li>
	);
}

// Phase 24B — reviewer-friendly rendering of the backend's structured diff.
// Presentation only: authority and version truth stay on the server.
export function VersionDiff({ comparison }) {
	if (!comparison) return null;
	if (comparison.identical) return <p className="kv-empty">These revisions are identical.</p>;
	return (
		<div className="version-diff">
			<p className="version-diff-title">
				v{comparison.before.revision} → v{comparison.after.revision}
				{comparison.truncated ? " · showing the first 200 changes" : ""}
			</p>
			{comparison.changes.length === 0 ? (
				<p className="kv-empty">No visible differences.</p>
			) : (
				<ol className="version-diff-list">
					{comparison.changes.map((change, index) => (
						<ChangeRow key={`${change.change}-${change.path}-${index}`} change={change} />
					))}
				</ol>
			)}
		</div>
	);
}
