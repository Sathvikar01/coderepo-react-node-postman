import { describe, expect, test } from "bun:test";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { once } from "node:events";
import { performRequest } from "./http-transport.js";

const limits = { captureBytes: 1024 * 1024, decodedBytes: 1024 * 1024, responseHeaderBytes: 32 * 1024, responseHeaderPairs: 200 };

async function withServer(handler, run) {
	const server = net.createServer(handler);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	const target = {
		scheme: "http",
		originalHostname: "127.0.0.1",
		authority: `127.0.0.1:${port}`,
		port,
		pathAndQuery: "/probe",
		ip: "127.0.0.1",
		family: 4,
		isIpLiteral: true,
		policyVersion: "1.0",
		local: false,
	};
	try {
		return await run(target);
	} finally {
		server.close();
	}
}

const respond = (socket, text) => socket.end(text);

describe("http transport", () => {
	test("preserves duplicate response headers and casing", async () => {
		const result = await withServer(
			(socket) => {
				socket.once("data", () =>
					respond(socket, "HTTP/1.1 200 OK\r\nX-Dup: one\r\nX-Dup: two\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi"),
				);
			},
			(target) =>
				performRequest({
					target,
					method: "GET",
					headers: [],
					body: null,
					timeoutMs: 5000,
					signal: new AbortController().signal,
					limits,
				}),
		);
		expect(result.ok).toBe(true);
		expect(result.state.headers.filter((header) => header.name === "X-Dup").map((header) => header.value)).toEqual(["one", "two"]);
		expect(result.encoded.toString()).toBe("hi");
	});

	test("sends duplicate request headers and the original Host", async () => {
		let received = "";
		let authority = "";
		const result = await withServer(
			(socket) => {
				socket.once("data", (chunk) => {
					received = chunk.toString("latin1");
					respond(socket, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
				});
			},
			(target) => {
				authority = target.authority;
				return performRequest({
					target,
					method: "GET",
					headers: [
						{ name: "X-Out", value: "a" },
						{ name: "X-Out", value: "b" },
					],
					body: null,
					timeoutMs: 5000,
					signal: new AbortController().signal,
					limits,
				});
			},
		);
		expect(result.ok).toBe(true);
		expect(received).toContain(`Host: ${authority}`);
		expect(received.match(/X-Out: [ab]/g)).toHaveLength(2);
	});

	test("reads a chunked body", async () => {
		const result = await withServer(
			(socket) => {
				socket.once("data", () => {
					socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
					socket.write("5\r\nhello\r\n");
					socket.end("6\r\n world\r\n0\r\n\r\n");
				});
			},
			(target) =>
				performRequest({
					target,
					method: "GET",
					headers: [],
					body: null,
					timeoutMs: 5000,
					signal: new AbortController().signal,
					limits,
				}),
		);
		expect(result.encoded.toString()).toBe("hello world");
	});


	test("accepts a valid close-delimited response body", async () => {
		const result = await withServer(
			(socket) => {
				socket.once("data", () => respond(socket, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhello"));
			},
			(target) =>
				performRequest({
					target,
					method: "GET",
					headers: [],
					body: null,
					timeoutMs: 5000,
					signal: new AbortController().signal,
					limits,
				}),
		);
		expect(result.ok).toBe(true);
		expect(result.encoded.toString()).toBe("hello");
	});

	test("rejects malformed chunk delimiters and oversized chunk metadata", async () => {
		const malformed = await withServer(
			(socket) => {
				socket.once("data", () =>
					respond(socket, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhelloXX0\r\n\r\n"),
				);
			},
			(target) =>
				performRequest({
					target,
					method: "GET",
					headers: [],
					body: null,
					timeoutMs: 5000,
					signal: new AbortController().signal,
					limits,
				}),
		);
		expect(malformed.ok).toBe(false);
		expect(malformed.error.kind).toBe("decode_error");

		const oversized = await withServer(
			(socket) => {
				socket.once("data", () => {
					socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
					socket.write("a".repeat(9000));
				});
			},
			(target) =>
				performRequest({
					target,
					method: "GET",
					headers: [],
					body: null,
					timeoutMs: 1000,
					signal: new AbortController().signal,
					limits,
				}),
		);
		expect(oversized.ok).toBe(false);
		expect(oversized.error.kind).toBe("decode_error");
	});

	test("skips informational responses before the final one", async () => {
		const result = await withServer(
			(socket) => {
				socket.once("data", () =>
					socket.end("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"),
				);
			},
			(target) =>
				performRequest({
					target,
					method: "GET",
					headers: [],
					body: null,
					timeoutMs: 5000,
					signal: new AbortController().signal,
					limits,
				}),
		);
		expect(result.state.status).toBe(201);
	});

	test("returns no body for HEAD", async () => {
		const result = await withServer(
			(socket) => {
				socket.once("data", () => respond(socket, "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n"));
			},
			(target) =>
				performRequest({
					target,
					method: "HEAD",
					headers: [],
					body: null,
					timeoutMs: 5000,
					signal: new AbortController().signal,
					limits,
				}),
		);
		expect(result.ok).toBe(true);
		expect(result.encoded.length).toBe(0);
	});

	test("aborts an in-flight request", async () => {
		const controller = new AbortController();
		const result = await withServer(
			(socket) => {
				socket.on("data", () => setTimeout(() => controller.abort(), 60));
			},
			(target) =>
				performRequest({ target, method: "GET", headers: [], body: null, timeoutMs: 5000, signal: controller.signal, limits }),
		);
		expect(result.ok).toBe(false);
		expect(result.error.kind).toBe("cancelled");
	});

	test("enforces the deadline", async () => {
		const result = await withServer(
			() => {},
			(target) =>
				performRequest({
					target,
					method: "GET",
					headers: [],
					body: null,
					timeoutMs: 120,
					signal: new AbortController().signal,
					limits,
				}),
		);
		expect(result.ok).toBe(false);
		expect(result.error.kind).toBe("timeout");
	});

	test("stops and reports when the encoded body exceeds the cap", async () => {
		const result = await withServer(
			(socket) => {
				socket.once("data", () => {
					socket.write("HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n");
					socket.write(Buffer.alloc(4096, 97));
				});
			},
			(target) =>
				performRequest({
					target,
					method: "GET",
					headers: [],
					body: null,
					timeoutMs: 5000,
					signal: new AbortController().signal,
					limits: { ...limits, captureBytes: 256 },
				}),
		);
		expect(result.ok).toBe(false);
		expect(result.error.kind).toBe("size_limit");
	});

	test("reports an invalid status line as a decode error", async () => {
		const result = await withServer(
			(socket) => {
				socket.once("data", () => respond(socket, "NOT-HTTP\r\nContent-Length: 0\r\n\r\n"));
			},
			(target) =>
				performRequest({
					target,
					method: "GET",
					headers: [],
					body: null,
					timeoutMs: 5000,
					signal: new AbortController().signal,
					limits,
				}),
		);
		expect(result.ok).toBe(false);
		expect(result.error.kind).toBe("decode_error");
	});

	test("refuses to reuse a peer that does not match the pinned address", async () => {
		const result = await withServer(
			(socket) => {
				socket.once("data", () => respond(socket, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"));
			},
			(target) =>
				performRequest({
					target: { ...target, ip: "127.0.0.2" },
					method: "GET",
					headers: [],
					body: null,
					timeoutMs: 3000,
					signal: new AbortController().signal,
					limits,
				}),
		);
		expect(result.ok).toBe(false);
		expect(result.state.status).toBe(0);
	});
});

describe("response decoding limits", () => {
	test("a compressed body decodes within the decoded budget", async () => {
		const payload = zlib.gzipSync(Buffer.from("a".repeat(5000)));
		const result = await withServer(
			(socket) => {
				socket.once("data", () => {
					socket.write(
						`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
					);
					socket.end(payload);
				});
			},
			(target) =>
				performRequest({
					target,
					method: "GET",
					headers: [],
					body: null,
					timeoutMs: 5000,
					signal: new AbortController().signal,
					limits,
				}),
		);
		expect(result.ok).toBe(true);
		expect(zlib.gunzipSync(result.encoded).toString()).toHaveLength(5000);
	});
});

describe("http transport framing adversaries", () => {
	const request = (target, overrides = {}) =>
		performRequest({
			target,
			method: "GET",
			headers: [],
			body: null,
			timeoutMs: 3000,
			signal: new AbortController().signal,
			limits,
			...overrides,
		});

	test("returns redirects verbatim and never follows them", async () => {
		let followed = 0;
		const destination = net.createServer((socket) => {
			followed += 1;
			socket.end();
		});
		destination.listen(0, "127.0.0.1");
		await once(destination, "listening");
		const destinationPort = destination.address().port;
		let requests = 0;
		try {
			const result = await withServer(
				(socket) => {
					requests += 1;
					socket.once("data", () =>
						respond(
							socket,
							`HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${destinationPort}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
						),
					);
				},
				(target) => request(target),
			);
			expect(result.ok).toBe(true);
			expect(result.state.status).toBe(302);
			expect(result.state.headers).toContainEqual({ name: "Location", value: `http://127.0.0.1:${destinationPort}/elsewhere` });
			expect(result.encoded.length).toBe(0);
			expect(requests).toBe(1);
			expect(followed).toBe(0);
		} finally {
			destination.close();
		}
	});

	test("treats 204 and 304 as bodyless even with a bogus Content-Length", async () => {
		for (const status of [204, 304]) {
			const result = await withServer(
				(socket) => {
					socket.once("data", () => respond(socket, `HTTP/1.1 ${status} No Body\r\nContent-Length: 99\r\nConnection: close\r\n\r\n`));
				},
				(target) => request(target),
			);
			expect(result.ok).toBe(true);
			expect(result.state.status).toBe(status);
			expect(result.encoded.length).toBe(0);
		}
	});

	test("reports an early disconnect as a network error", async () => {
		const truncatedBody = await withServer(
			(socket) => {
				socket.once("data", () => {
					socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc");
					setTimeout(() => socket.destroy(), 20);
				});
			},
			(target) => request(target),
		);
		expect(truncatedBody.ok).toBe(false);
		expect(truncatedBody.error.kind).toBe("network_error");

		const truncatedHead = await withServer(
			(socket) => {
				socket.once("data", () => {
					socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n");
					setTimeout(() => socket.destroy(), 20);
				});
			},
			(target) => request(target),
		);
		expect(truncatedHead.ok).toBe(false);
		expect(truncatedHead.error.kind).toBe("network_error");
	});

	test("rejects conflicting or invalid Content-Length framing", async () => {
		const conflicting = await withServer(
			(socket) => {
				socket.once("data", () => respond(socket, "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 9\r\nConnection: close\r\n\r\nhello"));
			},
			(target) => request(target),
		);
		expect(conflicting.ok).toBe(false);
		expect(conflicting.error.kind).toBe("decode_error");

		const invalid = await withServer(
			(socket) => {
				socket.once("data", () => respond(socket, "HTTP/1.1 200 OK\r\nContent-Length: 5x\r\nConnection: close\r\n\r\nhello"));
			},
			(target) => request(target),
		);
		expect(invalid.ok).toBe(false);
		expect(invalid.error.kind).toBe("decode_error");
	});

	test("prefers chunked framing when both Transfer-Encoding and Content-Length are present", async () => {
		const result = await withServer(
			(socket) => {
				socket.once("data", () =>
					respond(socket, "HTTP/1.1 200 OK\r\nContent-Length: 999\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\n\r\n"),
				);
			},
			(target) => request(target),
		);
		expect(result.ok).toBe(true);
		expect(result.encoded.toString()).toBe("hello");
	});

	test("reports a chunked body cut short by a disconnect", async () => {
		const result = await withServer(
			(socket) => {
				socket.once("data", () => {
					socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhel");
					setTimeout(() => socket.destroy(), 20);
				});
			},
			(target) => request(target),
		);
		expect(result.ok).toBe(false);
		expect(result.error.kind).toBe("network_error");
	});

	test("times out on a stalled body after valid headers", async () => {
		const result = await withServer(
			(socket) => {
				socket.once("data", () => socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc"));
			},
			(target) => request(target, { timeoutMs: 150 }),
		);
		expect(result.ok).toBe(false);
		expect(result.error.kind).toBe("timeout");
	});
});

// Throwaway self-signed certificate for TLS identity tests only. It is not a secret and is never used by the app.
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDLjCCAhagAwIBAgIUZldPctkmju7/KqTEwCmHw3himMEwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MB4XDTI2MDkxOTIxMzQxOVoXDTM2
MDkxNjIxMzQxOVowFzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEApIQDP9LS5A3pIUgV/QQsUJpspaytndN4KVE6
gQYjzpJkhVRHMZlt9co5L87d5k+RceG/ac1XKSmphOjUqp6vyMMXMbcIelCFRMZt
ablk2WwqLHD1dbG+xaORB+mdiP4UoAxlGeW19pA584YSSGBp9554S5lrXfnqO45n
8MUD6AzEdtQXgKhFW9/rUjVq/qNVHAAXyNqmGgY/Is0ain/9uCnmGsKiXuNYhHxn
wTnUx+vszPZCu+1NpMo9NNsNu+g4sMcb4vR7cNm+EfvjIs7H/404wy4otRe1ufF1
Fnt0fajdYAMzbRtRMEGqO3X6EiIOg+Ak9rws5K7TmzDS04Y66wIDAQABo3IwcDAd
BgNVHQ4EFgQUl0ZpBvSiw7wna7C9nw+YssX+mxowHwYDVR0jBBgwFoAUl0ZpBvSi
w7wna7C9nw+YssX+mxowDwYDVR0TAQH/BAUwAwEB/zAdBgNVHREEFjAUggxleGFt
cGxlLnRlc3SHBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAGiukXpY4eEcuOBfw44Y
V5SLPv1COVxl63lMEloSLIAM8Gq8I7YtPkFaC7uOijZlpb4+9C9LOSWG16QBQCnN
r8+Vc0Xu2WV9qv7EQbAEHSedPsSgfXmUNQ0n6MY36q7lfqgjB7Fchs4CldUP9O3L
lIbdM72Sd+yMLP0P4MNTtBtyIV8kA+1+e+RReH0svVzrpPG7Pr243aN53JV5iRpB
x7YjMiD0MG1JwfpTz91SQfb1gLGcBDTU1MivCm1aocoBN5DF0RFTxh/080O3B+Ar
i7qSKL3QzMxps6Nxvap4XCQ4xMzjxLeuXhywC2urlmDHfBQGP+BOzvRBmbss1SWp
y7Y=
-----END CERTIFICATE-----`;

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCkhAM/0tLkDekh
SBX9BCxQmmylrK2d03gpUTqBBiPOkmSFVEcxmW31yjkvzt3mT5Fx4b9pzVcpKamE
6NSqnq/Iwxcxtwh6UIVExm1puWTZbCoscPV1sb7Fo5EH6Z2I/hSgDGUZ5bX2kDnz
hhJIYGn3nnhLmWtd+eo7jmfwxQPoDMR21BeAqEVb3+tSNWr+o1UcABfI2qYaBj8i
zRqKf/24KeYawqJe41iEfGfBOdTH6+zM9kK77U2kyj002w276Diwxxvi9Htw2b4R
++Mizsf/jTjDLii1F7W58XUWe3R9qN1gAzNtG1EwQao7dfoSIg6D4CT2vCzkrtOb
MNLThjrrAgMBAAECggEACpZKRT2yf6Wbhp5Gd/lgRrGhY0oJBDqbJYGKM8pq3HzU
RjZFvJ3kkyg35Ok5o3wkXoFKGatyu/3n4FtBcFd09YUEhZkDTSfIY8QnP2IEaO+K
iUCdszzEi6B6kVlJ34qGVkRl7zQ2sQ7YA+FxZMH7n8lNcYQGgk42ci24Z6iuFy08
m/GcwYM1O85hDUEAxHu8cDJ6kPUuGxZbQU2q3GLTrV6pKqdhyv0kaOOplcY8dC8s
Us42ZXdDpLK1zfV29ueqtHB8vCH/QuFawxAXS8N7k/L06KKvQX5WqI0w98k+HFa4
uGQhzw3jEwPSdP8oPFqdqn5lRraCTPNhGJl4VnYVMQKBgQDjYqN1KNQRKKb2yH8k
HxquTwf4Ir94Jqfjmrgvir0+qWVrA26lq+vh9cxTWpDVgsoPE7wC4R5UiDo27av+
GturjSMdfXnKas4eS5S5qZkhZwz8rN/ZxD2yRmQt54DsFatfFsHcwpcrddyXh9fS
upOUjf6q4mXNyAefs6e1TaDTewKBgQC5N/09bDIfE2i7/QHgcZOVDNSB5REhP4x3
5hwhmFFDy6TLInamVOLsKSIa7hdtDMPfXR0pgalc9uhPziH8Jwj+ZeHliF4MO2Sp
XtvN+lSthQOoXpAc+W9TL9IE3uc8lm97utz9fLymmVmpyymJMFqL+0d/DNqihWjU
yicuODSjUQKBgQCR/wBStk9LYR2q8Frp92qrJqVIRg9H9xHvCqVeKSePNzad+kst
5nAC2k5B6rF51YslGRerhZ1yyzENmZbIBbirsmgshCcRt3f2bbLlbqaaks784Yat
DNpMP/QMoUreyp8I49S/iNWFGxzy0k7Zx+AADxfH4qtY8Cks+i4hM+GiRwKBgCXv
iMe+1Fk3EXmHbY351T9u/EuKjkKgEHYyRErBNsvK9vrAGUsiEcRK/HhFkbi9J5Ul
LiblLroivBw0XROXLylj1qu7jX+13n0uN5jtj9BmcQRYMe4tTJbeMYbb3MK1ESpn
cIHevYjl2c6EFQLLS5BmLBOin1kwN/N1YCcATg+xAoGBAK2PmJDw3cqpHy4F3p/x
0ovtSzXMKsjatEwGGE5Dr2yVwhUtLFcQHu8RahwKlM+JqSPorxQIblzgK0Qe7UBT
GImmVaffBEk1LX+OJckMV3ywSXbt3LebdVTAFSkdVfV+X1yWhJuPacQahEaWYzg7
9WyTmyWeXPTcqqsU+owCYB43
-----END PRIVATE KEY-----`;

// Some Bun builds accept the servername option for certificate verification but never emit the
// ClientHello SNI extension (observed on Bun 1.3.9/Windows). Probe the runtime so the SNI
// assertion only runs where the platform can actually honor it; certificate rejection is
// asserted unconditionally.
async function runtimeSendsSni() {
	const seen = [];
	const server = tls.createServer(
		{
			key: TEST_TLS_KEY,
			cert: TEST_TLS_CERT,
			SNICallback: (name, callback) => {
				seen.push(name);
				callback(null, tls.createSecureContext({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }));
			},
		},
		(socket) => socket.end(),
	);
	server.on("error", () => {});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	try {
		await new Promise((resolve) => {
			const socket = tls.connect({ host: "127.0.0.1", port, servername: "example.test", rejectUnauthorized: false }, () => {
				socket.destroy();
				resolve();
			});
			socket.on("error", () => resolve());
			setTimeout(() => {
				socket.destroy();
				resolve();
			}, 1500);
		});
	} finally {
		server.close();
	}
	return seen.includes("example.test");
}

const SNI_CAPABLE = await runtimeSendsSni();

describe("http transport TLS identity", () => {
	test.skipIf(!SNI_CAPABLE)("sends the original hostname as SNI while dialing the pinned address", async () => {
		const sni = [];
		const server = tls.createServer(
			{
				key: TEST_TLS_KEY,
				cert: TEST_TLS_CERT,
				SNICallback: (name, callback) => {
					sni.push(name);
					callback(null, tls.createSecureContext({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }));
				},
			},
			(socket) => socket.end(),
		);
		server.on("error", () => {});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = server.address().port;
		try {
			await performRequest({
				target: {
					scheme: "https",
					originalHostname: "example.test",
					authority: `example.test:${port}`,
					port,
					pathAndQuery: "/probe",
					ip: "127.0.0.1",
					family: 4,
					isIpLiteral: false,
					policyVersion: "1.0",
					local: false,
				},
				method: "GET",
				headers: [],
				body: null,
				timeoutMs: 3000,
				signal: new AbortController().signal,
				limits,
			});
			expect(sni).toEqual(["example.test"]);
		} finally {
			server.close();
		}
	});

	test("refuses an untrusted certificate on the pinned address", async () => {
		const server = tls.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (socket) => socket.end());
		server.on("error", () => {});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = server.address().port;
		try {
			const result = await performRequest({
				target: {
					scheme: "https",
					originalHostname: "example.test",
					authority: `example.test:${port}`,
					port,
					pathAndQuery: "/probe",
					ip: "127.0.0.1",
					family: 4,
					isIpLiteral: false,
					policyVersion: "1.0",
					local: false,
				},
				method: "GET",
				headers: [],
				body: null,
				timeoutMs: 3000,
				signal: new AbortController().signal,
				limits,
			});
			expect(result.ok).toBe(false);
			expect(result.error.kind).toBe("network_error");
		} finally {
			server.close();
		}
	});

	test("does not send SNI for an IP literal target", async () => {
		const sni = [];
		const server = tls.createServer(
			{
				key: TEST_TLS_KEY,
				cert: TEST_TLS_CERT,
				SNICallback: (name, callback) => {
					sni.push(name);
					callback(null, tls.createSecureContext({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }));
				},
			},
			(socket) => socket.end(),
		);
		server.on("error", () => {});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = server.address().port;
		try {
			const result = await performRequest({
				target: {
					scheme: "https",
					originalHostname: "127.0.0.1",
					authority: `127.0.0.1:${port}`,
					port,
					pathAndQuery: "/probe",
					ip: "127.0.0.1",
					family: 4,
					isIpLiteral: true,
					policyVersion: "1.0",
					local: false,
				},
				method: "GET",
				headers: [],
				body: null,
				timeoutMs: 3000,
				signal: new AbortController().signal,
				limits,
			});
			expect(sni).toEqual([]);
			expect(result.ok).toBe(false);
			expect(result.error.kind).toBe("network_error");
		} finally {
			server.close();
		}
	});
});
