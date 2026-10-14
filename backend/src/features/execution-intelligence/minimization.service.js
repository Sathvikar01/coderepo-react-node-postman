import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.js";
import { getConfig } from "../../shared/config/index.js";
import { executionService } from "../executions/execution.service.js";
import { historyService } from "../history/history.service.js";
import { mockService } from "../mocks/mock.service.js";
import { minimizeFailure, MINIMIZATION_MAX_PROBES } from "./failure-minimizer.js";
import { minimizationRepository } from "./minimization.repository.js";
import { failurePredicateForRecord, sanitizeCapsuleRequest } from "./repro-capsule.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function key(profileId, jobId) {
	return `${profileId}:${jobId}`;
}

function expiresAt() {
	return new Date(Date.now() + getConfig().execution.retentionDays * 24 * 60 * 60 * 1000);
}

function publicFailure(error) {
	const code = error?.code ?? "MINIMIZATION_FAILED";
	const messages = {
		MINIMIZATION_CANCELLED: "Failure minimization was cancelled.",
		MINIMIZATION_FLAKY: "The selected failure was not stable across baseline probes.",
		MINIMIZATION_PREDICATE_NOT_MET: "The source request no longer reproduces the selected failure.",
	};
	return { code, message: messages[code] ?? "Failure minimization could not complete." };
}

function presentJob(record) {
	if (!record) return null;
	return {
		schemaVersion: record.schemaVersion ?? 1,
		kind: record.kind ?? "tracer.minimization-job",
		jobId: record.jobId,
		sourceExecutionId: record.sourceExecutionId,
		status: record.status,
		predicate: record.predicate,
		targetMode: record.targetMode,
		probeBudget: record.probeBudget,
		result: record.result ?? null,
		error: record.error ?? null,
		startedAt: record.startedAt ?? null,
		finishedAt: record.finishedAt ?? null,
	};
}

export function createMinimizationService({
	repository = minimizationRepository,
	history = historyService,
	executions = executionService,
	mocks = mockService,
} = {}) {
	const active = new Map();

	// Applies a terminal transition atomically. If the expected source state no longer
	// matches, another writer already finalized the job, so reload and return the
	// canonical stored terminal record instead of overwriting the winner.
	async function finalize(profileId, jobId, expectedStatus, patch) {
		const updated = await repository.transition(profileId, jobId, expectedStatus, patch);
		if (updated) return updated;
		return repository.get(profileId, jobId);
	}

	async function sourceRecord(profileId, executionId) {
		const record = await history.get(profileId, executionId);
		if (!record || record.expired || record.visible === false)
			throw new AppError(404, "HISTORY_NOT_FOUND", "The source history entry does not exist.");
		if (!record.receipt)
			throw new AppError(409, "RECEIPT_UNAVAILABLE", "The source history entry has no execution passport.");
		return record;
	}

	function enforceSafety(record, input) {
		const method = String(record.request?.method ?? "").toUpperCase();
		const targetMode = input.targetMode ?? "execution";
		if (targetMode === "mock" || SAFE_METHODS.has(method)) return;
		if (record.receipt?.policy?.local !== true)
			throw new AppError(
				409,
				"MINIMIZATION_UNSAFE_METHOD",
				"Automatic probes for mutating methods require an approved local execution or mock mode.",
			);
		if (input.allowUnsafeLocal !== true)
			throw new AppError(
				409,
				"MINIMIZATION_CONFIRMATION_REQUIRED",
				"Confirm that this approved local target may receive repeated mutating requests.",
			);
	}

	async function start(profileId, input) {
		const record = await sourceRecord(profileId, input.sourceExecutionId);
		enforceSafety(record, input);
		const jobId = randomUUID();
		const targetMode = input.targetMode ?? "execution";
		const predicate = input.predicate ?? failurePredicateForRecord(record);
		const startedAt = new Date();
		const created = await repository.create({
			ownerProfileId: profileId,
			jobId,
			schemaVersion: 1,
			kind: "tracer.minimization-job",
			sourceExecutionId: input.sourceExecutionId,
			status: "running",
			predicate,
			targetMode,
			probeBudget: MINIMIZATION_MAX_PROBES,
			result: null,
			error: null,
			startedAt,
			finishedAt: null,
			expiresAt: expiresAt(),
		});

		const controller = new AbortController();
		let attempt = 0;
		const environment = record.context?.environment ?? null;
		const probe = async (candidate) => {
			attempt += 1;
			if (targetMode === "mock") {
				const resolved = await mocks.resolve(profileId, {
					request: candidate,
					environmentId: environment?.environmentId ?? undefined,
					executionId: randomUUID(),
				});
				return resolved.result;
			}
			return executions.send(
				profileId,
				{
					executionId: randomUUID(),
					tabId: `min:${jobId.slice(0, 8)}`,
					draftVersion: attempt,
					request: candidate,
					context: {
						replayHistoryId: input.sourceExecutionId,
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

		const promise = minimizeFailure({
			request: record.request,
			predicate,
			probe,
			signal: controller.signal,
			maxProbes: MINIMIZATION_MAX_PROBES,
		})
			.then(async (result) => {
				const sanitized = sanitizeCapsuleRequest(result.request);
				return finalize(profileId, jobId, "running", {
					status: "completed",
					result: { ...result, request: sanitized.request, requiredInputs: [...sanitized.state.inputs.values()] },
					error: null,
					finishedAt: new Date(),
				});
			})
			.catch(async (error) =>
				finalize(profileId, jobId, "running", {
					status: error?.code === "MINIMIZATION_CANCELLED" ? "cancelled" : "failed",
					result: null,
					error: publicFailure(error),
					finishedAt: new Date(),
				}),
			)
			.finally(() => active.delete(key(profileId, jobId)));
		active.set(key(profileId, jobId), { controller, promise });
		return presentJob(created);
	}

	async function status(profileId, jobId) {
		let record = await repository.get(profileId, jobId);
		if (!record) throw new AppError(404, "MINIMIZATION_NOT_FOUND", "The minimization job does not exist.");
		if (record.status === "running" && !active.has(key(profileId, jobId))) {
			record = await finalize(profileId, jobId, "running", {
				status: "failed",
				error: { code: "MINIMIZATION_INTERRUPTED", message: "The server restarted before minimization completed." },
				finishedAt: new Date(),
			});
		}
		return presentJob(record);
	}

	async function wait(profileId, jobId) {
		const running = active.get(key(profileId, jobId));
		if (running) await running.promise;
		return status(profileId, jobId);
	}

	async function cancel(profileId, jobId) {
		const record = await repository.get(profileId, jobId);
		if (!record) throw new AppError(404, "MINIMIZATION_NOT_FOUND", "The minimization job does not exist.");
		if (record.status !== "running") return presentJob(record);
		const running = active.get(key(profileId, jobId));
		if (!running) return status(profileId, jobId);
		running.controller.abort();
		await running.promise;
		return status(profileId, jobId);
	}

	return { start, status, wait, cancel };
}

export const minimizationService = createMinimizationService();
