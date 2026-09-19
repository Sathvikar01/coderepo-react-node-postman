import { AppError } from "../../shared/errors/app-error.js";
import { getConfig } from "../../shared/config/index.js";

class TokenBucket {
    constructor(capacity, refillPerMinute) {
        this.capacity = capacity;
        this.tokens = capacity;
        this.refillPerMs = refillPerMinute / 60000;
        this.updatedAt = Date.now();
    }

    take() {
        const now = Date.now();
        this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) * this.refillPerMs);
        this.updatedAt = now;
        if (this.tokens < 1) return Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs / 1000));
        this.tokens -= 1;
        return 0;
    }
}

export function createOperationRegistry() {
    const active = new Map();
    const buckets = new Map();
    const bucketFor = (key, capacity, perMinute) => {
        if (!buckets.has(key)) buckets.set(key, new TokenBucket(capacity, perMinute));
        return buckets.get(key);
    };
    const countProfile = (profileId) => [...active.values()].filter((entry) => entry.profileId === profileId).length;

    return {
        rateLimit(profileId, kind) {
            const { sendRatePerMinute, sendBurst, statusRatePerMinute, statusBurst } = getConfig().execution;
            const limit = kind === "send" ? bucketFor(`send:${profileId}`, sendBurst, sendRatePerMinute) : bucketFor(`status:${profileId}`, statusBurst, statusRatePerMinute);
            const retryAfterSeconds = limit.take();
            if (retryAfterSeconds > 0) throw new AppError(429, "RATE_LIMITED", "Too many requests. Try again shortly.", { retryAfterSeconds });
        },
        reserve(profileId, executionId) {
            const { maxConcurrentPerProfile, maxConcurrentPerProcess } = getConfig().execution;
            if (active.size >= maxConcurrentPerProcess) throw new AppError(429, "CONCURRENCY_LIMIT", "The server is handling the maximum number of active executions.", { limit: maxConcurrentPerProcess, scope: "process" });
            if (countProfile(profileId) >= maxConcurrentPerProfile) throw new AppError(429, "CONCURRENCY_LIMIT", "This profile already has the maximum number of active executions.", { limit: maxConcurrentPerProfile, scope: "profile" });
            if (active.has(executionId)) throw new AppError(409, "EXECUTION_RUNNING", "This execution is already active.");
            const controller = new AbortController();
            active.set(executionId, { profileId, controller, startedAt: Date.now(), cancelRequested: false });
            return controller;
        },
        requestCancel(executionId) {
            const entry = active.get(executionId);
            if (!entry) return false;
            entry.cancelRequested = true;
            entry.controller.abort();
            return true;
        },
        release(executionId) {
            active.delete(executionId);
        },
        isActive: (executionId) => active.has(executionId),
        isCancelRequested: (executionId) => active.get(executionId)?.cancelRequested === true,
        activeCount: () => active.size,
        activeIds: () => [...active.keys()],
    };
}

export const operationRegistry = createOperationRegistry();
