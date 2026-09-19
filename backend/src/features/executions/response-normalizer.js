import { LIMITS } from "../../shared/utils/limits.js";

const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);

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
	if (body.value.length > LIMITS.historyBodyBytes) {
		const limit = body.encoding === "base64" ? LIMITS.historyBodyBytes - (LIMITS.historyBodyBytes % 4) : LIMITS.historyBodyBytes;
		body.value = body.value.slice(0, limit);
		body.truncated = true;
		body.omittedReason = "retention";
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
			persistedBodyBytes: Buffer.byteLength(body.value ?? "", "utf8"),
		},
		timeoutMs,
		warnings,
	};
}
