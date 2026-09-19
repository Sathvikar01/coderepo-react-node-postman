import { LIMITS } from "../../shared/utils/limits.js";

const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);

function historyBodyLimit(encoding) {
	return encoding === "base64" ? LIMITS.historyBodyBytes - (LIMITS.historyBodyBytes % 4) : LIMITS.historyBodyBytes;
}

function capTextForHistory(value, encoding) {
	const limit = historyBodyLimit(encoding);
	if (encoding !== "base64") {
		const bytes = Buffer.from(value, "utf8");
		if (bytes.length <= limit) return value;
		return new TextDecoder("utf-8").decode(bytes.subarray(0, limit), { stream: true });
	}
	return value.length <= limit ? value : value.slice(0, limit);
}

export function redactText(text, secretValues) {
	let output = String(text ?? "");
	for (const secret of secretValues) {
		if (!secret || secret.length < 3) continue;
		output = output.split(secret).join("[REDACTED]");
	}
	return output;
}

export function buildResponseResult({ transport, capture, redaction, executedUrl, timeoutMs }) {
	const headers = transport.state.headers.map((header) => ({
		name: header.name,
		value:
			SENSITIVE_HEADERS.has(header.name.toLowerCase()) || redaction.headerNames.includes(header.name.toLowerCase())
				? "[REDACTED]"
				: redactText(header.value, redaction.values),
	}));
	const body = { ...capture.body };
	if (body.encoding === "utf8") {
		body.value = redactText(body.value, redaction.values);
	} else if (body.encoding === "base64" && body.value) {
		const bytes = Buffer.from(body.value, "base64");
		const containsSecret = (redaction.values ?? []).some((secret) => {
			if (!secret || secret.length < 3) return false;
			return bytes.includes(Buffer.from(secret, "utf8"));
		});
		if (containsSecret) {
			body.value = "";
			body.truncated = true;
			body.omittedReason = "sensitive";
		}
	}
	const warnings = [...capture.warnings];
	if (transport.truncated)
		warnings.push({
			code: "CAPTURE_LIMIT",
			message: `Only the first ${LIMITS.captureBytes} bytes of the response body were captured.`,
		});
	return {
		status: transport.state.status,
		statusText: transport.state.statusText,
		httpVersion: transport.state.httpVersion,
		executedUrl,
		headers,
		body,
		timing: { totalMs: transport.timing.totalMs, firstByteMs: transport.timing.firstByteMs },
		size: {
			receivedBodyBytes: transport.encodedBytes,
			decodedBodyBytes: capture.decodedBodyBytes,
			capturedBodyBytes: Math.min(transport.encodedBytes, LIMITS.captureBytes),
			persistedBodyBytes: Buffer.byteLength(capTextForHistory(body.value ?? "", body.encoding ?? "utf8"), "utf8"),
		},
		timeoutMs,
		warnings,
	};
}

export function truncateBodyForHistory(response) {
	const body = response?.body;
	if (!body) return response;
	const capped = capTextForHistory(body.value ?? "", body.encoding ?? "utf8");
	if (capped === body.value) return response;
	const historyBody = { ...body, value: capped, truncated: true, omittedReason: "history_limit", historyBodyTruncated: true };
	return {
		...response,
		body: historyBody,
		size: { ...response.size, persistedBodyBytes: Buffer.byteLength(capped, "utf8") },
		warnings: [
			...(response.warnings ?? []),
			{ code: "HISTORY_LIMIT", message: `Only the first ${LIMITS.historyBodyBytes} bytes of this body are kept in history.` },
		],
	};
}
