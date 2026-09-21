// Redirect resolution for the inspector's copy action. A Location value is only
// trusted after it resolves against the executed URL and stays HTTP(S); anything
// else is reported so the UI never copies a non-web URL as if it were safe.
export function resolveRedirectUrl(location, executedUrl) {
	if (!location) return { ok: false, reason: "missing" };
	let resolved;
	try {
		resolved = new URL(location, executedUrl || undefined);
	} catch {
		return { ok: false, reason: "invalid" };
	}
	if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return { ok: false, reason: "scheme" };
	return { ok: true, url: resolved.toString() };
}
