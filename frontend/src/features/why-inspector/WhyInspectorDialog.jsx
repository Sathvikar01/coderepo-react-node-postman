import { useEffect, useRef, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { useRovingTabs } from "../../shared/hooks/useRovingTabs.js";
import { whyInspectorApi } from "./why-inspector.api.js";
import {
	configurationGroups,
	evidenceKindLabel,
	hasRecordedChange,
	isExplanation,
	precedenceLadder,
	sectionStateLabel,
	sectionStateTone,
	variableRows,
	verificationBasisLabel,
	verificationTone,
	WHY_TABS,
	whyErrorMessage,
} from "./why-inspector-model.js";
import "./why-inspector.css";

// Phase 49 — "Why?" Inspector dialog.
//
// Presentation only. It fetches one backend projection and renders exactly what
// the backend returned:
//
//   * It never derives variable precedence, impact, drift, contract
//     compatibility, a verification state, or a proof.
//   * It never resolves a secret. The projection only carries references.
//   * It fails closed: a section with no recorded evidence says so explicitly.
//
// The dialog is read-only. There is no send, save, or mutate action, because an
// explanation describes evidence that already exists.

function AvailabilityChip({ state }) {
	return <span className={`why-chip ${sectionStateTone(state)}`}>{sectionStateLabel(state)}</span>;
}

function GapList({ gaps }) {
	if (!gaps || gaps.length === 0) return null;
	return (
		<ul className="why-gaps">
			{gaps.map((gap) => (
				<li key={`${gap.code}:${gap.detail}`}>
					<code>{gap.code}</code>
					<span>{gap.detail}</span>
				</li>
			))}
		</ul>
	);
}

function EmptySection({ title, note }) {
	return (
		<div className="why-empty" role="status">
			<MaterialIcon size={18}>info</MaterialIcon>
			<div>
				<strong>{title}</strong>
				<p>{note}</p>
			</div>
		</div>
	);
}

function VerificationCard({ verification }) {
	const tone = verificationTone(verification.state);
	return (
		<section className={`why-card why-verification ${tone}`}>
			<div className="why-card-head">
				<h3>Verification result</h3>
				<span className={`why-state-pill ${tone}`}>{verification.state}</span>
			</div>
			<p className="why-basis">
				State basis: <strong>{verificationBasisLabel(verification.stateBasis)}</strong> <code>{verification.stateBasis}</code>
			</p>
			{verification.reasons?.length > 0 && (
				<ul className="why-reasons">
					{verification.reasons.map((reason) => (
						<li key={`${reason.code}:${reason.text}`}>
							<code>{reason.code}</code>
							<span>{reason.text}</span>
						</li>
					))}
				</ul>
			)}
			<p className="why-caveat">{verification.caveat}</p>
		</section>
	);
}

function ConfigurationPanel({ explanation }) {
	const { configuration, dependencies, verification } = explanation;
	const groups = configurationGroups(configuration.entries);
	const ladder = precedenceLadder(dependencies.precedence);
	const variables = variableRows(dependencies);

	return (
		<div className="why-stack">
			<VerificationCard verification={verification} />

			<section className="why-card">
				<div className="why-card-head">
					<h3>Effective configuration</h3>
					<AvailabilityChip state={configuration.state} />
				</div>
				{groups.length === 0 ? (
					<EmptySection title="No configuration evidence" note="This execution recorded no configuration to explain." />
				) : (
					groups.map((group) => (
						<div className="why-group" key={group.group}>
							<h4>{group.label}</h4>
							<dl className="why-kv">
								{group.entries.map((entry) => (
									<div className="why-kv-row" key={entry.id}>
										<dt>{entry.label}</dt>
										<dd className={entry.valueKind === "url" || entry.valueKind === "address" ? "mono" : ""} title={entry.value ?? ""}>
											{entry.value ?? "—"}
										</dd>
									</div>
								))}
							</dl>
						</div>
					))
				)}
				{configuration.truncated && <p className="field-hint">More configuration entries were recorded than are shown.</p>}
				<GapList gaps={configuration.gaps} />
			</section>

			<section className="why-card">
				<div className="why-card-head">
					<h3>Dependencies &amp; precedence</h3>
					<AvailabilityChip state={dependencies.state} />
				</div>
				<p className="field-hint">{dependencies.precedence.note}</p>
				{ladder.length > 0 && (
					<ol className="why-ladder">
						{ladder.map((step) => (
							<li className={step.applied ? "applied" : ""} key={step.scope}>
								<span className="why-ladder-rank">{step.rank}</span>
								<span className="why-ladder-label">{step.label}</span>
								<span className="why-ladder-scope mono">{step.scope}</span>
								<span className={`why-chip ${step.applied ? "success" : "neutral"}`}>
									{step.applied ? "Contributed" : "No value used"}
								</span>
							</li>
						))}
					</ol>
				)}
				{variables.length === 0 ? (
					<EmptySection title="No variable references" note="Nothing was interpolated from a scope for this execution." />
				) : (
					<table className="why-table">
						<thead>
							<tr>
								<th scope="col">Field</th>
								<th scope="col">Variable</th>
								<th scope="col">Scope</th>
								<th scope="col">Precedence</th>
							</tr>
						</thead>
						<tbody>
							{variables.map((variable, index) => (
								<tr key={`${variable.field}:${variable.key}:${variable.scope}:${index}`}>
									<td className="mono">{variable.field}</td>
									<td className="mono">{variable.key}</td>
									<td>{variable.scopeText}</td>
									<td>{variable.precedenceText}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{dependencies.truncated && <p className="field-hint">More variable references were recorded than are shown.</p>}
				{dependencies.references?.length > 0 && (
					<>
						<h4>Source references</h4>
						<ul className="why-references">
							{dependencies.references.map((reference) => (
								<li key={`${reference.kind}:${reference.ref}`}>
									<strong>{reference.kind}</strong> · {reference.label}
									{reference.revision !== null && reference.revision !== undefined && (
										<span className="field-hint">
											{" "}
											— recorded revision {reference.revision}
											{reference.currentRevision !== null && reference.currentRevision !== undefined
												? `, current ${reference.currentRevision}`
												: ""}
										</span>
									)}
								</li>
							))}
						</ul>
					</>
				)}
				<GapList gaps={dependencies.gaps} />
			</section>
		</div>
	);
}

function ExecutionPanel({ explanation }) {
	const { execution } = explanation;
	return (
		<div className="why-stack">
			<section className="why-card">
				<div className="why-card-head">
					<h3>Execution pipeline</h3>
					<AvailabilityChip state={execution.state} />
				</div>
				<div className="why-summary-grid">
					<div>
						<span>Outcome</span>
						<strong>{execution.outcome ?? "—"}</strong>
					</div>
					<div>
						<span>Effect certainty</span>
						<strong>{execution.effectCertainty ?? "—"}</strong>
					</div>
				</div>
				{execution.stages.length === 0 ? (
					<EmptySection title="No pipeline evidence" note="No execution receipt was recorded, so no stage can be explained." />
				) : (
					<ol className="why-stages">
						{execution.stages.map((stage) => (
							<li className={stage.state} key={stage.id}>
								<div className="why-stage-head">
									<span className="why-stage-marker" aria-hidden="true" />
									<strong>{stage.label}</strong>
									<span className={`why-chip ${stage.state === "recorded" ? "success" : "neutral"}`}>
										{stage.state === "recorded" ? "Recorded" : "Not recorded"}
									</span>
								</div>
								<p>{stage.summary}</p>
								{stage.evidence?.length > 0 && (
									<div className="why-stage-evidence">
										{stage.evidence.map((item) => (
											<span key={`${item.kind}:${item.ref}`} title={item.ref}>
												{evidenceKindLabel(item.kind)}: <code>{String(item.ref).slice(0, 16)}…</code>
											</span>
										))}
									</div>
								)}
							</li>
						))}
					</ol>
				)}
				<GapList gaps={execution.gaps} />
			</section>

			{execution.error && (
				<section className="why-card why-danger">
					<div className="why-card-head">
						<h3>Recorded error</h3>
						<code>{execution.error.code}</code>
					</div>
					<p>{execution.error.message}</p>
				</section>
			)}

			{execution.warnings?.length > 0 && (
				<section className="why-card">
					<h3>Warnings</h3>
					<ul className="why-reasons">
						{execution.warnings.map((warning) => (
							<li key={`${warning.code}:${warning.message}`}>
								<code>{warning.code}</code>
								<span>{warning.message}</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

function ChangePanel({ explanation }) {
	const { change } = explanation;
	if (!hasRecordedChange(change)) {
		return (
			<div className="why-stack">
				<EmptySection title="No change evidence recorded" note={change.reason ?? "No persisted change analysis references this execution."} />
				{change.hint && <p className="field-hint">{change.hint}</p>}
				<section className="why-card">
					<h3>How to record change evidence</h3>
					<p className="field-hint">
						Change evidence is only ever composed from a persisted analysis that names this execution. Tracer does not infer what changed from
						the request alone.
					</p>
				</section>
			</div>
		);
	}

	return (
		<div className="why-stack">
			{change.comparisons.map((comparison) => (
				<section className="why-card" key={comparison.investigationId}>
					<div className="why-card-head">
						<h3>Change analysis</h3>
						<span className="why-chip neutral">{comparison.status ?? "completed"}</span>
					</div>
					{comparison.summary && <p>{comparison.summary}</p>}
					{comparison.firstDivergence ? (
						<div className="why-first-divergence">
							<h4>First meaningful divergence</h4>
							<p>{comparison.firstDivergence.message}</p>
							<p className="field-hint mono">
								{comparison.firstDivergence.category} · {comparison.firstDivergence.path}
							</p>
						</div>
					) : (
						<p className="field-hint">No first divergence was recorded for this analysis.</p>
					)}

					<h4>Verified causes</h4>
					{comparison.verifiedCauses.length === 0 ? (
						<p className="field-hint">No change was verified as the cause by experiment.</p>
					) : (
						<ul className="why-reasons">
							{comparison.verifiedCauses.map((cause) => (
								<li key={`${cause.path}:${cause.label}`}>
									<strong>{cause.label}</strong>
									<span className="mono">{cause.path}</span>
									<span className="field-hint">{cause.executionIds.length} probe execution(s)</span>
								</li>
							))}
						</ul>
					)}
					{comparison.unverifiedChangeCount > 0 && (
						<p className="field-hint">
							{comparison.unverifiedChangeCount} correlated change{comparison.unverifiedChangeCount === 1 ? "" : "s"} were recorded but not
							proven causal.
						</p>
					)}

					{comparison.changes.length > 0 && (
						<>
							<h4>Recorded changes</h4>
							<table className="why-table">
								<thead>
									<tr>
										<th scope="col">Category</th>
										<th scope="col">Path</th>
										<th scope="col">Change</th>
									</tr>
								</thead>
								<tbody>
									{comparison.changes.map((item, index) => (
										<tr key={`${item.category}:${item.path}:${index}`}>
											<td>{item.category}</td>
											<td className="mono">{item.path}</td>
											<td>{item.message}</td>
										</tr>
									))}
								</tbody>
							</table>
							{comparison.changesTruncated && <p className="field-hint">More changes were recorded than are shown.</p>}
						</>
					)}

					{comparison.regressionBoundary && (
						<p className="field-hint">
							Regression boundary {comparison.regressionBoundary.resolved ? "resolved" : "unresolved"}
							{comparison.regressionBoundary.reason ? ` — ${comparison.regressionBoundary.reason}` : ""}
						</p>
					)}
					{comparison.reproducibility?.statement && <p className="field-hint">{comparison.reproducibility.statement}</p>}
				</section>
			))}
			{change.truncated && <p className="field-hint">More change analyses reference this execution than are shown.</p>}
		</div>
	);
}

function EvidencePanel({ explanation }) {
	const { evidence } = explanation;
	return (
		<div className="why-stack">
			<section className="why-card">
				<h3>Evidence chain</h3>
				<p className="field-hint">
					Every node below is a reference to recorded evidence. Secret values, credentials, cookies, and bodies are never part of an
					explanation.
				</p>
				{evidence.chain.length === 0 ? (
					<EmptySection title="No evidence recorded" note="Nothing was recorded for this execution, so there is no chain to show." />
				) : (
					<ol className="why-chain">
						{evidence.chain.map((node) => (
							<li className={node.available ? "" : "unavailable"} key={`${node.order}:${node.kind}`}>
								<span className="why-chain-order">{node.order}</span>
								<div>
									<strong>{node.label}</strong>
									<span className="why-chip neutral">{evidenceKindLabel(node.kind)}</span>
									{node.detail && <p>{node.detail}</p>}
									{node.ref ? (
										<code title={node.ref}>{String(node.ref).slice(0, 24)}…</code>
									) : (
										<code className="why-unavailable">Not available</code>
									)}
								</div>
							</li>
						))}
					</ol>
				)}
				{evidence.truncated && <p className="field-hint">More evidence nodes were recorded than are shown.</p>}
			</section>

			<section className="why-card">
				<h3>Projection metadata</h3>
				<dl className="why-kv">
					<div className="why-kv-row">
						<dt>Question</dt>
						<dd>{explanation.question}</dd>
					</div>
					<div className="why-kv-row">
						<dt>Execution</dt>
						<dd className="mono" title={explanation.executionId ?? ""}>
							{explanation.executionId ?? "—"}
						</dd>
					</div>
					<div className="why-kv-row">
						<dt>Envelope</dt>
						<dd className="mono">
							{explanation.kind} v{explanation.schemaVersion}
						</dd>
					</div>
					<div className="why-kv-row">
						<dt>Generated</dt>
						<dd>{explanation.generatedAt}</dd>
					</div>
				</dl>
			</section>
		</div>
	);
}

export function WhyInspectorDialog({ executionId, onClose, onInvestigate, onOpenPassport }) {
	const [tab, setTab] = useState("configuration");
	const [explanation, setExplanation] = useState(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const requestToken = useRef(0);
	const tabs = useRovingTabs();

	useEffect(() => {
		const token = requestToken.current + 1;
		requestToken.current = token;
		setLoading(true);
		setError("");
		whyInspectorApi
			.explainExecution(executionId)
			.then((value) => {
				if (requestToken.current !== token) return;
				if (!isExplanation(value)) {
					setError("Tracer returned an explanation this view does not understand. Nothing is shown rather than guessing.");
					setExplanation(null);
					return;
				}
				setExplanation(value);
			})
			.catch((caught) => {
				if (requestToken.current === token) setError(whyErrorMessage(caught));
			})
			.finally(() => {
				if (requestToken.current === token) setLoading(false);
			});
		return () => {
			requestToken.current += 1;
		};
	}, [executionId]);

	const availability = explanation?.availability ?? {};

	return (
		<Modal className="why-modal" label="Why this request?" onClose={onClose}>
			<section className="form-dialog why-dialog">
				<header className="recorder-header">
					<div>
						<p className="eyebrow">Explainability</p>
						<h2>Why?</h2>
						<p className="field-hint why-headline-hint">
							Why did this request execute this way, and why did Tracer reach this result? Every value below is a recorded fact or an explicit
							&ldquo;not recorded&rdquo;.
						</p>
					</div>
					<div className="why-header-actions">
						{onOpenPassport && (
							<button className="text-button" type="button" onClick={() => onOpenPassport(executionId)}>
								<MaterialIcon size={16}>description</MaterialIcon>
								Passport
							</button>
						)}
						{onInvestigate && (
							<button className="text-button" type="button" onClick={() => onInvestigate(executionId)}>
								<MaterialIcon size={16}>search</MaterialIcon>
								Investigate
							</button>
						)}
						<button aria-label="Close Why Inspector" className="icon-button" type="button" onClick={onClose}>
							<MaterialIcon>close</MaterialIcon>
						</button>
					</div>
				</header>

				{loading && <p className="kv-empty" role="status">Reading recorded evidence…</p>}

				{!loading && error && (
					<p className="dialog-error" role="alert">
						{error}
					</p>
				)}

				{!loading && !error && explanation && (
					<>
						<div
							aria-label="Why Inspector sections"
							className="code-formats"
							onKeyDown={tabs.onKeyDown}
							ref={tabs.listRef}
							role="tablist"
						>
							{WHY_TABS.map((item) => (
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
									{availability[item.id] && (
										<span className={`why-tab-dot ${sectionStateTone(availability[item.id].state)}`} aria-hidden="true" />
									)}
									<span className="sr-only"> — {sectionStateLabel(availability[item.id]?.state)}</span>
								</button>
							))}
						</div>

						{!explanation.recorded && (
							<EmptySection
								title="No execution record"
								note={explanation.reason ?? "No execution record exists for this identifier in this profile."}
							/>
						)}

						<div className="recorder-content why-content" role="tabpanel">
							{explanation.recorded && tab === "configuration" && <ConfigurationPanel explanation={explanation} />}
							{explanation.recorded && tab === "execution" && <ExecutionPanel explanation={explanation} />}
							{explanation.recorded && tab === "change" && <ChangePanel explanation={explanation} />}
							{explanation.recorded && tab === "evidence" && <EvidencePanel explanation={explanation} />}
							{!explanation.recorded && tab === "evidence" && <EvidencePanel explanation={explanation} />}
						</div>
					</>
				)}

				<footer>
					<button type="button" onClick={onClose}>
						Close
					</button>
				</footer>
			</section>
		</Modal>
	);
}
