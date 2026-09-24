// Phase 43A — API Contract Compatibility Engine.
//
// Public boundary for the deterministic compatibility engine. It answers one
// question and nothing else:
//
//   "Does this supplied API response remain compatible with this published Tracer
//    contract?"
//
// It performs comparison only. It never sends an HTTP request, updates a contract,
// captures a contract, touches the runner, exposes UI, or makes a verification
// decision for Phase 41. Every fact it uses is supplied by the caller.
//
// Usage:
//
//   const report = compareContractToResponse({
//     contract,                       // a PUBLISHED Phase-42 contract row
//     response: {
//       status: 200,
//       headers: [{ name: "content-type", value: "application/json" }],
//       body: { id: "user-1", name: "Ada" },
//       identity: { requestId, workspaceId, profileId },   // optional; contradicts -> refuse
//     },
//   });
//
//   report.compatible   // true | false
//   report.findings[]   // { code, class, path, contractPath, parentPath, expected, actual, severity }
//   report.summary      // { total, breaking, nonBreaking, unknown, statusChecked, headersChecked, bodyStructureChecked }

export {
	COMPATIBILITY_KIND,
	COMPATIBILITY_SCHEMA_VERSION,
	COMPATIBILITY_CLASSES,
	COMPATIBILITY_CLASS,
	COMPATIBILITY_CODES,
	COMPATIBILITY_CODE_VALUES,
	CODE_CLASSES,
	classForCode,
	COMPARABLE_CONTRACT_STATES,
	findingSchema,
	compatibilityResultSchema,
	assertCompatibilityResult,
	parseObservedResponse,
	parseCompatibilityInput,
} from "./compatibility-schema.js";

export {
	BODY_REPRESENTATION,
	SUSPECT_PROPERTY_NAMES,
	observableTypeOf,
	isPlainObject,
	normalizeHeaders,
	normalizeBody,
	normalizeObservedResponse,
} from "./response-normalization.js";

export { compareHeaders, compareHeader } from "./header-compatibility.js";

export { compareBody, compareNode } from "./body-compatibility.js";

export { evaluateStatus, evaluateIdentity, runCompatibilityRules, IDENTITY_CODES } from "./compatibility-rules.js";

export {
	compareStrings,
	severityOf,
	findingSortKey,
	dedupeFindings,
	sortFindings,
	resolveCompatible,
	buildCompatibilityResult,
} from "./compatibility-result.js";

export { compareContractToResponse, compareContractToObserved } from "./contract-compatibility.service.js";

import { compareContractToResponse } from "./contract-compatibility.service.js";

// ---------------------------------------------------------------------------
// Injectable integration seam
// ---------------------------------------------------------------------------
//
// Later phases must be able to compose this engine into a larger pipeline without
// changing it:
//
//   Execution Result
//     -> Contract Compatibility        (this phase)
//     -> Cross-Environment Verification (a later integration phase)
//
// The factory below is that seam. It accepts a contract source so a caller can hand
// the engine a resolved published contract (from the Phase-42 registry or anywhere
// else) without this module importing or depending on the resolution path. The
// engine itself is unchanged: the same pure comparison runs.
//
// The compatibility result is returned as-is. Translating it into verification
// evidence is explicitly deferred to the integration phase, so this engine does not
// make — or influence — a Phase-41 verification decision.
export function createContractCompatibilityComparator({ contractSource = null } = {}) {
	return function compare({ contract, response, ...rest } = {}) {
		const resolved = contract ?? (contractSource ? contractSource(rest) : null);
		if (!resolved) throw new Error("createContractCompatibilityComparator requires a contract or a contractSource.");
		return compareContractToResponse({ contract: resolved, response });
	};
}

// A structural guard used by the integration phase to confirm a Phase-43 result is
// the shape it expects, without importing the builder.
export function acceptsCompatibilityResultShape(value) {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		typeof value.compatible === "boolean" &&
		Array.isArray(value.findings) &&
		value.summary !== undefined &&
		value.contract !== undefined
	);
}
