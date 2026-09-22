import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.js";
import { getConfig } from "../../shared/config/index.js";
import { LIMITS } from "../../shared/utils/limits.js";
import { collectionRepository } from "../collections/collection.repository.js";
import { cookieService } from "../cookies/cookie.service.js";
import { environmentRepository } from "../environments/environment.repository.js";
import { environmentService } from "../environments/environment.service.js";
import { historyService } from "../history/history.service.js";
import { fingerprintKeyId, fingerprintOf } from "../history/fingerprint.js";
import { localRuntimeService } from "../local-runtime/local-runtime.service.js";
import { composeScriptResults, mergePostResponseResults, scriptService } from "../scripts/script-runner.js";
import { buildExecutionReceipt } from "../execution-intelligence/execution-receipt.js";
import { operationRegistry } from "./active-registry.js";
import { performRequest } from "./http-transport.js";
import { captureBody } from "./response-capture.js";
import { buildResponseResult, truncateBodyForHistory } from "./response-normalizer.js";
import { compileRequest, redactUrl } from "./request-compiler.js";
import { createTargetPolicy } from "./target-policy.js";

export const INSTANCE_ID = randomUUID();

const OUTCOME_BY_KIND = {
	timeout: "timeout",
	cancelled: "cancelled",
	size_limit: "size_limit",
	decode_error: "decode_error",
	network_error: "network_error",
};
const RETENTION_MS = () => getConfig().execution.retentionDays * 24 * 60 * 60 * 1000;

function findRequest(collection, requestId) {
	return collection?.requests?.find((request) => request.id === requestId) ?? null;
}

const REQUIRED_INPUT = "[REQUIRED_INPUT]";
const VARIABLE_REFERENCE = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/;

function sanitizeAuthForHistory(auth) {
	if (!auth || auth.mode === "none" || auth.mode === "inherit") return auth ?? { mode: "none" };
	if (auth.mode === "bearer")
		return { mode: "bearer", tokenTemplate: VARIABLE_REFERENCE.test(auth.tokenTemplate ?? "") ? auth.tokenTemplate : REQUIRED_INPUT };
	if (auth.mode === "basic")
		return {
			mode: "basic",
			usernameTemplate: VARIABLE_REFERENCE.test(auth.usernameTemplate ?? "") ? auth.usernameTemplate : REQUIRED_INPUT,
			passwordTemplate: VARIABLE_REFERENCE.test(auth.passwordTemplate ?? "") ? auth.passwordTemplate : REQUIRED_INPUT,
		};
	if (auth.mode === "apiKey")
		return {
			mode: "apiKey",
			key: auth.key,
			valueTemplate: VARIABLE_REFERENCE.test(auth.valueTemplate ?? "") ? auth.valueTemplate : REQUIRED_INPUT,
			in: auth.in,
		};
	return { mode: "none" };
}

function sanitizeRequestForHistory(request) {
	if (!request) return request;
	return { ...request, auth: sanitizeAuthForHistory(request.auth) };
}

export function terminalResult(record) {
	return {
		executionId: record.executionId,
		outcome: record.outcome,
		effectCertainty: record.effectCertainty,
		executedUrl: record.snapshot?.executedUrl ?? null,
		response: record.response ?? null,
		error: record.error ?? null,
		persistence: record.persistence ?? { state: "saved" },
		startedAt: record.startedAt,
		finishedAt: record.finishedAt ?? null,
		request: record.request ?? null,
		snapshot: record.snapshot ?? null,
		compileTrace: record.compileTrace ?? [],
		warnings: record.warnings ?? [],
		receipt: record.receipt ?? null,
		scriptResults: record.snapshot?.scriptResults ?? null,
		historyId: record.executionId,
		visible: record.visible !== false,
		localAccess: record.snapshot?.localAccess === true,
	};
}

export function persistenceFrom(record) {
	if (record) return { state: "saved" };
	return {
		state: "unknown",
		warning: "The result was selected but its final record could not be confirmed within the finalization budget.",
	};
}

function raceBudget(promise, { deadlineAt, signal }) {
	const start = () => {
		if (signal?.aborted) return { state: "cancelled" };
		if (deadlineAt - Date.now() <= 0) return { state: "timeout" };
		return null;
	};
	const immediate = start();
	if (immediate) return Promise.resolve(immediate);
	return new Promise((resolve) => {
		let done = false;
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const settle = (result) => {
			if (done) return;
			done = true;
			cleanup();
			resolve(result);
		};
		const timer = setTimeout(() => settle({ state: "timeout" }), Math.max(1, deadlineAt - Date.now()));
		const onAbort = () => settle({ state: "cancelled" });
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => settle({ state: "ok", value }),
			(error) => settle({ state: "error", error }),
		);
	});
}

export function createExecutionService({
	registry = operationRegistry,
	transport = performRequest,
	policy = null,
	history = historyService,
	localRuntime = localRuntimeService,
	cookies = cookieService,
} = {}) {
	const targetPolicy = policy ?? createTargetPolicy();

	async function resolveRequestContext(profileId, context, draftRequest) {
		if (context.collectionId && context.replayHistoryId)
			throw new AppError(400, "CONTEXT_CONFLICT", "Collection and history replay contexts cannot be combined.");
		if (context.replayHistoryId) {
			const record = await history.get(profileId, context.replayHistoryId);
			if (!record || record.expired)
				throw new AppError(404, "HISTORY_NOT_FOUND", "The requested history entry does not exist or has expired.");
			return {
				request: draftRequest ?? record.request,
				collection: record.snapshot?.collectionDefaults
					? {
							name: record.snapshot.collectionDefaults.name,
							variables: structuredClone(record.snapshot.collectionDefaults.variables ?? []),
							auth: structuredClone(record.snapshot.collectionDefaults.auth ?? { mode: "none" }),
						}
					: null,
				replay: record,
				source: { type: "history", historyId: context.replayHistoryId },
			};
		}
		if (!context.collectionId) return { request: draftRequest, collection: null, source: { type: "scratch" } };
		const collection = await collectionRepository.findById(context.collectionId, profileId);
		if (!collection) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
		if (context.collectionRevision !== undefined && context.collectionRevision !== collection.revision) {
			throw new AppError(
				409,
				"CONTEXT_CHANGED",
				"This collection changed after the request was loaded. Reload the collection and send again.",
			);
		}
		return {
			request: draftRequest ?? findRequest(collection, context.requestId),
			collection,
			source: {
				type: "collection",
				collectionId: String(collection._id),
				collectionRevision: collection.revision,
				name: collection.name,
				requestId: draftRequest?.id ?? context.requestId ?? null,
			},
		};
	}

	async function resolveEnvironment(profileId, environmentId, environmentRevision) {
		if (!environmentId) return { environment: null, source: null };
		const environment = await environmentRepository.findById(environmentId, profileId);
		if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
		if (environmentRevision !== undefined && environmentRevision !== environment.revision) {
			throw new AppError(
				409,
				"CONTEXT_CHANGED",
				"This environment changed after it was selected. Reload the environment and send again.",
			);
		}
		return {
			environment,
			source: { environmentId: String(environment._id), environmentRevision: environment.revision, name: environment.name },
		};
	}

	async function send(profileId, input) {
		registry.rateLimit(profileId, "send");
		const { executionId, tabId, draftVersion, request, context = {}, authOverride } = input;
		const timeoutMs = Math.min(
			Math.max(request?.settings?.timeoutMs ?? getConfig().execution.defaultTimeoutMs, getConfig().execution.minTimeoutMs),
			getConfig().execution.maxTimeoutMs,
		);

		const resolved = await resolveRequestContext(profileId, context, request);
		const effectiveRequest = resolved.request;
		if (!effectiveRequest) throw new AppError(404, "REQUEST_NOT_FOUND", "The request to send does not exist in this collection.");
		const environment = await resolveEnvironment(profileId, context.environmentId, context.environmentRevision);

		const preScript = scriptService.runPreRequest({
			request: effectiveRequest,
			collection: resolved.collection,
			environment: environment.environment,
		});
		const workingRequest = preScript.request;
		const scriptWarnings = [...preScript.warnings];
		let scriptResults = preScript.phase ? composeScriptResults({ preRequest: preScript.phase }) : null;

		const fingerprint = fingerprintOf({
			request: effectiveRequest,
			authOverride: authOverride ?? null,
			context: {
				collectionId: context.collectionId ?? null,
				collectionRevision: context.collectionRevision ?? null,
				replayHistoryId: context.replayHistoryId ?? null,
				environmentId: context.environmentId ?? null,
				environmentRevision: context.environmentRevision ?? null,
			},
		});

		const existing = await history.get(profileId, executionId);
		if (existing?.expired) throw new AppError(410, "RESULT_REMOVED", "The stored result for this execution has expired.");
		if (existing) {
			if (existing.fingerprint !== fingerprint)
				throw new AppError(409, "EXECUTION_ID_CONFLICT", "This execution identifier is already used with different input.");
			if (existing.status === "running") throw new AppError(409, "EXECUTION_RUNNING", "This execution is already running.");
			if (existing.visible === false) throw new AppError(410, "RESULT_REMOVED", "The stored result for this execution was removed.");
			return { ...terminalResult(existing), duplicate: true, tabId, draftVersion };
		}

		const controller = registry.reserve(profileId, executionId);
		const startedAt = new Date();
		const deadlineAt = Date.now() + timeoutMs;

		const snapshot = {
			displayUrl: workingRequest.urlTemplate,
			source: resolved.source,
			environment: environment.source,
			collectionDefaults: resolved.collection
				? {
						name: resolved.collection.name,
						variables: (resolved.collection.variables ?? []).map((variable) => ({
							id: variable.id,
							key: variable.key,
							kind: variable.kind,
							enabled: variable.enabled !== false,
							...(variable.kind === "plain" ? { value: variable.value ?? "" } : { alias: variable.alias }),
						})),
						auth: sanitizeAuthForHistory(resolved.collection.auth),
					}
				: null,
		};
		const receiptInput = ({ outcome, effectCertainty, compiled = null, target = null, response = null, error = null, finishedAt, warnings = [] }) =>
			buildExecutionReceipt({
				executionId,
				fingerprint,
				fingerprintKeyId: fingerprintKeyId(),
				startedAt,
				finishedAt,
				outcome,
				effectCertainty,
				request: sanitizeRequestForHistory(workingRequest),
				source: resolved.source,
				environment: environment.source,
				compiled,
				target,
				response,
				error,
				scriptResults,
				warnings,
			});

		try {
			await history.admit({
				ownerProfileId: profileId,
				executionId,
				fingerprint,
				fingerprintKeyId: fingerprintKeyId(),
				instanceId: INSTANCE_ID,
				status: "running",
				effectCertainty: "not_dispatched",
				persistence: { state: "saved" },
				request: sanitizeRequestForHistory(workingRequest),
				context: { tabId, draftVersion, source: resolved.source, environment: environment.source },
				snapshot,
				startedAt,
			});
		} catch (error) {
			registry.release(executionId);
			if (error?.code === 11000) {
				const winner = await history.get(profileId, executionId);
				if (winner?.status === "running") throw new AppError(409, "EXECUTION_RUNNING", "This execution is already running.");
				if (winner && winner.fingerprint !== fingerprint)
					throw new AppError(409, "EXECUTION_ID_CONFLICT", "This execution identifier is already used with different input.");
				if (winner) return { ...terminalResult(winner), duplicate: true, tabId, draftVersion };
			}
			throw new AppError(503, "DATABASE_UNAVAILABLE", "The execution could not be recorded. Try again.");
		}

		const persist = async (update) => {
			const expiresAt = new Date(Date.now() + RETENTION_MS());
			let finalized = null;
			try {
				finalized = await Promise.race([
					history.finalize(profileId, executionId, { status: "terminal", finishedAt: new Date(), expiresAt, ...update }),
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error("finalize timeout")), getConfig().execution.finalizeTimeoutMs),
					),
				]);
			} catch {
				finalized = null;
			}
			if (finalized) return { persistence: persistenceFrom(finalized), record: finalized };
			const current = await history.get(profileId, executionId).catch(() => null);
			if (current && current.status === "terminal") return { persistence: persistenceFrom(current), record: current };
			return { persistence: persistenceFrom(null), record: null };
		};

		const preDispatchFailure = async (outcome, code, message, details, compiledResult = null) => {
			const compileTrace = compiledResult?.trace ?? [];
			const warnings = [...(compiledResult?.warnings ?? []), ...scriptWarnings];
			const error = { code, message, details: details ?? null };
			const finishedAt = new Date();
			const receiptCompiled = compiledResult
				? { ...compiledResult, executedUrl: redactUrl(compiledResult.url, compiledResult.redaction) }
				: null;
			const receipt = receiptInput({
				outcome,
				effectCertainty: "not_dispatched",
				compiled: receiptCompiled,
				error,
				finishedAt,
				warnings,
			});
			const persistence = await persist({
				finishedAt,
				outcome,
				effectCertainty: "not_dispatched",
				response: null,
				error,
				persistence: { state: "saved" },
				compileTrace,
				warnings,
				receipt,
				"snapshot.scriptResults": scriptResults,
			});
			registry.release(executionId);
			if (persistence.record) return { ...terminalResult(persistence.record), tabId, draftVersion };
			return {
				executionId,
				tabId,
				draftVersion,
				outcome,
				response: null,
				error,
				effectCertainty: "not_dispatched",
				persistence: persistence.persistence,
				historyId: executionId,
				startedAt,
				finishedAt,
				compileTrace,
				warnings,
				scriptResults,
				receipt,
			};
		};

		const semanticFailure = (code, message, details) =>
			preDispatchFailure("validation_error", code, message, details);

		const secretValues = [];
		const secrets = new Map();
		for (const variable of resolved.collection?.variables ?? []) {
			if (variable.enabled !== false && variable.kind === "secretRef" && variable.alias) {
				const secret = environmentService.resolveSecretAlias(profileId, variable.alias);
				if (secret) {
					secrets.set(variable.key, secret);
					secretValues.push(secret);
				}
			}
		}
		for (const variable of environment.environment?.variables ?? []) {
			if (variable.enabled !== false && variable.kind === "secretRef" && variable.alias) {
				const secret = environmentService.resolveSecretAlias(profileId, variable.alias);
				if (secret) {
					secrets.set(variable.key, secret);
					secretValues.push(secret);
				}
			}
		}

		let compiled;
		try {
			compiled = compileRequest({
				request: workingRequest,
				collection: resolved.collection,
				environment: environment.environment,
				authOverride,
				secrets,
				variableOverlay: preScript.variables,
			});
			compiled.redaction.values.push(...secretValues);
		} catch (error) {
			return semanticFailure(error.code ?? "VALIDATION_ERROR", error.message, error.details);
		}

		const executedUrl = redactUrl(compiled.url, compiled.redaction);

		const localSettings = await localRuntime.forExecution(profileId);

		const validation = await raceBudget(
			targetPolicy.validate(compiled.url, {
				allowLocalDemo: true,
				authoredUrl: compiled.authoredUrl,
				localRuntime: localSettings,
			}),
			{ deadlineAt, signal: controller.signal },
		);
		if (validation.state === "timeout")
			return preDispatchFailure("timeout", "TIMEOUT", "This execution exceeded its time budget before dispatch.", null, compiled);
		if (validation.state === "cancelled")
			return preDispatchFailure("cancelled", "CANCELLED", "This execution was cancelled before dispatch.", null, compiled);
		if (validation.state === "error")
			return semanticFailure(validation.error.code ?? "TARGET_INVALID", validation.error.message, validation.error.details);
		const target = validation.value;
		const localAccess = target.local === true;

		const remainingBeforeDispatch = deadlineAt - Date.now();
		if (remainingBeforeDispatch <= 0)
			return preDispatchFailure("timeout", "TIMEOUT", "This execution exceeded its time budget before dispatch.", null, compiled);

		// The profile jar is applied after compilation and target validation so a
		// stored cookie can never change which target this execution reaches.
		const cookieApplication = await cookies.applyToRequest({
			profileId,
			url: compiled.url,
			headers: compiled.headers,
		});
		compiled.headers = cookieApplication.headers;
		compiled.warnings.push(...cookieApplication.warnings);
		compiled.redaction.values.push(...(cookieApplication.secretValues ?? []));

		let dispatchStarted = false;
		const result = await transport({
			target,
			method: compiled.method,
			headers: compiled.headers,
			body: compiled.body,
			timeoutMs: remainingBeforeDispatch,
			signal: controller.signal,
			limits: {
				captureBytes: LIMITS.captureBytes,
				decodedBytes: LIMITS.decodedBytes,
				responseHeaderBytes: LIMITS.responseHeaderBytes,
				responseHeaderPairs: LIMITS.responseHeaderPairs,
			},
			onDispatch: () => {
				dispatchStarted = true;
			},
		});

		const effectCertainty = dispatchStarted ? "may_have_reached_target" : "not_dispatched";
		// Redirects are never followed automatically, so Set-Cookie on a 3xx response
		// is stored exactly like any other response and only used by later sends.
		const cookieCapture = await cookies.storeResponseCookies({
			profileId,
			url: compiled.url,
			responseHeaders: result.state?.headers ?? [],
		});
		let outcome = "response";
		let response = null;
		let errorPayload = null;
		if (!result.ok) {
			outcome = OUTCOME_BY_KIND[result.error.kind] ?? "network_error";
			errorPayload = { code: result.error.kind.toUpperCase(), message: result.error.message, details: result.error.details ?? null };
		} else {
			try {
				const capture = await captureBody({
					encoded: result.encoded,
					headers: result.state.headers,
					limits: { decodedBytes: LIMITS.decodedBytes },
					method: compiled.method,
					status: result.state.status,
					signal: controller.signal,
					deadlineAt,
				});
				response = buildResponseResult({ transport: result, capture, redaction: compiled.redaction, executedUrl, timeoutMs });
			} catch (error) {
				outcome = OUTCOME_BY_KIND[error?.kind] ?? "decode_error";
				errorPayload = {
					code: error?.kind ? error.kind.toUpperCase() : "DECODE_ERROR",
					message: error.message,
					details: error.details ?? null,
				};
			}
		}

		const postScript = response
			? scriptService.runPostResponse({
					request: workingRequest,
					response,
					collection: resolved.collection,
					environment: environment.environment,
					variables: preScript.variables,
				})
			: scriptService.skippedPostResponse(workingRequest);
		if (postScript.phase || postScript.tests.length) {
			scriptResults = mergePostResponseResults(scriptResults, postScript.phase, postScript.tests);
		}
		scriptWarnings.push(...postScript.warnings);

		const finishedAt = new Date();
		const warnings = [
			...(compiled.warnings ?? []),
			...(localAccess
				? [
						{
							code: "LOCAL_RUNTIME",
							message: `This request used Local Runtime access to ${target.originalHostname}.`,
						},
					]
				: []),
			...cookieCapture.warnings,
			...scriptWarnings,
			...(response?.warnings ?? []),
		];
		const persistedResponse = truncateBodyForHistory(response);
		const receiptCompiled = { ...compiled, executedUrl };
		const receipt = receiptInput({
			outcome,
			effectCertainty,
			compiled: receiptCompiled,
			target,
			response: persistedResponse,
			error: errorPayload,
			finishedAt,
			warnings,
		});
		const persistence = await persist({
			finishedAt,
			outcome,
			effectCertainty,
			response: persistedResponse,
			error: errorPayload,
			persistence: { state: "saved" },
			"snapshot.bytesSent": result.bytesSent ?? 0,
			"snapshot.executedUrl": executedUrl,
			...(localAccess ? { "snapshot.localAccess": true } : {}),
			"snapshot.effectiveAuth": compiled.authSource === "override" ? null : sanitizeAuthForHistory(compiled.authTemplate),
			"snapshot.requestHeaders": compiled.headers.map((header) => header.name),
			"snapshot.scriptResults": scriptResults,
			compileTrace: compiled.trace,
			warnings,
			receipt,
		});
		registry.release(executionId);
		if (persistence.record) return { ...terminalResult(persistence.record), tabId, draftVersion };
		return {
			executionId,
			tabId,
			draftVersion,
			outcome,
			effectCertainty,
			executedUrl,
			response,
			error: errorPayload,
			effectCertainty,
			persistence: persistence.persistence,
			historyId: executionId,
			startedAt,
			finishedAt,
			compileTrace: compiled.trace,
			warnings,
			localAccess,
			scriptResults,
			receipt,
		};
	}

	return {
		send,
		async status(profileId, executionId) {
			registry.rateLimit(profileId, "status");
			if (registry.isActive(profileId, executionId)) return { executionId, status: "running", effectCertainty: "may_have_reached_target" };
			let record = await history.get(profileId, executionId);
			if (record?.status === "running") {
				await history.reconcileStale();
				record = await history.get(profileId, executionId);
			}
			if (!record) throw new AppError(404, "EXECUTION_NOT_FOUND", "The requested execution does not exist.");
			if (record.expired || record.visible === false)
				throw new AppError(410, "RESULT_REMOVED", "The stored result for this execution is no longer available.");
			return { ...terminalResult(record), status: "terminal" };
		},
		async cancel(profileId, executionId) {
			if (registry.isActive(profileId, executionId)) {
				registry.requestCancel(profileId, executionId);
				return { executionId, status: "cancelling" };
			}
			const record = await history.get(profileId, executionId);
			if (!record) throw new AppError(404, "EXECUTION_NOT_FOUND", "The requested execution does not exist.");
			if (record.expired || record.visible === false)
				throw new AppError(410, "RESULT_REMOVED", "The stored result for this execution is no longer available.");
			if (record.status === "running") {
				await history.finalize(profileId, executionId, {
					status: "terminal",
					outcome: "interrupted",
					effectCertainty: "may_have_reached_target",
					finishedAt: new Date(),
					expiresAt: new Date(Date.now() + RETENTION_MS()),
					persistence: { state: "saved" },
				});
				const updated = await history.get(profileId, executionId);
				if (!updated) throw new AppError(404, "EXECUTION_NOT_FOUND", "The requested execution does not exist.");
				return { ...terminalResult(updated), status: "terminal" };
			}
			return { ...terminalResult(record), status: "terminal" };
		},
	};
}

export const executionService = createExecutionService();
