import { describe, expect, test } from "bun:test";
import net from "node:net";
import zlib from "node:zlib";
import { once } from "node:events";
import { performRequest } from "./http-transport.js";

const limits = { captureBytes: 1024 * 1024, decodedBytes: 1024 * 1024, responseHeaderBytes: 32 * 1024, responseHeaderPairs: 200 };

async function withServer(handler, run) {
    const server = net.createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    const target = { scheme: "http", originalHostname: "127.0.0.1", authority: `127.0.0.1:${port}`, port, pathAndQuery: "/probe", ip: "127.0.0.1", family: 4, isIpLiteral: true, policyVersion: "1.0", local: false };
    try {
        return await run(target);
    } finally {
        server.close();
    }
}

const respond = (socket, text) => socket.end(text);

describe("http transport", () => {
    test("preserves duplicate response headers and casing", async () => {
        const result = await withServer((socket) => {
            socket.once("data", () => respond(socket, "HTTP/1.1 200 OK\r\nX-Dup: one\r\nX-Dup: two\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi"));
        }, (target) => performRequest({ target, method: "GET", headers: [], body: null, timeoutMs: 5000, signal: new AbortController().signal, limits }));
        expect(result.ok).toBe(true);
        expect(result.state.headers.filter((header) => header.name === "X-Dup").map((header) => header.value)).toEqual(["one", "two"]);
        expect(result.encoded.toString()).toBe("hi");
    });

    test("sends duplicate request headers and the original Host", async () => {
        let received = "";
        let authority = "";
        const result = await withServer((socket) => {
            socket.once("data", (chunk) => {
                received = chunk.toString("latin1");
                respond(socket, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            });
        }, (target) => {
            authority = target.authority;
            return performRequest({ target, method: "GET", headers: [{ name: "X-Out", value: "a" }, { name: "X-Out", value: "b" }], body: null, timeoutMs: 5000, signal: new AbortController().signal, limits });
        });
        expect(result.ok).toBe(true);
        expect(received).toContain(`Host: ${authority}`);
        expect(received.match(/X-Out: [ab]/g)).toHaveLength(2);
    });

    test("reads a chunked body", async () => {
        const result = await withServer((socket) => {
            socket.once("data", () => {
                socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
                socket.write("5\r\nhello\r\n");
                socket.end("6\r\n world\r\n0\r\n\r\n");
            });
        }, (target) => performRequest({ target, method: "GET", headers: [], body: null, timeoutMs: 5000, signal: new AbortController().signal, limits }));
        expect(result.encoded.toString()).toBe("hello world");
    });

    test("skips informational responses before the final one", async () => {
        const result = await withServer((socket) => {
            socket.once("data", () => socket.end("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"));
        }, (target) => performRequest({ target, method: "GET", headers: [], body: null, timeoutMs: 5000, signal: new AbortController().signal, limits }));
        expect(result.state.status).toBe(201);
    });

    test("returns no body for HEAD", async () => {
        const result = await withServer((socket) => {
            socket.once("data", () => respond(socket, "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n"));
        }, (target) => performRequest({ target, method: "HEAD", headers: [], body: null, timeoutMs: 5000, signal: new AbortController().signal, limits }));
        expect(result.ok).toBe(true);
        expect(result.encoded.length).toBe(0);
    });

    test("aborts an in-flight request", async () => {
        const controller = new AbortController();
        const result = await withServer((socket) => {
            socket.on("data", () => setTimeout(() => controller.abort(), 60));
        }, (target) => performRequest({ target, method: "GET", headers: [], body: null, timeoutMs: 5000, signal: controller.signal, limits }));
        expect(result.ok).toBe(false);
        expect(result.error.kind).toBe("cancelled");
    });

    test("enforces the deadline", async () => {
        const result = await withServer(() => {}, (target) => performRequest({ target, method: "GET", headers: [], body: null, timeoutMs: 120, signal: new AbortController().signal, limits }));
        expect(result.ok).toBe(false);
        expect(result.error.kind).toBe("timeout");
    });

    test("stops and reports when the encoded body exceeds the cap", async () => {
        const result = await withServer((socket) => {
            socket.once("data", () => {
                socket.write("HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n");
                socket.write(Buffer.alloc(4096, 97));
            });
        }, (target) => performRequest({ target, method: "GET", headers: [], body: null, timeoutMs: 5000, signal: new AbortController().signal, limits: { ...limits, captureBytes: 256 } }));
        expect(result.ok).toBe(false);
        expect(result.error.kind).toBe("size_limit");
    });

    test("reports an invalid status line as a decode error", async () => {
        const result = await withServer((socket) => {
            socket.once("data", () => respond(socket, "NOT-HTTP\r\nContent-Length: 0\r\n\r\n"));
        }, (target) => performRequest({ target, method: "GET", headers: [], body: null, timeoutMs: 5000, signal: new AbortController().signal, limits }));
        expect(result.ok).toBe(false);
        expect(result.error.kind).toBe("decode_error");
    });

    test("refuses to reuse a peer that does not match the pinned address", async () => {
        const result = await withServer((socket) => {
            socket.once("data", () => respond(socket, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"));
        }, (target) => performRequest({ target: { ...target, ip: "127.0.0.2" }, method: "GET", headers: [], body: null, timeoutMs: 3000, signal: new AbortController().signal, limits }));
        expect(result.ok).toBe(false);
        expect(result.state.status).toBe(0);
    });
});

describe("response decoding limits", () => {
    test("a compressed body decodes within the decoded budget", async () => {
        const payload = zlib.gzipSync(Buffer.from("a".repeat(5000)));
        const result = await withServer((socket) => {
            socket.once("data", () => {
                socket.write(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`);
                socket.end(payload);
            });
        }, (target) => performRequest({ target, method: "GET", headers: [], body: null, timeoutMs: 5000, signal: new AbortController().signal, limits }));
        expect(result.ok).toBe(true);
        expect(zlib.gunzipSync(result.encoded).toString()).toHaveLength(5000);
    });
});
