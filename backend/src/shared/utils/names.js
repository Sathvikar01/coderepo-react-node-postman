export function nameKey(value) {
	return String(value ?? "")
		.trim()
		.normalize("NFKC")
		.toLowerCase();
}

export function escapeRegex(value) {
	return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
