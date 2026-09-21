// Copy helper for generated snippets. Returns a boolean so the dialog can tell
// the user the truth instead of showing a success it did not get.

export async function writeClipboard(text, clipboard = globalThis.navigator?.clipboard ?? null) {
	if (!clipboard?.writeText) return false;
	try {
		await clipboard.writeText(String(text));
		return true;
	} catch {
		return false;
	}
}
