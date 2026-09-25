import { utf8Bytes } from "../../shared/utils/limits.js";
import { workspaceActivityRepository } from "./workspace-activity.repository.js";

// A single activity entry may carry at most this much free-form metadata. Anything
// larger is dropped rather than truncated, so the feed can never become a covert
// channel for large payloads.
const MAX_METADATA_BYTES = 2048;

// Even inside `metadata`, keys that could name a credential are refused outright.
const BLOCKED_KEY = /(authorization|cookie|token|secret|password|credential|api[_-]?key|bearer|body|value|header)/i;

const isScalar = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);

export function sanitizeActivityMetadata(metadata) {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
	const clean = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (typeof key !== "string" || BLOCKED_KEY.test(key)) continue;
		if (isScalar(value)) {
			clean[key] = typeof value === "string" ? value.slice(0, 200) : value;
		} else if (Array.isArray(value)) {
			const items = value.filter(isScalar).slice(0, 20).map((item) => (typeof item === "string" ? item.slice(0, 120) : item));
			if (items.length > 0) clean[key] = items;
		}
	}
	return utf8Bytes(JSON.stringify(clean)) > MAX_METADATA_BYTES ? {} : clean;
}

export async function recordWorkspaceActivity(entry) {
	return workspaceActivityRepository.record({
		workspaceId: entry.workspaceId,
		actorProfileId: entry.actorProfileId ?? null,
		action: entry.action,
		targetType: entry.targetType,
		targetId: entry.targetId ? String(entry.targetId) : null,
		targetLabel: entry.targetLabel ? String(entry.targetLabel).slice(0, 120) : null,
		previousRevision: entry.previousRevision ?? null,
		newRevision: entry.newRevision ?? null,
		summary: String(entry.summary ?? "").slice(0, 300),
		metadata: sanitizeActivityMetadata(entry.metadata),
		createdAt: new Date(),
	});
}
