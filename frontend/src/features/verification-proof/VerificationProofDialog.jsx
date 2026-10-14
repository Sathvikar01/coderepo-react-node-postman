import { useEffect, useMemo, useRef, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { useRovingTabs } from "../../shared/hooks/useRovingTabs.js";
import { VERIFICATION_WORKFLOW } from "../product/product-content.js";
import { WorkflowProgression } from "../product/WorkflowProgression.jsx";
import { verificationProofApi } from "./verification-proof.api.js";
import {
	contractRows,
	countRows,
	driftSummary,
	evidenceRows,
	integrityDetails,
	looksLikeProofArtifact,
	proofErrorMessage,
	rehearsalLine,
	reviewPromotionOptions,
	reasonTexts,
	reportHeadline,
	reportTone,
	safeFilename,
	stateReasonCodes,
	statusLabel,
	verificationStateBadge,
} from "./proof-view.js";

// Phase 47C — Verification Proof dialog.
//
// This component is presentation only. It issues Phase 47B requests and renders
// exactly what the backend returns:
//
//   * It never builds a proof, never recomputes a fingerprint, and never decides
//     whether a proof is current.
//   * It never upgrades a state. A STALE or UNKNOWN proof is rendered as such.
//   * Import is inspection-only: it never executes, sends, saves, or mutates the
//     workspace verification.
//
// The dialog can be opened from two places, both of which land here:
//   * "View Verification Proof" in the workspace command rail (import path), and
//   * the Flight Recorder / runner, when a proof is available.
export const PROOF_TABS = [
	{ id: "proof", label: "Proof" },
	{ id: "evidence", label: "Evidence" },
	{ id: "integrity", label: "Integrity" },
	{ id: "import", label: "Import & Verify" },
];

function downloadText(filename, text) {
	const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	URL.revokeObjectURL(url);
}

function Fingerprint({ label, value }) {
	return (
		<div className="recorder-evidence-row">
			<span>{label}</span>
			<code title={value ?? "Unavailable"}>{value ? `${value.slice(0, 20)}…` : "—"}</code>
		</div>
	);
}

function CountGrid({ rows }) {
	if (rows.length === 0) return <p className="kv-empty">No request counts are committed in this proof.</p>;
	return (
		<div className="proof-count-grid">
			{rows.map((row) => (
				<div className={`proof-count ${row.tone === "warning" ? "warning" : ""}`} key={row.key}>
					<span>{row.label}</span>
					<strong>{row.value}</strong>
				</div>
			))}
		</div>
	);
}

function Headline({ report }) {
	const headline = reportHeadline(report);
	return (
		<div className={`proof-headline ${headline.tone}`} role="status">
			<MaterialIcon size={18}>{headline.tone === "success" ? "check" : headline.tone === "unknown" ? "info" : "warning"}</MaterialIcon>
			<div>
				<strong>{headline.title}</strong>
				<p>{headline.detail}</p>
			</div>
		</div>
	);
}

// A proof is only rendered as evidence when the backend report says it is VALID.
// Every other status keeps its own non-green presentation.
function ProofView({ proof, report, promotionOptions, onPromote, promoteBusy }) {
	if (!proof) return <p className="kv-empty">Load or import a verification proof to inspect it.</p>;
	const counts = countRows(proof.counts);
	const contracts = contractRows(proof.contracts);
	const drift = driftSummary(proof.drift);
	const reasons = report ? reasonTexts(report.reasons) : stateReasonCodes(proof);

	return (
		<div className="recorder-stack">
			<Headline report={report} />
			{onPromote && promotionOptions.length > 0 && (
				<section className="recorder-card" aria-label="Review actions">
					<h3>Promote to Review</h3>
					<p className="field-hint">
						Tracer carries this exact validated proof into the review. No copy/paste, no retyping technical state, and no new verification run.
					</p>
					<div className="recorder-actions">
						{promotionOptions.map((option) => (
							<button
								key={option.findingType}
								disabled={promoteBusy}
								type="button"
								onClick={() => onPromote(option)}
							>
								<MaterialIcon size={17}>rate_review</MaterialIcon>
								{promoteBusy ? "Preparing review…" : option.label}
							</button>
						))}
					</div>
				</section>
			)}
			<div className="recorder-summary-grid">
				<div><span>Verification state</span><strong>{verificationStateBadge(proof.state).label}</strong></div>
				<div><span>Report status</span><strong>{statusLabel(report?.status)}</strong></div>
				<div><span>Snapshot</span><strong>{proof.identity?.snapshot?.snapshotId ?? "—"}</strong></div>
				<div><span>Target environment</span><strong>{proof.identity?.targetEnvironment?.environmentName ?? proof.identity?.targetEnvironment?.environmentId ?? "—"}</strong></div>
			</div>

			<section className="recorder-card">
				<h3>Snapshot &amp; environment identity</h3>
				<Fingerprint label="Snapshot id" value={proof.identity?.snapshot?.snapshotId} />
				<Fingerprint label="Snapshot fingerprint" value={proof.identity?.snapshot?.snapshotFingerprint} />
				<Fingerprint label="Environment id" value={proof.identity?.targetEnvironment?.environmentId} />
				<Fingerprint label="Environment fingerprint" value={proof.identity?.targetEnvironment?.environmentFingerprint} />
				{report?.current ? (
					<p className="field-hint">
						Current observed {report.current.snapshot ? `snapshot ${report.current.snapshot.snapshotId}` : "snapshot unknown"} ·{" "}
						{report.current.targetEnvironment ? `environment ${report.current.targetEnvironment.environmentId}` : "environment unknown"}
					</p>
				) : (
					<p className="field-hint">No current identity was supplied, so currency is unknown rather than current.</p>
				)}
			</section>

			<section className="recorder-card">
				<h3>Rehearsal run</h3>
				<Fingerprint label="Plan id" value={proof.identity?.planId} />
				<Fingerprint label="Run id" value={proof.identity?.runId} />
				<Fingerprint label="Run identity fingerprint" value={proof.identity?.runIdentityFingerprint} />
				<p className="field-hint">{rehearsalLine(proof.rehearsal)}</p>
			</section>

			<section className="recorder-card">
				<h3>Verification counts</h3>
				<CountGrid rows={counts} />
				{reasons.length > 0 && (
					<div className="proof-reasons">
						{reasons.map((reason) => (
							<p key={reason.code}>{reason.text}</p>
						))}
					</div>
				)}
			</section>

			<section className="recorder-card">
				<h3>Contract compatibility</h3>
				{contracts.present ? (
					<CountGrid rows={contracts.rows} />
				) : (
					<p className="field-hint">{contracts.note}</p>
				)}
			</section>

			<section className={`recorder-card ${drift.blockingCount > 0 ? "proof-card-danger" : ""}`}>
				<h3>Environment drift</h3>
				<p className="field-hint">{drift.label}</p>
				{drift.blocking.map((finding, index) => (
					<p key={`${finding.category}:${finding.path ?? index}`}>
						<strong>{finding.severity ?? "unknown"}</strong> · {String(finding.category ?? "").replaceAll("_", " ").toLowerCase()}
						{finding.path ? ` · ${finding.path}` : ""}
						{finding.status ? ` · ${finding.status}` : ""}
					</p>
				))}
			</section>

			<section className="recorder-card">
				<h3>Proof identity</h3>
				<Fingerprint label="Proof fingerprint" value={proof.fingerprint} />
				<Fingerprint label="Verified at" value={proof.verifiedAt} />
				<p className="field-hint">The fingerprint is computed by Tracer over the proof content. This view never recomputes it.</p>
			</section>
		</div>
	);
}

function EvidenceView({ proof }) {
	const rows = useMemo(() => evidenceRows(proof), [proof]);
	if (!proof) return <p className="kv-empty">No proof is loaded, so there is no per-request evidence to show.</p>;
	if (rows.length === 0) return <p className="kv-empty">This proof commits no per-request evidence rows.</p>;
	return (
		<div className="recorder-stack">
			<p className="field-hint">Evidence references only. Bodies, credentials, and resolved secret environment values are never part of a proof.</p>
			<div className="proof-evidence-table">
				<div className="proof-evidence-head">
					<span>Request</span>
					<span>Impact</span>
					<span>Contract</span>
					<span>Verification</span>
					<span>Evidence</span>
				</div>
				{rows.map((row) => (
					<div className="proof-evidence-row" key={row.requestId}>
						<span className="proof-request-id" title={row.requestId}>{row.requestId}</span>
						<span>{row.impacted ? `Impacted${row.impactKind ? ` (${row.impactKind})` : ""}` : "Not impacted"}</span>
						<span>{row.contractState}</span>
						<span className={`status-pill ${verificationStateBadge(row.verificationState).tone}`}>{verificationStateBadge(row.verificationState).label}</span>
						<span>
							{row.evidenceCount === 0 ? "—" : row.evidenceRefs.map((ref) => `${ref.kind}:${ref.refId}`).join(", ")}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

function IntegrityView({ proof, artifact }) {
	const details = integrityDetails(proof, artifact);
	if (!details) return <p className="kv-empty">No proof is loaded, so there is no integrity metadata to show.</p>;
	return (
		<div className="recorder-stack">
			<p className="field-hint">Compact integrity and provenance metadata. This is secondary detail; the primary proof view is on the Proof tab.</p>
			<section className="recorder-card">
				<h3>Integrity</h3>
				<Fingerprint label="Proof id" value={details.proofId} />
				<Fingerprint label="Fingerprint" value={details.fingerprint} />
				<Fingerprint label="Fingerprint key id" value={details.fingerprintKeyId} />
				<Fingerprint label="Schema version" value={details.schemaVersion === null ? null : String(details.schemaVersion)} />
				<Fingerprint label="Integrity algorithm" value={details.algorithm} />
				<Fingerprint label="Canonicalization" value={details.canonicalization} />
				<Fingerprint label="Verified at" value={details.verifiedAt} />
			</section>
			<section className="recorder-card">
				<h3>Provenance</h3>
				<Fingerprint label="Source count" value={String(details.provenanceCount)} />
				{artifact ? <Fingerprint label="Artifact fingerprint" value={details.artifactFingerprint} /> : <p className="field-hint">No portable artifact wrapper is loaded.</p>}
			</section>
			<details className="proof-raw">
				<summary>Raw proof JSON (advanced)</summary>
				<textarea aria-label="Raw verification proof JSON" className="recorder-capsule-text" readOnly value={JSON.stringify(proof, null, 2)} />
			</details>
		</div>
	);
}

export function VerificationProofDialog({ initialProof = null, onClose, onOpenHelp, onPromoteToReview }) {
	const [tab, setTab] = useState("proof");
	const [artifactText, setArtifactText] = useState("");
	const [validatedArtifactText, setValidatedArtifactText] = useState("");
	const [proof, setProof] = useState(initialProof);
	const [artifact, setArtifact] = useState(null);
	const [report, setReport] = useState(null);
	const [importResult, setImportResult] = useState(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState("");
	const requestToken = useRef(0);
	const tabs = useRovingTabs();

	// Abandon in-flight responses when the dialog unmounts so a late response can
	// never write into an unmounted view.
	useEffect(() => () => {
		requestToken.current += 1;
	}, []);

	const run = async (key, work) => {
		const token = requestToken.current + 1;
		requestToken.current = token;
		setBusy(key);
		setError("");
		setNotice("");
		try {
			const value = await work();
			if (requestToken.current !== token) return null;
			return value;
		} catch (caught) {
			if (requestToken.current === token) setError(proofErrorMessage(caught));
			return null;
		} finally {
			if (requestToken.current === token) setBusy("");
		}
	};

	// A proof produced by Change Safety is already backend-minted. Re-check it
	// through the existing Phase 47B verify route on open so this dialog renders
	// the same report semantics as imported artifacts.
	useEffect(() => {
		if (!initialProof) return;
		setProof(initialProof);
		setArtifact(null);
		setImportResult(null);
		setTab("proof");
		const token = requestToken.current + 1;
		requestToken.current = token;
		setBusy("verify");
		setError("");
		verificationProofApi
			.verify({ proof: initialProof })
			.then((value) => {
				if (requestToken.current === token) setReport(value);
			})
			.catch((caught) => {
				if (requestToken.current === token) setError(proofErrorMessage(caught));
			})
			.finally(() => {
				if (requestToken.current === token) setBusy("");
			});
	}, [initialProof]);

	// Import never trusts the artifact. It parses it strictly, and the proof only
	// becomes inspectable after the backend has decided its status.
	const importArtifact = async () => {
		const submittedArtifact = artifactText;
		const result = await run("import", () => verificationProofApi.importProof(submittedArtifact));
		if (!result) return;
		setValidatedArtifactText(submittedArtifact);
		setImportResult(result);
		setProof(result.proof);
		setArtifact(null);
		setReport(result.report ?? null);
		setTab("proof");
		// The import response carries explicit "did nothing" flags; if the backend
		// ever reports that it acted, the UI says so instead of assuming silence.
		if (result.executed || result.autoSend || result.autoSave || result.persisted || result.upgraded) {
			setNotice("Tracer reported a side effect during import. Treat this artifact as untrusted.");
		} else {
			setNotice("Artifact inspected. Nothing was executed, sent, or saved.");
		}
	};

	// Verify re-checks the loaded proof against the current identity the caller
	// holds. With no current identity the backend answers UNKNOWN, which the UI
	// shows rather than dressing up as a pass.
	const verifyLoaded = async () => {
		if (!proof) return;
		const result = await run("verify", () => verificationProofApi.verify({ proof }));
		if (result) setReport(result);
	};

	const loadArtifactText = (text) => {
		setArtifactText(text);
		setError("");
		setNotice("");
	};

	// Export is a deterministic backend artifact. The proof is not mutated here.
	const exportLoaded = async ({ download = true } = {}) => {
		if (!proof) return null;
		const result = await run(download ? "export" : "promote", () => verificationProofApi.exportProof({ proof }));
		if (!result) return null;
		setArtifact(JSON.parse(result.text));
		setArtifactText(result.text);
		setValidatedArtifactText(result.text);
		if (download) {
			downloadText(safeFilename(result.filename), result.text);
			setNotice(`Exported ${safeFilename(result.filename)} (proof ${result.proofId}).`);
		}
		return result.text;
	};

	const promoteToReview = async (option) => {
		if (!proof || !onPromoteToReview) return;
		const exactArtifact = validatedArtifactText || (await exportLoaded({ download: false }));
		if (!exactArtifact) return;
		onPromoteToReview({
			...option,
			proofArtifact: exactArtifact,
			proofId: proof.proofId ?? null,
			proofState: proof.state ?? null,
		});
	};

	const hasProof = Boolean(proof);
	const promotionOptions = useMemo(() => reviewPromotionOptions(proof), [proof]);
	const canImport = artifactText.trim().length > 0 && looksLikeProofArtifact(artifactText);
	const malformedImport = artifactText.trim().length > 0 && !looksLikeProofArtifact(artifactText);

	return (
		<Modal className="verification-proof-modal" label="Verification Proof" onClose={onClose}>
			<section className="form-dialog verification-proof-dialog">
				<header className="recorder-header">
					<div>
						<p className="eyebrow">Verification proof</p>
						<h2>Verification Proof</h2>
						<p className="field-hint proof-headline-hint">
							A keyed, tamper-evident record of what was verified. Tracer never upgrades a state — every state and status below is the backend's answer.
						</p>
					</div>
					<div className="proof-header-actions">
						{onOpenHelp && (
							<button className="text-button" type="button" onClick={onOpenHelp}>
								<MaterialIcon size={16}>info</MaterialIcon>
								How verification works
							</button>
						)}
						<button aria-label="Close Verification Proof" className="icon-button" type="button" onClick={onClose}>
							<MaterialIcon>close</MaterialIcon>
						</button>
					</div>
				</header>

				<WorkflowProgression compact currentStep="proof" label="Verification workflow" workflow={VERIFICATION_WORKFLOW} />

				<div
					aria-label="Verification Proof sections"
					className="code-formats"
					onKeyDown={tabs.onKeyDown}
					ref={tabs.listRef}
					role="tablist"
				>
					{PROOF_TABS.map((item) => (
						<button
							aria-selected={tab === item.id}
							className="code-format"
							key={item.id}
							role="tab"
							tabIndex={tab === item.id ? 0 : -1}
							type="button"
							onClick={() => setTab(item.id)}
						>
							{item.label}
						</button>
					))}
				</div>

				{error && <p className="dialog-error" role="alert">{error}</p>}
				{notice && <p className="field-hint proof-notice" role="status">{notice}</p>}

				<div className="recorder-content" role="tabpanel">
					{tab === "proof" && (
						<ProofView
							proof={proof}
							report={report}
							promotionOptions={promotionOptions}
							onPromote={onPromoteToReview ? promoteToReview : null}
							promoteBusy={busy === "promote"}
						/>
					)}
					{tab === "evidence" && <EvidenceView proof={proof} />}
					{tab === "integrity" && <IntegrityView artifact={artifact} proof={proof} />}
					{tab === "import" && (
						<div className="recorder-stack">
							<section className="recorder-card">
								<h3>Import Proof</h3>
								<p className="field-hint">
									An imported artifact is untrusted and inspection-only. Tracer never executes, sends, or saves anything from it, and never
									upgrades its state.
								</p>
								<textarea
									aria-label="Verification proof artifact JSON"
									className="recorder-capsule-text"
									placeholder="Paste a tracer.verification-proof-artifact file here, then select Verify."
									value={artifactText}
									onChange={(event) => loadArtifactText(event.target.value)}
								/>
								{malformedImport && <p className="field-hint proof-warning-text">This text is not shaped like a verification proof artifact. Verifying it will be refused, not repaired.</p>}
								<div className="recorder-actions">
									<button
										className="primary-button"
										disabled={!canImport || busy === "import"}
										type="button"
										onClick={importArtifact}
									>
										<MaterialIcon size={17}>check</MaterialIcon>
										{busy === "import" ? "Verifying…" : "Verify"}
									</button>
									{hasProof && (
										<button disabled={busy === "verify"} type="button" onClick={verifyLoaded}>
											{busy === "verify" ? "Re-checking…" : "Re-check loaded proof"}
										</button>
									)}
								</div>
							</section>
							{hasProof && (
								<section className="recorder-card">
									<h3>Export Proof</h3>
									<p className="field-hint">
										Tracer produces the artifact on the server, deterministically, from the loaded proof. It exposes no request bodies or
										secrets.
									</p>
									<div className="recorder-actions">
										<button className="primary-button" disabled={busy === "export"} type="button" onClick={() => exportLoaded()}>
											<MaterialIcon size={17}>download</MaterialIcon>
											{busy === "export" ? "Exporting…" : "Export Proof"}
										</button>
									</div>
								</section>
							)}
							{importResult && (
								<section className="recorder-card">
									<h3>Import result</h3>
									<p className="field-hint">
										{importResult.executed ? "Executed" : "Not executed"} · {importResult.autoSend ? "auto-send on" : "no auto-send"} ·{" "}
										{importResult.autoSave ? "auto-save on" : "no auto-save"} · {importResult.persisted ? "persisted" : "not persisted"} ·{" "}
										{importResult.upgraded ? "state upgraded" : "state unchanged"}
									</p>
								</section>
							)}
						</div>
					)}
					{!hasProof && tab !== "import" && (
						<p className="kv-empty">
							No proof is loaded. Open the Import &amp; Verify section to inspect an artifact.
						</p>
					)}
				</div>

				<footer>
					<button className="primary-button" disabled={!hasProof || busy === "export"} type="button" onClick={exportLoaded}>
						<MaterialIcon size={17}>download</MaterialIcon>
						Export Proof
					</button>
					<button type="button" onClick={onClose}>
						Close
					</button>
				</footer>
			</section>
		</Modal>
	);
}
