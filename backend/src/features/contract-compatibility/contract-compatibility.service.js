import { AppError } from "../../shared/errors/app-error.js";
import {
	COMPARABLE_CONTRACT_STATES,
	parseCompatibilityInput,
	parseObservedResponse,
} from "./compatibility-schema.js";
import { normalizeObservedResponse } from "./response-normalization.js";
import { evaluateIdentity, runCompatibilityRules } from "./compatibility-rules.js";
import { buildCompatibilityResult } from "./compatibility-result.js";
import { parseStoredContract, isValidContractState } from "../contract-registry/index.js";

// Phase 43A — Contract compatibility service.
//
// The public boundary of the engine. It answers one question:
//
//   "Does this supplied API response remain compatible with this published Tracer
//    contract?"
//
// It performs comparison only. There is deliberately no persistence, no HTTP, no
// runner access, no contract write, no auto-capture, no UI, and no verification
// decision. Every fact it uses is handed in by the caller, which is what makes the
// result reproducible and the function pure enough to test exhaustively.

// A guard for the structural identity fields a contract must carry to be
// comparable. A contract missing these cannot be attributed, so comparing it would
// produce a result about an unknown expectation.
function assertComparableContract(contract) {
	if (!contract || typeof contract !== "object")
		throw new AppError(400, "COMPATIBILITY_CONTRACT_MISSING", "A published contract is required for comparison.");

	// Lifecycle safety: only a PUBLISHED version is a valid comparison authority.
	// A DRAFT is unfinished authoring and a SUPERSEDED row is history.
	if (!isValidContractState(contract.state))
		throw new AppError(400, "COMPATIBILITY_CONTRACT_STATE_INVALID", "The contract lifecycle state is not recognized.", {
			state: contract.state ?? null,
		});
	if (!COMPARABLE_CONTRACT_STATES.includes(contract.state))
		throw new AppError(409, "COMPATIBILITY_CONTRACT_NOT_PUBLISHED", `A ${contract.state} contract cannot be used for compatibility comparison. Only a PUBLISHED contract is authoritative.`, {
			state: contract.state,
			contractId: contract.contractId ?? null,
			sequence: contract.sequence ?? null,
		});

	// Identity completeness: an unattributable result is worse than no result.
	const missing = [];
	for (const field of ["contractId", "requestId", "contentFingerprint", "fingerprintKeyId"]) {
		if (contract[field] === undefined || contract[field] === null || String(contract[field]).length === 0) missing.push(field);
	}
	if (!Number.isInteger(contract.sequence) || contract.sequence < 1) missing.push("sequence");
	if (missing.length > 0)
		throw new AppError(400, "COMPATIBILITY_CONTRACT_IDENTITY_INCOMPLETE", "The contract identity is incomplete and cannot be compared.", { missing });

	// Content validity: the stored contract content must itself parse. A malformed
	// contract fails closed rather than being compared against a vocabulary it does
	// not conform to.
	try {
		parseStoredContract(contract.content);
	} catch (error) {
		if (error instanceof AppError)
			throw new AppError(400, "COMPATIBILITY_CONTRACT_MALFORMED", "The contract content is not valid and cannot be compared.", { issues: error.details?.issues ?? [] });
		throw error;
	}

	return contract;
}

// Compare one supplied response against one published contract.
//
// Pure with respect to its arguments: neither `contract` nor `response` is mutated.
// The result is deterministic — identical inputs yield a byte-identical report.
export function compareContractToResponse(input) {
	parseCompatibilityInput(input);
	const { contract, response } = input;

	const comparable = assertComparableContract(contract);
	const parsedResponse = parseObservedResponse(response);
	const observed = normalizeObservedResponse(parsedResponse);

	// Caller-provided identity that contradicts the contract is refused: comparing
	// another request's or profile's response would produce a confident result about
	// the wrong expectation.
	const mismatches = evaluateIdentity(comparable, observed.identity);
	if (mismatches.length > 0)
		throw new AppError(
			409,
			"COMPATIBILITY_IDENTITY_MISMATCH",
			"The supplied response identity contradicts the contract and cannot be compared.",
			{ mismatches },
		);

	const { findings, statusChecked, headersChecked, bodyStructureChecked } = runCompatibilityRules({ contract: comparable, observed });

	return buildCompatibilityResult({
		contract: comparable,
		observed,
		findings,
		statusChecked,
		headersChecked,
		bodyStructureChecked,
	});
}

// A convenience seam for a caller whose sample carries its own identity alongside
// the response, so later phases can attach execution identity without reshaping
// the engine's input.
export function compareContractToObserved({ contract, observed, identity = null } = {}) {
	return compareContractToResponse({
		contract,
		response: identity ? { ...observed, identity } : observed,
	});
}
