import { describe, expect, test } from "bun:test";
import zlib from "node:zlib";
import { captureBody } from "./response-capture.js";

describe("response capture limits", () => {
	test("reports decoded compressed overflow as size_limit", async () => {
		const encoded = zlib.gzipSync(Buffer.from("a".repeat(5000)));
		await expect(
			captureBody({
				encoded,
				headers: [
					{ name: "Content-Encoding", value: "gzip" },
					{ name: "Content-Type", value: "text/plain" },
				],
				limits: { decodedBytes: 256 },
				method: "GET",
				status: 200,
			}),
		).rejects.toMatchObject({ kind: "size_limit" });
	});

	test("reports identity overflow as size_limit", async () => {
		await expect(
			captureBody({
				encoded: Buffer.alloc(300, 97),
				headers: [{ name: "Content-Type", value: "text/plain" }],
				limits: { decodedBytes: 256 },
				method: "GET",
				status: 200,
			}),
		).rejects.toMatchObject({ kind: "size_limit" });
	});
});

describe("response decoding matrix", () => {
	const limits = { decodedBytes: 1024 * 1024 };

	test("decodes gzip, x-gzip, deflate, raw deflate, and brotli", async () => {
		const payload = Buffer.from("compressed payload ".repeat(40));
		const cases = [
			["gzip", zlib.gzipSync(payload)],
			["x-gzip", zlib.gzipSync(payload)],
			["deflate", zlib.deflateSync(payload)],
			["deflate-raw", zlib.deflateRawSync(payload)],
			["br", zlib.brotliCompressSync(payload)],
		];
		for (const [encoding, encoded] of cases) {
			const result = await captureBody({
				encoded,
				headers: [
					{ name: "Content-Encoding", value: encoding === "deflate-raw" ? "deflate" : encoding },
					{ name: "Content-Type", value: "text/plain" },
				],
				limits,
				method: "GET",
				status: 200,
			});
			expect(result.body.value).toBe(payload.toString());
			expect(result.warnings).toEqual([]);
		}
	});

	test("reports a brotli compression bomb as decoded size_limit", async () => {
		const bomb = zlib.brotliCompressSync(Buffer.alloc(4 * 1024 * 1024, 97));
		await expect(
			captureBody({
				encoded: bomb,
				headers: [
					{ name: "Content-Encoding", value: "br" },
					{ name: "Content-Type", value: "text/plain" },
				],
				limits: { decodedBytes: 512 },
				method: "GET",
				status: 200,
			}),
		).rejects.toMatchObject({ kind: "size_limit" });
	});

	test("reports invalid supported compression as decode_error", async () => {
		await expect(
			captureBody({
				encoded: Buffer.from("this is not gzip"),
				headers: [
					{ name: "Content-Encoding", value: "gzip" },
					{ name: "Content-Type", value: "text/plain" },
				],
				limits,
				method: "GET",
				status: 200,
			}),
		).rejects.toMatchObject({ kind: "decode_error" });
	});

	test("keeps stacked or unknown encodings as bounded base64 with a notice", async () => {
		for (const encoding of ["gzip, br", "zstd"]) {
			const result = await captureBody({
				encoded: Buffer.from([0, 1, 2, 3]),
				headers: [
					{ name: "Content-Encoding", value: encoding },
					{ name: "Content-Type", value: "application/octet-stream" },
				],
				limits,
				method: "GET",
				status: 200,
			});
			expect(result.body.encoding).toBe("base64");
			expect(result.body.value).toBe(Buffer.from([0, 1, 2, 3]).toString("base64"));
			expect(result.warnings).toContainEqual(expect.objectContaining({ code: "ENCODING_UNSUPPORTED" }));
		}
	});

	test("refuses to decode when the execution was cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			captureBody({
				encoded: zlib.gzipSync(Buffer.from("late")),
				headers: [{ name: "Content-Encoding", value: "gzip" }],
				limits,
				method: "GET",
				status: 200,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ kind: "cancelled" });
	});

	test("refuses to decode after the execution deadline", async () => {
		await expect(
			captureBody({
				encoded: zlib.gzipSync(Buffer.from("late")),
				headers: [{ name: "Content-Encoding", value: "gzip" }],
				limits,
				method: "GET",
				status: 200,
				deadlineAt: Date.now() - 1,
			}),
		).rejects.toMatchObject({ kind: "timeout" });
	});
});

describe("response body classification", () => {
	const limits = { decodedBytes: 1024 * 1024 };

	test("HEAD, 204, and 304 always produce an empty UTF-8 body", async () => {
		const cases = [
			{ method: "HEAD", status: 200, headers: [{ name: "Content-Type", value: "application/json" }] },
			{ method: "GET", status: 204, headers: [] },
			{ method: "GET", status: 304, headers: [{ name: "Content-Type", value: "text/plain" }] },
		];
		for (const { method, status, headers } of cases) {
			const result = await captureBody({ encoded: Buffer.alloc(0), headers, limits, method, status });
			expect(result.body.encoding).toBe("utf8");
			expect(result.body.value).toBe("");
			expect(result.body.truncated).toBe(false);
			expect(result.decodedBodyBytes).toBe(0);
			expect(result.capturedBodyBytes).toBe(0);
			expect(result.warnings).toEqual([]);
		}
	});

	test("invalid UTF-8 with a textual media type is labeled and never rendered as text", async () => {
		const encoded = Buffer.from([0xff, 0xfe, 0x00]);
		const result = await captureBody({
			encoded,
			headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
			limits,
			method: "GET",
			status: 200,
		});
		expect(result.body.encoding).toBe("base64");
		expect(result.body.omittedReason).toBe("invalid_utf8");
		expect(result.body.value).toBe(encoded.toString("base64"));
		expect(result.warnings).toContainEqual(expect.objectContaining({ code: "INVALID_UTF8" }));
	});

	test("valid UTF-8 multibyte text survives identity capture byte-for-byte", async () => {
		const text = "héllo — 日本語 🚀";
		const result = await captureBody({
			encoded: Buffer.from(text, "utf8"),
			headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
			limits,
			method: "GET",
			status: 200,
		});
		expect(result.body.encoding).toBe("utf8");
		expect(result.body.value).toBe(text);
		expect(result.decodedBodyBytes).toBe(Buffer.byteLength(text, "utf8"));
	});

	test("compressed multibyte text decodes exactly", async () => {
		const text = "héllo — 日本語 🚀".repeat(20);
		const result = await captureBody({
			encoded: zlib.gzipSync(Buffer.from(text, "utf8")),
			headers: [
				{ name: "Content-Encoding", value: "gzip" },
				{ name: "Content-Type", value: "text/plain; charset=utf-8" },
			],
			limits,
			method: "GET",
			status: 200,
		});
		expect(result.body.value).toBe(text);
		expect(result.warnings).toEqual([]);
	});

	test("binary media types with valid UTF-8 bytes stay readable text", async () => {
		const result = await captureBody({
			encoded: Buffer.from("plain text"),
			headers: [{ name: "Content-Type", value: "application/octet-stream" }],
			limits,
			method: "GET",
			status: 200,
		});
		expect(result.body.encoding).toBe("utf8");
		expect(result.body.value).toBe("plain text");
	});
});
