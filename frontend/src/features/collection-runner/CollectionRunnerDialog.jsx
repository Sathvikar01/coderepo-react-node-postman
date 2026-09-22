import { useEffect, useMemo, useRef, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { formatDuration } from "../../shared/utils/format.js";
import { collectionRunApi } from "./collection-run.api.js";
import {
	assertionLine,
	buildRunInput,
	cleanRunVariables,
	planLimitError,
	plannedRequests,
	previousExecutedStep,
	runProgress,
	selectionLabel,
	stepStatusLabel,
	stepTone,
	stopReasonLine,
	summaryLine,
} from "./run-view.js";

function methodClass(method) {
	return `method-tag ${(method || "").toLowerCase()}`;
}

// The preview list is checkbox-driven: leaving every request selected runs the whole
// collection (or folder); deselecting produces an explicit request selection in the
// same deterministic order the backend plan uses.
function effectiveSelection(baseSelection, planned, excluded) {
	const checked = planned.filter((entry) => !excluded.has(entry.id)).map((entry) => entry.id);
	if (checked.length === planned.length) return baseSelection;
	return { mode: "requests", requestIds: checked };
}

function RunStepRow({ canCompare, onCompare, onOpenPassport, results, step }) {
	const previous = previousExecutedStep(results, step.index);
	return (
		<li className="run-step">
			<span className="run-step-index">
				{step.index + 1}
				{step.iteration > 1 ? ` · i${step.iteration}` : ""}
			</span>
			<span className={methodClass(step.method)}>{step.method}</span>
			<span className="run-step-name">
				{step.name}
				{step.failureReason ? <small>{step.failureReason}</small> : null}
			</span>
			<span className={`status-pill ${stepTone(step)}`}>{stepStatusLabel(step)}</span>
			<span className="run-step-meta">{assertionLine(step)}</span>
			<span className="run-step-meta">
				{step.durationMs === null || step.durationMs === undefined ? "—" : formatDuration(step.durationMs)}
			</span>
			<span className="run-step-actions">
				{step.executionId ? (
					<>
						<button
							aria-label={`Open the execution passport for ${step.name}`}
							type="button"
							onClick={() => onOpenPassport(step.executionId)}
						>
							Passport
						</button>
						{canCompare && previous ? (
							<button
								aria-label={`Compare ${step.name} with ${previous.name}`}
								type="button"
								onClick={() => onCompare(previous.executionId, step.executionId)}
							>
								Compare
							</button>
						) : null}
					</>
				) : null}
			</span>
		</li>
	);
}

export function CollectionRunnerDialog({
	activeEnvironmentId = null,
	collection,
	environments = [],
	folderId = null,
	onClose,
	onCompare,
	onOpenPassport,
}) {
	const baseSelection = useMemo(
		() => (folderId ? { mode: "folder", folderId } : { mode: "collection" }),
		[folderId],
	);
	const [excluded, setExcluded] = useState(() => new Set());
	const [environmentId, setEnvironmentId] = useState(() => activeEnvironmentId ?? "");
	const [iterations, setIterations] = useState(1);
	const [stopOnFailure, setStopOnFailure] = useState(true);
	const [variableRows, setVariableRows] = useState([{ key: "", value: "" }]);
	const [run, setRun] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const pollToken = useRef(0);

	const planned = plannedRequests(collection, baseSelection);
	const selection = effectiveSelection(baseSelection, planned, excluded);
	const selectedCount = planned.length - excluded.size;
	const environment = environments.find((entry) => entry._id === environmentId) ?? null;
	const variables = cleanRunVariables(variableRows);
	const limitError = planLimitError(iterations, selectedCount);
	const running = run?.status === "running";

	useEffect(() => {
		if (!run || run.status !== "running") return undefined;
		const token = (pollToken.current += 1);
		let timer = null;
		const poll = async () => {
			try {
				const fresh = await collectionRunApi.get(run.runId);
				if (pollToken.current !== token) return;
				setRun(fresh);
				if (fresh.status === "running") timer = setTimeout(poll, 650);
			} catch (caught) {
				if (pollToken.current === token) setError(caught.message);
			}
		};
		timer = setTimeout(poll, 650);
		return () => clearTimeout(timer);
	}, [run]);

	const start = async () => {
		setBusy(true);
		setError("");
		try {
			setRun(
				await collectionRunApi.start(
					buildRunInput({ collection, selection, environment, iterations, stopOnFailure, variables: variables.variables }),
				),
			);
		} catch (caught) {
			setError(caught.message);
		} finally {
			setBusy(false);
		}
	};

	const cancelRun = async () => {
		setBusy(true);
		setError("");
		try {
			setRun(await collectionRunApi.cancel(run.runId));
		} catch (caught) {
			setError(caught.message);
		} finally {
			setBusy(false);
		}
	};

	const rerun = async () => {
		setBusy(true);
		setError("");
		try {
			setRun(await collectionRunApi.rerun(run.runId));
		} catch (caught) {
			setError(caught.message);
		} finally {
			setBusy(false);
		}
	};

	const toggleRequest = (requestId) =>
		setExcluded((current) => {
			const next = new Set(current);
			if (next.has(requestId)) next.delete(requestId);
			else next.add(requestId);
			return next;
		});

	const progress = runProgress(run);
	const finished = Boolean(run) && run.status !== "running";

	return (
		<Modal className="flight-recorder-modal" label="Collection runner" onClose={onClose}>
			<section className="form-dialog flight-recorder-dialog">
				<header className="recorder-header">
					<div>
						<p className="eyebrow">Collection runner</p>
						<h2>
							{collection.name} · {selectionLabel(selection, collection)}
						</h2>
					</div>
					<button aria-label="Close the collection runner" className="icon-button" type="button" onClick={onClose}>
						<MaterialIcon>close</MaterialIcon>
					</button>
				</header>
				{error && (
					<p className="dialog-error" role="alert">
						{error}
					</p>
				)}
				<div className="recorder-content">
					{!run ? (
						<div className="recorder-stack">
							<section className="recorder-card">
								<h3>Run plan</h3>
								<p className="field-hint">
									Requests run in this order. Every request is a normal execution with its own history entry and Execution Passport.
									Run and script variables stay in memory for the run and never change saved environments.
								</p>
								{planned.length === 0 ? (
									<p className="kv-empty">This selection has no requests.</p>
								) : (
									<ul className="run-plan-list">
										{planned.map((entry) => (
											<li key={entry.id}>
												<label className="checkbox-row">
													<input
														checked={!excluded.has(entry.id)}
														type="checkbox"
														onChange={() => toggleRequest(entry.id)}
													/>
													<span className={methodClass(entry.method)}>{entry.method}</span>
													<span>{entry.name}</span>
												</label>
											</li>
										))}
									</ul>
								)}
							</section>
							<section className="recorder-card">
								<h3>Options</h3>
								<label>
									Environment
									<select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}>
										<option value="">No environment</option>
										{environments.map((entry) => (
											<option key={entry._id} value={entry._id}>
												{entry.name}
											</option>
										))}
									</select>
								</label>
								<label>
									Iterations
									<input
										aria-label="Iterations"
										max={25}
										min={1}
										type="number"
										value={iterations}
										onChange={(event) => setIterations(Number.parseInt(event.target.value, 10) || 1)}
									/>
								</label>
								<label className="checkbox-row">
									<input checked={stopOnFailure} type="checkbox" onChange={(event) => setStopOnFailure(event.target.checked)} />
									Stop the run at the first failure
								</label>
							</section>
							<section className="recorder-card">
								<h3>Initial run variables</h3>
								<p className="field-hint">
									Optional starting values for this run only. Secret references stay read-only and are never accepted here.
								</p>
								{variableRows.map((row, index) => (
									<div className="field-row" key={`run-variable-${index}`}>
										<input
											aria-label={`Run variable name ${index + 1}`}
											placeholder="name"
											type="text"
											value={row.key}
											onChange={(event) =>
												setVariableRows((current) =>
													current.map((item, position) => (position === index ? { ...item, key: event.target.value } : item)),
												)
											}
										/>
										<input
											aria-label={`Run variable value ${index + 1}`}
											placeholder="value"
											type="text"
											value={row.value}
											onChange={(event) =>
												setVariableRows((current) =>
													current.map((item, position) => (position === index ? { ...item, value: event.target.value } : item)),
												)
											}
										/>
										<button
											aria-label={`Remove run variable ${index + 1}`}
											className="icon-button small"
											type="button"
											onClick={() => setVariableRows((current) => current.filter((_, position) => position !== index))}
										>
											<MaterialIcon size={18}>close</MaterialIcon>
										</button>
									</div>
								))}
								<button type="button" onClick={() => setVariableRows((current) => [...current, { key: "", value: "" }])}>
									Add variable
								</button>
								{!variables.ok && <p className="dialog-error">{variables.error}</p>}
							</section>
						</div>
					) : (
						<div className="recorder-stack">
							<section className="recorder-card">
								<h3>{finished ? "Run summary" : "Run progress"}</h3>
								{running && (
									<p className="field-hint" role="status">
										Step {Math.min(progress.completed + 1, progress.total)} of {progress.total}
										{progress.current ? ` · ${progress.current.name}` : ""}
									</p>
								)}
								<div aria-hidden="true" className="run-progress">
									<span style={{ width: `${progress.percent}%` }} />
								</div>
								{finished && (
									<>
										<div
											aria-live="polite"
											className={`status-banner ${run.summary?.outcome === "passed" ? "" : "danger"}`}
											role="status"
										>
											{run.summary?.outcome === "passed" ? "Run passed" : "Run finished with failures"} ·{" "}
											{summaryLine(run.summary)}
										</div>
										{stopReasonLine(run.stopReason) ? <p className="field-hint">{stopReasonLine(run.stopReason)}</p> : null}
										<p className="field-hint">Total request time {formatDuration(run.summary?.durationMs)}</p>
									</>
								)}
							</section>
							<section className="recorder-card">
								<h3>Requests</h3>
								<ol className="run-step-list">
									{run.results.map((step) => (
										<RunStepRow
											canCompare={finished}
											key={`${step.index}-${step.requestId}`}
											onCompare={onCompare}
											onOpenPassport={onOpenPassport}
											results={run.results}
											step={step}
										/>
									))}
								</ol>
								<p className="field-hint">
									Passport opens the execution evidence. Compare shows the first divergence from the previous executed request.
								</p>
							</section>
						</div>
					)}
				</div>
				<footer>
					{!run ? (
						<>
							<button type="button" onClick={onClose}>
								Cancel
							</button>
							<button
								className="primary-button"
								disabled={busy || Boolean(limitError) || !variables.ok || selectedCount === 0}
								type="button"
								onClick={start}
							>
								<MaterialIcon size={17}>play_arrow</MaterialIcon>
								Run {selectedCount * (Number(iterations) || 1)} request(s)
							</button>
						</>
					) : (
						<>
							<button type="button" onClick={onClose}>
								Close
							</button>
							{running ? (
								<button disabled={busy} type="button" onClick={cancelRun}>
									<MaterialIcon size={17}>stop</MaterialIcon> Cancel run
								</button>
							) : (
								<button className="primary-button" disabled={busy} type="button" onClick={rerun}>
									<MaterialIcon size={17}>replay</MaterialIcon> Rerun
								</button>
							)}
						</>
					)}
				</footer>
				{!run && limitError && selectedCount > 0 ? <p className="dialog-error">{limitError}</p> : null}
			</section>
		</Modal>
	);
}
