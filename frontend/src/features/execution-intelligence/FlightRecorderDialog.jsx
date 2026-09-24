import { useEffect, useMemo, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { useRovingTabs } from "../../shared/hooks/useRovingTabs.js";
import { executionIntelligenceApi } from "./execution-intelligence.api.js";
import {
	contractBadge,
	groupComparisonChanges,
	minimizationSummary,
	recorderErrorMessage,
} from "./flight-recorder-model.js";

const TABS = [
	{ id: "passport", label: "Passport" },
	{ id: "compare", label: "Compare" },
	{ id: "minimize", label: "Minimize" },
	{ id: "capsule", label: "Capsule" },
];

function Fingerprint({ label, value }) {
	return (
		<div className="recorder-evidence-row">
			<span>{label}</span>
			<code title={value ?? "Unavailable"}>{value ? `${value.slice(0, 16)}…` : "—"}</code>
		</div>
	);
}

function PassportView({ receipt }) {
	if (!receipt) return <p className="kv-empty">Loading execution passport…</p>;
	return (
		<div className="recorder-stack">
			<div className="recorder-summary-grid">
				<div><span>Outcome</span><strong>{receipt.outcome ?? "—"}</strong></div>
				<div><span>Policy</span><strong>{receipt.policy?.decision ?? "—"}</strong></div>
				<div><span>Target</span><strong>{receipt.target ? `${receipt.target.hostname}:${receipt.target.port}` : "Not dispatched"}</strong></div>
				<div><span>Destination</span><strong>{receipt.target?.address ?? "—"}</strong></div>
			</div>
			<section className="recorder-card">
				<h3>Request evidence</h3>
				<Fingerprint label="Authored" value={receipt.request?.authoredFingerprint} />
				<Fingerprint label="Compiled" value={receipt.request?.compiledFingerprint} />
				<p className="field-hint">{receipt.request?.method} {receipt.request?.executedUrl ?? receipt.request?.displayUrl}</p>
			</section>
			<section className="recorder-card">
				<h3>Response contract</h3>
				<p>Status {receipt.response?.contract?.status ?? "—"} · {receipt.response?.contract?.headers?.length ?? 0} header names · {receipt.response?.contract?.bodyShape?.length ?? 0} shape entries</p>
				<Fingerprint label="Body" value={receipt.response?.bodyFingerprint} />
			</section>
		</div>
	);
}

function ComparisonView({ comparison, loading }) {
	const groups = useMemo(() => groupComparisonChanges(comparison), [comparison]);
	if (loading) return <p className="kv-empty">Comparing execution evidence…</p>;
	if (!comparison) return <p className="kv-empty">Choose Compare on two history entries to create a causal comparison.</p>;
	const badge = contractBadge(comparison.contract);
	return (
		<div className="recorder-stack">
			<div className={`status-banner ${badge.tone}`} role="status"><MaterialIcon size={16}>difference</MaterialIcon>{badge.label}</div>
			{comparison.firstDivergence ? (
				<section className="recorder-card recorder-first-divergence">
					<h3>First meaningful divergence</h3>
					<p>{comparison.firstDivergence.message}</p>
				</section>
			) : <p className="kv-empty">These executions have equivalent recorded evidence.</p>}
			{groups.map((group) => (
				<section className="recorder-card" key={group.category}>
					<h3>{group.category}</h3>
					{group.changes.map((change) => <p key={change.path}>{change.message}</p>)}
				</section>
			))}
			{(comparison.contract?.changes ?? []).length > 0 && (
				<section className="recorder-card">
					<h3>Contract checks</h3>
					{comparison.contract.changes.map((change) => (
						<p key={`${change.kind}:${change.path}`}><strong>{change.severity}</strong> · {change.path} · {change.kind.replaceAll("_", " ")}</p>
					))}
				</section>
			)}
		</div>
	);
}

function downloadText(filename, text) {
	const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	URL.revokeObjectURL(url);
}

export function FlightRecorderDialog({ comparisonIds = null, executionId, onClose, onOpenDraft, onWhy }) {
	const [tab, setTab] = useState(comparisonIds ? "compare" : "passport");
	const [receipt, setReceipt] = useState(null);
	const [comparison, setComparison] = useState(null);
	const [loadingComparison, setLoadingComparison] = useState(Boolean(comparisonIds));
	const [error, setError] = useState("");
	const [capsuleText, setCapsuleText] = useState("");
	const [includeResponseBody, setIncludeResponseBody] = useState(false);
	const [importPreview, setImportPreview] = useState(null);
	const [job, setJob] = useState(null);
	const [targetMode, setTargetMode] = useState("execution");
	const [allowUnsafeLocal, setAllowUnsafeLocal] = useState(false);
	const [busy, setBusy] = useState(false);
	const tabs = useRovingTabs();

	useEffect(() => {
		let current = true;
		executionIntelligenceApi.receipt(executionId).then((value) => current && setReceipt(value)).catch((caught) => current && setError(recorderErrorMessage(caught)));
		return () => { current = false; };
	}, [executionId]);

	useEffect(() => {
		if (!comparisonIds) return undefined;
		let current = true;
		setLoadingComparison(true);
		executionIntelligenceApi.compare(comparisonIds.baseExecutionId, comparisonIds.candidateExecutionId)
			.then((value) => current && setComparison(value))
			.catch((caught) => current && setError(recorderErrorMessage(caught)))
			.finally(() => current && setLoadingComparison(false));
		return () => { current = false; };
	}, [comparisonIds]);

	useEffect(() => {
		if (job?.status !== "running") return undefined;
		let current = true;
		const timer = window.setTimeout(() => {
			executionIntelligenceApi.minimization(job.jobId)
				.then((value) => current && setJob(value))
				.catch((caught) => current && setError(recorderErrorMessage(caught)));
		}, 700);
		return () => { current = false; window.clearTimeout(timer); };
	}, [job]);

	const exportCapsule = async () => {
		setBusy(true); setError("");
		try {
			const value = await executionIntelligenceApi.exportCapsule(executionId, includeResponseBody);
			setCapsuleText(value.text);
			downloadText(value.filename, value.text);
		} catch (caught) { setError(recorderErrorMessage(caught)); } finally { setBusy(false); }
	};
	const previewImport = async () => {
		setBusy(true); setError("");
		try { setImportPreview(await executionIntelligenceApi.importCapsule(capsuleText)); }
		catch (caught) { setImportPreview(null); setError(recorderErrorMessage(caught)); }
		finally { setBusy(false); }
	};
	const startMinimization = async () => {
		setBusy(true); setError("");
		try {
			setJob(await executionIntelligenceApi.startMinimization({ sourceExecutionId: executionId, targetMode, allowUnsafeLocal }));
		} catch (caught) { setError(recorderErrorMessage(caught)); } finally { setBusy(false); }
	};
	const cancelMinimization = async () => {
		if (!job?.jobId) return;
		setBusy(true);
		try { setJob(await executionIntelligenceApi.cancelMinimization(job.jobId)); }
		catch (caught) { setError(recorderErrorMessage(caught)); } finally { setBusy(false); }
	};

	return (
		<Modal className="flight-recorder-modal" label="API Flight Recorder" onClose={onClose}>
			<section className="form-dialog flight-recorder-dialog">
				<header className="recorder-header"><div><p className="eyebrow">Execution intelligence</p><h2>API Flight Recorder</h2></div><div className="proof-header-actions">{onWhy && (<button className="text-button" type="button" onClick={() => onWhy(executionId)}>Why?</button>)}<button aria-label="Close Flight Recorder" className="icon-button" type="button" onClick={onClose}><MaterialIcon>close</MaterialIcon></button></div></header>
				<div aria-label="Flight Recorder sections" className="code-formats" onKeyDown={tabs.onKeyDown} ref={tabs.listRef} role="tablist">
					{TABS.map((item) => <button aria-selected={tab === item.id} className="code-format" key={item.id} role="tab" tabIndex={tab === item.id ? 0 : -1} type="button" onClick={() => setTab(item.id)}>{item.label}</button>)}
				</div>
				{error && <p className="dialog-error" role="alert">{error}</p>}
				<div className="recorder-content" role="tabpanel">
					{tab === "passport" && <PassportView receipt={receipt} />}
					{tab === "compare" && <ComparisonView comparison={comparison} loading={loadingComparison} />}
					{tab === "capsule" && <div className="recorder-stack">
						<section className="recorder-card">
							<h3>Export Capsule</h3>
							<p className="field-hint">Capsules hold placeholders and evidence fingerprints only. Resolved secrets are redacted before export.</p>
							<label className="checkbox-row"><input checked={includeResponseBody} type="checkbox" onChange={(event) => setIncludeResponseBody(event.target.checked)} />Include the scrubbed bounded response body</label>
							<div className="recorder-actions"><button className="primary-button" disabled={busy} type="button" onClick={exportCapsule}><MaterialIcon size={17}>download</MaterialIcon>Export Capsule</button></div>
						</section>
						<section className="recorder-card">
							<h3>Import Capsule</h3>
							<p className="field-hint">Import always opens an unsent, unsaved dirty draft. Nothing is sent or saved automatically.</p>
							<textarea aria-label="Reproduction capsule JSON" className="recorder-capsule-text" placeholder="Paste a ReproCapsuleV1 file here to preview it" value={capsuleText} onChange={(event) => { setCapsuleText(event.target.value); setImportPreview(null); }} />
							<div className="recorder-actions"><button disabled={!capsuleText || busy} type="button" onClick={previewImport}>Preview import</button>{importPreview && <button className="primary-button" type="button" onClick={() => onOpenDraft(importPreview)}>Open dirty draft</button>}</div>
							{importPreview && <p className="field-hint">{importPreview.requiredInputs.length} required input(s). Nothing has been sent or saved.</p>}
						</section>
					</div>}
					{tab === "minimize" && <div className="recorder-stack">
						<p className="field-hint">Tracer verifies the failure twice, then removes query rows, headers, and top-level JSON fields within a 12-probe budget.</p>
						<label>Probe target<select value={targetMode} onChange={(event) => setTargetMode(event.target.value)}><option value="execution">Recorded execution path</option><option value="mock">Saved examples only (zero network)</option></select></label>
						<label className="checkbox-row"><input checked={allowUnsafeLocal} type="checkbox" onChange={(event) => setAllowUnsafeLocal(event.target.checked)} />Allow repeated mutating probes only when this receipt proves approved local access</label>
						<div className={`status-banner ${minimizationSummary(job).tone}`} role="status">{minimizationSummary(job).label}</div>
						<div className="recorder-actions">{job?.status === "running" ? <button disabled={busy} type="button" onClick={cancelMinimization}>Cancel minimization</button> : <button className="primary-button" disabled={busy} type="button" onClick={startMinimization}>Start minimization</button>}{job?.status === "completed" && <button type="button" onClick={() => onOpenDraft({ draft: job.result.request, dirty: true, autoSend: false, autoSave: false })}>Open minimized draft</button>}</div>
					</div>}
				</div>
				<footer><button type="button" onClick={onClose}>Close</button></footer>
			</section>
		</Modal>
	);
}
