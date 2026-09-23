import { randomUUID } from "node:crypto";
import { AppError } from "../../../shared/errors/app-error.js";
import { getConfig } from "../../../shared/config/index.js";
import { executionService } from "../../executions/execution.service.js";
import { historyService } from "../../history/history.service.js";
import { mockService } from "../../mocks/mock.service.js";
import { failurePredicateForRecord, sanitizeCapsuleRequest } from "../repro-capsule.js";
import {
	REPRODUCTION_DEFAULT_PROBES,
	normalizeProbeCount,
	runReproductionSeries,
	validateFailurePredicate,
} from "./reproduction-series.js";
import { reproductionRepository } from "./reproduction.repository.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function key(profileId, seriesId) {
	return `${profileId}:${seriesId}`;
}

function expiresAt() {
	return new Date(Date.now() + getConfig().execution.retentionDays * 24 * 60 * 60 * 1000);
}

// The stored series never contains the request, resolved credentials, headers,
// or bodies: only probe evidence (execution id, outcome, response status,
// predicate match, duration) plus the predicate itself. Free-text fields that
// could echo upstream failures are additionally scrubbed with every secret
// value the sanitized source request is known to carry.
function scrubSeries(result, secrets) {
	const scrub = (value) => {
		let output = String(value ?? "");
		for (const secret of secrets) {
			if (secret.length >= 3) output = output.split(secret).join("[REDACTED]");
		}
		return output;
	};
	return {
		...result,
		error: result.error ? { code: result.error.code, message: scrub(result.error.message) } : null,
		probes: result.probes.map((probe) => ({ ...probe, outcome: scrub(probe.outcome) })),
	};
}

function presentSeries(record) {
	if (!record) return null;
	return {
		schemaVersion: record.schemaVersion ?? 1,
		kind: record.kind ?? "tracer.reproduction-series",
		seriesId: record.seriesId,
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

export function createReproductionService({
	repository = reproductionRepository,
	history = historyService,
	executions = executionService,
	mocks = mockService,
} = {}) {
	const active = new Map();

	async function sourceRecord(profileId, executionId) {
		const record = await history.get(profileId, executionId);
		if (!record || record.expired || record.visible === false)
			throw new AppError(404, "HISTORY_NOT_FOUND", "The source history entry does not exist.");
		if (!record.receipt)
			throw new AppError(409, "RECEIPT_UNAVAILABLE", "The source history entry has no execution passport.");
		return record;
	}

	// Repeated probes of a mutating request are an amplified side-effect risk, so
	// they are only allowed against approved local targets or zero-network mocks.
	// Every probe still travels the normal compiler/policy/DNS/transport path, so
	// SSRF and target-policy boundaries remain in force for each attempt.
	function enforceSafety(record, input) {
		const method = String(record.request?.method ?? "").toUpperCase();
		const targetMode = input.targetMode ?? "execution";
		if (targetMode === "mock" || SAFE_METHODS.has(method)) return;
		if (record.receipt?.policy?.local !== true)
			throw new AppError(
				409,
				"REPRO_UNSAFE_METHOD",
				"Automatic probes for mutating methods require an approved local execution or mock mode.",
			);
		if (input.allowUnsafeLocal !== true)
			throw new AppError(
				409,
				"REPRO_CONFIRMATION_REQUIRED",
				"Confirm that this approved local target may receive repeated mutating requests.",
			);
	}

	async function start(profileId, input) {
		const record = await sourceRecord(profileId, input.sourceExecutionId);
		enforceSafety(record, input);
		const predicate = validateFailurePredicate(input.predicate ?? failurePredicateForRecord(record));
		const planned = normalizeProbeCount(input.probes ?? REPRODUCTION_DEFAULT_PROBES);
		const targetMode = input.targetMode ?? "execution";
		const seriesId = randomUUID();
		const startedAt = new Date();
		const created = await repository.create({
			ownerProfileId: profileId,
			seriesId,
			schemaVersion: 1,
			kind: "tracer.reproduction-series",
			sourceExecutionId: input.sourceExecutionId,
			status: "running",
			predicate,
			targetMode,
			probeBudget: planned,
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
			const executionId = randomUUID();
			let result;
			if (targetMode === "mock") {
				const resolved = await mocks.resolve(profileId, {
					request: candidate,
					environmentId: environment?.environmentId ?? undefined,
					executionId,
				});
				result = resolved?.result ?? resolved;
			} else {
				result = await executions.send(
					profileId,
					{
						executionId,
						tabId: `repro:${seriesId.slice(0, 8)}`,
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
			}
			return result && result.executionId ? result : { ...result, executionId };
		};

		const secrets = sanitizeCapsuleRequest(record.request).state.secrets;
		const promise = runReproductionSeries({
			request: record.request,
			predicate,
			probe,
			probeCount: planned,
			signal: controller.signal,
		})
			.then(async (result) => {
				const scrubbed = scrubSeries(result, secrets);
				return repository.update(profileId, seriesId, {
					status: scrubbed.status,
					result: scrubbed,
					error: scrubbed.error,
					finishedAt: new Date(),
				});
			})
			.catch(async () =>
				repository.update(profileId, seriesId, {
					status: "failed",
					result: null,
					error: { code: "REPRO_FAILED", message: "The reproduction series could not complete." },
					finishedAt: new Date(),
				}),
			)
			.finally(() => active.delete(key(profileId, seriesId)));
		active.set(key(profileId, seriesId), { controller, promise });
		return presentSeries(created);
	}

	async function status(profileId, seriesId) {
		let record = await repository.get(profileId, seriesId);
		if (!record) throw new AppError(404, "REPRO_NOT_FOUND", "The reproduction series does not exist.");
		if (record.status === "running" && !active.has(key(profileId, seriesId))) {
			record = await repository.update(profileId, seriesId, {
				status: "failed",
				error: { code: "REPRO_INTERRUPTED", message: "The server restarted before the reproduction series completed." },
				finishedAt: new Date(),
			});
		}
		return presentSeries(record);
	}

	async function wait(profileId, seriesId) {
		const running = active.get(key(profileId, seriesId));
		if (running) await running.promise;
		return status(profileId, seriesId);
	}

	async function cancel(profileId, seriesId) {
		const record = await repository.get(profileId, seriesId);
		if (!record) throw new AppError(404, "REPRO_NOT_FOUND", "The reproduction series does not exist.");
		if (record.status !== "running") return presentSeries(record);
		const running = active.get(key(profileId, seriesId));
		if (!running) return status(profileId, seriesId);
		running.controller.abort();
		await running.promise;
		return status(profileId, seriesId);
	}

	return { start, status, wait, cancel };
}

export const reproductionService = createReproductionService();
