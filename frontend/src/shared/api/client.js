const baseUrl = import.meta.env.VITE_API_URL || "/api/v1";
const SESSION_KEY = "request-desk-session-token";
const PROFILE_TOKEN_KEY = "request-desk-profile-token";
const PROFILE_ID_KEY = "request-desk-profile-id";
// Phase 24 — the workspace boundary. Every workspace-scoped endpoint reads this
// header, so which workspace the UI is looking at is decided in exactly one place.
const WORKSPACE_ID_KEY = "request-desk-workspace-id";

// Phase 24B — per-session mutation origin. This value is generated fresh in each
// browser session and never persisted; two tabs (or two machines) sharing one
// profile get different origins. Mutations send it as `x-tracer-origin` so the
// live event stream can mark an event as this session's own echo. The value is
// correlation metadata only — it grants no access and carries no secret.
function createClientOrigin() {
	try {
		if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	} catch {}
	const random = Math.random().toString(36).slice(2);
	return `origin-${Date.now().toString(36)}-${random}`;
}

const CLIENT_ORIGIN = createClientOrigin();
export const getClientOrigin = () => CLIENT_ORIGIN;

let sessionToken = localStorage.getItem(SESSION_KEY) || "";
let profileToken = localStorage.getItem(PROFILE_TOKEN_KEY) || "";
let workspaceId = localStorage.getItem(WORKSPACE_ID_KEY) || "";

export function setSessionToken(token) {
	sessionToken = token || "";
	if (sessionToken) localStorage.setItem(SESSION_KEY, sessionToken);
	else localStorage.removeItem(SESSION_KEY);
}

export function setProfileToken(token) {
	profileToken = token || "";
	if (profileToken) localStorage.setItem(PROFILE_TOKEN_KEY, profileToken);
	else localStorage.removeItem(PROFILE_TOKEN_KEY);
}

export function setStoredProfileId(profileId) {
	if (profileId) localStorage.setItem(PROFILE_ID_KEY, profileId);
	else localStorage.removeItem(PROFILE_ID_KEY);
}

export function readStoredProfileId() {
	return localStorage.getItem(PROFILE_ID_KEY) || "";
}

// Workspace ids are profile-scoped, so they are cleared alongside the profile
// session: a different signed-in user must never inherit another user's boundary.
export function setActiveWorkspaceId(nextWorkspaceId) {
	workspaceId = nextWorkspaceId || "";
	if (workspaceId) localStorage.setItem(WORKSPACE_ID_KEY, workspaceId);
	else localStorage.removeItem(WORKSPACE_ID_KEY);
}

export function readActiveWorkspaceId() {
	return workspaceId;
}

export function clearProfileSession() {
	setProfileToken("");
	setStoredProfileId("");
	setActiveWorkspaceId("");
}

export function clearSession() {
	setSessionToken("");
	clearProfileSession();
}

export const hasSessionToken = () => Boolean(sessionToken || profileToken);
export const hasProfileToken = () => Boolean(profileToken);

export function apiUrl(path) {
	return `${baseUrl}${path}`;
}

// Header builder shared by JSON requests and the Phase 24B live event stream,
// so the streaming fetch authenticates exactly like every other API call:
// profile/session bearer plus the active workspace boundary. Tokens never go
// into a URL or query string.
export function apiHeaders(extra = {}) {
	return {
		...(profileToken || sessionToken ? { Authorization: `Bearer ${profileToken || sessionToken}` } : {}),
		...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
		...extra,
	};
}

export async function request(path, options = {}) {
	// Only mutations carry the session origin: the server tags events caused by a
	// state change, and reads must not pretend to have caused one.
	const method = String(options.method || "GET").toUpperCase();
	const originHeader = method === "GET" || method === "HEAD" ? {} : { "x-tracer-origin": CLIENT_ORIGIN };
	let response;
	try {
		response = await fetch(apiUrl(path), {
			...options,
			headers: {
				"Content-Type": "application/json",
				...originHeader,
				...apiHeaders(options.headers),
			},
		});
	} catch (cause) {
		// A transport-level failure (server down, DNS failure, offline, or a CORS
		// rejection) surfaces from fetch as a bare TypeError whose message varies by
		// browser. Wrap it in the same shape as a server error so every caller shows
		// an actionable message instead of "Failed to fetch".
		const error = new Error("Tracer could not reach its API. Check that the backend is running and that you are online, then try again.");
		error.code = "NETWORK_UNREACHABLE";
		error.details = null;
		error.status = 0;
		error.cause = cause;
		throw error;
	}
	if (response.status === 204) return null;
	const contentType = response.headers?.get?.("content-type") || "";
	const payload = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
	if (!response.ok) {
		const code = payload?.error?.code;
		const message = payload?.error?.message || `Tracer returned ${response.status}.`;
		if (response.status === 401 && ["AUTH_REQUIRED", "INVALID_TOKEN", "ACCOUNT_UNAVAILABLE"].includes(code)) {
			clearSession();
			window.dispatchEvent(new CustomEvent("request-desk-session-expired", { detail: message }));
		}
		const error = new Error(message);
		error.code = code;
		error.details = payload?.error?.details ?? null;
		error.status = response.status;
		throw error;
	}
	if (!payload || !("data" in payload)) throw new Error("Tracer returned an invalid response.");
	return payload.data;
}
