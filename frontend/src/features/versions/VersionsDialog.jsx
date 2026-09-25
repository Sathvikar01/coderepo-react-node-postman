import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { versionsApi } from "./versions.api.js";
import { VersionDiff } from "./VersionDiff.jsx";
import "./versions.css";

function formatWhen(value) {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const ACTION_LABEL = { CREATED: "created", UPDATED: "saved", RESTORED: "restored" };

// Phase 24B — version history dialog for one collection or environment.
//
// Selecting a revision shows actor, timestamp, fingerprint, and compare actions.
// Restore is OWNER/EDITOR only and carries the revision the dialog opened with,
// so a concurrent save returns the attributed 409 instead of overwriting.
export function VersionsDialog({ canRestore, currentRevision, onClose, onRestored, resourceId, resourceName, resourceType }) {
	const api = resourceType === "collection" ? versionsApi.collection : versionsApi.environment;
	const [versions, setVersions] = useState([]);
	const [selected, setSelected] = useState(null);
	const [comparison, setComparison] = useState(null);
	const [compareMode, setCompareMode] = useState("current");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		api
			.list(resourceId)
			.then((rows) => {
				if (cancelled) return;
				setVersions(rows ?? []);
				setError("");
			})
			.catch((caught) => {
				if (!cancelled) setError(caught.message);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [resourceId]); // eslint-disable-line react-hooks/exhaustive-deps

	const openRevision = async (row) => {
		setSelected(row);
		setComparison(null);
		setCompareMode("current");
		setError("");
		try {
			const result = await api.compare(resourceId, row.revision, currentRevision);
			setComparison(result);
		} catch (caught) {
			setError(caught.message);
		}
	};

	const compareWith = async (mode) => {
		if (!selected) return;
		setCompareMode(mode);
		setError("");
		try {
			const other = mode === "current" ? currentRevision : selected.revision - 1;
			if (other < 1) {
				setComparison({ identical: true, changes: [], before: { revision: selected.revision }, after: { revision: selected.revision } });
				return;
			}
			setComparison(await api.compare(resourceId, mode === "current" ? selected.revision : other, mode === "current" ? currentRevision : selected.revision));
		} catch (caught) {
			setError(caught.message);
		}
	};

	const restore = async () => {
		if (!selected || selected.revision === currentRevision) return;
		setBusy(true);
		setError("");
		try {
			const result = await api.restore(resourceId, selected.revision, currentRevision);
			onRestored?.(result);
			onClose();
		} catch (caught) {
			setError(caught.message);
		} finally {
			setBusy(false);
		}
	};

	return createPortal(
		<Modal className="workspace-modal versions-modal" labelledBy="versions-title" onClose={onClose}>
			<section className="form-dialog-body">
				<h2 id="versions-title">
					<MaterialIcon size={20}>history</MaterialIcon>
					Versions · {resourceName}
				</h2>
				{loading && <p className="kv-empty">Loading versions…</p>}
				{!loading && error && (
					<p className="dialog-error" role="alert">
						{error}
					</p>
				)}
				{!loading && !error && versions.length === 0 && <p className="kv-empty">No versions recorded yet.</p>}
				{!loading && versions.length > 0 && (
					<div className="versions-layout">
						<ol className="versions-list">
							{versions.map((row) => (
								<li key={row.revision}>
									<button
										aria-current={selected?.revision === row.revision}
										className={`versions-row${selected?.revision === row.revision ? " active" : ""}`}
										type="button"
										onClick={() => openRevision(row)}
									>
										<strong>v{row.revision}</strong>
										{row.revision === currentRevision && <span className="versions-current">current</span>}
										<span className="versions-meta">
											{ACTION_LABEL[row.action] ?? row.action} · {row.actorName ?? "Unknown actor"} · {formatWhen(row.createdAt)}
										</span>
									</button>
								</li>
							))}
						</ol>
						<div className="versions-detail">
							{!selected && <p className="kv-empty">Select a revision to inspect, compare, or restore.</p>}
							{selected && (
								<>
									<p className="versions-detail-head">
										v{selected.revision} · {ACTION_LABEL[selected.action] ?? selected.action} · {selected.actorName ?? "Unknown actor"}
										{selected.action === "RESTORED" && selected.sourceRevision != null ? ` from v${selected.sourceRevision}` : ""}
									</p>
									<p className="versions-fingerprint" title={selected.fingerprint}>
										{selected.fingerprint?.slice(0, 12)}… · {formatWhen(selected.createdAt)}
									</p>
									<div className="versions-compare-tabs" role="tablist" aria-label="Compare revisions">
										<button
											aria-selected={compareMode === "current"}
											role="tab"
											type="button"
											className={compareMode === "current" ? "active" : ""}
											onClick={() => compareWith("current")}
										>
											Compare with current
										</button>
										<button
											aria-selected={compareMode === "previous"}
											role="tab"
											type="button"
											className={compareMode === "previous" ? "active" : ""}
											onClick={() => compareWith("previous")}
										>
											Compare with previous
										</button>
									</div>
									<VersionDiff comparison={comparison} />
									{canRestore && selected.revision !== currentRevision && (
										<button className="button" disabled={busy} type="button" onClick={restore}>
											{busy ? "Restoring…" : `Restore v${selected.revision} as a new revision`}
										</button>
									)}
								</>
							)}
						</div>
					</div>
				)}
				<footer className="dialog-footer">
					<button type="button" onClick={onClose}>
						Close
					</button>
				</footer>
			</section>
		</Modal>,
		document.body,
	);
}
