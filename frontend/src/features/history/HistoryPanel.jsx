import { useEffect, useRef, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { OUTCOME_LABELS, relativeTime } from "../../shared/utils/format.js";
import { canInvestigateHistoryItem } from "../execution-intelligence/investigation-model.js";
import { historyApi } from "./history.api.js";

const OUTCOME_STYLE = {
	response: "response",
	cancelled: "neutral",
	interrupted: "neutral",
	validation_error: "warning",
	timeout: "warning",
	size_limit: "warning",
	network_error: "error",
	decode_error: "error",
};

export function HistoryPanel({ compareBaseId, onAnalyze, onCompare, onDelete, onInvestigate, onOpen, onResend, onSaveAs, onWhy, onClear, refreshToken }) {
	const [items, setItems] = useState([]);
	const [cursor, setCursor] = useState(null);
	const [query, setQuery] = useState("");
	const [method, setMethod] = useState("");
	const [outcome, setOutcome] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const searchTimer = useRef(null);
	const requestId = useRef(0);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const load = async ({ append = false, nextCursor = null } = {}) => {
		const id = ++requestId.current;
		setLoading(true);
		setError("");
		try {
			const page = await historyApi.list({
				cursor: nextCursor,
				limit: 25,
				method: method || undefined,
				outcome: outcome || undefined,
				q: query || undefined,
			});
			if (id !== requestId.current || !mounted.current) return;
			setItems((current) => (append ? [...current, ...page.items] : page.items));
			setCursor(page.nextCursor);
		} catch (caught) {
			if (id !== requestId.current || !mounted.current) return;
			setError(caught.message);
		} finally {
			if (id === requestId.current && mounted.current) setLoading(false);
		}
	};

	useEffect(() => {
		clearTimeout(searchTimer.current);
		searchTimer.current = setTimeout(() => load(), 220);
		return () => clearTimeout(searchTimer.current);
	}, [query, method, outcome, refreshToken]);

	return (
		<div className="sidebar-panel">
			<div className="sidebar-section-label">
				<span>History</span>
				<button
					aria-label="Clear history"
					className="icon-button small"
					title="Clear visible history"
					type="button"
					onClick={onClear}
				>
					<MaterialIcon size={18}>delete</MaterialIcon>
				</button>
			</div>
			<div className="sidebar-search">
				<MaterialIcon size={18}>search</MaterialIcon>
				<input
					aria-label="Search history"
					maxLength={120}
					placeholder="Search name or URL"
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</div>
			<div className="field-row" style={{ gap: 8 }}>
				<select
					aria-label="Filter by method"
					className="url-input"
					style={{ height: 34 }}
					value={method}
					onChange={(event) => setMethod(event.target.value)}
				>
					<option value="">All methods</option>
					{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((item) => (
						<option key={item} value={item}>
							{item}
						</option>
					))}
				</select>
				<select
					aria-label="Filter by outcome"
					className="url-input"
					style={{ height: 34 }}
					value={outcome}
					onChange={(event) => setOutcome(event.target.value)}
				>
					<option value="">All outcomes</option>
					{Object.entries(OUTCOME_LABELS).map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</div>
			{error && (
				<p className="dialog-error" role="alert">
					{error}
				</p>
			)}
			<div className="sidebar-scroll">
				{items.length === 0 && !loading && <p className="kv-empty">No history yet. Every send is recorded here.</p>}
				<div className="history-list">
					{items.map((item) => (
						<div className={`history-item ${compareBaseId === item.executionId ? "active" : ""}`} key={item.executionId}>
							<div className="history-item-top">
								<span className={`method-tag ${(item.method || "").toLowerCase()}`}>{item.method ?? "?"}</span>
								<span className="history-item-title">{item.name ?? "Untitled"}</span>
								<span className={`outcome-chip ${OUTCOME_STYLE[item.outcome] ?? "neutral"}`}>
									{OUTCOME_LABELS[item.outcome] ?? item.outcome}
								</span>
							</div>
							<div className="history-item-url">{item.displayUrl ?? "—"}</div>
							<div className="history-item-meta">
								<span>{item.statusCode ?? "—"}</span>
								<span>{item.durationMs ? `${Math.round(item.durationMs)} ms` : "—"}</span>
								<span>{relativeTime(item.startedAt)}</span>
							</div>
							<div className="history-item-meta">
								<button className="text-button" type="button" onClick={() => onAnalyze(item.executionId)}>
									Passport
								</button>
								{onWhy && (
									<button className="text-button" type="button" onClick={() => onWhy(item.executionId)}>
										Why?
									</button>
								)}
								<button className="text-button" type="button" onClick={() => onCompare(item.executionId)}>
									{compareBaseId === item.executionId ? "Selected" : "Compare"}
								</button>
								{onInvestigate && canInvestigateHistoryItem(item) && (
									<button className="text-button" type="button" onClick={() => onInvestigate(item.executionId)}>
										Investigate failure
									</button>
								)}
								<button className="text-button" type="button" onClick={() => onOpen(item.executionId)}>
									Inspect
								</button>
								<button className="text-button" type="button" onClick={() => onOpen(item.executionId, { reopen: true })}>
									Reopen
								</button>
								<button className="text-button" type="button" onClick={() => onResend(item.executionId)}>
									Resend
								</button>
								<button className="text-button" type="button" onClick={() => onSaveAs(item.executionId)}>
									Save as
								</button>
								<button className="text-button danger-button" type="button" onClick={() => onDelete(item.executionId)}>
									Delete
								</button>
							</div>
						</div>
					))}
				</div>
				{cursor && (
					<button
						className="text-button"
						disabled={loading}
						type="button"
						onClick={() => load({ append: true, nextCursor: cursor })}
					>
						{loading ? "Loading…" : "Load more"}
					</button>
				)}
				{items.length > 0 && (
					<p className="field-hint">
						Results are retained for 7 days. Bodies are trimmed to the newest 200 completed sends per profile.
					</p>
				)}
			</div>
		</div>
	);
}
