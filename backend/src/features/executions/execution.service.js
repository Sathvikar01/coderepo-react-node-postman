import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.js";
import { getConfig } from "../../shared/config/index.js";
import { LIMITS } from "../../shared/utils/limits.js";
import { collectionRepository } from "../collections/collection.repository.js";
import { environmentRepository } from "../environments/environment.repository.js";
import { environmentService } from "../environments/environment.service.js";
import { historyService } from "../history/history.service.js";
import { fingerprintKeyId, fingerprintOf } from "../history/fingerprint.js";
import { operationRegistry } from "./active-registry.js";
import { performRequest } from "./http-transport.js";
import { captureBody } from "./response-capture.js";
import { buildResponseResult } from "./response-normalizer.js";
import { compileRequest, redactUrl } from "./request-compiler.js";
import { createTargetPolicy } from "./target-policy.js";

export const INSTANCE_ID = randomUUID();

const OUTCOME_BY_KIND = { timeout: "timeout", cancelled: "cancelled", size_limit: "size_limit", decode_error: "decode_error", network_error: "network_error" };
const RETENTION_MS = () => getConfig().execution.retentionDays * 24 * 60 * 60 * 1000;

function findRequest(collection, requestId) {
    return collection?.requests?.find((request) => request.id === requestId) ?? null;
}

export function terminalResult(record) {
    return {
        executionId: record.executionId,
        outcome: record.outcome,
        effectCertainty: record.effectCertainty,
        response: record.response ?? null,
        error: record.error ?? null,
        persistence: record.persistence ?? { state: "saved" },
        startedAt: record.startedAt,
        finishedAt: record.finishedAt ?? null,
        request: record.request ?? null,
        snapshot: record.snapshot ?? null,
        visible: record.visible !== false,
    };
}

function previewUrl(request) {
    const base = request?.urlTemplate ?? "";
    if (!base.includes("?")) return base;
    return base;
}

export function createExecutionService({ registry = operationRegistry, transport = performRequest, policy = null } = {}) {
    const targetPolicy = policy ?? createTargetPolicy();

    async function resolveRequestContext(profileId, context, draftRequest) {
        if (context.collectionId && context.replayHistoryId) throw new AppError(400, "CONTEXT_CONFLICT", "Collection and history replay contexts cannot be combined.");
        if (context.replayHistoryId) {
            const record = await historyService.get(profileId, context.replayHistoryId);
            if (!record || record.expired) throw new AppError(404, "HISTORY_NOT_FOUND", "The requested history entry does not exist or has expired.");
            return { request: draftRequest ?? record.request, collection: null, replay: record, source: { type: "history", historyId: context.replayHistoryId } };
        }
        if (!context.collectionId) return { request: draftRequest, collection: null, source: { type: "scratch" } };
        const collection = await collectionRepository.findById(context.collectionId, profileId);
        if (!collection) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
        if (context.collectionRevision !== undefined && context.collectionRevision !== collection.revision) {
            throw new AppError(409, "CONTEXT_CHANGED", "This collection changed after the request was loaded. Reload the collection and send again.");
        }
        return {
            request: draftRequest ?? findRequest(collection, context.requestId),
            collection,
            source: { type: "collection", collectionId: String(collection._id), collectionRevision: collection.revision, name: collection.name, requestId: draftRequest?.id ?? context.requestId ?? null },
        };
    }

    async function resolveEnvironment(profileId, environmentId, environmentRevision) {
        if (!environmentId) return { environment: null, source: null };
        const environment = await environmentRepository.findById(environmentId, profileId);
        if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
        if (environmentRevision !== undefined && environmentRevision !== environment.revision) {
            throw new AppError(409, "CONTEXT_CHANGED", "This environment changed after it was selected. Reload the environment and send again.");
        }
        return { environment, source: { environmentId: String(environment._id), environmentRevision: environment.revision, name: environment.name } };
    }

    async function send(profileId, input) {
        registry.rateLimit(profileId, "send");
        const { executionId, tabId, draftVersion, request, context = {}, authOverride } = input;
        const timeoutMs = Math.min(Math.max(request?.settings?.timeoutMs ?? getConfig().execution.defaultTimeoutMs, getConfig().execution.minTimeoutMs), getConfig().execution.maxTimeoutMs);

        const resolved = await resolveRequestContext(profileId, context, request);
        const effectiveRequest = resolved.request;
        if (!effectiveRequest) throw new AppError(404, "REQUEST_NOT_FOUND", "The request to send does not exist in this collection.");
        const environment = await resolveEnvironment(profileId, context.environmentId, context.environmentRevision);

        const fingerprint = fingerprintOf({
            request: effectiveRequest,
            authOverride: authOverride ?? null,
            context: { collectionId: context.collectionId ?? null, collectionRevision: context.collectionRevision ?? null, replayHistoryId: context.replayHistoryId ?? null, environmentId: context.environmentId ?? null, environmentRevision: context.environmentRevision ?? null },
        });

        const existing = await historyService.get(profileId, executionId);
        if (existing?.expired) throw new AppError(410, "RESULT_REMOVED", "The stored result for this execution has expired.");
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new AppError(409, "EXECUTION_ID_CONFLICT", "This execution identifier is already used with different input.");
            if (existing.status === "running") throw new AppError(409, "EXECUTION_RUNNING", "This execution is already running.");
            if (existing.visible === false) throw new AppError(410, "RESULT_REMOVED", "The stored result for this execution was removed.");
            return { ...terminalResult(existing), duplicate: true, tabId, draftVersion };
        }

        const controller = registry.reserve(profileId, executionId);
        const startedAt = new Date();
        const deadlineAt = Date.now() + timeoutMs;

        const snapshot = {
            displayUrl: previewUrl(effectiveRequest),
            source: resolved.source,
            environment: environment.source,
            collectionDefaults: resolved.collection
                ? { name: resolved.collection.name, variables: (resolved.collection.variables ?? []).map((variable) => ({ key: variable.key, kind: variable.kind })), auth: resolved.collection.auth }
                : null,
        };

        try {
            await historyService.admit({
                ownerProfileId: profileId,
                executionId,
                fingerprint,
                fingerprintKeyId: fingerprintKeyId(),
                instanceId: INSTANCE_ID,
                status: "running",
                effectCertainty: "not_dispatched",
                persistence: { state: "saved" },
                request: { id: effectiveRequest.id, name: effectiveRequest.name, method: effectiveRequest.method, urlTemplate: effectiveRequest.urlTemplate, folderId: effectiveRequest.folderId ?? null },
                context: { tabId, draftVersion, source: resolved.source, environment: environment.source },
                snapshot,
                startedAt,
            });
        } catch (error) {
            registry.release(executionId);
            if (error?.code === 11000) {
                const winner = await historyService.get(profileId, executionId);
                if (winner?.status === "running") throw new AppError(409, "EXECUTION_RUNNING", "This execution is already running.");
                if (winner && winner.fingerprint !== fingerprint) throw new AppError(409, "EXECUTION_ID_CONFLICT", "This execution identifier is already used with different input.");
                if (winner) return { ...terminalResult(winner), duplicate: true, tabId, draftVersion };
            }
            throw new AppError(503, "DATABASE_UNAVAILABLE", "The execution could not be recorded. Try again.");
        }

        const persist = async (update) => {
            const expiresAt = new Date(Date.now() + RETENTION_MS());
            try {
                await Promise.race([
                    historyService.finalize(profileId, executionId, { status: "terminal", finishedAt: new Date(), expiresAt, ...update }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("finalize timeout")), getConfig().execution.finalizeTimeoutMs)),
                ]);
                return true;
            } catch {
                return false;
            }
        };

        const semanticFailure = async (code, message, details) => {
            registry.release(executionId);
            await persist({ outcome: "validation_error", effectCertainty: "not_dispatched", error: { code, message, details: details ?? null }, persistence: { state: "saved" } });
            return { executionId, tabId, draftVersion, outcome: "validation_error", response: null, error: { code, message, details: details ?? null }, effectCertainty: "not_dispatched", persistence: { state: "saved" }, historyId: executionId, startedAt, finishedAt: new Date(), compileTrace: [] };
        };

        const secretValues = [];
        const secrets = new Map();
        for (const variable of environment.environment?.variables ?? []) {
            if (variable.enabled !== false && variable.kind === "secretRef" && variable.alias) {
                const secret = environmentService.resolveSecretAlias(profileId, variable.alias);
                if (secret) { secrets.set(variable.key, secret); secretValues.push(secret); }
            }
        }
        for (const variable of resolved.collection?.variables ?? []) {
            if (variable.enabled !== false && variable.kind === "secretRef" && variable.alias) {
                const secret = environmentService.resolveSecretAlias(profileId, variable.alias);
                if (secret) { secrets.set(variable.key, secret); secretValues.push(secret); }
            }
        }

        let compiled;
        try {
            compiled = compileRequest({ request: effectiveRequest, collection: resolved.collection, environment: environment.environment, authOverride, secrets });
            compiled.redaction.values.push(...secretValues);
        } catch (error) {
            return semanticFailure(error.code ?? "VALIDATION_ERROR", error.message, error.details);
        }

        let target;
        try {
            target = await targetPolicy.validate(compiled.url, { allowLocalDemo: true });
        } catch (error) {
            return semanticFailure(error.code ?? "TARGET_INVALID", error.message, error.details);
        }

        let dispatchStarted = false;
        const result = await transport({
            target,
            method: compiled.method,
            headers: compiled.headers,
            body: compiled.body,
            timeoutMs: Math.max(1, deadlineAt - Date.now()),
            signal: controller.signal,
            limits: { captureBytes: LIMITS.captureBytes, decodedBytes: LIMITS.decodedBytes, responseHeaderBytes: LIMITS.responseHeaderBytes, responseHeaderPairs: LIMITS.responseHeaderPairs },
            onDispatch: () => { dispatchStarted = true; },
        });

        const effectCertainty = dispatchStarted ? "may_have_reached_target" : "not_dispatched";
        let outcome = "response";
        let response = null;
        let errorPayload = null;
        if (!result.ok) {
            outcome = OUTCOME_BY_KIND[result.error.kind] ?? "network_error";
            errorPayload = { code: result.error.kind.toUpperCase(), message: result.error.message, details: result.error.details ?? null };
        } else {
            try {
                const capture = await captureBody({ encoded: result.encoded, headers: result.state.headers, limits: { decodedBytes: LIMITS.decodedBytes }, method: compiled.method, status: result.state.status });
                response = buildResponseResult({ transport: result, capture, redaction: compiled.redaction, executedUrl: redactUrl(compiled.url, compiled.redaction), timeoutMs });
            } catch (error) {
                outcome = "decode_error";
                errorPayload = { code: "DECODE_ERROR", message: error.message, details: null };
            }
        }

        registry.release(executionId);
        const finishedAt = new Date();
        const persisted = await persist({
            outcome,
            effectCertainty,
            response,
            error: errorPayload,
            persistence: { state: "saved" },
            "snapshot.bytesSent": result.bytesSent ?? 0,
        });
        const persistence = persisted ? { state: "saved" } : { state: "unknown", warning: "The result was selected but its final record could not be confirmed within the finalization budget." };
        return {
            executionId,
            tabId,
            draftVersion,
            outcome,
            response,
            error: errorPayload,
            effectCertainty,
            persistence,
            historyId: executionId,
            startedAt,
            finishedAt,
            compileTrace: compiled.trace,
            warnings: [...(compiled.warnings ?? []), ...((response?.warnings) ?? [])],
        };
    }

    return {
        send,
        async status(profileId, executionId) {
            registry.rateLimit(profileId, "status");
            if (registry.isActive(executionId)) return { executionId, status: "running", effectCertainty: "may_have_reached_target" };
            let record = await historyService.get(profileId, executionId);
            if (record?.status === "running") {
                await historyService.reconcileStale();
                record = await historyService.get(profileId, executionId);
            }
            if (!record) throw new AppError(404, "EXECUTION_NOT_FOUND", "The requested execution does not exist.");
            if (record.expired) throw new AppError(410, "RESULT_REMOVED", "The stored result for this execution has expired.");
            return { ...terminalResult(record), status: "terminal" };
        },
        async cancel(profileId, executionId) {
            if (registry.isActive(executionId)) {
                registry.requestCancel(executionId);
                return { executionId, status: "cancelling" };
            }
            const record = await historyService.get(profileId, executionId);
            if (!record) throw new AppError(404, "EXECUTION_NOT_FOUND", "The requested execution does not exist.");
            if (record.status === "running") {
                await historyService.finalize(profileId, executionId, { status: "terminal", outcome: "interrupted", effectCertainty: "may_have_reached_target", finishedAt: new Date(), expiresAt: new Date(Date.now() + RETENTION_MS()), persistence: { state: "saved" } });
                const updated = await historyService.get(profileId, executionId);
                return { ...terminalResult(updated), status: "terminal" };
            }
            return { ...terminalResult(record), status: "terminal" };
        },
    };
}

export const executionService = createExecutionService();
