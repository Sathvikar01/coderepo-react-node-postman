import { useEffect, useRef, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { exampleApi } from "./example.api.js";
import { describeExample } from "./example-draft.js";

function statusClass(status) {
	if (!status) return "unknown";
	if (status < 300) return "success";
	if (status < 400) return "redirect";
	if (status < 500) return "warning";
	return "danger";
}

export function ExamplesPanel({ onChanged, onCreate, onCopyMockUrl, onDelete, onEdit, refreshToken = 0 }) {
	const [items, setItems] = useState([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const requestId = useRef(0);

	useEffect(() => {
		const id = ++requestId.current;
		setLoading(true);
		setError("");
		exampleApi
			.list()
			.then((data) => {
				if (id === requestId.current) setItems(data);
			})
			.catch((caught) => {
				if (id === requestId.current) setError(caught.message);
			})
			.finally(() => {
				if (id === requestId.current) setLoading(false);
			});
	}, [refreshToken]);

	return (
		<div className="sidebar-panel">
			<div className="sidebar-section-label">
				<span>Examples</span>
				<span className="sidebar-label-actions">
					<button aria-label="Copy mock URL" className="icon-button small" type="button" onClick={onCopyMockUrl}>
						<MaterialIcon size={18}>link</MaterialIcon>
					</button>
					<button aria-label="New example" className="icon-button small" type="button" onClick={onCreate}>
						<MaterialIcon size={18}>add</MaterialIcon>
					</button>
				</span>
			</div>
			{loading && <p className="kv-empty">Loading examples.</p>}
			{!loading && error && (
				<p className="kv-empty" role="alert">
					{error}
				</p>
			)}
			{!loading && !error && items.length === 0 && (
				<p className="kv-empty">No examples yet. Send a request, then choose Save as example to build a deterministic mock.</p>
			)}
			<div className="sidebar-scroll">
				<ul className="example-list">
					{items.map((example) => {
						const summary = describeExample(example);
						return (
							<li className="example-row" key={example._id}>
								<div className="example-row-main">
									<span className={`method-tag ${summary.method.toLowerCase()}`}>{summary.method}</span>
									<span className="example-row-path" title={summary.path}>
										{summary.path}
									</span>
								</div>
								<div className="example-row-meta">
									<span className={`status-pill ${statusClass(summary.status)}`}>{summary.status}</span>
									<span className="field-hint">
										{example.name} · {summary.rules} rule{summary.rules === 1 ? "" : "s"} · {summary.source}
									</span>
								</div>
								<div className="example-row-actions">
									<button className="text-button" type="button" onClick={() => onEdit(example)}>
										Edit
									</button>
									<button className="text-button danger" type="button" onClick={() => onDelete(example)}>
										Delete
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			</div>
			<p className="field-hint sidebar-hint">
				Mock Send resolves the current request against these examples. Nothing is sent over the network and nothing is written to
				history.
			</p>
			<button className="text-button" type="button" onClick={onChanged}>
				Refresh
			</button>
		</div>
	);
}
