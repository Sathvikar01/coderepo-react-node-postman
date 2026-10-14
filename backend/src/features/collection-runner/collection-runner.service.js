import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.js";
import { getConfig } from "../../shared/config/index.js";
import { collectionRepository } from "../collections/collection.repository.js";
import { environmentRepository } from "../environments/environment.repository.js";
import { executionService } from "../executions/execution.service.js";
import { collectionRunRepository } from "./collection-run.repository.js";
import { RUN_LIMITS } from "./run-limits.js";
import { buildRunPlan } from "./run-plan.js";
import { assertionCountsOf, failureReasonOf, stepPassed, summarizeSteps } from "./run-summary.js";

// The collection runner executes saved requests as ordered runs of ordinary
// executions. There is no second transport: every step goes through the normal
// compile -> policy -> DNS -> transport -> capture -> normalize -> history pipeline
// with its own execution identifier and Execution Passport, so SSRF policy, cookies,
// auth, scripts, assertions, timeouts, and redaction behave exactly as a manual send.
//
// Variable scopes, lowest to highest precedence:
//   1. initial  - run inputs supplied when the run starts.
//   2. collection / environment - the persisted scopes (environment wins).
//   3. run      - writes made by scripts during this run, propagated to later steps.
//   4. request/script - the current step's script writes; they fold into run scope.
// Run and script writes live only in memory for the duration of the run, so a run
// never corrupts persisted environments or collections.

const SKIP_REASONS = {
	cancelled: "The run was cancelled before this request ran.",
	duration: "The run reached its time budget before this request ran.",
	stop_on_failure: "The run stopped at the first failure before this request ran.",
	interrupted: "The run ended before this request ran.",
};

function key(profileId, runId) {
	return `${profileId}:${runId}`;
}

function expiresAt() {
	return new Date(Date.now() + getConfig().execution.retentionDays * 24 * 60 * 60 * 1000);
}

function publicStep(step) {
	const { snapshot, ...record } = step;
	return record;
}

function plainRunVariables(variables, collection, environment) {
	const reserved = new Set();
	for (const variable of [...(collection?.variables ?? []), ...(environment?.variables ?? [])]) {
		if (variable.kind === "secretRef") reserved.add(variable.key);
	}
	const map = new Map();
	for (const variable of variables ?? []) {
		if (reserved.has(variable.key))
			throw new AppError(
				400,
				"RUN_VARIABLE_RESERVED",
				`The variable "${variable.key}" is a secret reference and cannot be set as a run variable.`,
				{ key: variable.key },
			);
		map.set(variable.key, String(variable.value ?? ""));
	}
	return map;
}

function skippedSteps(results, reason) {
	return results.map((step) =>
		step.status === "pending" || step.status === "running"
			? { ...step, status: "skipped", failureReason: reason, finishedAt: step.finishedAt ?? new Date() }
			: step,
	);
}

function presentRun(record, { includeResults = true } = {}) {
	const steps = record.results ?? [];
	const completed = steps.filter((step) => step.status !== "pending" && step.status !== "running").length;
	const payload = {
		schemaVersion: record.schemaVersion ?? 1,
		kind: record.kind ?? "tracer.collection-run",
		runId: record.runId,
		collection: { id: record.collectionId, name: record.collectionName, revision: record.collectionRevision },
		environment: record.environmentId ? { id: record.environmentId, revision: record.environmentRevision ?? null } : null,
		options: {
			selection: record.input?.selection ?? { mode: "collection" },
			iterations: record.input?.iterations ?? 1,
			stopOnFailure: record.input?.stopOnFailure !== false,
			variableKeys: (record.input?.variables ?? []).map((variable) => variable.key),
		},
		status: record.status,
		stopReason: record.stopReason ?? null,
		progress: { total: steps.length, completed },
		summary: record.summary ?? null,
		error: record.error ?? null,
		startedAt: record.startedAt ?? null,
		finishedAt: record.finishedAt ?? null,
	};
	if (includeResults) payload.results = steps;
	return payload;
}

export function createCollectionRunnerService({
	repository = collectionRunRepository,
	collections = collectionRepository,
	environments = environmentRepository,
	executions = executionService,
} = {}) {
	const active = new Map();
	// Admission reservations. A slot is claimed synchronously, before the first await
	// of a start request, and converted into the real active entry once the run record
	// exists. Both limits count reservations, so two starts racing for one remaining
	// slot cannot both observe free capacity.
	const reservations = new Map();

	function countFor(profileId) {
		let count = 0;
		for (const entry of active.values()) if (entry.profileId === profileId) count += 1;
		for (const reservedProfileId of reservations.values()) if (reservedProfileId === profileId) count += 1;
		return count;
	}

	function inUse() {
		return active.size + reservations.size;
	}

	// Synchronous admission: both limits are checked and a slot is reserved in one
	// uninterrupted turn, so no await can interleave between observing free capacity and
	// claiming it. The reservation is released by the caller on every failure path.
	function admit(profileId) {
		const runId = randomUUID();
		const reservationKey = key(profileId, runId);
		if (inUse() >= RUN_LIMITS.activeRunsPerProcess)
			throw new AppError(429, "RUN_CONCURRENCY_LIMIT", "The server is already running the maximum number of collection runs.", {
				limit: RUN_LIMITS.activeRunsPerProcess,
				scope: "process",
			});
		if (countFor(profileId) >= RUN_LIMITS.activeRunsPerProfile)
			throw new AppError(429, "RUN_CONCURRENCY_LIMIT", "This profile already has a collection run in progress.", {
				limit: RUN_LIMITS.activeRunsPerProfile,
				scope: "profile",
			});
		reservations.set(reservationKey, profileId);
		return { runId, reservationKey };
	}

	// Applies a lifecycle transition atomically. If the expected source state no longer
	// matches, another writer already moved the run, so reload the canonical stored
	// record instead of retrying or overwriting the winner.
	async function finalize(profileId, runId, expectedStatus, patch) {
		const updated = await repository.transition(profileId, runId, expectedStatus, patch);
		if (updated) return updated;
		return repository.get(profileId, runId);
	}

	async function executeRun(profileId, workspaceId, record, plan, initialVariables, signal, entry) {
		const steps = plan.steps.map((step) => ({
			index: step.index,
			iteration: step.iteration,
			requestId: step.requestId,
			name: step.name,
			method: step.method,
			status: "pending",
			executionId: null,
			outcome: null,
			httpStatus: null,
			assertions: { passed: 0, failed: 0, errors: 0 },
			durationMs: null,
			failureReason: null,
			startedAt: null,
			finishedAt: null,
			snapshot: step.snapshot,
		}));
		// Progress writes stay compare-and-set on `running` so a late progress writer can
		// never rewrite the results of a run another writer has already finalized.
		const persist = (patch) => repository.transition(profileId, record.runId, "running", patch);
		const runWrites = new Map();
		const deadlineAt = Date.now() + RUN_LIMITS.durationMs;
		let stopReason = null;
		let status = "completed";

		for (const step of steps) {
			if (!stopReason) {
				if (signal.aborted) {
					status = "cancelled";
					stopReason = "cancelled";
				} else if (Date.now() >= deadlineAt) stopReason = "duration";
			}
			if (stopReason) {
				if (step.status === "pending") {
					step.status = "skipped";
					step.failureReason = SKIP_REASONS[stopReason] ?? SKIP_REASONS.interrupted;
				}
				continue;
			}
			step.status = "running";
			step.startedAt = new Date();
			await persist({ results: steps.map(publicStep) });
			const executionId = randomUUID();
			entry.currentExecutionId = executionId;
			let result = null;
			let failure = null;
			try {
				result = await executions.send(
					profileId,
					{
						executionId,
						tabId: `run:${record.runId.slice(0, 8)}`,
						draftVersion: step.index,
						request: step.snapshot,
						context: {
							collectionId: record.collectionId,
							collectionRevision: record.collectionRevision,
							requestId: step.requestId,
							...(record.environmentId
								? { environmentId: record.environmentId, environmentRevision: record.environmentRevision ?? undefined }
								: {}),
						},
					},
					{ rateLimit: false, workspaceId, runScope: { initial: initialVariables, writes: runWrites } },
				);
			} catch (error) {
				failure = error;
			}
			entry.currentExecutionId = null;
			step.finishedAt = new Date();
			step.durationMs = step.finishedAt.getTime() - step.startedAt.getTime();
			if (failure) {
				// Context or admission errors leave no execution record, so there is no
				// passport to link. Everything else returns a terminal result.
				step.status = "failed";
				step.failureReason = failureReasonOf({ outcome: "validation_error", error: failure, scriptResults: null });
			} else {
				for (const write of result.variableWrites ?? []) runWrites.set(write.key, write.value);
				const passed = stepPassed(result);
				step.status = passed ? "passed" : result.outcome === "cancelled" ? "cancelled" : "failed";
				step.outcome = result.outcome;
				step.httpStatus = result.response?.status ?? null;
				step.assertions = assertionCountsOf(result.scriptResults);
				step.executionId = result.executionId ?? executionId;
				step.failureReason = passed ? null : failureReasonOf(result);
			}
			await persist({ results: steps.map(publicStep) });
			if (step.status !== "passed" && !stopReason && record.input?.stopOnFailure !== false) stopReason = "stop_on_failure";
		}

		if (signal.aborted) {
			status = "cancelled";
			stopReason = "cancelled";
		}

		const finalSteps = steps.map((step) =>
			step.status === "pending" || step.status === "running"
				? { ...step, status: "skipped", failureReason: SKIP_REASONS[stopReason] ?? SKIP_REASONS.interrupted }
				: step,
		);
		return finalize(profileId, record.runId, "running", {
			status,
			stopReason,
			results: finalSteps.map(publicStep),
			summary: summarizeSteps(finalSteps),
			finishedAt: new Date(),
		});
	}

	// `scope` carries the resolved workspace when the run is started from the shared
	// workspace API. Run *records* stay profile-scoped (a personal artifact), but the
	// collection and environment being executed are looked up inside that workspace so
	// an EDITOR can run a collection that a collaborator authored.
	async function start(profileId, input, scope = null) {
		const workspaceId = scope?.workspaceId ?? null;
		// Reserve a slot synchronously, before the first await, so two concurrent starts
		// cannot both observe free capacity and both proceed.
		const { runId, reservationKey } = admit(profileId);
		try {
			return await startReserved(profileId, runId, reservationKey, workspaceId, input);
		} catch (error) {
			// Every failure path releases the reservation and any partially registered
			// active entry, so a failed start never leaks capacity or leaves a ghost run.
			reservations.delete(reservationKey);
			active.delete(reservationKey);
			throw error;
		}
	}

	async function startReserved(profileId, runId, reservationKey, workspaceId, input) {
		const collection =
			workspaceId && collections.findByIdInWorkspace
				? await collections.findByIdInWorkspace(input.collectionId, workspaceId)
				: await collections.findById(input.collectionId, profileId);
		if (!collection) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
		if (input.collectionRevision !== undefined && input.collectionRevision !== collection.revision)
			throw new AppError(
				409,
				"CONTEXT_CHANGED",
				"This collection changed after the run was prepared. Reload the collection and run again.",
			);
		let environment = null;
		if (input.environmentId) {
			environment =
				workspaceId && environments.findByIdInWorkspace
					? await environments.findByIdInWorkspace(input.environmentId, workspaceId)
					: await environments.findById(input.environmentId, profileId);
			if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
			if (input.environmentRevision !== undefined && input.environmentRevision !== environment.revision)
				throw new AppError(
					409,
					"CONTEXT_CHANGED",
					"This environment changed after it was selected. Reload the environment and run again.",
				);
		}
		const plan = buildRunPlan({ collection, selection: input.selection, iterations: input.iterations });
		const initialVariables = plainRunVariables(input.variables, collection, environment);
		const startedAt = new Date();
		const storedInput = {
			selection: input.selection,
			iterations: plan.iterations,
			stopOnFailure: input.stopOnFailure !== false,
			variables: (input.variables ?? []).map((variable) => ({ key: variable.key, value: String(variable.value ?? "") })),
		};
		const created = await repository.create({
			ownerProfileId: profileId,
			runId,
			schemaVersion: 1,
			kind: "tracer.collection-run",
			collectionId: String(collection._id),
			collectionRevision: collection.revision,
			collectionName: collection.name,
			environmentId: environment ? String(environment._id) : null,
			environmentRevision: environment ? environment.revision : null,
			input: storedInput,
			status: "running",
			stopReason: null,
			results: plan.steps.map((step) => ({
				index: step.index,
				iteration: step.iteration,
				requestId: step.requestId,
				name: step.name,
				method: step.method,
				status: "pending",
				executionId: null,
				outcome: null,
				httpStatus: null,
				assertions: { passed: 0, failed: 0, errors: 0 },
				durationMs: null,
				failureReason: null,
				startedAt: null,
				finishedAt: null,
			})),
			summary: null,
			error: null,
			startedAt,
			finishedAt: null,
			expiresAt: expiresAt(),
		});
		const controller = new AbortController();
		const entry = { profileId, controller, currentExecutionId: null, promise: null };
		// Convert the reservation into the real active entry before the run loop starts so
		// cancellation can reach the in-flight execution immediately. The reservation is
		// removed first so the combined in-use count never exceeds the limit.
		reservations.delete(reservationKey);
		active.set(reservationKey, entry);
		entry.promise = executeRun(profileId, workspaceId, { ...created, input: storedInput }, plan, initialVariables, controller.signal, entry)
			.catch(async (error) => {
				const steps = skippedSteps(
					(await repository.get(profileId, runId))?.results ?? [],
					SKIP_REASONS.interrupted,
				);
				// Terminal transitions require the run to still be `running` and fail closed
				// otherwise, so this recovery cannot overwrite a completion or cancellation
				// that already won. A lost CAS reloads the canonical terminal record.
				await finalize(profileId, runId, "running", {
					status: "failed",
					stopReason: "error",
					error: {
						code: error?.code ?? "RUN_FAILED",
						message: error?.message ?? "The collection run could not complete.",
					},
					results: steps,
					summary: summarizeSteps(steps),
					finishedAt: new Date(),
				});
			})
			.finally(() => active.delete(reservationKey));
		return presentRun(created);
	}

	async function status(profileId, runId) {
		let record = await repository.get(profileId, runId);
		if (!record) throw new AppError(404, "RUN_NOT_FOUND", "The requested collection run does not exist.");
		if (record.status === "running" && !active.has(key(profileId, runId))) {
			const steps = skippedSteps(record.results ?? [], SKIP_REASONS.interrupted);
			// Fail closed: recover only an actually-running record, and reload the
			// canonical state if another writer finalized it first.
			record = await finalize(profileId, runId, "running", {
				status: "failed",
				stopReason: record.stopReason ?? "interrupted",
				error: { code: "RUN_INTERRUPTED", message: "The server restarted before this run completed." },
				results: steps,
				summary: summarizeSteps(steps),
				finishedAt: new Date(),
			});
		}
		return presentRun(record);
	}

	async function wait(profileId, runId) {
		const running = active.get(key(profileId, runId));
		if (running) await running.promise;
		return status(profileId, runId);
	}

	async function cancel(profileId, runId) {
		const record = await repository.get(profileId, runId);
		if (!record) throw new AppError(404, "RUN_NOT_FOUND", "The requested collection run does not exist.");
		if (record.status !== "running") return presentRun(record);
		const running = active.get(key(profileId, runId));
		if (!running) return status(profileId, runId);
		running.controller.abort();
		if (running.currentExecutionId) await executions.cancel(profileId, running.currentExecutionId).catch(() => null);
		await running.promise;
		return status(profileId, runId);
	}

	async function rerun(profileId, runId, scope = null) {
		const record = await repository.get(profileId, runId);
		if (!record) throw new AppError(404, "RUN_NOT_FOUND", "The requested collection run does not exist.");
		// A rerun re-pins the current collection and environment revisions and keeps
		// the selection, iterations, failure policy, and run inputs of the original.
		return start(profileId, {
			collectionId: record.collectionId,
			selection: record.input?.selection ?? { mode: "collection" },
			iterations: record.input?.iterations ?? 1,
			stopOnFailure: record.input?.stopOnFailure !== false,
			variables: record.input?.variables ?? [],
			...(record.environmentId ? { environmentId: record.environmentId } : {}),
		}, scope);
	}

	async function list(profileId, query = {}) {
		const limit = Math.min(Math.max(Number(query.limit) || RUN_LIMITS.recentRunsLimit, 1), RUN_LIMITS.recentRunsLimit);
		const records = await repository.list(profileId, { collectionId: query.collectionId ?? null, limit });
		return records.map((record) => presentRun(record, { includeResults: false }));
	}

	// Internal admission accounting probe. Not part of the HTTP response surface; it
	// exists so concurrency tests can assert the reservation lifecycle directly.
	function stats() {
		return { active: active.size, reserved: reservations.size };
	}

	return { start, status, wait, cancel, rerun, list, stats };
}

export const collectionRunnerService = createCollectionRunnerService();
