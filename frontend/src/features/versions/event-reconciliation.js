// Phase 24B — advisory workspace event reconciliation.
//
// A live event is never truth: the local mutation response and a canonical
// reload are. The one thing the event must not do is mistake this session's own
// write for a collaborator's write. Each browser session stamps its mutations
// with a random `x-tracer-origin` value; the broker echoes it on the event. This
// session ignores only that exact echo — another session on the same profile has
// a different origin and still reconciles normally.

export const RESOURCE_EVENT = Object.freeze({
	IGNORE: "ignore",
	SELF: "self",
	NOTICE: "notice",
	APPLY: "apply",
});

export function isOwnSessionEvent(event, clientOrigin) {
	return Boolean(event?.originClientId) && Boolean(clientOrigin) && event.originClientId === clientOrigin;
}

// `dirty` describes whether any open tab for the touched resource has unsaved
// edits. A remote write while dirty must surface the conflict banner and never
// overwrite the draft; a remote write while clean may simply follow the tip.
export function classifyResourceEvent(event, { clientOrigin = null, dirty = false } = {}) {
	if (!event?.action) return RESOURCE_EVENT.IGNORE;
	if (isOwnSessionEvent(event, clientOrigin)) return RESOURCE_EVENT.SELF;
	return dirty ? RESOURCE_EVENT.NOTICE : RESOURCE_EVENT.APPLY;
}
