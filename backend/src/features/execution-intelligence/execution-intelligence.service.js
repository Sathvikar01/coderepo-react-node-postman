import { AppError } from "../../shared/errors/app-error.js";
import { historyService } from "../history/history.service.js";
import { compareReceipts } from "./run-comparison.js";
import { buildReproCapsule, parseReproCapsule, serializeReproCapsule } from "./repro-capsule.js";

function capsuleFilename(name) {
	const slug = String(name ?? "request")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return `${slug || "request"}.repro.json`;
}

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
		async exportCapsule(profileId, executionId, options = {}) {
			const value = await record(profileId, executionId);
			const capsule = buildReproCapsule(value, options);
			return { filename: capsuleFilename(value.request?.name), text: serializeReproCapsule(capsule) };
		},
		importCapsule(text) {
			const capsule = parseReproCapsule(text);
			return {
				draft: structuredClone(capsule.request),
				dirty: true,
				autoSend: false,
				autoSave: false,
				requiredInputs: capsule.requiredInputs,
				predicate: capsule.predicate,
				receiptSummary: capsule.receipt,
				warnings: ["Review and provide every required input before sending this draft."],
			};
		},
	};
}

export const executionIntelligenceService = createExecutionIntelligenceService();
