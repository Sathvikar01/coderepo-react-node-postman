import { LIMITS } from "../../shared/utils/limits.js";

// Phase 24B — small in-process workspace event broker for the live collaboration
// stream. Events are advisory freshness signals only: the persisted
// Activity/Version records stay authoritative, and a client that restarts or
// misses events reloads canonical server state. No new dependency, no external
// pub/sub, no persistence — a process restart simply drops live subscriptions and
// clients reconnect.
//
// Each workspace keeps a bounded in-memory replay ring so a reconnecting client
// can resume after its last seen event id without re-reading the database.

const subscribersByWorkspace = new Map();
const replayByWorkspace = new Map();
const sequenceByWorkspace = new Map();

function nextEventId(workspaceId) {
	const sequence = (sequenceByWorkspace.get(workspaceId) ?? 0) + 1;
	sequenceByWorkspace.set(workspaceId, sequence);
	return `${workspaceId}:${sequence}`;
}

function replayFor(workspaceId) {
	let replay = replayByWorkspace.get(workspaceId);
	if (!replay) {
		replay = [];
		replayByWorkspace.set(workspaceId, replay);
	}
	return replay;
}

export function publishWorkspaceEvent({ workspaceId, action, resourceType = null, resourceId = null, revision = null, actorProfileId = null, actorName = null, timestamp = null }) {
	const key = String(workspaceId);
	const event = {
		id: nextEventId(key),
		workspaceId: key,
		action: String(action),
		resourceType,
		resourceId: resourceId ? String(resourceId) : null,
		revision,
		actorProfileId: actorProfileId ? String(actorProfileId) : null,
		actorName,
		timestamp: timestamp ?? new Date().toISOString(),
	};
	const replay = replayFor(key);
	replay.push(event);
	if (replay.length > LIMITS.workspaceEventReplay) replay.splice(0, replay.length - LIMITS.workspaceEventReplay);
	const subscribers = subscribersByWorkspace.get(key);
	if (!subscribers || subscribers.size === 0) return event;
	for (const subscriber of [...subscribers]) {
		// Membership revocation is enforced at delivery: a removed member's stream
		// is closed immediately and receives no further workspace events.
		if (event.action === "member.removed" && event.resourceId && String(subscriber.profileId) === String(event.resourceId)) {
			try {
				subscriber.send(event);
			} catch {}
			try {
				subscriber.close();
			} catch {}
			subscribers.delete(subscriber);
			continue;
		}
		try {
			subscriber.send(event);
		} catch {
			subscribers.delete(subscriber);
		}
	}
	return event;
}

export function subscribeWorkspace(workspaceId, profileId, { send, close }) {
	const key = String(workspaceId);
	let subscribers = subscribersByWorkspace.get(key);
	if (!subscribers) {
		subscribers = new Set();
		subscribersByWorkspace.set(key, subscribers);
	}
	const subscriber = { profileId: String(profileId), send, close };
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}

// Close every stream a profile holds in a workspace (role revocation path calls
// this when the member row disappears outside the event flow, e.g. workspace
// deletion). Returns the number of closed streams.
export function closeStreamsForProfile(workspaceId, profileId) {
	const subscribers = subscribersByWorkspace.get(String(workspaceId));
	if (!subscribers) return 0;
	let closed = 0;
	for (const subscriber of [...subscribers]) {
		if (String(subscriber.profileId) !== String(profileId)) continue;
		try {
			subscriber.close();
		} catch {}
		subscribers.delete(subscriber);
		closed += 1;
	}
	return closed;
}

export function replayAfter(workspaceId, lastEventId) {
	const replay = replayByWorkspace.get(String(workspaceId)) ?? [];
	if (!lastEventId) return [...replay];
	const index = replay.findIndex((event) => event.id === String(lastEventId));
	if (index < 0) return [...replay];
	return replay.slice(index + 1);
}

// Test seam: reset broker state between suites.
export function resetWorkspaceEventBroker() {
	subscribersByWorkspace.clear();
	replayByWorkspace.clear();
	sequenceByWorkspace.clear();
}
