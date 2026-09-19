import { describe, expect, test } from "bun:test";
import { LIMITS } from "../../shared/utils/limits.js";
import { buildResponseResult } from "./response-normalizer.js";

function transportWith(bodyLength, encoding) {
	return {
		ok: true,
		truncated: false,
		encodedBytes: bodyLength,
		state: { status: 200, statusText: "OK", httpVersion: "1.1", headers: [] },
		timing: { totalMs: 12, firstByteMs: 8 },
	};
}

describe("response body persistence cap", () => {
	test("utf8 bodies beyond the history cap are truncated and labeled", () => {
		const long = "a".repeat(LIMITS.historyBodyBytes + 500);
		const result = buildResponseResult({
			transport: transportWith(long.length),
			capture: { body: { encoding: "utf8", value: long, mediaType: "text/plain" }, decodedBodyBytes: long.length, warnings: [] },
			redaction: { values: [], headerNames: [], queryKeys: [] },
			executedUrl: "http://example.test/",
			timeoutMs: 15000,
		});

		expect(result.body.value.length).toBe(LIMITS.historyBodyBytes);
		expect(result.body.truncated).toBe(true);
		expect(result.body.omittedReason).toBe("retention");
	});

	test("base64 bodies beyond the cap stay decodable and are counted honestly", () => {
		const binary = Buffer.alloc(LIMITS.historyBodyBytes + 1024, 7);
		const encoded = binary.toString("base64");
		const result = buildResponseResult({
			transport: transportWith(binary.length),
			capture: {
				body: { encoding: "base64", value: encoded, mediaType: "application/octet-stream" },
				decodedBodyBytes: binary.length,
				warnings: [],
			},
			redaction: { values: [], headerNames: [], queryKeys: [] },
			executedUrl: "http://example.test/",
			timeoutMs: 15000,
		});

		expect(result.body.value.length).toBeLessThanOrEqual(LIMITS.historyBodyBytes);
		expect(result.body.truncated).toBe(true);
		const decoded = Buffer.from(result.body.value, "base64");
		expect(decoded.length).toBeGreaterThan(0);
		expect(decoded.toString("base64")).toBe(result.body.value);
		expect(result.size.persistedBodyBytes).toBe(Buffer.byteLength(result.body.value, "utf8"));
	});

	test("small bodies are stored untouched", () => {
		const result = buildResponseResult({
			transport: transportWith(11),
			capture: { body: { encoding: "utf8", value: "hello world", mediaType: "text/plain" }, decodedBodyBytes: 11, warnings: [] },
			redaction: { values: [], headerNames: [], queryKeys: [] },
			executedUrl: "http://example.test/",
			timeoutMs: 15000,
		});

		expect(result.body.value).toBe("hello world");
		expect(result.body.truncated).toBeUndefined();
		expect(result.size.persistedBodyBytes).toBe(11);
	});
});
