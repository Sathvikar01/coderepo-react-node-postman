import { AppError } from "../../shared/errors/app-error.js";
import { getConfig } from "../../shared/config/index.js";
import { LIMITS } from "../../shared/utils/limits.js";
import { historyRepository } from "./history.repository.js";

function decodeCursor(raw) {
    if (!raw) return null;
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    } catch {
        throw new AppError(400, "CURSOR_INVALID", "The history cursor is not valid.");
    }
    const startedAt = new Date(parsed?.startedAt);
    if (Number.isNaN(startedAt.getTime()) || typeof parsed?.id !== "string") throw new AppError(400, "CURSOR_INVALID", "The history cursor is not valid.");
    return { startedAt, id: parsed.id };
}

function encodeCursor(item) {
    return Buffer.from(JSON.stringify({ startedAt: item.startedAt, id: String(item._id) }), "utf8").toString("base64url");
}

export const historyService = {
    async admit(entry) {
        return historyRepository.insertAdmission(entry);
    },
    async finalize(ownerProfileId, executionId, update) {
        return historyRepository.finalize(ownerProfileId, executionId, update);
    },
    async get(ownerProfileId, executionId) {
        const record = await historyRepository.findByExecutionId(ownerProfileId, executionId);
        if (!record) return null;
        if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) return { ...record, expired: true };
        return record;
    },
    async list(ownerProfileId, query) {
        const { limit = LIMITS.historyPageDefault, method, outcome, q, cursor } = query;
        const pageSize = Math.min(Math.max(Number(limit) || LIMITS.historyPageDefault, 1), LIMITS.historyPageMax);
        const trimmed = q ? String(q).trim().slice(0, LIMITS.historySearchMaxLength) : "";
        const items = await historyRepository.list(ownerProfileId, { limit: pageSize, method, outcome, q: trimmed, cursor: decodeCursor(cursor) });
        const hasMore = items.length > pageSize;
        const page = hasMore ? items.slice(0, pageSize) : items;
        return {
            items: page.map((item) => ({
                executionId: item.executionId,
                status: item.status,
                outcome: item.outcome,
                effectCertainty: item.effectCertainty,
                method: item.request?.method ?? null,
                name: item.request?.name ?? null,
                displayUrl: item.snapshot?.displayUrl ?? null,
                startedAt: item.startedAt,
                finishedAt: item.finishedAt,
                statusCode: item.response?.status ?? null,
                durationMs: item.response?.timing?.totalMs ?? null,
                sizeBytes: item.response?.size?.receivedBodyBytes ?? null,
                errorCode: item.error?.code ?? null,
            })),
            nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
        };
    },
    async hide(ownerProfileId, executionId) {
        const record = await historyRepository.findByExecutionId(ownerProfileId, executionId);
        if (!record) throw new AppError(404, "HISTORY_NOT_FOUND", "The requested history entry does not exist.");
        if (record.status === "running") throw new AppError(409, "EXECUTION_ACTIVE", "This execution is still running and cannot be deleted.");
        const hidden = await historyRepository.hide(ownerProfileId, executionId);
        if (!hidden) throw new AppError(409, "EXECUTION_ACTIVE", "This execution is still running and cannot be deleted.");
        return hidden;
    },
    async clear(ownerProfileId) {
        const cutoff = new Date();
        return historyRepository.hideTerminalBefore(ownerProfileId, cutoff);
    },
    async recoverInterrupted(instanceId) {
        const { retentionDays } = getConfig().execution;
        const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
        return historyRepository.markRunningInterrupted(instanceId, expiresAt);
    },
    async reconcileStale() {
        const { staleRunningMs, retentionDays } = getConfig().execution;
        const cutoff = new Date(Date.now() - staleRunningMs);
        const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
        return historyRepository.markStaleRunningInterrupted(cutoff, expiresAt);
    },
    async retentionPass() {
        const seen = new Set();
        const collections = await import("../collections/collection.model.js");
        const profiles = await collections.Collection.distinct("ownerProfileId");
        for (const profileId of profiles) {
            if (seen.has(String(profileId))) continue;
            seen.add(String(profileId));
            const excess = await historyRepository.selectBodyCandidates(profileId, getConfig().execution.retainedBodyRecords);
            if (excess.length > 0) await historyRepository.trimBodies(excess.map((item) => item._id));
        }
    },
};
