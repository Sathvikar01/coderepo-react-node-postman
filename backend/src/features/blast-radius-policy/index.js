// Phase 45A — Blast-Radius Safety Policy Core.
//
// Public surface. Backend-only, no routes, no persistence, no execution.
//
// Composition seam for later phases:
//
//   Change Impact  ->  Blast Radius Policy  ->  Checkpointed Rehearsal
//
// Not implemented here on purpose.

export {
	BLAST_RADIUS_POLICY_KIND,
	BLAST_RADIUS_POLICY_VERSION,
	BLAST_RADIUS_ENVELOPE_KIND,
	BLAST_RADIUS_ENVELOPE_VERSION,
	BLAST_RADIUS_ABORT_KIND,
	BLAST_RADIUS_ABORT_VERSION,
	BlastRadiusError,
	parseBlastRadiusInput,
	assertPolicyConsistent,
} from "./blast-radius-schema.js";

export {
	ADMISSION_STATES,
	ADMISSION_STATE_VALUES,
	REQUEST_CLASSIFICATIONS,
	REQUEST_CLASSIFICATION_VALUES,
	REASON_CODES,
	REASON_CODE_VALUES,
	BLAST_RADIUS_ERROR_CODES,
	ABORT_DECISIONS,
} from "./reason-codes.js";

export {
	classifyMethod,
	normalizeMethod,
	isWellFormedMethod,
	isMutatingClassification,
} from "./request-classification.js";

export {
	normalizeHost,
	hostKey,
	normalizeHostIdentity,
	normalizeMethodList,
	normalizeIdList,
	describeLimit,
	normalizePolicy,
	normalizeRequests,
} from "./policy-normalization.js";

export { admitRequest, evaluateEnvironment } from "./admission-rules.js";

export { buildEnvelope, buildExecutionEntry, buildResultEntry, buildHostSummary } from "./execution-envelope.js";

export {
	evaluateBlastRadius,
	evaluateAbort,
	policyIdentity,
	blastRadiusCanonicalJson,
} from "./blast-radius.service.js";
