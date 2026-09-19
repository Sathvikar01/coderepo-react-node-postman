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
