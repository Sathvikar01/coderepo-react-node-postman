// Phase 45A — the execution envelope.
//
// The envelope is the only thing a future checkpointed-rehearsal engine may
// consume. It carries identity and decisions, never payloads.
//
// Never present in the envelope (or anywhere in the service output):
//   * request bodies
//   * credential templates or resolved credential values
//   * Authorization / Cookie header values
//   * bearer tokens
//   * secret values, or the resolved values behind secretRef aliases
//   * query strings, URLs, or any caller-supplied text we did not classify
//
// The envelope deliberately stores no free-form caller strings beyond IDs and
// normalized host identities, so leakage cannot be reintroduced by a future
// field.

import {
	BLAST_RADIUS_ENVELOPE_KIND,
	BLAST_RADIUS_ENVELOPE_VERSION,
} from "./blast-radius-schema.js";
import { ADMISSION_STATES, REQUEST_CLASSIFICATIONS } from "./reason-codes.js";

/**
 * Build one admitted-request execution entry.
 *
 * @param {object} args
 * @param {object} args.request normalized request descriptor
 * @param {object} args.decision admission decision for this request
 * @returns {object} stable, payload-free execution entry
 */
export function buildExecutionEntry({ request, decision }) {
	return {
		requestId: request.requestId,
		host: decision.host.resolved ? decision.host.host : null,
		hostKey: decision.host.resolved ? decision.host.key : null,
		port: decision.host.resolved ? decision.host.port : null,
		method: request.method || null,
		classification: decision.classification,
		mutating: decision.mutating === true,
		admission: decision.state,
		reasonCodes: [...decision.reasons],
	};
}

/**
 * Build the full result entry (used for blocked and unknown requests too, so a
 * reviewer can see why something was not admitted without seeing its payload).
 */
export function buildResultEntry({ request, decision, ordinal }) {
	return {
		ordinal,
		requestId: request.requestId,
		host: decision.host.resolved ? decision.host.host : null,
		hostKey: decision.host.resolved ? decision.host.key : null,
		port: decision.host.resolved ? decision.host.port : null,
		method: request.method || null,
		classification: decision.classification,
		mutating: decision.mutating === true,
		admission: decision.state,
		reasonCodes: [...decision.reasons],
	};
}

/**
 * Build a per-host summary from result entries.
 *
 * @param {object[]} entries
 * @returns {object[]} sorted, stable host summary
 */
export function buildHostSummary(entries) {
	const hosts = new Map();
	for (const entry of entries) {
		const key = entry.hostKey;
		if (!key) continue;
		if (!hosts.has(key)) {
			hosts.set(key, {
				hostKey: key,
				host: entry.host,
				port: entry.port,
				proposed: 0,
				admitted: 0,
				blocked: 0,
				unknown: 0,
				requiresConfirmation: 0,
				mutating: 0,
				nonMutating: 0,
			});
		}
		const summary = hosts.get(key);
		summary.proposed += 1;
		if (entry.admission === ADMISSION_STATES.ADMITTED) summary.admitted += 1;
		if (entry.admission === ADMISSION_STATES.BLOCKED) summary.blocked += 1;
		if (entry.admission === ADMISSION_STATES.UNKNOWN) summary.unknown += 1;
		if (entry.admission === ADMISSION_STATES.REQUIRES_CONFIRMATION) summary.requiresConfirmation += 1;
		if (entry.mutating) summary.mutating += 1;
		else summary.nonMutating += 1;
	}
	return [...hosts.values()].sort((left, right) => left.hostKey.localeCompare(right.hostKey));
}

/**
 * Build the complete, machine-readable envelope.
 *
 * @param {object} args
 * @returns {object} stable envelope
 */
export function buildEnvelope({
	workspaceId,
	snapshotId,
	environmentId,
	targetEnvironmentId,
	policyRef,
	admissionState,
	entries,
	executionEntries,
	effectiveLimits,
	violations,
	confirmations,
	abortConditions,
	reasonCodes,
	classificationCounts,
}) {
	const hosts = buildHostSummary(entries);
	return {
		kind: BLAST_RADIUS_ENVELOPE_KIND,
		version: BLAST_RADIUS_ENVELOPE_VERSION,
		policy: {
			kind: policyRef.kind,
			version: policyRef.version,
			identity: policyRef.identity,
		},
		workspace: {
			workspaceId,
			snapshotId: snapshotId ?? null,
		},
		environment: {
			environmentId,
			targetEnvironmentId: targetEnvironmentId ?? null,
		},
		admissionState,
		requests: {
			proposed: entries.length,
			admitted: entries.filter((entry) => entry.admission === ADMISSION_STATES.ADMITTED).length,
			blocked: entries.filter((entry) => entry.admission === ADMISSION_STATES.BLOCKED).length,
			unknown: entries.filter((entry) => entry.admission === ADMISSION_STATES.UNKNOWN).length,
			requiresConfirmation: entries.filter((entry) => entry.admission === ADMISSION_STATES.REQUIRES_CONFIRMATION)
				.length,
		},
		classification: classificationCounts,
		allowedRequests: executionEntries,
		blockedRequests: entries
			.filter((entry) => entry.admission === ADMISSION_STATES.BLOCKED)
			.map((entry) => ({ requestId: entry.requestId, host: entry.host, method: entry.method, reasonCodes: entry.reasonCodes })),
		unknownRequests: entries
			.filter((entry) => entry.admission === ADMISSION_STATES.UNKNOWN)
			.map((entry) => ({ requestId: entry.requestId, host: entry.host, method: entry.method, reasonCodes: entry.reasonCodes })),
		confirmationRequests: entries
			.filter((entry) => entry.admission === ADMISSION_STATES.REQUIRES_CONFIRMATION)
			.map((entry) => ({ requestId: entry.requestId, host: entry.host, method: entry.method, reasonCodes: entry.reasonCodes })),
		mutatingRequestIds: entries
			.filter((entry) => entry.classification === REQUEST_CLASSIFICATIONS.MUTATING)
			.map((entry) => entry.requestId),
		nonMutatingRequestIds: entries
			.filter((entry) => entry.classification === REQUEST_CLASSIFICATIONS.NON_MUTATING)
			.map((entry) => entry.requestId),
		unknownRequestIds: entries
			.filter((entry) => entry.classification === REQUEST_CLASSIFICATIONS.UNKNOWN)
			.map((entry) => entry.requestId),
		hostSummary: hosts,
		effectiveLimits,
		violations,
		confirmations,
		abortConditions,
		reasonCodes,
	};
}
