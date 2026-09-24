// Phase 49 — Effective Configuration / "Why?" Inspector: pure projection.
//
// `buildWhyExplanation` is deterministic and side-effect free: identical inputs
// always produce an identical envelope. It reads only evidence that was already
// recorded and already redacted at write time:
//
//   * the persisted execution history record (including its execution receipt),
//   * the compile trace produced by the request compiler,
//   * profile-scoped collection / environment summaries,
//   * persisted investigations linked to the execution.
//
// It never resolves a variable value, never reads a credential, never re-runs a
// policy decision, and never upgrades a verification state. Where evidence is
// missing it fails closed with an explicit reason code instead of a blank.
import {
	EXECUTION_STAGES,
	SECTION_STATES,
	VARIABLE_SCOPE_LABEL,
	VARIABLE_SCOPE_ORDER,
	VERIFICATION_STATE_BASIS,
	WHY_CAVEAT,
	WHY_EXPLANATION_KIND,
	WHY_EXPLANATION_SCHEMA_VERSION,
	WHY_LIMITS,
	WHY_QUESTION,
	WHY_REASON,
	WHY_SECTIONS,
} from "./why-schema.js";

function iso(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function text(value, max = WHY_LIMITS.maxTextBytes) {
	if (value === null || value === undefined) return null;
	const raw = String(value);
	if (raw.length <= max) return raw;
	return `${raw.slice(0, max - 1)}…`;
}

function idOf(value) {
	if (value === null || value === undefined) return null;
	const raw = String(value);
	return raw.length > 0 ? raw : null;
}

function numberOrNull(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Bounded slice that reports truncation instead of dropping data silently. */
function bounded(list, max) {
	const items = Array.isArray(list) ? list : [];
	if (items.length <= max) return { items, truncated: false };
	return { items: items.slice(0, max), truncated: true };
}

function scopeIndex(scope) {
	const index = VARIABLE_SCOPE_ORDER.indexOf(scope);
	return index === -1 ? null : index;
}

function scopeLabel(scope) {
	return VARIABLE_SCOPE_LABEL[scope] ?? (scope ? `Unknown scope (${scope})` : "Unknown scope");
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

function configurationSection({ record, receipt, related }) {
	const request = record?.request ?? {};
	const source = receipt?.source ?? {};
	const policy = receipt?.policy ?? {};
	const target = receipt?.target ?? {};
	const transport = receipt?.transport ?? null;
	const persistence = record?.persistence ?? null;
	const settings = request.settings ?? {};
	const collection = related.collection ?? null;
	const environment = related.environment ?? null;

	const entries = [];
	const push = (group, id, label, value, valueKind = "text", extra = {}) => {
		if (value === null || value === undefined || value === "") return;
		entries.push({ id: `${group}.${id}`, group, label, value: text(value), valueKind, ...extra });
	};

	push("request", "name", "Request name", request.name ?? "Untitled");
	push("request", "method", "Method", request.method);
	push("request", "url", "Authored URL", receipt?.request?.displayUrl ?? record?.snapshot?.displayUrl, "url");
	push("request", "executedUrl", "Executed URL", receipt?.request?.executedUrl, "url");
	push("request", "bodyMode", "Body mode", receipt?.request?.body?.mode ?? request.body?.mode);
	if (numberOrNull(receipt?.request?.body?.sizeBytes) !== null)
		push("request", "bodySize", "Compiled body size", `${receipt.request.body.sizeBytes} bytes`);
	push("request", "timeout", "Timeout", numberOrNull(settings.timeoutMs) !== null ? `${settings.timeoutMs} ms` : null);

	push("target", "hostname", "Hostname", target.hostname);
	push("target", "port", "Port", numberOrNull(target.port) !== null ? String(target.port) : null);
	push("target", "address", "Resolved address", target.address, "address");
	push("target", "family", "Address family", target.family ? `IPv${target.family}` : null);
	push("target", "scheme", "Scheme", target.scheme);

	push("auth", "mode", "Auth mode", receipt?.request?.auth?.mode ?? request.auth?.mode ?? "none");
	push("auth", "source", "Auth source", receipt?.request?.auth?.source);
	push("auth", "references", "Credential references", (receipt?.request?.auth?.referenceKeys ?? []).join(", "));

	push("policy", "decision", "Policy decision", policy.decision);
	push("policy", "local", "Local target allowed", policy.local === true ? "Yes" : "No");
	push("policy", "version", "Policy version", policy.version);

	push("timing", "startedAt", "Started", iso(record?.startedAt), "timestamp");
	push("timing", "finishedAt", "Finished", iso(record?.finishedAt), "timestamp");
	push(
		"timing",
		"duration",
		"Duration",
		numberOrNull(transport?.durationMs) !== null ? `${Math.round(transport.durationMs)} ms` : null,
	);

	push("source", "collection", "Collection", collection?.name ?? source.collectionId, "reference");
	push("source", "collectionRevision", "Collection revision", source.collectionRevision, "count");
	push("source", "environment", "Environment", environment?.name ?? source.environmentId, "reference");
	push("source", "environmentRevision", "Environment revision", source.environmentRevision, "count");
	push("source", "sourceType", "Request source", source.type);

	push("persistence", "state", "Persistence", persistence?.state);

	const boundedEntries = bounded(entries, WHY_LIMITS.maxConfigurationEntries);
	const gaps = [];
	if (entries.length === 0) {
		gaps.push({ code: WHY_REASON.CONFIGURATION_NOT_RECORDED, detail: "No configuration evidence was recorded for this execution." });
	}
	if (!collection && !environment && !source.collectionId && !source.environmentId) {
		gaps.push({
			code: WHY_REASON.NO_SOURCE_REFERENCE,
			detail: "This execution ran from a scratch request, so no collection or environment was referenced.",
		});
	}
	if (collection && source.collectionRevision !== null && source.collectionRevision !== undefined && collection.revision !== source.collectionRevision) {
		gaps.push({
			code: WHY_REASON.SOURCE_REVISION_CHANGED,
			detail: `The collection has changed since this execution (recorded revision ${source.collectionRevision}, current revision ${collection.revision}).`,
		});
	}
	if (environment && source.environmentRevision !== null && source.environmentRevision !== undefined && environment.revision !== source.environmentRevision) {
		gaps.push({
			code: WHY_REASON.SOURCE_REVISION_CHANGED,
			detail: `The environment has changed since this execution (recorded revision ${source.environmentRevision}, current revision ${environment.revision}).`,
		});
	}

	return {
		state: gaps.length === 0 ? "recorded" : entries.length > 0 ? "partial" : "not_recorded",
		entries: boundedEntries.items,
		truncated: boundedEntries.truncated,
		gaps,
	};
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

function dependencySection({ record, receipt, related }) {
	const rawSources = Array.isArray(receipt?.request?.variableSources)
		? receipt.request.variableSources
		: Array.isArray(record?.compileTrace)
			? record.compileTrace
			: [];

	const seen = new Set();
	const variables = [];
	for (const entry of rawSources) {
		const field = text(entry?.field ?? "", 200) ?? "";
		const key = text(entry?.variable ?? entry?.key ?? "", 200) ?? "";
		const scope = text(entry?.scope ?? "", 80) ?? "";
		if (!key) continue;
		const dedupeKey = `${field}\u0000${key}\u0000${scope}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		variables.push({
			field: field || "unknown",
			key,
			scope: scope || "unknown",
			scopeLabel: scopeLabel(scope),
			precedence: scopeIndex(scope),
		});
	}
	variables.sort((left, right) => {
		const leftIndex = left.precedence ?? Number.MAX_SAFE_INTEGER;
		const rightIndex = right.precedence ?? Number.MAX_SAFE_INTEGER;
		if (leftIndex !== rightIndex) return leftIndex - rightIndex;
		if (left.field !== right.field) return left.field.localeCompare(right.field);
		return left.key.localeCompare(right.key);
	});
	const boundedVariables = bounded(variables, WHY_LIMITS.maxVariables);

	const source = receipt?.source ?? {};
	const references = [];
	if (source.collectionId) {
		references.push({
			kind: "collection",
			ref: idOf(source.collectionId),
			label: related.collection?.name ?? "Collection",
			revision: source.collectionRevision ?? null,
			currentRevision: related.collection?.revision ?? null,
		});
	}
	if (source.environmentId) {
		references.push({
			kind: "environment",
			ref: idOf(source.environmentId),
			label: related.environment?.name ?? "Environment",
			revision: source.environmentRevision ?? null,
			currentRevision: related.environment?.revision ?? null,
		});
	}
	const authMode = receipt?.request?.auth?.mode ?? null;
	if (authMode && authMode !== "none") {
		references.push({
			kind: "auth",
			ref: authMode,
			label: `Auth: ${authMode} (${receipt?.request?.auth?.source ?? "request"})`,
			revision: null,
			currentRevision: null,
		});
	}
	const boundedReferences = bounded(references, WHY_LIMITS.maxReferences);

	const appliedScopes = VARIABLE_SCOPE_ORDER.filter((scope) => variables.some((variable) => variable.scope === scope));

	const gaps = [];
	if (variables.length === 0) {
		gaps.push({
			code: WHY_REASON.NO_VARIABLE_REFERENCES,
			detail: "No variable interpolation was recorded, so nothing was resolved from a scope.",
		});
	}

	return {
		state: gaps.length === 0 ? "recorded" : "partial",
		variables: boundedVariables.items,
		truncated: boundedVariables.truncated,
		references: boundedReferences.items,
		precedence: {
			order: [...VARIABLE_SCOPE_ORDER],
			labels: VARIABLE_SCOPE_ORDER.map((scope) => ({ scope, label: scopeLabel(scope) })),
			appliedScopes,
			note: "Scope precedence is applied by the request compiler, lowest to highest. Later scopes shadow earlier ones. Secret values are never resolved by this read-model.",
		},
		gaps,
	};
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

function executionSection({ record, receipt }) {
	const compileTrace = Array.isArray(record?.compileTrace) ? record.compileTrace : [];
	const response = record?.response ?? null;
	const contract = receipt?.response?.contract ?? null;

	const summaryById = {
		compile: () => {
			if (!receipt?.request?.compiledFingerprint) return null;
			return compileTrace.length > 0
				? `${compileTrace.length} interpolation${compileTrace.length === 1 ? "" : "s"} recorded`
				: "Compiled with no variable interpolation";
		},
		policy: () => (receipt?.policy?.decision ? `Decision: ${receipt.policy.decision}${receipt.policy.local ? " (local target)" : ""}` : null),
		dns: () => (receipt?.target ? `Resolved to ${receipt.target.address ?? "unknown"}${receipt.target.family ? ` (IPv${receipt.target.family})` : ""}` : null),
		transport: () =>
			receipt?.transport
				? `${receipt.transport.httpVersion ?? "HTTP"} in ${Math.round(receipt.transport.durationMs ?? 0)} ms`
				: null,
		capture: () => {
			if (!receipt?.transport) return null;
			const received = receipt.transport.receivedBodyBytes;
			const captured = receipt.transport.capturedBodyBytes;
			const truncated = receipt.response?.truncated === true ? " (truncated)" : "";
			return `${received ?? 0} bytes received, ${captured ?? 0} captured${truncated}`;
		},
		normalize: () => (contract ? `Status ${contract.status ?? "—"} · ${contract.headers?.length ?? 0} header names · ${contract.bodyShape?.length ?? 0} shape entries` : null),
		history: () => (record?.persistence?.state ? `Persistence: ${record.persistence.state}` : null),
	};

	const stages = EXECUTION_STAGES.map((stage) => {
		const summary = summaryById[stage.id]?.() ?? null;
		const evidence = [];
		if (stage.id === "compile" && receipt?.request?.compiledFingerprint)
			evidence.push({ kind: "fingerprint", ref: receipt.request.compiledFingerprint, label: "Compiled request fingerprint" });
		if (stage.id === "policy" && receipt?.policy?.version)
			evidence.push({ kind: "policy", ref: String(receipt.policy.version), label: "Policy version" });
		if (stage.id === "dns" && receipt?.target?.address)
			evidence.push({ kind: "address", ref: receipt.target.address, label: "Pinned destination" });
		if (stage.id === "capture" && receipt?.response?.bodyFingerprint)
			evidence.push({ kind: "fingerprint", ref: receipt.response.bodyFingerprint, label: "Response body fingerprint" });
		if (stage.id === "history" && receipt?.fingerprint)
			evidence.push({ kind: "fingerprint", ref: receipt.fingerprint, label: "Execution fingerprint" });
		return {
			id: stage.id,
			label: stage.label,
			state: summary ? "recorded" : "not_recorded",
			summary: summary ?? "Not recorded for this execution.",
			evidence,
		};
	});

	const boundedStages = bounded(stages, WHY_LIMITS.maxStages);

	const gaps = [];
	if (!receipt) {
		gaps.push({ code: WHY_REASON.CONFIGURATION_NOT_RECORDED, detail: "No execution receipt was recorded for this execution." });
	}
	if (!response) {
		gaps.push({ code: WHY_REASON.RESPONSE_NOT_RECORDED, detail: "No response was captured (the execution did not complete a dispatch)." });
	}

	return {
		state: receipt ? (gaps.length === 0 ? "recorded" : "partial") : "not_recorded",
		outcome: record?.outcome ?? null,
		effectCertainty: record?.effectCertainty ?? null,
		stages: boundedStages.items,
		truncated: boundedStages.truncated,
		warnings: (Array.isArray(record?.warnings) ? record.warnings : []).slice(0, 10).map((warning) => ({
			code: text(warning?.code ?? "WARNING", 120),
			message: text(warning?.message ?? "", 300),
		})),
		error: record?.error ? { code: text(record.error.code ?? "UNKNOWN_ERROR", 120), message: text(record.error.message ?? "", 300) } : null,
		gaps,
	};
}

/* -------------------------------------------------------------------------- */
/* Change                                                                     */
/* -------------------------------------------------------------------------- */

function changeSection({ related }) {
	const investigations = Array.isArray(related.investigations) ? related.investigations : [];
	const completed = investigations.filter((entry) => entry?.result);

	if (completed.length === 0) {
		return {
			state: "not_recorded",
			recorded: false,
			reasonCode: WHY_REASON.NO_CHANGE_EVIDENCE,
			reason:
				"No persisted change analysis references this execution. Run Investigate on this execution to record what changed and which change was verified as causal.",
			hint: "Open the Flight Recorder and choose Investigate, or use Investigate failure on a history entry.",
			comparisons: [],
			truncated: false,
		};
	}

	const comparisons = completed.map((entry) => {
		const result = entry.result ?? {};
		const comparison = result.comparison ?? {};
		const changeItems = bounded(comparison.changes ?? [], WHY_LIMITS.maxChangeItems);
		const verified = bounded(result.verifiedCauses ?? [], WHY_LIMITS.maxVerifiedCauses);
		return {
			investigationId: idOf(entry.investigationId ?? result.investigationId),
			status: text(entry.status ?? result.status ?? null, 40),
			startedAt: iso(entry.startedAt),
			finishedAt: iso(entry.finishedAt),
			comparisonAvailable: comparison.available === true,
			unavailableReason: text(comparison.unavailableReason ?? null, 200),
			baseExecutionId: idOf(comparison.baseExecutionId),
			candidateExecutionId: idOf(comparison.candidateExecutionId),
			firstDivergence: comparison.firstDivergence
				? {
						category: text(comparison.firstDivergence.category ?? null, 80),
						path: text(comparison.firstDivergence.path ?? null, 300),
						message: text(comparison.firstDivergence.message ?? null, 500),
					}
				: null,
			changes: changeItems.items.map((change) => ({
				category: text(change?.category ?? null, 80),
				path: text(change?.path ?? null, 300),
				message: text(change?.message ?? null, 500),
			})),
			changesTruncated: changeItems.truncated,
			verifiedCauses: verified.items.map((cause) => ({
				label: text(cause?.label ?? null, 200),
				path: text(cause?.path ?? null, 300),
				executionIds: (Array.isArray(cause?.executionIds) ? cause.executionIds : []).slice(0, 10).map((id) => idOf(id)).filter(Boolean),
			})),
			verifiedCausesTruncated: verified.truncated,
			unverifiedChangeCount: Array.isArray(result.unverifiedChanges) ? result.unverifiedChanges.length : 0,
			regressionBoundary: result.regressionBoundary
				? {
						resolved: result.regressionBoundary.resolved === true,
						goodExecutionId: idOf(result.regressionBoundary.goodExecutionId),
						reason: text(result.regressionBoundary.unresolved?.reason ?? null, 120),
						caveat: text(result.regressionBoundary.caveat ?? null, 400),
					}
				: null,
			reproducibility: result.reproducibility
				? {
						status: text(result.reproducibility.status ?? null, 40),
						classification: text(result.reproducibility.classification ?? null, 60),
						statement: text(result.reproducibility.statement ?? null, 400),
					}
				: null,
			summary: text(result.summary?.text ?? null, 600),
		};
	});
	const boundedComparisons = bounded(comparisons, WHY_LIMITS.maxChangeComparisons);

	return {
		state: "recorded",
		recorded: true,
		reasonCode: WHY_REASON.CHANGE_EVIDENCE_RECORDED,
		reason: "Persisted change analysis referencing this execution was found.",
		hint: null,
		comparisons: boundedComparisons.items,
		truncated: boundedComparisons.truncated,
	};
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Restate the verification state Tracer already reached for this execution.
 *
 * This is a read-model mapping over recorded facts, in a fixed precedence order.
 * It never runs a verifier and never upgrades a state:
 *
 *   1. a linked persisted verification artifact, if one exists;
 *   2. the backend's own recorded target-policy decision (`blocked`);
 *   3. the execution's own recorded assertion results;
 *   4. otherwise `UNKNOWN` with the specific missing evidence listed.
 */
export function deriveVerificationState({ receipt, related }) {
	const linked = related?.verification ?? null;
	if (linked && typeof linked.state === "string") {
		return {
			state: linked.state,
			stateBasis: "linked_verification",
			reasonCode: WHY_REASON.LINKED_VERIFICATION_STATE,
			reasons: [
				{
					code: WHY_REASON.LINKED_VERIFICATION_STATE,
					text: `A persisted verification artifact reports ${linked.state}${linked.source ? ` (source: ${linked.source})` : ""}.`,
				},
			],
		};
	}

	const decision = receipt?.policy?.decision ?? null;
	if (decision === "blocked") {
		return {
			state: "BLOCKED",
			stateBasis: "target_policy",
			reasonCode: WHY_REASON.TARGET_POLICY_BLOCKED,
			reasons: [
				{
					code: WHY_REASON.TARGET_POLICY_BLOCKED,
					text: "The recorded target-policy decision blocked this execution, so it was never dispatched.",
				},
			],
		};
	}

	const counts = receipt?.tests?.counts ?? null;
	const passed = numberOrNull(counts?.passed) ?? 0;
	const failed = numberOrNull(counts?.failed) ?? 0;
	const errored = numberOrNull(counts?.error) ?? 0;
	const total = passed + failed + errored;

	if (total > 0 && failed + errored > 0) {
		return {
			state: "NEEDS_REHEARSAL",
			stateBasis: "recorded_assertions",
			reasonCode: WHY_REASON.RECORDED_ASSERTIONS_FAILED,
			reasons: [
				{
					code: WHY_REASON.RECORDED_ASSERTIONS_FAILED,
					text: `${failed + errored} of ${total} recorded assertion${total === 1 ? "" : "s"} did not pass, so the request is not verified against its own tests.`,
				},
			],
		};
	}

	if (total > 0 && passed > 0 && receipt?.outcome === "response") {
		return {
			state: "VERIFIED",
			stateBasis: "recorded_assertions",
			reasonCode: WHY_REASON.RECORDED_ASSERTIONS_PASSED,
			reasons: [
				{
					code: WHY_REASON.RECORDED_ASSERTIONS_PASSED,
					text: `All ${total} recorded assertion${total === 1 ? "" : "s"} passed against the captured response.`,
				},
			],
		};
	}

	const reasons = [
		{
			code: WHY_REASON.NO_VERIFICATION_EVIDENCE,
			text: "No persisted verification artifact references this execution and no request assertions were recorded, so Tracer cannot state a verification result.",
		},
	];
	if (!receipt) reasons.push({ code: WHY_REASON.CONFIGURATION_NOT_RECORDED, text: "No execution receipt was recorded." });
	if (receipt && total === 0)
		reasons.push({ code: WHY_REASON.NO_VERIFICATION_EVIDENCE, text: "This request defines no assertions or test script." });
	if (receipt && decision && decision !== "blocked")
		reasons.push({ code: WHY_REASON.NO_VERIFICATION_EVIDENCE, text: `The target policy recorded "${decision}", which is not a verification result.` });

	return { state: "UNKNOWN", stateBasis: "none", reasonCode: WHY_REASON.NO_VERIFICATION_EVIDENCE, reasons };
}

function verificationSection({ record, receipt, related, derived }) {
	const contract = receipt?.response?.contract ?? null;
	const counts = receipt?.tests?.counts ?? null;
	const investigations = Array.isArray(related.investigations) ? related.investigations : [];
	const completed = investigations.filter((entry) => entry?.result);
	const totalVerifiedCauses = completed.reduce((sum, entry) => sum + (entry.result?.verifiedCauses?.length ?? 0), 0);

	const reasons = bounded(derived.reasons, WHY_LIMITS.maxReasons);

	return {
		state: derived.state,
		stateBasis: derived.stateBasis,
		reasonCode: derived.reasonCode,
		stateIsValid: VERIFICATION_STATE_BASIS.includes(derived.stateBasis),
		reasons: reasons.items,
		reasonsTruncated: reasons.truncated,
		caveat: WHY_CAVEAT,
		assertions: {
			recorded: Boolean(counts),
			passed: numberOrNull(counts?.passed) ?? 0,
			failed: numberOrNull(counts?.failed) ?? 0,
			error: numberOrNull(counts?.error) ?? 0,
			failureFingerprint: receipt?.tests?.failureFingerprint ?? null,
		},
		policy: { decision: receipt?.policy?.decision ?? null, local: receipt?.policy?.local === true },
		contract: contract
			? {
					status: numberOrNull(contract.status),
					headerCount: Array.isArray(contract.headers) ? contract.headers.length : 0,
					shapeEntries: Array.isArray(contract.bodyShape) ? contract.bodyShape.length : 0,
					truncated: receipt?.response?.truncated === true,
					binary: receipt?.response?.binary === true,
				}
			: null,
		outcome: record?.outcome ?? null,
		linkedInvestigation:
			completed.length > 0
				? {
						count: completed.length,
						verifiedCauses: totalVerifiedCauses,
						investigationId: idOf(completed[0].investigationId ?? completed[0].result?.investigationId),
					}
				: null,
	};
}

/* -------------------------------------------------------------------------- */
/* Evidence chain                                                             */
/* -------------------------------------------------------------------------- */

function evidenceSection({ record, receipt, related, verification }) {
	const chain = [];
	let order = 0;
	const add = (kind, ref, label, detail, available = Boolean(ref)) => {
		order += 1;
		chain.push({ order, kind, ref: ref ?? null, label, detail: text(detail ?? null, 400), available });
	};

	const source = receipt?.source ?? {};
	if (source.collectionId || source.environmentId) {
		const parts = [];
		if (source.collectionId) parts.push(`collection ${source.collectionId}@${source.collectionRevision ?? "?"}`);
		if (source.environmentId) parts.push(`environment ${source.environmentId}@${source.environmentRevision ?? "?"}`);
		add("configuration", source.collectionId ?? source.environmentId, "Configuration source", parts.join(", "));
	} else {
		add("configuration", null, "Configuration source", "Scratch request with no persisted source.", false);
	}
	add("execution-receipt", receipt?.fingerprint, "Execution receipt", `Key ${receipt?.fingerprintKeyId ?? "unknown"} · outcome ${record?.outcome ?? "—"}`);
	add("compiled-request", receipt?.request?.compiledFingerprint, "Compiled request", receipt?.request?.executedUrl ?? null);
	add("response-body", receipt?.response?.bodyFingerprint, "Captured response body", receipt?.response ? `status ${receipt.response.contract?.status ?? "—"}` : "No response captured");
	for (const entry of Array.isArray(related.investigations) ? related.investigations : []) {
		if (!entry?.result) continue;
		add("change-analysis", idOf(entry.investigationId), "Change analysis", entry.result?.summary?.text ?? null);
	}
	add("verification", verification.stateBasis, "Verification state", `${verification.state} (${verification.stateBasis})`, verification.state !== "UNKNOWN");

	const boundedChain = bounded(chain, WHY_LIMITS.maxEvidence);
	return { chain: boundedChain.items, truncated: boundedChain.truncated };
}

/* -------------------------------------------------------------------------- */
/* Envelope                                                                   */
/* -------------------------------------------------------------------------- */

function emptySection() {
	return {
		state: "not_recorded",
		entries: [],
		variables: [],
		references: [],
		stages: [],
		truncated: false,
		warnings: [],
		error: null,
		outcome: null,
		effectCertainty: null,
		precedence: { order: [...VARIABLE_SCOPE_ORDER], labels: [], appliedScopes: [], note: null },
		gaps: [{ code: WHY_REASON.EXECUTION_NOT_RECORDED, detail: "No execution record exists for this identifier in this profile." }],
	};
}

export function buildWhyExplanation({ record = null, related = {} } = {}) {
	const receipt = record?.receipt ?? null;
	const recorded = Boolean(record);

	const configuration = recorded ? configurationSection({ record, receipt, related }) : emptySection();
	const dependencies = recorded ? dependencySection({ record, receipt, related }) : emptySection();
	const execution = recorded ? executionSection({ record, receipt }) : emptySection();	const change = changeSection({ related });
	const derived = deriveVerificationState({ receipt, related });
	const verification = recorded ? verificationSection({ record, receipt, related, derived }) : {
		state: derived.state,
		stateBasis: derived.stateBasis,
		reasonCode: derived.reasonCode,
		stateIsValid: VERIFICATION_STATE_BASIS.includes(derived.stateBasis),
		reasons: derived.reasons,
		reasonsTruncated: false,
		caveat: WHY_CAVEAT,
		assertions: { recorded: false, passed: 0, failed: 0, error: 0, failureFingerprint: null },
		policy: { decision: null, local: false },
		contract: null,
		outcome: null,
		linkedInvestigation: null,
	};
	const evidence = recorded ? evidenceSection({ record, receipt, related, verification }) : { chain: [], truncated: false };

	const availability = {
		configuration: { state: configuration.state, note: configuration.gaps?.[0]?.detail ?? null },
		dependencies: { state: dependencies.state, note: dependencies.gaps?.[0]?.detail ?? null },
		execution: { state: execution.state, note: execution.gaps?.[0]?.detail ?? null },
		change: { state: change.state, note: change.reason ?? null },
		verification: { state: verification.state === "UNKNOWN" ? "not_recorded" : "recorded", note: verification.reasons?.[0]?.text ?? null },
		evidence: { state: evidence.chain.length > 0 ? "recorded" : "not_recorded", note: null },
	};
	for (const section of WHY_SECTIONS) {
		if (!SECTION_STATES.includes(availability[section].state)) availability[section].state = "not_recorded";
	}

	return {
		kind: WHY_EXPLANATION_KIND,
		schemaVersion: WHY_EXPLANATION_SCHEMA_VERSION,
		question: WHY_QUESTION,
		executionId: idOf(record?.executionId) ?? null,
		generatedAt: new Date().toISOString(),
		recorded,
		reasonCode: recorded ? null : WHY_REASON.EXECUTION_NOT_RECORDED,
		reason: recorded ? null : "No execution record exists for this identifier in this profile.",
		sections: [...WHY_SECTIONS],
		availability,
		configuration,
		dependencies,
		execution,
		change,
		verification,
		evidence,
	};
}
