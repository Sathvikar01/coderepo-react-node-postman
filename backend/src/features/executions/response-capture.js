import zlib from "node:zlib";
import { TransportError } from "./http-transport.js";

const DECODERS = { gzip: zlib.createGunzip, "x-gzip": zlib.createGunzip, deflate: zlib.createInflate, "raw-deflate": zlib.createInflateRaw, br: zlib.createBrotliDecompress };
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

function budgetFailure({ signal, deadlineAt } = {}) {
	if (signal?.aborted) return new TransportError("cancelled", "This execution was cancelled.");
	if (deadlineAt !== undefined && deadlineAt - Date.now() <= 0)
		return new TransportError("timeout", "This execution exceeded its time budget.");
	return null;
}

function decodeStreaming(buffer, encoding, limit, budget = {}) {
	return new Promise((resolve, reject) => {
		const { signal, deadlineAt } = budget;
		const early = budgetFailure(budget);
		if (early) return reject(early);
		const decoder = DECODERS[encoding]();
		const chunks = [];
		let size = 0;
		let exceeded = false;
		let failure = null;
		let settled = false;
		let timer = null;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const settle = () => {
			if (settled) return;
			settled = true;
			cleanup();
			if (failure) reject(failure);
			else resolve({ buffer: Buffer.concat(chunks), size, exceeded });
		};
		const abort = (error) => {
			if (failure || settled) return;
			failure = error;
			decoder.destroy();
		};
		const onAbort = () => abort(new TransportError("cancelled", "This execution was cancelled."));
		decoder.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				exceeded = true;
				decoder.destroy();
				return;
			}
			chunks.push(chunk);
		});
		decoder.on("end", settle);
		decoder.on("error", (error) => {
			if (failure) return settle();
			failure = new TransportError("decode_error", `The response body could not be decompressed (${error.code || error.message}).`, {
				code: error.code,
			});
			settle();
		});
		decoder.on("close", settle);
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		if (deadlineAt !== undefined)
			timer = setTimeout(
				() => abort(new TransportError("timeout", "This execution exceeded its time budget.")),
				Math.max(1, deadlineAt - Date.now()),
			);
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

export async function captureBody({ encoded, headers, limits, method, status, signal, deadlineAt }) {
	const { encoding, supported, stacked } = contentEncodingOf(headers);
	const mediaType = mediaTypeOf(headers);
	const decodedBodyBytes = encoded.length;
	const warnings = [];
	const budget = { signal, deadlineAt };
	const outOfBudget = budgetFailure(budget);
	if (outOfBudget) throw outOfBudget;
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
		let result;
		try {
			result = await decodeStreaming(encoded, encoding, limits.decodedBytes, budget);
		} catch (error) {
			if (encoding !== "deflate" || error?.kind !== "decode_error") throw error;
			result = await decodeStreaming(encoded, "raw-deflate", limits.decodedBytes, budget);
		}
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
