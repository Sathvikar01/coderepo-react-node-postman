/**
 * Phase 31 — counterfactual verification service wrapper.
 *
 * Loads the two profile-scoped history records, enforces the same safety model
 * the failure minimizer uses (safe methods automatically; mutating methods only
 * against an approved local execution or an explicit mock), and drives the pure
 * engine through the *normal* execution pipeline. It deliberately does not
 * register routes or persist jobs: Phase 31 is the verification capability, and
 * wiring it into the workspace is a later, separately-authorized phase.
 */

import { randomUUID } from "node:crypto";
import { AppError } from "../../../shared/errors/app-error.js";
import { executionService } from "../../executions/execution.service.js";
import { historyService } from "../../history/history.service.js";
import { mockService } from "../../mocks/mock.service.js";
import { failurePredicateForRecord } from "../repro-capsule.js";
import { COUNTERFACTUAL_MAX_PROBES, COUNTERFACTUAL_SAFE_METHODS } from "./counterfactual-model.js";
import { verifyCounterfactual } from "./counterfactual.js";

const SAFE_METHODS = new Set(COUNTERFACTUAL_SAFE_METHODS);

export function createCounterfactualService({
	history = historyService,
	executions = executionService,
	mocks = mockService,
} = {}) {
	async function sourceRecord(profileId, executionId) {
		if (!executionId) throw new AppError(400, "COUNTERFACTUAL_INPUT", "Both base and candidate execution identifiers are required.");
		const record = await history.get(profileId, executionId);
		if (!record || record.expired || record.visible === false)
			throw new AppError(404, "COUNTERFACTUAL_NOT_FOUND", "A source history entry does not exist.");
		if (!record.receipt)
			throw new AppError(409, "COUNTERFACTUAL_RECEIPT_UNAVAILABLE", "A source history entry has no execution passport.");
		if (!record.request)
			throw new AppError(409, "COUNTERFACTUAL_REQUEST_UNAVAILABLE", "A source history entry has no request definition.");
		return record;
	}

	function enforceSafety(record, input) {
		const method = String(record.request?.method ?? "").toUpperCase();
		const targetMode = input.targetMode ?? "execution";
		if (targetMode === "mock" || SAFE_METHODS.has(method)) return;
		if (record.receipt?.policy?.local !== true)
			throw new AppError(
				409,
				"COUNTERFACTUAL_UNSAFE_METHOD",
				"Automatic probes for mutating methods require an approved local execution or mock mode.",
			);
		if (input.allowUnsafeLocal !== true)
			throw new AppError(
				409,
				"COUNTERFACTUAL_CONFIRMATION_REQUIRED",
				"Confirm that this approved local target may receive repeated mutating requests.",
			);
	}

	return {
		/**
		 * @param {string} profileId
		 * @param {{ baseExecutionId: string, candidateExecutionId: string, predicate?: object, targetMode?: "execution"|"mock", allowUnsafeLocal?: boolean, maxProbes?: number }} input
		 * @param {{ signal?: AbortSignal|null }} [options]
		 */
		async analyze(profileId, input = {}, { signal = null } = {}) {
			if (!input.baseExecutionId || !input.candidateExecutionId)
				throw new AppError(400, "COUNTERFACTUAL_INPUT", "Both base and candidate execution identifiers are required.");
			if (input.baseExecutionId === input.candidateExecutionId)
				throw new AppError(400, "COUNTERFACTUAL_INPUT", "Base and candidate executions must differ.");

			const base = await sourceRecord(profileId, input.baseExecutionId);
			const candidate = await sourceRecord(profileId, input.candidateExecutionId);
			enforceSafety(base, input);
			enforceSafety(candidate, input);

			const targetMode = input.targetMode ?? "execution";
			const predicate = input.predicate ?? failurePredicateForRecord(candidate);
			const environment = candidate.context?.environment ?? null;
			const approvedLocal = base.receipt?.policy?.local === true || candidate.receipt?.policy?.local === true;
			const mutatingAllowed = targetMode === "mock" || (approvedLocal && input.allowUnsafeLocal === true);
			let attempt = 0;

			const probe = async (request) => {
				attempt += 1;
				if (targetMode === "mock") {
					const resolved = await mocks.resolve(profileId, {
						request,
						environmentId: environment?.environmentId ?? undefined,
						executionId: randomUUID(),
					});
					return resolved.result;
				}
				return executions.send(
					profileId,
					{
						executionId: randomUUID(),
						tabId: `cf:${String(input.candidateExecutionId).slice(0, 8)}`,
						draftVersion: attempt,
						request,
						context: {
							replayHistoryId: input.candidateExecutionId,
							...(environment?.environmentId
								? {
									environmentId: environment.environmentId,
									environmentRevision: environment.environmentRevision,
								}
								: {}),
						},
					},
					{ rateLimit: false, visible: false },
				);
			};

			return verifyCounterfactual({
				baseRequest: base.request,
				candidateRequest: candidate.request,
				baseReceipt: base.receipt,
				candidateReceipt: candidate.receipt,
				baseExecutionId: input.baseExecutionId,
				candidateExecutionId: input.candidateExecutionId,
				predicate,
				probe,
				signal,
				maxProbes: input.maxProbes ?? COUNTERFACTUAL_MAX_PROBES,
				safety: { mutatingAllowed },
			});
		},
	};
}

export const counterfactualService = createCounterfactualService();
