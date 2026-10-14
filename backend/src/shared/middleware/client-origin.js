import { AsyncLocalStorage } from "node:async_hooks";

// Phase 24B — per-session mutation origin. A live workspace event must be
// distinguishable from the local save that caused it, but two different browser
// sessions sharing one profile must still see each other's changes. The client
// therefore stamps each request with a random, in-memory `x-tracer-origin`
// value that is unique to that browser session (not the profile). The value is
// carried through the request's async context and attached to the advisory event
// so the originating session can recognise its own echo without suppressing
// updates from another session on the same profile.
//
// This is correlation metadata only, never an authorization input: the header
// cannot grant access and is ignored by every route/permission decision.
const storage = new AsyncLocalStorage();

const MAX_ORIGIN_LENGTH = 128;
// Printable, non-secret characters only; anything else is discarded.
const VALID_ORIGIN = /^[A-Za-z0-9._:-]{1,128}$/;

export function normalizeClientOrigin(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_ORIGIN_LENGTH || !VALID_ORIGIN.test(trimmed)) return null;
	return trimmed;
}

export function captureClientOrigin(request, response, next) {
	const origin = normalizeClientOrigin(request.get("x-tracer-origin"));
	storage.run({ clientOrigin: origin }, next);
}

export function currentClientOrigin() {
	return storage.getStore()?.clientOrigin ?? null;
}
