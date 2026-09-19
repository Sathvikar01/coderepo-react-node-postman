import { describe, expect, test } from "bun:test";
import { LIMITS } from "../../shared/utils/limits.js";
import { buildResponseResult, truncateBodyForHistory } from "./response-normalizer.js";

function transportWith(bodyLength, encoding) {
	return {
		ok: true,
		truncated: false,
		encodedBytes: bodyLength,
		state: { status: 200, statusText: "OK", httpVersion: "1.1", headers: [] },
		timing: { totalMs: 12, firstByteMs: 8 },
	};
}

function build(capture) {
	return buildResponseResult({
		transport: transportWith(capture.body.value?.length ?? 0),
		capture,
		redaction: { values: [], headerNames: [], queryKeys: [] },
		executedUrl: "http://example.test/",
		timeoutMs: 15000,
	});
}

describe("response body persistence cap", () => {
	test("utf8 bodies beyond the history cap are truncated and labeled in history only", () => {
		const long = "a".repeat(LIMITS.historyBodyBytes + 500);
		const live = build({ body: { encoding: "utf8", value: long, mediaType: "text/plain" }, decodedBodyBytes: long.length, warnings: [] });
		const result = truncateBodyForHistory(live);

		expect(live.body.value.length).toBe(long.length);
		expect(live.body.truncated).toBeUndefined();
		expect(result.body.value.length).toBe(LIMITS.historyBodyBytes);
		expect(result.body.truncated).toBe(true);
		expect(result.body.omittedReason).toBe("history_limit");
		expect(result.body.historyBodyTruncated).toBe(true);
		expect(result.warnings).toContainEqual(expect.objectContaining({ code: "HISTORY_LIMIT" }));
	});

	test("base64 bodies beyond the cap stay decodable and are counted honestly", () => {
		const binary = Buffer.alloc(LIMITS.historyBodyBytes + 1024, 7);
		const encoded = binary.toString("base64");
		const live = build({
			body: { encoding: "base64", value: encoded, mediaType: "application/octet-stream" },
			decodedBodyBytes: binary.length,
			warnings: [],
		});
		const result = truncateBodyForHistory(live);

		expect(live.body.value).toBe(encoded);
		expect(result.body.value.length).toBeLessThanOrEqual(LIMITS.historyBodyBytes);
		expect(result.body.truncated).toBe(true);
		const decoded = Buffer.from(result.body.value, "base64");
		expect(decoded.length).toBeGreaterThan(0);
		expect(decoded.toString("base64")).toBe(result.body.value);
		expect(result.size.persistedBodyBytes).toBe(Buffer.byteLength(result.body.value, "utf8"));
	});

	test("utf8 capping is byte-accurate for multibyte characters", () => {
		const text = "€".repeat(LIMITS.historyBodyBytes);
		const live = build({ body: { encoding: "utf8", value: text, mediaType: "text/plain" }, decodedBodyBytes: text.length, warnings: [] });
		const result = truncateBodyForHistory(live);

		expect(result.body.value).not.toBe(text);
		expect(Buffer.byteLength(result.body.value, "utf8")).toBeLessThanOrEqual(LIMITS.historyBodyBytes);
		expect(result.size.persistedBodyBytes).toBe(Buffer.byteLength(result.body.value, "utf8"));
		expect(result.body.value.endsWith("€")).toBe(true);
	});

	test("small bodies are stored untouched", () => {
		const live = build({ body: { encoding: "utf8", value: "hello world", mediaType: "text/plain" }, decodedBodyBytes: 11, warnings: [] });
		const result = truncateBodyForHistory(live);

		expect(result).toBe(live);
		expect(result.body.value).toBe("hello world");
		expect(result.body.truncated).toBeUndefined();
		expect(result.size.persistedBodyBytes).toBe(11);
	});
});
