import { useCallback, useEffect, useRef, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { executionIntelligenceApi } from "./execution-intelligence.api.js";
import {
	boundaryLine,
	capsuleLine,
	changeLabel,
	failurePredicateForReceipt,
	investigationErrorMessage,
	sanitizeEvidenceText,
	investigationStatusBanner,
	isRunning,
	isTerminalStatus,
	minimizationLine,
	predicateLine,
	reproducibilityLine,
	shortId,
	INVESTIGATION_STAGES,
	unverifiedChangeItems,
	verifiedCauseItems,
} from "./investigation-model.js";
import { investigationApi } from "./investigation.api.js";

function StageTimeline({ job }) {
	const reached = isRunning(job) ? INVESTIGATION_STAGES.findIndex((stage) => stage.id === job.stage) : INVESTIGATION_STAGES.length;
	return (
		<ol className="recorder-timeline">
			{INVESTIGATION_STAGES.map((stage, index) => {
				const state = index < reached ? "done" : index === reached ? "active" : "todo";
				return (
					<li key={stage.id} className={`recorder-timeline-item ${state}`}>
						<span className="recorder-timeline-dot" aria-hidden="true">
							{state === "done" ? "✓" : ""}
						</span>
						<span>{stage.label}</span>
					</li>
				);
			})}
		</ol>
	);
}

function QuestionCard({ title, badge, tone, children }) {
	return (
		<section className={`recorder-card recorder-question${tone ? ` ${tone}` : ""}`}>
			<h3>
				{title}
				{badge ? <span className={`cause-chip ${tone ?? ""}`}>{badge}</span> : null}
			</h3>
			{children}
		</section>
	);
}

function StartCard({ receipt, probeTarget, onProbeTargetChange, onStart, onOpenPassport, busy }) {
	return (
		<div className="recorder-stack">
			<section className="recorder-card">
				<h3>What will happen</h3>
				<p className="field-hint">
					Tracer replays a few safe changed variations of the failing request against your local demo or mock targets, then reports only what was
					experimentally verified as the cause. Request secrets stay redacted.
				</p>
				<p className="field-hint">Use mock mode for mutating requests — unsafe methods are never replayed against real targets.</p>
			</section>
			<section className="recorder-card">
				<h3>Failure predicate</h3>
				<p>{receipt ? <code>{predicateLine(failurePredicateForReceipt(receipt))}</code> : <span className="kv-empty">Loading…</span>}</p>
				<p className="field-hint">Derived from this run's recorded failure (assertion, response status, or outcome).</p>
				<p className="field-hint">
					Source run <code>{receipt ? shortId(receipt.executionId) : "—"}</code>
				</p>
				<div className="field-row">
					<label htmlFor="investigation-probe-target">Probe target</label>
					<select id="investigation-probe-target" value={probeTarget} onChange={(event) => onProbeTargetChange(event.target.value)}>
						<option value="execution">Replay execution</option>
						<option value="mock">Mock example</option>
					</select>
				</div>
			</section>
			<div className="recorder-actions">
				<button className="primary-button" type="button" onClick={onStart} disabled={Boolean(busy) || !receipt} data-autofocus>
					{busy ? "Starting…" : "Start investigation"}
				</button>
				<button type="button" onClick={() => onOpenPassport(receipt?.executionId ?? null)} disabled={!receipt}>
					Open passport
				</button>
			</div>
		</div>
	);
}

function ResultSections({ result, onOpenComparison, onOpenPassport, onOpenDraft, onExportCapsule, exportingCapsule }) {
	const causes = verifiedCauseItems(result);
	const unverified = unverifiedChangeItems(result);
	const comparison = result?.comparison ?? null;
	const boundary = result?.regressionBoundary ?? null;
	const minimization = result?.minimization ?? null;
	const reproducibility = result?.reproducibility ?? null;
	const capsule = result?.reproductionCapsule ?? null;
	const goodId = comparison?.baseExecutionId ?? boundary?.goodExecutionId ?? result?.goodExecutionId ?? null;
	const hasComparison = Boolean(goodId && comparison?.candidateExecutionId);

	return (
		<div className="recorder-stack">
			<QuestionCard title="What happened?">
				<p>
					<code>{predicateLine(result?.predicate)}</code>
				</p>
				<p className="field-hint">{sanitizeEvidenceText(result?.summary?.text) || "Summary unavailable."}</p>
			</QuestionCard>

			<QuestionCard title="When did it start?">
				<p>{boundaryLine(boundary)}</p>
				{boundary?.caveat ? <p className="field-hint">{sanitizeEvidenceText(boundary.caveat)}</p> : null}
				{boundary?.resolved ? (
					<p className="field-hint">
						good <code>{shortId(boundary.goodExecutionId)}</code> → failing <code>{shortId(boundary.failingExecutionId ?? result?.failingExecutionId)}</code>
					</p>
				) : null}
				<p className="field-hint">The regression boundary is chronological evidence only — it is not proof of cause.</p>
			</QuestionCard>

			<QuestionCard title="What changed?">
				{comparison?.available && comparison.changes.length > 0 ? (
					<ul className="recorder-deltas">
						{comparison.changes.map((change, index) => (
							<li key={`${change.category}:${change.path}:${index}`}>
								<code>{change.path}</code> <span className="cause-chip">{change.category}</span>
								{change.before?.text !== undefined || change.after?.text !== undefined ? (
									<span className="field-hint">
										{" "}
										<code>{String(change.before?.text ?? "—")}</code> → <code>{String(change.after?.text ?? "—")}</code>
									</span>
								) : null}
							</li>
						))}
					</ul>
				) : (
					<p className="kv-empty">{comparison?.available ? "No recorded input differed between the two runs." : (comparison?.unavailableReason ?? "Comparison unavailable.")}</p>
				)}
				<div className="recorder-actions">
					<button type="button" disabled={!hasComparison} onClick={() => onOpenComparison(goodId, comparison?.candidateExecutionId ?? result?.failingExecutionId)}>
						Open comparison
					</button>
					<button type="button" onClick={() => onOpenPassport(result?.failingExecutionId ?? null)}>
						Open failing passport
					</button>
				</div>
			</QuestionCard>

			<QuestionCard title="What was experimentally verified to cause it?" badge="Verified cause" tone="verified">
				{causes.length === 0 ? (
					<p className="field-hint">
						No change was experimentally verified as the cause. The differences underneath are correlated facts only — listed because they changed,
						not because they were proven to drive the failure.
					</p>
				) : (
					<ul className="recorder-deltas">
						{causes.map((entry, index) => (
							<li key={entry.delta?.id ?? index}>
								<p>
									<code>
										{entry.delta?.path ?? entry.delta?.id ?? "change"}: {String(entry.delta?.before?.text ?? "—")} → {String(entry.delta?.after?.text ?? "—")}
									</code>
								</p>
								<p className="field-hint">{sanitizeEvidenceText(entry.evidenceSummary)}</p>
								<p className="field-hint">
									applied → {entry.evidence?.applied?.predicateMatched ? "failure reproduced" : "failure did not reproduce"}; reverted →{" "}
									{entry.evidence?.reverted?.predicateMatched ? "failure persisted" : "failure disappeared"}
									{entry.evidence?.reverted?.probeExecutionId ? ` (probe ${shortId(entry.evidence.reverted.probeExecutionId)})` : ""}
								</p>
							</li>
						))}
					</ul>
				)}
			</QuestionCard>

			<QuestionCard title="What remains unverified?" badge="Unverified differences" tone="unverified">
				{unverified.length === 0 ? (
					<p className="kv-empty">Nothing else differed between the runs.</p>
				) : (
					<ul className="recorder-deltas">
						{unverified.map((entry, index) => (
							<li key={entry.change?.id ?? index}>
								<p>
									<code>
										{entry.change?.path ?? entry.change?.id ?? "change"}: {String(entry.change?.before?.text ?? "—")} → {String(entry.change?.after?.text ?? "—")}
									</code>
								</p>
								<p className="field-hint">{changeLabel(entry.label)}</p>
								{entry.reason ? <p className="field-hint">{sanitizeEvidenceText(entry.reason)}</p> : null}
							</li>
						))}
					</ul>
				)}
			</QuestionCard>

			<QuestionCard title="What is the smallest reproducer?">
				<p>{minimizationLine(minimization)}</p>
				<div className="recorder-actions">
					<button type="button" disabled={!minimization?.request} onClick={() => onOpenDraft({ draft: minimization.request, dirty: true, autoSend: false, autoSave: false })}>
						Open minimized draft
					</button>
				</div>
			</QuestionCard>

			<QuestionCard title="Does it reproduce reliably?">
				<p>{reproducibilityLine(reproducibility)}</p>
				{reproducibility?.probes?.length ? (
					<ul className="recorder-deltas">
						{reproducibility.probes.map((probe, index) => (
							<li key={probe.probeExecutionId ?? index} className="field-hint">
								<code>
									probe {probe.index ?? index + 1}: {probe.outcome}
									{probe.responseStatus ? ` status ${probe.responseStatus}` : ""} — {probe.predicateMatched ? "failure reproduced" : "failure did not reproduce"} (
									{shortId(probe.probeExecutionId)})
								</code>
							</li>
						))}
					</ul>
				) : null}
			</QuestionCard>

			<QuestionCard title="Export Repro Capsule">
				<p>{capsuleLine(capsule)}</p>
				{capsule?.requiredInputs?.length ? (
					<ul className="recorder-deltas">
						{capsule.requiredInputs.map((input) => (
							<li key={input.name} className="field-hint">
								<code>
									{input.name} — {input.source}
								</code>
							</li>
						))}
					</ul>
				) : null}
				<p className="field-hint">Import always opens an unsent, unsaved dirty draft. Nothing is sent or saved automatically.</p>
				<div className="recorder-actions">
					<button className="primary-button" type="button" disabled={!capsule?.available || exportingCapsule} onClick={onExportCapsule}>
						<MaterialIcon size={17}>download</MaterialIcon>
						{exportingCapsule ? "Exporting…" : "Export Repro Capsule"}
					</button>
					<button type="button" disabled={!capsule?.available || exportingCapsule} onClick={() => onOpenDraft(null)}>
						Open as draft
					</button>
				</div>
			</QuestionCard>
		</div>
	);
}

export function InvestigationDialog({ failingExecutionId, goodExecutionId, onClose, onOpenComparison, onOpenDraft, onOpenPassport, onWhy }) {
	const [probeTarget, setProbeTarget] = useState("execution");
	const [receipt, setReceipt] = useState(null);
	const [job, setJob] = useState(null);
	const [error, setError] = useState(null);
	const [starting, setStarting] = useState(false);
	const [exportingCapsule, setExportingCapsule] = useState(false);
	const pollRef = useRef(null);

	const stopPolling = useCallback(() => {
		if (pollRef.current) window.clearInterval(pollRef.current);
		pollRef.current = null;
	}, []);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const record = await executionIntelligenceApi.receipt(failingExecutionId);
				if (!cancelled) setReceipt(record);
			} catch (fetchError) {
				if (!cancelled) setError({ code: fetchError.code, message: investigationErrorMessage(fetchError) });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [failingExecutionId]);

	useEffect(() => () => stopPolling(), [stopPolling]);

	const handleStart = useCallback(async () => {
		setStarting(true);
		setError(null);
		try {
			const started = await investigationApi.start({
				failingExecutionId,
				...(goodExecutionId ? { goodExecutionId } : {}),
				targetMode: probeTarget === "mock" ? "mock" : "execution",
			});
			setJob(started);
			stopPolling();
			pollRef.current = window.setInterval(async () => {
				try {
					const status = await investigationApi.status(started.investigationId);
					setJob(status);
					if (isTerminalStatus(status.status)) stopPolling();
				} catch (pollError) {
					setError({ code: pollError.code, message: investigationErrorMessage(pollError) });
					stopPolling();
				}
			}, 500);
		} catch (startError) {
			setError({ code: startError.code, message: investigationErrorMessage(startError) });
		} finally {
			setStarting(false);
		}
	}, [failingExecutionId, goodExecutionId, probeTarget, stopPolling]);

	const handleCancel = useCallback(async () => {
		if (!job?.investigationId) return;
		stopPolling();
		try {
			const record = await investigationApi.cancel(job.investigationId);
			setJob(record);
		} catch (cancelError) {
			setError({ code: cancelError.code, message: investigationErrorMessage(cancelError) });
		}
	}, [job, stopPolling]);

	const handleExportCapsule = useCallback(async () => {
		if (!job?.investigationId) return;
		setExportingCapsule(true);
		setError(null);
		try {
			const capsule = await investigationApi.exportCapsule(job.investigationId);
			const url = URL.createObjectURL(new Blob([capsule.text], { type: "text/plain" }));
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = capsule.filename;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
		} catch (capsuleError) {
			setError({ code: capsuleError.code, message: investigationErrorMessage(capsuleError) });
		} finally {
			setExportingCapsule(false);
		}
	}, [job]);

	const handleOpenDraft = useCallback(
		async (preset = null) => {
			setError(null);
			try {
				let imported = preset;
				if (!imported) {
					const capsule = await investigationApi.exportCapsule(job.investigationId);
					imported = await executionIntelligenceApi.importCapsule(capsule.text);
				}
				const opened = await onOpenDraft({ ...imported, autoSend: false, autoSave: false, dirty: true });
				if (opened !== false) onClose();
			} catch (draftError) {
				setError({ code: draftError.code, message: investigationErrorMessage(draftError) });
			}
		},
		[job, onOpenDraft, onClose],
	);

	const handleRestart = useCallback(() => {
		setJob(null);
		setError(null);
		stopPolling();
	}, [stopPolling]);

	const banner = investigationStatusBanner(job);
	const terminal = job ? isTerminalStatus(job.status) : false;

	return (
		<Modal className="flight-recorder-modal" label="Investigate failure" onClose={onClose}>
			<div className="flight-recorder-dialog">
				<header className="recorder-header">
					<div>
						<p className="eyebrow">Execution intelligence</p>
						<h2>Investigate failure</h2>
					</div>
					<div className="proof-header-actions">
						{onWhy && (
							<button className="text-button" type="button" onClick={() => onWhy(failingExecutionId)}>
								Why?
							</button>
						)}
						<button aria-label="Close investigation" className="icon-button" type="button" onClick={onClose}>
							<MaterialIcon>close</MaterialIcon>
						</button>
					</div>
				</header>
				{error ? (
					<div className="status-banner danger" role="alert" data-testid="investigation-error">
						<MaterialIcon size={16}>error</MaterialIcon>
						{error.message}
					</div>
				) : null}
				{banner ? (
					<div className={`status-banner ${banner.tone}`} role="status" data-testid="investigation-status">
						{banner.text}
					</div>
				) : null}
				<div className="recorder-content">
					{error && !receipt ? null : !receipt ? (
						<p className="kv-empty" data-testid="investigation-loading">
							Loading execution passport…
						</p>
					) : job ? (
						<div className="recorder-stack">
							<StageTimeline job={job} />
							{isRunning(job) ? (
								<div className="recorder-actions">
									<button type="button" onClick={handleCancel}>
										Cancel investigation
									</button>
								</div>
							) : null}
							{terminal && job.result ? (
								<ResultSections
									result={job.result}
									onOpenComparison={onOpenComparison}
									onOpenPassport={onOpenPassport}
									onOpenDraft={handleOpenDraft}
									onExportCapsule={handleExportCapsule}
									exportingCapsule={exportingCapsule}
								/>
							) : null}
							{terminal ? (
								<div className="recorder-actions">
									<button type="button" onClick={handleRestart}>
										Start over
									</button>
								</div>
							) : null}
						</div>
					) : (
						<StartCard
							receipt={receipt}
							probeTarget={probeTarget}
							onProbeTargetChange={setProbeTarget}
							onStart={handleStart}
							onOpenPassport={onOpenPassport}
							busy={starting}
						/>
					)}
				</div>
				<footer>
					<button type="button" onClick={onClose}>
						Close
					</button>
				</footer>
			</div>
		</Modal>
	);
}

export default InvestigationDialog;
