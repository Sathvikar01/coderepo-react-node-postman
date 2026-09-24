import { AppError } from "../../shared/errors/app-error.js";
import { CONTRACT_STATE, CONTRACT_STATES } from "./contract-schema.js";

// Phase 42A — Contract lifecycle rules.
//
// A small, explicit state machine with no approval step:
//
//   DRAFT  --publish-->  PUBLISHED  --newer version published-->  SUPERSEDED
//     ^                      |
//     +----edit/replace------+   (drafts only)
//
// The transitions are pure predicates so both the service and tests reason about
// the same definitions. Published content is never rewritten; a change is always a
// new version.

export const LIFECYCLE_TRANSITIONS = Object.freeze({
	[CONTRACT_STATE.DRAFT]: [CONTRACT_STATE.PUBLISHED],
	[CONTRACT_STATE.PUBLISHED]: [CONTRACT_STATE.SUPERSEDED],
	[CONTRACT_STATE.SUPERSEDED]: [],
});

export function isValidContractState(state) {
	return CONTRACT_STATES.includes(state);
}

export function canTransition(from, to) {
	if (!isValidContractState(from) || !isValidContractState(to)) return false;
	return (LIFECYCLE_TRANSITIONS[from] ?? []).includes(to);
}

export function isMutable(state) {
	return state === CONTRACT_STATE.DRAFT;
}

export function isTerminal(state) {
	return state === CONTRACT_STATE.SUPERSEDED;
}

// A published contract's content can never change. Enforced here as a predicate so
// the repository's state filters and the service's guards agree.
export function assertMutable(contract) {
	if (!contract) throw new AppError(404, "CONTRACT_NOT_FOUND", "The requested contract version does not exist.");
	if (!isMutable(contract.state))
		throw new AppError(409, "CONTRACT_IMMUTABLE", `A ${contract.state} contract cannot be modified. Publish a new version instead.`, {
			contractId: contract.contractId,
			sequence: contract.sequence,
			state: contract.state,
		});
	return contract;
}

export function assertTransition(from, to) {
	if (!canTransition(from, to))
		throw new AppError(409, "CONTRACT_STATE_INVALID", `A contract cannot move from ${from} to ${to}.`, { from, to });
}

// Compare two contract content snapshots for lifecycle purposes. Identical content
// means a publish is a no-op, which the service reports rather than storing a
// redundant version.
export function contentEqual(left, right) {
	if (!left || !right) return false;
	return left.contentFingerprint === right.contentFingerprint;
}
