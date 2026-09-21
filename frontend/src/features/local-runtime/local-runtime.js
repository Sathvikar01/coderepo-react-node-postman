export const EMPTY_LOCAL_RUNTIME = { enabled: false, targets: [], revision: 0 };

// The API accepts only { host } entries; server-assigned ids and timestamps
// must never be echoed back.
export const hostPayload = (targets = []) => targets.map((target) => ({ host: target.host }));

// Mirrors the backend allowlist rules so obvious mistakes are caught before a
// round trip. The backend remains the authority.
export function validateHostInput(raw, approvedHosts = []) {
	const trimmed = String(raw ?? "").trim().toLowerCase();
	if (!trimmed) return { ok: false, error: "Enter a hostname or IP address to approve." };
	if (trimmed.length > 253) return { ok: false, error: "Approved hosts must be 253 characters or fewer." };
	if (/[\s/*@?#]/.test(trimmed) || trimmed.includes("://") || trimmed.includes("\\"))
		return { ok: false, error: "Approve one exact host. Wildcards, CIDR ranges, ports, and URLs are not allowed." };
	const withoutDot = trimmed.replace(/\.$/, "");
	const host = withoutDot.startsWith("[") && withoutDot.endsWith("]") ? withoutDot.slice(1, -1) : withoutDot;
	if (host.includes(":") && (host.match(/:/g) ?? []).length < 2)
		return { ok: false, error: "Approve one exact host. Ports are not part of an approved host." };
	if (approvedHosts.includes(host)) return { ok: false, error: `${host} is already on the approved list.` };
	if (!/^[a-z0-9.:-]+$/.test(host)) return { ok: false, error: "Use a hostname or IP address without spaces or symbols." };
	return { ok: true, host };
}

// Best-effort pre-send warning. Templates with variables cannot be resolved in
// the browser, so those rely on the recorded result instead.
export function approvedHostForUrl(urlTemplate, approvedHosts = []) {
	if (!urlTemplate || approvedHosts.length === 0 || String(urlTemplate).includes("{{")) return null;
	let hostname;
	try {
		hostname = new URL(urlTemplate).hostname.replace(/^\[|\]$/g, "").toLowerCase();
	} catch {
		return null;
	}
	return approvedHosts.includes(hostname) ? hostname : null;
}
