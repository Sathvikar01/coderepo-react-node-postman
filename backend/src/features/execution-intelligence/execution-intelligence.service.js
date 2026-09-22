import { AppError } from "../../shared/errors/app-error.js";
import { historyService } from "../history/history.service.js";
import { compareReceipts } from "./run-comparison.js";

export function createExecutionIntelligenceService({ history = historyService } = {}) {
	async function record(profileId, executionId) {
		const value = await history.get(profileId, executionId);
		if (!value || value.expired || value.visible === false)
			throw new AppError(404, "HISTORY_NOT_FOUND", "The requested history entry does not exist.");
		return value;
	}

	async function receipt(profileId, executionId) {
		const value = await record(profileId, executionId);
		if (!value.receipt)
			throw new AppError(409, "RECEIPT_UNAVAILABLE", "This history entry predates execution passports and cannot be analyzed.");
		return value.receipt;
	}

	return {
		getRecord: record,
		getReceipt: receipt,
		async compare(profileId, baseExecutionId, candidateExecutionId) {
			const [base, candidate] = await Promise.all([
				receipt(profileId, baseExecutionId),
				receipt(profileId, candidateExecutionId),
			]);
			return compareReceipts(base, candidate);
		},
	};
}

export const executionIntelligenceService = createExecutionIntelligenceService();
