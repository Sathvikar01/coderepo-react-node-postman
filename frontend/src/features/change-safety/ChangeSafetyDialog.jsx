import { useEffect, useMemo, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { SelectMenu } from "../../shared/components/SelectMenu.jsx";
import { versionsApi } from "../versions/versions.api.js";
import { changeSafetyApi } from "./change-safety.api.js";
import "./change-safety.css";

function countOf(value) {
	return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function impactLabel(result, index) {
	const change = result?.change ?? {};
	const target = change.requestId || change.key || change.folderId || change.collectionId || change.field || "workspace";
	const category = String(change.category || change.kind || change.type || "change").replaceAll("_", " ").toLowerCase();
	return `${index + 1}. ${category} · ${target}`;
}

function Stage({ icon, title, status, detail, tone = "" }) {
	return (
		<div className={`change-safety-stage ${tone}`}>
			<span className="change-safety-stage-icon"><MaterialIcon size={18}>{icon}</MaterialIcon></span>
			<div>
				<span>{title}</span>
				<strong>{status}</strong>
				<small>{detail}</small>
			</div>
		</div>
	);
}

export function ChangeSafetyDialog({
	activeCollectionId,
	activeEnvironmentId,
	canExecute,
	collections,
	environments,
	onClose,
	onProofGenerated,
}) {
	const initialCollectionId = activeCollectionId || collections[0]?._id || "";
	const initialSource = activeEnvironmentId || environments[0]?._id || "";
	const initialTarget = environments.find((item) => item._id !== initialSource)?._id || "";

	const [collectionId, setCollectionId] = useState(initialCollectionId);
	const [sourceEnvironmentId, setSourceEnvironmentId] = useState(initialSource);
	const [targetEnvironmentId, setTargetEnvironmentId] = useState(initialTarget);
	const [versions, setVersions] = useState([]);
	const [baselineRevision, setBaselineRevision] = useState("");
	const [changeIndex, setChangeIndex] = useState(0);
	const [allowMutating, setAllowMutating] = useState(false);
	const [analysis, setAnalysis] = useState(null);
	const [result, setResult] = useState(null);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");

	const currentCollection = collections.find((item) => item._id === collectionId) ?? null;
	const currentRevision = Number(currentCollection?.revision ?? 0);

	useEffect(() => {
		let active = true;
		setVersions([]);
		setBaselineRevision("");
		setAnalysis(null);
		setResult(null);
		setError("");
		if (!collectionId) return () => {
			active = false;
		};
		versionsApi.collection
			.list(collectionId)
			.then((rows) => {
				if (!active) return;
				const sorted = [...(rows ?? [])].sort((a, b) => Number(b.revision) - Number(a.revision));
				setVersions(sorted);
				const previous = sorted.find((entry) => Number(entry.revision) < currentRevision) ?? sorted[sorted.length - 1] ?? null;
				if (previous) setBaselineRevision(String(previous.revision));
			})
			.catch((caught) => {
				if (active) setError(caught.message);
			});
		return () => {
			active = false;
		};
	}, [collectionId, currentRevision]);

	useEffect(() => {
		if (!sourceEnvironmentId) return;
		if (targetEnvironmentId && targetEnvironmentId !== sourceEnvironmentId) return;
		setTargetEnvironmentId(environments.find((item) => item._id !== sourceEnvironmentId)?._id || "");
	}, [sourceEnvironmentId, targetEnvironmentId, environments]);

	const collectionOptions = collections.map((item) => ({
		value: item._id,
		label: item.name,
		hint: `current revision v${item.revision}`,
	}));
	const sourceOptions = environments.map((item) => ({
		value: item._id,
		label: item.name,
		hint: `revision v${item.revision}`,
	}));
	const targetOptions = environments
		.filter((item) => item._id !== sourceEnvironmentId)
		.map((item) => ({
			value: item._id,
			label: item.name,
			hint: `revision v${item.revision}`,
		}));
	const baselineOptions = versions.map((item) => ({
		value: String(item.revision),
		label: `Revision v${item.revision}`,
		hint: Number(item.revision) === currentRevision ? "current saved revision" : item.actorName || "saved version",
	}));
	const changeOptions = (analysis?.impactDiff?.changes ?? []).map((item, index) => ({
		value: String(index),
		label: impactLabel(item, index),
	}));

	const payload = () => ({
		collectionId,
		baselineRevision: Number(baselineRevision),
		sourceEnvironmentId,
		targetEnvironmentId,
		changeIndex,
		allowMutating,
	});

	const validSelection =
		Boolean(collectionId && baselineRevision && sourceEnvironmentId && targetEnvironmentId) &&
		sourceEnvironmentId !== targetEnvironmentId;

	const analyze = async (nextChangeIndex = changeIndex) => {
		if (!validSelection) return;
		setBusy("analyze");
		setError("");
		setResult(null);
		try {
			const next = await changeSafetyApi.analyze({ ...payload(), changeIndex: nextChangeIndex });
			setAnalysis(next);
			setChangeIndex(next.selection?.changeIndex ?? nextChangeIndex);
		} catch (caught) {
			setError(caught.message);
		} finally {
			setBusy("");
		}
	};

	const run = async () => {
		if (!analysis?.canRun || !canExecute) return;
		setBusy("run");
		setError("");
		try {
			const next = await changeSafetyApi.run(payload());
			setResult(next);
			setAnalysis(next);
		} catch (caught) {
			setError(caught.message);
		} finally {
			setBusy("");
		}
	};

	const impact = analysis?.selectedImpact;
	const direct = countOf(impact?.summary?.directRequests);
	const indirect = countOf(impact?.summary?.indirectRequests);
	const driftCount = countOf(analysis?.drift?.summary?.total);
	const executable = countOf(analysis?.plan?.summary?.executable);
	const contractPublished = countOf(analysis?.contracts?.published);
	const contractMissing = countOf(analysis?.contracts?.missing);
	const proof = result?.proof ?? null;
	const proofState = proof?.state ?? "Not generated";
	const runState = result?.rehearsal?.run?.runState ?? result?.rehearsal?.run?.state ?? "Not run";
	const changes = analysis?.impactDiff?.changes ?? [];
	const blockers = analysis?.blockers ?? [];
	const canAnalyze = validSelection && !busy;

	const workflowComplete = Boolean(proof);
	const mutationBlocked = blockers.some((item) => item.code === "NO_EXECUTABLE_REHEARSAL") && !allowMutating;

	return (
		<Modal className="change-safety-modal" label="Change Safety" onClose={onClose}>
			<section className="form-dialog change-safety-dialog">
				<header className="change-safety-header">
					<div>
						<p className="eyebrow">Change safety</p>
						<h2>Verify a saved API change</h2>
						<p className="field-hint">
							Tracer compares saved revisions, finds impact and environment drift, rehearses the affected requests through the normal backend execution path, checks published response contracts, and mints the resulting Verification Proof.
						</p>
					</div>
					<button aria-label="Close Change Safety" className="icon-button" type="button" onClick={onClose}>
						<MaterialIcon>close</MaterialIcon>
					</button>
				</header>

				<div className="change-safety-picker-grid">
					<label>
						<span>Collection</span>
						<SelectMenu ariaLabel="Change Safety collection" options={collectionOptions} value={collectionId} onChange={setCollectionId} />
					</label>
					<label>
						<span>Baseline revision</span>
						<SelectMenu
							ariaLabel="Baseline revision"
							disabled={versions.length === 0}
							options={baselineOptions.length > 0 ? baselineOptions : [{ value: "", label: "No saved versions" }]}
							value={baselineRevision}
							onChange={(value) => {
								setBaselineRevision(value);
								setAnalysis(null);
								setResult(null);
							}}
						/>
					</label>
					<label>
						<span>Source environment</span>
						<SelectMenu ariaLabel="Source environment" options={sourceOptions} value={sourceEnvironmentId} onChange={(value) => {
							setSourceEnvironmentId(value);
							setAnalysis(null);
							setResult(null);
						}} />
					</label>
					<label>
						<span>Target environment</span>
						<SelectMenu
							ariaLabel="Target environment"
							disabled={targetOptions.length === 0}
							options={targetOptions.length > 0 ? targetOptions : [{ value: "", label: "No other environment" }]}
							value={targetEnvironmentId}
							onChange={(value) => {
								setTargetEnvironmentId(value);
								setAnalysis(null);
								setResult(null);
							}}
						/>
					</label>
				</div>

				<div className="change-safety-actions">
					<button className="primary-button" disabled={!canAnalyze} type="button" onClick={() => analyze()}>
						<MaterialIcon size={17}>account_tree</MaterialIcon>
						{busy === "analyze" ? "Analyzing…" : "Analyze saved change"}
					</button>
					<label className="change-safety-mutation-toggle">
						<input
							checked={allowMutating}
							type="checkbox"
							onChange={(event) => {
								setAllowMutating(event.target.checked);
								setAnalysis(null);
								setResult(null);
							}}
						/>
						<span>Allow mutating requests in this rehearsal</span>
					</label>
				</div>

				{error && <p className="dialog-error" role="alert">{error}</p>}
				{!canExecute && (
					<p className="status-banner warning" role="status">
						<MaterialIcon size={16}>visibility</MaterialIcon>
						Your workspace role can analyze this change, but cannot execute a rehearsal.
					</p>
				)}

				{analysis && (
					<div className="change-safety-results">
						{changes.length > 1 && (
							<label className="change-safety-change-picker">
								<span>Detected change to verify</span>
								<SelectMenu
									ariaLabel="Detected change"
									options={changeOptions}
									value={String(changeIndex)}
									onChange={(value) => {
										const nextIndex = Number(value);
										setChangeIndex(nextIndex);
										analyze(nextIndex);
									}}
								/>
								<small>Each Phase 39 change keeps its own provenance. Tracer rehearses the selected change rather than merging unrelated impact claims in the browser.</small>
							</label>
						)}

						<div className="change-safety-stages" aria-label="Change verification stages">
							<Stage
								icon="account_tree"
								title="Impact"
								status={impact ? `${direct + indirect} affected` : "No change"}
								detail={impact ? `${direct} direct · ${indirect} indirect · ${countOf(impact.summary?.unknownReferences)} unknown references` : "Choose two distinct saved revisions."}
								tone={impact ? "ready" : ""}
							/>
							<Stage
								icon="difference"
								title="Environment drift"
								status={`${driftCount} finding${driftCount === 1 ? "" : "s"}`}
								detail={analysis.drift?.identical ? "Source and target effective environment state match." : "Backend-computed effective environment differences."}
								tone={driftCount > 0 ? "warning" : "ready"}
							/>
							<Stage
								icon="science"
								title="Rehearsal"
								status={result ? runState : `${executable} executable`}
								detail={result ? `${countOf(result.rehearsal?.executedStepIds?.length)} step(s) executed` : "Plan and safety policy are backend-owned."}
								tone={result ? "ready" : analysis.canRun ? "ready" : "warning"}
							/>
							<Stage
								icon="fact_check"
								title="Contract"
								status={`${contractPublished} published`}
								detail={`${contractMissing} affected request(s) have no published contract; missing evidence never becomes a pass.`}
								tone={contractMissing > 0 ? "warning" : "ready"}
							/>
							<Stage
								icon="verified"
								title="Proof"
								status={proofState}
								detail={proof ? `Proof ${proof.proofId}` : "Run the rehearsal to generate a backend verification result and proof."}
								tone={workflowComplete ? (proofState === "VERIFIED" ? "ready" : "warning") : ""}
							/>
						</div>

						{blockers.length > 0 && (
							<section className="change-safety-blockers" aria-label="Analysis blockers">
								<h3>Before rehearsal</h3>
								{blockers.map((item) => (
									<p key={item.code}><strong>{item.code.replaceAll("_", " ")}</strong> — {item.message}</p>
								))}
								{mutationBlocked && <p className="field-hint">If the affected request is intentionally mutating, enable the explicit rehearsal toggle above and analyze again.</p>}
							</section>
						)}

						<div className="change-safety-run-row">
							<button
								className="primary-button"
								disabled={!analysis.canRun || !canExecute || Boolean(busy)}
								type="button"
								onClick={run}
							>
								<MaterialIcon size={17}>play_arrow</MaterialIcon>
								{busy === "run" ? "Rehearsing & verifying…" : "Run rehearsal & generate proof"}
							</button>
							{proof && (
								<button type="button" onClick={() => onProofGenerated?.(proof)}>
									<MaterialIcon size={17}>verified</MaterialIcon>
									Open Verification Proof
								</button>
							)}
						</div>
					</div>
				)}

				<footer>
					<span className="field-hint">React displays the result; Impact, Drift, Rehearsal, Contract, Verification, and Proof authority stays on the backend.</span>
					<button type="button" onClick={onClose}>Close</button>
				</footer>
			</section>
		</Modal>
	);
}
