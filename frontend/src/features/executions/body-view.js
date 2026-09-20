import { formatBytes } from "../../shared/utils/format.js";
import { formatJsonText } from "./json-format.js";
import { formatHtml, formatXml } from "./markup-format.js";

export const PRETTY_BODY_LIMIT = 256 * 1024;

function structured(kind, result, source, { silent = false } = {}) {
	if (result.ok) return { presentation: kind, text: result.text };
	return { presentation: "raw", text: source, reason: silent ? null : result.reason };
}

// Single decision point for how a captured body may be presented. Formatting is
// only attempted when it cannot change the captured source, so every fallback
// keeps the Raw text intact.
export function describeBody(body) {
	if (!body) return { presentation: "empty", text: "" };
	if (body.encoding === "base64") return { presentation: "binary", text: body.value ?? "" };
	const text = body.encoding === "utf8" ? (body.value ?? "") : "";
	if (!text) return { presentation: "empty", text: "" };
	if (body.truncated) return { presentation: "raw", text };
	if (text.length > PRETTY_BODY_LIMIT)
		return {
			presentation: "raw",
			text,
			reason: `The body is larger than ${formatBytes(PRETTY_BODY_LIMIT)}; Raw source is shown instead.`,
		};
	const media = (body.mediaType || "").toLowerCase();
	if (media.includes("json")) return structured("json", formatJsonText(text), text);
	if (media.includes("xml")) return structured("xml", formatXml(text), text);
	if (media.includes("html")) return structured("html", formatHtml(text), text);
	if (/^\s*[[{]/.test(text)) return structured("json", formatJsonText(text), text, { silent: true });
	return { presentation: "raw", text };
}

export function bodyNotice(body, size = {}) {
	if (!body) return null;
	if (body.truncated) {
		if (body.omittedReason === "retention")
			return {
				tone: "warning",
				message: "This body was removed from history by the retention policy. Send the request again to inspect it.",
			};
		if (body.omittedReason === "sensitive")
			return { tone: "warning", message: "This body was withheld because it contains a redacted secret value." };
		if (body.omittedReason === "history_limit")
			return {
				tone: "warning",
				message: `History kept the first ${formatBytes(size.persistedBodyBytes)} of this ${formatBytes(size.decodedBodyBytes)} body. Send the request again to inspect the full response.`,
			};
		return { tone: "warning", message: "The captured body was truncated. Only the first part is displayed." };
	}
	if (body.encoding === "base64")
		return {
			tone: "info",
			message: `This response is binary or not valid UTF-8 (${body.mediaType || "unknown media type"}). It is shown as Base64 and never rendered as live content.`,
		};
	return null;
}
