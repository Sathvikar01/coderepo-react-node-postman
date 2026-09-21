export function cookieScope(cookie) {
	return `${cookie.domain}${cookie.path}`;
}

export function cookieBadges(cookie) {
	return [
		cookie.session ? "Session" : "Persistent",
		cookie.hostOnly ? "Host only" : "Domain",
		cookie.secure ? "Secure" : null,
		cookie.httpOnly ? "HttpOnly" : null,
	].filter(Boolean);
}

export function expiryLabel(cookie) {
	if (cookie.session) return "Session cookie";
	const time = new Date(cookie.expiresAt);
	if (Number.isNaN(time.getTime())) return "Expired";
	return `Expires ${time.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
