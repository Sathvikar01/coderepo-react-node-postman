const baseUrl = import.meta.env.VITE_API_URL || "/api/v1";
const SESSION_KEY = "request-desk-session-token";
const PROFILE_TOKEN_KEY = "request-desk-profile-token";
const PROFILE_ID_KEY = "request-desk-profile-id";

let sessionToken = localStorage.getItem(SESSION_KEY) || "";
let profileToken = localStorage.getItem(PROFILE_TOKEN_KEY) || "";

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

export function clearSession() {
    setSessionToken("");
    setProfileToken("");
    setStoredProfileId("");
}

export const hasSessionToken = () => Boolean(sessionToken || profileToken);
export const hasProfileToken = () => Boolean(profileToken);

export async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(profileToken || sessionToken ? { Authorization: `Bearer ${profileToken || sessionToken}` } : {}),
            ...options.headers,
        },
    });
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
