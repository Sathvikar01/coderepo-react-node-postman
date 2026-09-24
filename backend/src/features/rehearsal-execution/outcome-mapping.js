import { createHash } from "node:crypto";
import { CONTRACT_STATUS } from "./executor-schema.js";

// Phase 46C — outcome mapping.
//
// Pure translation between three vocabularies that must never be conflated:
//
//   * the existing execution path's outcome        (response/timeout/...)
//   * the Phase 45A abort evaluator's classification (success/failure/error/...)
//   * the Phase 46B checkpoint step state            (COMPLETED/SKIPPED/FAILED)
//
// It also projects an execution result into the strict observed-response shape
// Phase 43 accepts, and builds a Phase 41 assertion-evidence record. No I/O.

export const EXECUTION_OUTCOMES = Object.freeze([
	"response",
	"timeout",
	"cancelled",
	"size_limit",
	"decode_error",
	"network_error",
]);

export function isKnownOutcome(outcome) {
	return EXECUTION_OUTCOMES.includes(outcome);
}

// The 45A abort evaluator only understands success/failure/error/canceled/skipped.
// A response with an error status is a failure: the request did not do what the
// rehearsal expected, and the safety limits exist to stop after such failures.
export function classifyExecution(result) {
	const outcome = result?.outcome;
	if (outcome === "response") {
		const status = result?.response?.status;
		if (Number.isInteger(status) && status >= 400) return "failure";
		return "success";
	}
	if (outcome === "timeout" || outcome === "size_limit" || outcome === "decode_error") return "failure";
	if (outcome === "network_error") return "error";
	if (outcome === "cancelled") return "canceled";
	return "error";
}

// Bounded, flat, credential-free metadata for a checkpoint step outcome. Phase 46B
// caps this at 32 fields of <=512 bytes each and rejects credential-shaped text,
// so only scalars derived from the result are written.
export function buildStepMetadata(result, { contractStatus = null, compatibility = null } = {}) {
	const metadata = {};
	if (typeof result?.outcome === "string") metadata.outcome = result.outcome;
	if (typeof result?.effectCertainty === "string") metadata.effectCertainty = result.effectCertainty;

	const status = result?.response?.status;
	if (Number.isInteger(status)) metadata.httpStatus = status;

	const totalMs = result?.response?.timing?.totalMs;
	if (Number.isFinite(totalMs)) metadata.durationMs = Math.max(0, Math.round(totalMs));

	if (result?.error) metadata.errored = true;

	if (contractStatus) metadata.contractStatus = contractStatus;
	if (compatibility) {
		metadata.compatible = compatibility.compatible === true;
		metadata.findings = compatibility.summary?.total ?? 0;
		metadata.breaking = compatibility.summary?.breaking ?? 0;
		metadata.nonBreaking = compatibility.summary?.nonBreaking ?? 0;
		metadata.unknown = compatibility.summary?.unknown ?? 0;
	}

	return metadata;
}

// Phase 46B requires an `outcomeId` of at most 128 bytes that is not
// credential-shaped. A readable `${stepId}:${outcome}` is preferred; when it does
// not fit, a deterministic hash keeps the id stable and bounded.
export function buildOutcomeId(stepId, outcome) {
	const readable = `${stepId}:${outcome}`;
	if (Buffer.byteLength(readable, "utf8") <= 120) return readable;
	return createHash("sha256").update(`${stepId}\u0000${outcome}`, "utf8").digest("hex").slice(0, 48);
}

// Project the execution path's response into Phase 43's strict observed-response
// shape. Only the four fields 43 accepts are emitted. When the body cannot be
// trusted (absent response, base64, truncated, or omitted for sensitivity), the
// caller must skip the comparison rather than present an absent body as a claim.
export function toObservedResponse(result, identity = null) {
	const response = result?.response;
	if (result?.outcome !== "response" || !response || !Number.isInteger(response.status)) {
		return { response: null, status: CONTRACT_STATUS.SKIPPED_NO_RESPONSE };
	}

	const body = response.body ?? null;
	if (!body || body.encoding !== "text" || body.truncated === true || body.omittedReason) {
		return { response: null, status: body ? CONTRACT_STATUS.SKIPPED_TRUNCATED : CONTRACT_STATUS.SKIPPED_NO_BODY };
	}

	const headers = Array.isArray(response.headers) ? response.headers.map((row) => ({ name: row.name, value: row.value })) : [];
	const contentType = headers.find((row) => String(row.name ?? "").toLowerCase() === "content-type")?.value ?? null;

	const observed = { status: response.status, headers, body: body.value };
	if (contentType) observed.contentType = contentType;
	if (identity) observed.identity = identity;

	return { response: observed, status: CONTRACT_STATUS.COMPARED };
}

// Phase 45A abort reason codes are the authority on *why* the policy tripped. The
// checkpoint run only accepts its own closed vocabulary, so the most severe
// mapped cause is persisted. The mapping is explicit and total.
const ABORT_REASON_PRIORITY = Object.freeze(["CRITICAL_FAILURE", "FAILURE_LIMIT_REACHED", "CONSECUTIVE_FAILURE_LIMIT_REACHED"]);
const ABORT_REASON_MAP = Object.freeze({
	CRITICAL_FAILURE: "BLAST_RADIUS_LIMIT",
	FAILURE_LIMIT_REACHED: "FAILURE_LIMIT_REACHED",
	CONSECUTIVE_FAILURE_LIMIT_REACHED: "FAILURE_LIMIT_REACHED",
});

export function mapAbortReasonCode(reasonCodes = []) {
	const present = new Set(reasonCodes);
	for (const code of ABORT_REASON_PRIORITY) {
		if (present.has(code)) return ABORT_REASON_MAP[code];
	}
	// An abort with an unrecognized cause is still an abort. Persisting the
	// policy-limit code is the honest, conservative fallback.
	return "BLAST_RADIUS_LIMIT";
}

// Build a Phase 41 assertion-evidence record from a Phase 43 comparison. A
// comparison that did not run produces no record at all: absence is what makes
// Phase 41 report NEEDS_REHEARSAL instead of a fabricated pass.
export function buildContractAssertion({ executionId, requestId, collectionId = null, snapshotId = null, snapshotFingerprint = null, environmentId = null, ownerProfileId = null, compatible, observedAt = null }) {
	return {
		assertionId: `${executionId}:contract`,
		requestId,
		status: compatible === true ? "passed" : "failed",
		required: true,
		collectionId,
		snapshotFingerprint,
		snapshotId,
		environmentId,
		ownerProfileId,
		observedAt,
	};
}
