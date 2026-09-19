import net from "node:net";
import tls from "node:tls";

export class TransportError extends Error {
	constructor(kind, message, details) {
		super(message);
		this.kind = kind;
		this.details = details;
	}
}

const RESERVED = new Set(["host", "connection", "accept-encoding", "content-length"]);

export function serializeRequest({ method, target, headers, body }) {
	const lines = [
		`${method} ${target.pathAndQuery || "/"} HTTP/1.1`,
		`Host: ${target.authority}`,
		"Connection: close",
		"Accept-Encoding: gzip, deflate, br",
	];
	for (const header of headers) {
		if (RESERVED.has(header.name.toLowerCase())) continue;
		lines.push(`${header.name}: ${header.value}`);
	}
	if (body && body.length > 0) lines.push(`Content-Length: ${body.length}`);
	const head = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "utf8");
	return body && body.length > 0 ? Buffer.concat([head, body]) : head;
}

function connectSocket(target, { signal, connectTimeoutMs }) {
	return new Promise((resolve, reject) => {
		const options = { host: target.ip, port: target.port, family: target.family };
		const socket =
			target.scheme === "https"
				? tls.connect({
						...options,
						servername: target.isIpLiteral ? undefined : target.originalHostname,
						rejectUnauthorized: true,
					})
				: net.connect(options);
		let settled = false;
		const cleanup = () => {
			socket.removeListener("error", onError);
			socket.removeListener("timeout", onTimeout);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			reject(error);
		};
		const onError = (error) =>
			fail(
				new TransportError("network_error", `The target could not be reached (${error.code || error.message}).`, {
					code: error.code,
				}),
			);
		const onTimeout = () => fail(new TransportError("timeout", "The connection to the target timed out."));
		const onAbort = () => fail(new TransportError("cancelled", "This execution was cancelled."));
		socket.setTimeout(Math.max(1, connectTimeoutMs));
		socket.once("error", onError);
		socket.once("timeout", onTimeout);
		if (signal) {
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
		}
		socket.once(target.scheme === "https" ? "secureConnect" : "connect", () => {
			socket.setTimeout(0);
			const remote = String(socket.remoteAddress || "").replace(/^::ffff:/, "");
			if (remote !== String(target.ip).replace(/^::ffff:/, "")) {
				return fail(
					new TransportError("network_error", "The connected peer did not match the validated address.", {
						expected: target.ip,
						actual: remote,
					}),
				);
			}
			settled = true;
			cleanup();
			resolve(socket);
		});
	});
}

const NO_BODY_STATUS = new Set([204, 304]);
const MAX_INFORMATIONAL = 5;
const MAX_CHUNK_LINE_BYTES = 8192;

export async function performRequest({ target, method, headers, body, timeoutMs, signal, limits, onDispatch }) {
	const startedAt = Date.now();
	let firstByteMs = null;
	let socket;
	try {
		socket = await connectSocket(target, { signal, connectTimeoutMs: timeoutMs });
	} catch (error) {
		const transportError =
			error instanceof TransportError ? error : new TransportError("network_error", String(error?.message ?? error));
		return {
			ok: false,
			error: transportError,
			state: { status: 0, statusText: "", httpVersion: "1.1", headers: [] },
			encoded: Buffer.alloc(0),
			encodedBytes: 0,
			truncated: false,
			omittedReason: null,
			bytesSent: 0,
			timing: { totalMs: Date.now() - startedAt, firstByteMs },
		};
	}
	const requestBytes = serializeRequest({ method, target, headers, body });

	const state = { status: 0, statusText: "", httpVersion: "1.1", headers: [] };
	const sink = { encoded: Buffer.alloc(0), encodedBytes: 0, truncated: false, omittedReason: null };
	const captureLimit = limits.captureBytes;

	const push = (chunk) => {
		if (firstByteMs === null) firstByteMs = Date.now() - startedAt;
		sink.encodedBytes += chunk.length;
		const room = captureLimit - sink.encoded.length;
		if (room > 0) {
			sink.encoded = Buffer.concat([sink.encoded, chunk.subarray(0, room)]);
			if (chunk.length > room) {
				sink.truncated = true;
				sink.omittedReason = "capture_limit";
			}
		} else if (chunk.length > 0) {
			sink.truncated = true;
			sink.omittedReason = "capture_limit";
		}
		if (sink.encodedBytes > captureLimit) {
			throw new TransportError("size_limit", `The response body exceeded ${captureLimit} bytes.`, {
				encodedBytes: sink.encodedBytes,
				limit: captureLimit,
			});
		}
	};

	const outcome = await new Promise((resolve) => {
		let pending = Buffer.alloc(0);
		let phase = "head";
		let chunked = false;
		let chunkState = "size";
		let remaining = null;
		let chunkRemaining = 0;
		let informational = 0;
		let settled = false;

		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners("data");
			socket.removeAllListeners("close");
			socket.destroy();
			resolve({ error: error ?? null });
		};

		const fail = (error) => finish(error);

		const readHead = () => {
			const end = pending.indexOf("\r\n\r\n");
			if (end === -1) {
				if (pending.length > limits.responseHeaderBytes + 4)
					return fail(new TransportError("decode_error", "Response headers exceeded the allowed size."));
				return "wait";
			}
			const headText = pending.subarray(0, end).toString("latin1");
			if (Buffer.byteLength(headText, "latin1") > limits.responseHeaderBytes) {
				fail(new TransportError("decode_error", "Response headers exceeded the allowed size."));
				return "parsed";
			}
			const lines = headText.split("\r\n");
			const statusMatch = /^HTTP\/(\d\.\d) (\d{3})(?: (.*))?$/.exec(lines.shift() ?? "");
			if (!statusMatch) {
				fail(new TransportError("decode_error", "The target returned an invalid HTTP status line."));
				return "parsed";
			}
			const parsedHeaders = [];
			for (const line of lines) {
				const colon = line.indexOf(":");
				if (colon <= 0) {
					fail(new TransportError("decode_error", "The target returned an invalid HTTP header."));
					return "parsed";
				}
				parsedHeaders.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
			}
			if (parsedHeaders.length > limits.responseHeaderPairs) {
				fail(new TransportError("decode_error", "The response returned too many header pairs."));
				return "parsed";
			}
			pending = pending.subarray(end + 4);
			const status = Number(statusMatch[2]);
			if (status >= 100 && status < 200) {
				informational += 1;
				if (informational > MAX_INFORMATIONAL) {
					fail(new TransportError("decode_error", "The target returned too many informational responses."));
					return "parsed";
				}
				return "next";
			}
			state.status = status;
			state.statusText = statusMatch[3] ?? "";
			state.httpVersion = statusMatch[1];
			state.headers = parsedHeaders;
			phase = "body";
			if (method === "HEAD" || NO_BODY_STATUS.has(status)) {
				finish(null);
				return "parsed";
			}
			const transferEncoding = (
				parsedHeaders.find((header) => header.name.toLowerCase() === "transfer-encoding")?.value || ""
			).toLowerCase();
			if (transferEncoding.includes("chunked")) {
				chunked = true;
				chunkState = "size";
			} else if (transferEncoding.trim() && transferEncoding.trim() !== "identity") {
				fail(new TransportError("decode_error", "The target returned an unsupported Transfer-Encoding."));
				return "parsed";
			} else {
				const lengths = parsedHeaders
					.filter((header) => header.name.toLowerCase() === "content-length")
					.map((header) => header.value.trim());
				if (lengths.length > 1 && new Set(lengths).size > 1) {
					fail(new TransportError("decode_error", "The target returned conflicting Content-Length headers."));
					return "parsed";
				}
				if (lengths.length > 0) {
					if (!/^\d+$/.test(lengths[0]) || !Number.isSafeInteger(Number(lengths[0]))) {
						fail(new TransportError("decode_error", "The target returned an invalid Content-Length header."));
						return "parsed";
					}
					remaining = Number(lengths[0]);
				} else {
					remaining = null;
				}
			}
			if (remaining === 0) {
				finish(null);
				return "parsed";
			}
			return "parsed";
		};

		const pump = () => {
			try {
				for (;;) {
					if (settled) return;
					if (phase === "head") {
						const outcome = readHead();
						if (settled) return;
						if (outcome === "wait") return;
						if (outcome === "parsed") continue;
						if (outcome === "next") {
							phase = "head";
							continue;
						}
						return;
					}
					if (chunked) {
						if (chunkState === "size") {
							const lineEnd = pending.indexOf("\r\n");
							if (lineEnd === -1) {
								if (pending.length > MAX_CHUNK_LINE_BYTES)
									fail(new TransportError("decode_error", "The chunk metadata exceeded the allowed size."));
								return;
							}
							const sizeLine = pending.subarray(0, lineEnd).toString("latin1").split(";")[0].trim();
							if (!/^[0-9a-fA-F]+$/.test(sizeLine)) {
								fail(new TransportError("decode_error", "The target returned an invalid chunked body."));
								return;
							}
							const size = Number.parseInt(sizeLine, 16);
							pending = pending.subarray(lineEnd + 2);
							if (size === 0) {
								finish(null);
								return;
							}
							chunkRemaining = size;
							chunkState = "data";
							continue;
						}
						if (chunkState === "data") {
							const take = Math.min(chunkRemaining, pending.length);
							if (take > 0) {
								push(pending.subarray(0, take));
								pending = pending.subarray(take);
								chunkRemaining -= take;
							}
							if (chunkRemaining > 0) return;
							chunkState = "crlf";
							continue;
						}
						if (pending.length < 2) return;
						if (pending[0] !== 13 || pending[1] !== 10) {
							fail(new TransportError("decode_error", "The target returned an invalid chunk delimiter."));
							return;
						}
						pending = pending.subarray(2);
						chunkState = "size";
						continue;
					}
					if (remaining !== null) {
						if (remaining === 0) {
							finish(null);
							return;
						}
						if (pending.length === 0) return;
						const take = Math.min(remaining, pending.length);
						push(pending.subarray(0, take));
						pending = pending.subarray(take);
						remaining -= take;
						if (remaining === 0) {
							finish(null);
							return;
						}
						continue;
					}
					if (pending.length === 0) return;
					push(pending);
					pending = Buffer.alloc(0);
					return;
				}
			} catch (error) {
				return fail(error);
			}
		};

		const timer = setTimeout(
			() => fail(new TransportError("timeout", "This execution exceeded its time budget.")),
			Math.max(1, timeoutMs - (Date.now() - startedAt)),
		);
		const onAbort = () => fail(new TransportError("cancelled", "This execution was cancelled."));
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		socket.on("data", (chunk) => {
			if (firstByteMs === null) firstByteMs = Date.now() - startedAt;
			pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
			pump();
		});
		socket.once("error", (error) =>
			fail(new TransportError("network_error", `The connection failed (${error.code || error.message}).`, { code: error.code })),
		);
		socket.once("close", () => {
			if (settled) return;
			try {
				pump();
			} catch (error) {
				fail(error);
				return;
			}
			if (settled) return;
			if (phase === "body" && !chunked && remaining === null) {
				finish(null);
				return;
			}
			fail(new TransportError("network_error", "The target closed the connection before the response completed."));
		});
		onDispatch?.();
		socket.write(requestBytes);
	});

	return {
		ok: !outcome.error,
		error: outcome.error ?? null,
		state,
		encoded: sink.encoded,
		encodedBytes: sink.encodedBytes,
		truncated: sink.truncated,
		omittedReason: sink.omittedReason,
		bytesSent: requestBytes.length,
		timing: { totalMs: Date.now() - startedAt, firstByteMs },
	};
}
