// Phase 49B — Effective Configuration / "Why?" Inspector: pure projection.
//
// `buildWhyExplanation` is deterministic and side-effect free: identical inputs
// always produce an identical envelope. It reads only evidence that was already
// recorded, already redacted at write time, and already interpreted by the phase
// that owns it:
//
//   * the persisted execution history record (including its execution receipt),
//   * the compile trace produced by the request compiler,
//   * profile-scoped collection / environment summaries,
//   * persisted investigations linked to the execution,
//   * the Phase 49B evidence links (`related.links`): the persisted Phase 46B
//     rehearsal run that produced this execution, and an optional supplied Phase
//     47 verification proof carrying the Phase 39/40/41/43 results.
//
// It never resolves a variable value, never reads a credential, never re-runs a
// policy decision, and — the Phase 49B correction — never *decides* a verification
// state. The only state it can report is one Phase 41 already reached and Phase 47
// signed. Where evidence is missing it fails closed with an explicit reason code
// instead of a blank.
import {
	EXECUTION_STAGES,
	LINK_SOURCE,
	LINK_STATUS,
	LINK_STATUS_VALUES,
	SECTION_STATES,
	VARIABLE_SCOPE_LABEL,
	VARIABLE_SCOPE_ORDER,
	VERIFICATION_BASIS_LABEL,
	VERIFICATION_STATE_BASIS,
	VERIFICATION_STATES,
	WHY_CAVEAT,
	WHY_CHAIN,
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
/* Evidence links                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The link envelope is produced by `why-evidence.js`. This accessor only
 * normalizes absent entries into explicit `not_recorded` links so a section can
 * never render an ambiguous blank.
 */
function linksOf(related) {
	return related?.links ?? {};
}

function absentLink(source, reasonCode, reason) {
	return {
		status: LINK_STATUS.NOT_RECORDED,
		source,
		identity: [],
		reasonCode,
		reason,
		observedAt: null,
		fingerprint: null,
	};
}

function linkOrAbsent(value, source, reasonCode, reason) {
	if (value && value.link) return value;
	return { link: absentLink(source, reasonCode, reason), detail: null };
}

function linkStatusTone(status) {
	return LINK_STATUS_VALUES.includes(status) ? status : LINK_STATUS.UNKNOWN;
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
/* Change — Phase 39 impact + Phase 40 drift + persisted investigations        */
/* -------------------------------------------------------------------------- */

function changeSection({ related }) {
	const links = linksOf(related);
	const impact = linkOrAbsent(links.impact, LINK_SOURCE.PHASE39_IMPACT, WHY_REASON.IMPACT_NOT_RECORDED, "No Phase 39 change-impact evidence is linked to this execution.");
	const drift = linkOrAbsent(links.drift, LINK_SOURCE.PHASE40_DRIFT, WHY_REASON.DRIFT_NOT_RECORDED, "No Phase 40 environment-drift evidence is linked to this execution.");

	const investigations = Array.isArray(related.investigations) ? related.investigations : [];
	const completed = investigations.filter((entry) => entry?.result);

	const impactRecorded = impact.detail?.present === true && impact.link.status === LINK_STATUS.RECORDED;
	const driftRecorded = drift.detail?.present === true && drift.link.status === LINK_STATUS.RECORDED;
	const comparisonRecorded = completed.length > 0;

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

	const missing = [];
	if (!impactRecorded) missing.push("Phase 39 change impact");
	if (!driftRecorded) missing.push("Phase 40 environment drift");
	if (!comparisonRecorded) missing.push("a persisted change analysis");

	const recordedCount = [impactRecorded, driftRecorded, comparisonRecorded].filter(Boolean).length;
	const reasonCode = recordedCount === 0 ? WHY_REASON.NO_CHANGE_EVIDENCE : WHY_REASON.CHANGE_EVIDENCE_RECORDED;

	return {
		state: recordedCount === 0 ? "not_recorded" : recordedCount === 3 ? "recorded" : "partial",
		recorded: recordedCount > 0,
		reasonCode,
		reason:
			recordedCount === 0
				? "No change evidence is linked to this execution. Tracer does not infer what changed from the request alone."
				: recordedCount === 3
					? "Phase 39 impact, Phase 40 drift, and a persisted change analysis all reference this execution."
					: `Linked change evidence is incomplete. Not recorded: ${missing.join(", ")}.`,
		hint:
			recordedCount === 3
				? null
				: "Change evidence is only ever composed from recorded analyses that name this execution. Link a verification proof on the Evidence section to surface the Phase 39/40 results recorded with it, or run Investigate on this execution.",
		impact,
		drift,
		comparisons: boundedComparisons.items,
		truncated: boundedComparisons.truncated,
	};
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Restate the verification state Phase 41 already reached for this execution.
 *
 * Phase 49B narrowed this decisively. The only authoritative source is a linked
 * Phase 41 result — carried by a supplied Phase 47 proof, or implied by a Phase 47
 * proof's absence meaning no result exists. Everything else is UNKNOWN with an
 * explicit reason, and the recorded assertions / target-policy decision are
 * returned as *observations* that cannot change the state.
 *
 * This function never runs a verifier, never inspects a response, and never
 * upgrades a state.
 */
export function deriveVerificationState({ receipt, related }) {
	const links = linksOf(related);
	const verification = links.verification ?? null;
	const state =
		verification && verification.authoritative === true && VERIFICATION_STATES.includes(verification.state)
			? verification.state
			: null;
	const link = verification?.link ?? absentLink(LINK_SOURCE.PHASE41_VERIFICATION, WHY_REASON.VERIFICATION_NOT_RECORDED, "No Phase 41 verification result is linked to this execution, so no verification state can be reported.");

	if (state) {
		return {
			state,
			stateBasis: "linked_verification",
			reasonCode: link.reasonCode,
			reasons: [{ code: link.reasonCode, text: link.reason }],
			link,
		};
	}

	const reasons = [{ code: link.reasonCode, text: link.reason }];
	const decision = receipt?.policy?.decision ?? null;
	const counts = receipt?.tests?.counts ?? null;
	const passed = numberOrNull(counts?.passed) ?? 0;
	const failed = numberOrNull(counts?.failed) ?? 0;
	const errored = numberOrNull(counts?.error) ?? 0;
	const total = passed + failed + errored;

	if (!receipt) {
		reasons.push({ code: WHY_REASON.CONFIGURATION_NOT_RECORDED, text: "No execution receipt was recorded." });
	}
	if (decision) {
		reasons.push({
			code: WHY_REASON.OBSERVATION_ONLY,
			text: `The recorded target-policy decision was "${decision}". A policy decision is not a Phase 41 verification result and does not set the state.`,
		});
	}
	if (total > 0) {
		reasons.push({
			code: WHY_REASON.OBSERVATION_ONLY,
			text: `This execution recorded ${total} request assertion${total === 1 ? "" : "s"} (${passed} passed, ${failed} failed, ${errored} errored). Per-execution assertion results are observations and are not a Phase 41 cross-environment verification result.`,
		});
	} else if (receipt) {
		reasons.push({ code: WHY_REASON.OBSERVATION_ONLY, text: "This request defines no assertions or test script, so it recorded no test results." });
	}

	return { state: "UNKNOWN", stateBasis: "none", reasonCode: link.reasonCode, reasons, link };
}

function verificationSection({ record, receipt, related, derived }) {
	const contract = receipt?.response?.contract ?? null;
	const counts = receipt?.tests?.counts ?? null;
	const investigations = Array.isArray(related.investigations) ? related.investigations : [];
	const completed = investigations.filter((entry) => entry?.result);
	const totalVerifiedCauses = completed.reduce((sum, entry) => sum + (entry.result?.verifiedCauses?.length ?? 0), 0);
	const detail = derived.link ?? null;
	const linkedDetail = linksOf(related).verification?.detail ?? null;

	const passed = numberOrNull(counts?.passed) ?? 0;
	const failed = numberOrNull(counts?.failed) ?? 0;
	const errored = numberOrNull(counts?.error) ?? 0;

	const observations = [
		{
			id: "recorded_assertions",
			label: "Recorded request assertions",
			status: counts ? "recorded" : "not_recorded",
			authoritative: false,
			value: counts ? { passed, failed, errored, total: passed + failed + errored } : null,
			note: "Per-execution assertion results are recorded facts about this one response. They are not a Phase 41 verification result and cannot set the verification state.",
		},
		{
			id: "target_policy",
			label: "Target policy decision",
			status: receipt?.policy?.decision ? "recorded" : "not_recorded",
			authoritative: false,
			value: receipt?.policy?.decision ?? null,
			note: "The policy gate decides whether a target may be contacted. BLOCKED is not the same statement as a Phase 41 BLOCKED verification result.",
		},
		{
			id: "response_outcome",
			label: "Execution outcome",
			status: record?.outcome ? "recorded" : "not_recorded",
			authoritative: false,
			value: record?.outcome ?? null,
			note: "The transport outcome is an observation about one dispatch, not a verification result.",
		},
	];

	const reasons = bounded(derived.reasons, WHY_LIMITS.maxReasons);

	return {
		state: derived.state,
		stateBasis: derived.stateBasis,
		basisLabel: VERIFICATION_BASIS_LABEL[derived.stateBasis] ?? derived.stateBasis,
		reasonCode: derived.reasonCode,
		stateIsValid: VERIFICATION_STATE_BASIS.includes(derived.stateBasis) && VERIFICATION_STATES.includes(derived.state),
		authoritative: derived.stateBasis === "linked_verification",
		reasons: reasons.items,
		reasonsTruncated: reasons.truncated,
		caveat: WHY_CAVEAT,
		link: detail,
		linked: linkedDetail
			? {
					state: linkedDetail.state,
					fingerprint: linkedDetail.fingerprint,
					verifiedRequestIds: linkedDetail.verifiedRequestIds,
					affectedRequestIds: linkedDetail.affectedRequestIds,
					requiredRehearsalRequestIds: linkedDetail.requiredRehearsalRequestIds,
					blockers: linkedDetail.blockers,
					warnings: linkedDetail.warnings,
					summary: linkedDetail.summary,
					requestVerified: linkedDetail.requestVerified,
				}
			: null,
		observations,
		assertions: {
			recorded: Boolean(counts),
			passed,
			failed,
			error: errored,
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
	const links = linksOf(related);
	const rehearsal = linkOrAbsent(links.rehearsal, LINK_SOURCE.PHASE46B_RUN, WHY_REASON.REHEARSAL_NOT_RECORDED, "No persisted rehearsal run records this execution.");
	const contract = linkOrAbsent(links.contract, LINK_SOURCE.PHASE43_CONTRACT, WHY_REASON.CONTRACT_NOT_RECORDED, "No Phase 43 contract comparison is linked to this execution.");
	const proof = linkOrAbsent(links.proof, LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_NOT_RECORDED, "No verification proof is linked to this execution.");
	const impact = linkOrAbsent(links.impact, LINK_SOURCE.PHASE39_IMPACT, WHY_REASON.IMPACT_NOT_RECORDED, "No Phase 39 change-impact evidence is linked to this execution.");
	const drift = linkOrAbsent(links.drift, LINK_SOURCE.PHASE40_DRIFT, WHY_REASON.DRIFT_NOT_RECORDED, "No Phase 40 environment-drift evidence is linked to this execution.");

	const source = receipt?.source ?? {};
	const investigations = Array.isArray(related.investigations) ? related.investigations.filter((entry) => entry?.result) : [];

	const refsByChainId = {
		configuration: source.collectionId ?? source.environmentId ?? null,
		execution: receipt?.fingerprint ?? null,
		impact: impact.link.fingerprint,
		drift: drift.link.fingerprint,
		rehearsal: rehearsal.link.fingerprint ?? rehearsal.run?.runId ?? null,
		contract: contract.link.fingerprint,
		verification: verification.link?.fingerprint ?? null,
		proof: proof.link.fingerprint,
	};
	const detailByChainId = {
		configuration:
			source.collectionId || source.environmentId
				? `collection ${source.collectionId ?? "—"}@${source.collectionRevision ?? "?"}, environment ${source.environmentId ?? "—"}@${source.environmentRevision ?? "?"}`
				: "Scratch request with no persisted source.",
		execution: `Key ${receipt?.fingerprintKeyId ?? "unknown"} · outcome ${record?.outcome ?? "—"}`,
		impact: impact.link.reason,
		drift: drift.link.reason,
		rehearsal: rehearsal.link.reason,
		contract: contract.link.reason,
		verification: `${verification.state} (${verification.stateBasis}) — ${verification.link?.reason ?? "no reason recorded"}`,
		proof: proof.link.reason,
	};
	const statusByChainId = {
		configuration: source.collectionId || source.environmentId ? LINK_STATUS.RECORDED : LINK_STATUS.NOT_RECORDED,
		execution: receipt?.fingerprint ? LINK_STATUS.RECORDED : LINK_STATUS.NOT_RECORDED,
		impact: impact.link.status,
		drift: drift.link.status,
		rehearsal: rehearsal.link.status,
		contract: contract.link.status,
		verification: verification.link?.status ?? LINK_STATUS.NOT_RECORDED,
		proof: proof.link.status,
	};

	const chain = WHY_CHAIN.map((node, index) => {
		const ref = refsByChainId[node.id] ?? null;
		const status = linkStatusTone(statusByChainId[node.id]);
		return {
			order: index + 1,
			id: node.id,
			kind: node.id,
			label: node.label,
			owner: node.owner,
			section: node.section,
			status,
			ref,
			detail: text(detailByChainId[node.id] ?? null, 400),
			available: status === LINK_STATUS.RECORDED || status === LINK_STATUS.PARTIAL,
		};
	});

	const boundedChain = bounded(chain, WHY_LIMITS.maxEvidence);

	return {
		state: boundedChain.items.some((node) => node.status === LINK_STATUS.RECORDED)
			? boundedChain.items.every((node) => node.status === LINK_STATUS.RECORDED)
				? "recorded"
				: "partial"
			: "not_recorded",
		chain: boundedChain.items,
		truncated: boundedChain.truncated,
		rehearsal: {
			link: rehearsal.link,
			run: rehearsal.run,
			step: rehearsal.step,
			runsTruncated: Boolean(rehearsal.runsTruncated ?? rehearsal.truncated),
		},
		contract: { link: contract.link, detail: contract.detail },
		verification: { link: verification.link, state: verification.state, stateBasis: verification.stateBasis },
		proof: {
			link: proof.link,
			detail: proof.detail,
			parseError: proof.parseError ?? null,
		},
		investigations: investigations.map((entry) => ({
			investigationId: idOf(entry.investigationId),
			summary: text(entry.result?.summary?.text ?? null, 600),
		})),
	};
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
		// Phase 49B section keys, present so every consumer sees one stable shape.
		recorded: false,
		reasonCode: WHY_REASON.EXECUTION_NOT_RECORDED,
		reason: "No execution record exists for this identifier in this profile.",
		hint: null,
		impact: { link: absentLink(LINK_SOURCE.PHASE39_IMPACT, WHY_REASON.IMPACT_NOT_RECORDED, "No execution record exists, so no impact evidence can be linked."), detail: null },
		drift: { link: absentLink(LINK_SOURCE.PHASE40_DRIFT, WHY_REASON.DRIFT_NOT_RECORDED, "No execution record exists, so no drift evidence can be linked."), detail: null },
		comparisons: [],
		chain: [],
		rehearsal: { link: absentLink(LINK_SOURCE.PHASE46B_RUN, WHY_REASON.REHEARSAL_NOT_RECORDED, "No execution record exists, so no rehearsal can be linked."), run: null, step: null, runsTruncated: false },
		contract: { link: absentLink(LINK_SOURCE.PHASE43_CONTRACT, WHY_REASON.CONTRACT_NOT_RECORDED, "No execution record exists, so no contract comparison can be linked."), detail: null },
		proof: { link: absentLink(LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_NOT_RECORDED, "No execution record exists, so no proof can be linked."), detail: null, parseError: null },
		investigations: [],
	};
}

function emptyVerification(derived) {
	return {
		state: derived.state,
		stateBasis: derived.stateBasis,
		basisLabel: VERIFICATION_BASIS_LABEL[derived.stateBasis] ?? derived.stateBasis,
		reasonCode: derived.reasonCode,
		stateIsValid: false,
		authoritative: false,
		reasons: derived.reasons,
		reasonsTruncated: false,
		caveat: WHY_CAVEAT,
		link: derived.link ?? null,
		linked: null,
		observations: [],
		assertions: { recorded: false, passed: 0, failed: 0, error: 0, failureFingerprint: null },
		policy: { decision: null, local: false },
		contract: null,
		outcome: null,
		linkedInvestigation: null,
	};
}

export function buildWhyExplanation({ record = null, related = {} } = {}) {
	const receipt = record?.receipt ?? null;
	const recorded = Boolean(record);

	const configuration = recorded ? configurationSection({ record, receipt, related }) : emptySection();
	const dependencies = recorded ? dependencySection({ record, receipt, related }) : emptySection();
	const execution = recorded ? executionSection({ record, receipt }) : emptySection();
	const change = changeSection({ related });
	const derived = deriveVerificationState({ receipt, related });
	const verification = recorded ? verificationSection({ record, receipt, related, derived }) : emptyVerification(derived);
	const evidence = evidenceSection({ record, receipt, related, verification });

	const availability = {
		configuration: { state: configuration.state, note: configuration.gaps?.[0]?.detail ?? null },
		dependencies: { state: dependencies.state, note: dependencies.gaps?.[0]?.detail ?? null },
		execution: { state: execution.state, note: execution.gaps?.[0]?.detail ?? null },
		change: { state: change.state, note: change.reason ?? null },
		verification: { state: verification.state === "UNKNOWN" ? "not_recorded" : "recorded", note: verification.reasons?.[0]?.text ?? null },
		evidence: { state: evidence.state ?? (evidence.chain.length > 0 ? "recorded" : "not_recorded"), note: null },
	};
	for (const section of WHY_SECTIONS) {
		if (!availability[section]) availability[section] = { state: "not_recorded", note: null };
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
		chain: WHY_CHAIN.map((node) => ({ ...node })),
		availability,
		configuration,
		dependencies,
		execution,
		change,
		verification,
		evidence,
	};
}
