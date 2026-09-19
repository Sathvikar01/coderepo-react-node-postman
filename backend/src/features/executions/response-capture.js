import zlib from "node:zlib";
import { TransportError } from "./http-transport.js";

const DECODERS = { gzip: zlib.createGunzip, "x-gzip": zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
const TEXTUAL = /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|graphql)|.*\+(json|xml)$)/i;

export function contentEncodingOf(headers) {
	const raw =
		headers
			.find((header) => header.name.toLowerCase() === "content-encoding")
			?.value?.trim()
			.toLowerCase() ?? "";
	if (!raw || raw === "identity") return { encoding: "identity", supported: true, stacked: false };
	const list = raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (list.length > 1) return { encoding: raw, supported: false, stacked: true };
	if (!DECODERS[list[0]]) return { encoding: list[0], supported: false, stacked: false };
	return { encoding: list[0], supported: true, stacked: false };
}

export function mediaTypeOf(headers) {
	return (
		headers
			.find((header) => header.name.toLowerCase() === "content-type")
			?.value?.split(";")[0]
			?.trim() || ""
	);
}

function decodeStreaming(buffer, encoding, limit) {
	return new Promise((resolve, reject) => {
		const decoder = DECODERS[encoding]();
		const chunks = [];
		let size = 0;
		let exceeded = false;
		decoder.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				exceeded = true;
				decoder.destroy();
				return;
			}
			chunks.push(chunk);
		});
		decoder.on("end", () => resolve({ buffer: Buffer.concat(chunks), size, exceeded }));
		decoder.on("error", (error) =>
			reject(
				new TransportError("decode_error", `The response body could not be decompressed (${error.code || error.message}).`, {
					code: error.code,
				}),
			),
		);
		decoder.on("close", () => {
			if (exceeded) resolve({ buffer: Buffer.concat(chunks), size, exceeded });
		});
		decoder.end(buffer);
	});
}

function toUtf8(buffer) {
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), valid: true };
	} catch {
		return { text: null, valid: false };
	}
}

export async function captureBody({ encoded, headers, limits, method, status }) {
	const { encoding, supported, stacked } = contentEncodingOf(headers);
	const mediaType = mediaTypeOf(headers);
	const decodedBodyBytes = encoded.length;
	const warnings = [];
	if (method === "HEAD" || status === 204 || status === 304 || encoded.length === 0) {
		return {
			body: { encoding: "utf8", value: "", mediaType, truncated: false },
			decodedBodyBytes: 0,
			capturedBodyBytes: encoded.length,
			warnings,
		};
	}
	if (stacked || !supported) {
		warnings.push({
			code: "ENCODING_UNSUPPORTED",
			message: `Response encoding "${encoding || "unknown"}" is not supported; showing the encoded bytes.`,
		});
		return {
			body: {
				encoding: "base64",
				value: encoded.toString("base64"),
				mediaType,
				truncated: false,
				omittedReason: "unsupported_encoding",
			},
			decodedBodyBytes: 0,
			capturedBodyBytes: encoded.length,
			warnings,
		};
	}
	let decoded = encoded;
	let exceeded = false;
	if (encoding !== "identity") {
		const result = await decodeStreaming(encoded, encoding, limits.decodedBytes);
		decoded = result.buffer;
		exceeded = result.exceeded;
		if (exceeded)
			throw new TransportError("size_limit", `The decoded response body exceeded ${limits.decodedBytes} bytes.`, {
				decodedBytes: result.size,
				limit: limits.decodedBytes,
			});
	} else if (decoded.length > limits.decodedBytes) {
		throw new TransportError("size_limit", `The decoded response body exceeded ${limits.decodedBytes} bytes.`, {
			decodedBytes: decoded.length,
			limit: limits.decodedBytes,
		});
	}
	const looksTextual = TEXTUAL.test(mediaType) || mediaType === "";
	const utf8 = toUtf8(decoded);
	if (!looksTextual && !utf8.valid) {
		return {
			body: {
				encoding: "base64",
				value: decoded.toString("base64"),
				mediaType,
				truncated: exceeded,
				omittedReason: exceeded ? "decoded_limit" : "binary",
			},
			decodedBodyBytes: decoded.length,
			capturedBodyBytes: encoded.length,
			warnings,
		};
	}
	if (!utf8.valid) {
		warnings.push({ code: "INVALID_UTF8", message: "The response body is not valid UTF-8; showing a safe encoded representation." });
		return {
			body: { encoding: "base64", value: decoded.toString("base64"), mediaType, truncated: exceeded, omittedReason: "invalid_utf8" },
			decodedBodyBytes: decoded.length,
			capturedBodyBytes: encoded.length,
			warnings,
		};
	}
	return {
		body: { encoding: "utf8", value: utf8.text, mediaType, truncated: exceeded },
		decodedBodyBytes: decoded.length,
		capturedBodyBytes: encoded.length,
		warnings,
	};
}
