// Phase 42A — API Contract Registry Core.
//
// A deterministic, backend-only registry for *versioned expected API response
// contracts*. It records one statement:
//
//   "For this request/workspace version, this is the response behavior we expect."
//
// It stores and validates contracts. It does not compare them to live executions,
// does not detect breaking changes, does not run requests, and has no UI.
//
// Public surface:
//
//   contractRegistryService.createDraft(profileId, input)        -> DRAFT row
//   contractRegistryService.updateDraft(profileId, id, seq, p)   -> DRAFT row
//   contractRegistryService.publish(profileId, id, seq)          -> { contract, idempotent, superseded }
//   contractRegistryService.getCurrentForRequest(profileId, req) -> live PUBLISHED row
//   contractRegistryService.listVersions(profileId, id)          -> full history
//
//   inferContractFromResponse({ response })                      -> candidate content
//
//   contractFingerprint(content)                                 -> stable content digest
//   canonicalContractJson(content)                               -> canonical bytes

export {
	CONTRACT_SCHEMA_VERSION,
	CONTRACT_KIND,
	CONTRACT_STATES,
	CONTRACT_STATE,
	CONTRACT_PROVENANCE,
	CONTRACT_VALUE_TYPES,
	CONTRACT_LIMITS,
	CONTRACT_SENSITIVE_HEADERS,
	isSensitiveHeader,
	contractTypeNodeSchema,
	contractBodySchema,
	contractIdentitySchema,
	contractDraftInputSchema,
	contractUpdateInputSchema,
	storedContractSchema,
	parseContractDraftInput,
	parseContractUpdateInput,
	parseContractBody,
	parseContractIdentity,
	parseStoredContract,
} from "./contract-schema.js";

export {
	canonicalizeContractValue,
	contractContentOf,
	canonicalContractJson,
	contractFingerprint,
	contractFingerprintKeyId,
	canonicalContractSummary,
	compareStrings,
} from "./contract-canonical.js";

export {
	LIFECYCLE_TRANSITIONS,
	isValidContractState,
	canTransition,
	isMutable,
	isTerminal,
	assertMutable,
	assertTransition,
	contentEqual,
} from "./contract-lifecycle.js";

export { inferContractBody, inferContractFromResponse, INFERRED_TYPES } from "./contract-inference.js";

export { createContractRegistryService, contractRegistryService } from "./contract.service.js";

export { contractRepository } from "./contract.repository.js";

export { ContractVersion, ContractCounter } from "./contract.model.js";
