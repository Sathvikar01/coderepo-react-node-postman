import { describe, expect, test } from "bun:test";
import { MAX_CURL_INPUT_BYTES, parseCurl } from "./curl-parser.js";

const echo = "http://127.0.0.1:8000/demo/v1/echo";

function imported(command) {
	const result = parseCurl(command);
	expect({ errors: result.errors, ok: result.ok }).toEqual({ errors: [], ok: true });
	return result;
}

function codes(command) {
	return parseCurl(command).errors.map((error) => error.code);
}

describe("cURL import: methods and URLs", () => {
	test("imports a bare URL as a GET", () => {
		const result = imported(`curl ${echo}`);
		expect(result.request).toMatchObject({
			method: "GET",
			urlTemplate: echo,
			query: [],
			headers: [],
			body: { mode: "none" },
			auth: { mode: "none" },
			settings: { timeoutMs: 15000 },
			name: "echo",
		});
		expect(result.authOverride).toBeNull();
		expect(result.warnings).toEqual([]);
	});

	test("accepts curl.exe, an absolute curl path, and a $ prompt", () => {
		expect(imported(`curl.exe ${echo}`).request.urlTemplate).toBe(echo);
		expect(imported(`/usr/bin/curl ${echo}`).request.urlTemplate).toBe(echo);
		expect(imported(`$ curl ${echo}`).request.urlTemplate).toBe(echo);
		expect(imported(`sudo curl ${echo}`).request.urlTemplate).toBe(echo);
	});

	test("reads the URL from --url", () => {
		expect(imported(`curl --url ${echo}`).request.urlTemplate).toBe(echo);
	});

	test("keeps the URL query string, including repeated keys", () => {
		const url = `${echo}?tag=a&tag=b&empty=&encoded=one%20two`;
		expect(imported(`curl '${url}'`).request.urlTemplate).toBe(url);
	});

	test("supports explicit methods", () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
			expect(imported(`curl -X ${method} ${echo}`).request.method).toBe(method);
		}
		expect(imported(`curl --request delete ${echo}`).request.method).toBe("DELETE");
	});

	test("infers POST from body data unless -G is used", () => {
		expect(imported(`curl -d 'a=1' ${echo}`).request.method).toBe("POST");
		const get = imported(`curl -G -d 'a=1&b=2' ${echo}`);
		expect(get.request.method).toBe("GET");
		expect(get.request.urlTemplate).toBe(`${echo}?a=1&b=2`);
		expect(get.request.body).toEqual({ mode: "none" });
	});

	test("lets an explicit method win over -G while keeping data in the URL", () => {
		const result = imported(`curl -G -X POST -d 'a=1' ${echo}`);
		expect(result.request.method).toBe("POST");
		expect(result.request.urlTemplate).toBe(`${echo}?a=1`);
	});

	test("maps -I to HEAD", () => {
		expect(imported(`curl -I ${echo}`).request.method).toBe("HEAD");
	});

	test("rejects multiple URLs", () => {
		expect(codes(`curl ${echo} http://example.com/other`)).toEqual(["MULTIPLE_URLS"]);
	});

	test("derives a readable name and falls back for templated URLs", () => {
		expect(imported(`curl ${echo}/users/42`).request.name).toBe("42");
		expect(imported("curl http://example.com/").request.name).toBe("example.com");
		expect(imported("curl {{base}}/users").request.name).toBe("Imported request");
	});
});

describe("cURL import: headers", () => {
	test("preserves header order", () => {
		const result = imported(`curl ${echo} -H 'B: 2' -H 'A: 1' -H 'C: 3'`);
		expect(result.request.headers.map((header) => `${header.key}:${header.value}`)).toEqual(["B:2", "A:1", "C:3"]);
		expect(result.warnings).toEqual([]);
	});

	test("preserves duplicate headers and warns that Tracer rejects them on send", () => {
		const result = imported(`curl ${echo} -H 'X-Tag: one' -H 'X-Tag: two'`);
		expect(result.request.headers).toEqual([
			{ key: "X-Tag", value: "one" },
			{ key: "X-Tag", value: "two" },
		]);
		expect(result.warnings.map((warning) => warning.code)).toContain("DUPLICATE_HEADERS");
	});

	test("keeps Authorization as an ordinary header", () => {
		const result = imported(`curl ${echo} -H 'Authorization: Bearer abc123'`);
		expect(result.request.headers).toEqual([{ key: "Authorization", value: "Bearer abc123" }]);
		expect(result.request.auth).toEqual({ mode: "none" });
		expect(result.authOverride).toBeNull();
	});

	test("supports empty header values", () => {
		expect(imported(`curl ${echo} -H 'X-Empty:'`).request.headers).toEqual([{ key: "X-Empty", value: "" }]);
		expect(imported(`curl ${echo} -H 'X-Empty;'`).request.headers).toEqual([{ key: "X-Empty", value: "" }]);
	});

	test("maps -A and -e to headers", () => {
		const result = imported(`curl ${echo} -A 'tracer/1.0' -e 'https://example.com/'`);
		expect(result.request.headers).toEqual([
			{ key: "User-Agent", value: "tracer/1.0" },
			{ key: "Referer", value: "https://example.com/" },
		]);
	});

	test("maps -b name=value to a Cookie header and rejects cookie files", () => {
		expect(imported(`curl ${echo} -b 'session=abc; theme=dark'`).request.headers).toEqual([
			{ key: "Cookie", value: "session=abc; theme=dark" },
		]);
		expect(codes(`curl ${echo} -b cookies.txt`)).toEqual(["FILE_READ"]);
	});

	test("warns about transport-managed headers", () => {
		const result = imported(`curl ${echo} -H 'Content-Length: 5' -H 'Accept-Encoding: gzip'`);
		expect(result.warnings.filter((warning) => warning.code === "RESERVED_HEADER")).toHaveLength(2);
		expect(result.request.headers).toHaveLength(2);
	});

	test("warns about invalid header names and values", () => {
		expect(imported(`curl ${echo} -H 'Bad Header: x'`).warnings.map((warning) => warning.code)).toContain("INVALID_HEADER_NAME");
		expect(imported(`curl ${echo} -H 'X-Tag:  one'`).request.headers).toEqual([{ key: "X-Tag", value: "one" }]);
	});

	test("rejects headers without a colon", () => {
		expect(codes(`curl ${echo} -H 'X-Tag one'`)).toEqual(["MALFORMED_HEADER"]);
	});
});

describe("cURL import: bodies", () => {
	test("imports an explicit JSON body as JSON", () => {
		const result = imported(`curl -X POST ${echo} -H 'Content-Type: application/json' -d '{"name":"Ada","tags":["a","b"]}'`);
		expect(result.request.body).toEqual({ mode: "json", text: '{"name":"Ada","tags":["a","b"]}' });
		expect(result.request.headers).toEqual([{ key: "Content-Type", value: "application/json" }]);
	});

	test("keeps the default curl content type for data without a header", () => {
		const result = imported(`curl -d 'name=Ada+Lovelace&role=engineer' ${echo}`);
		expect(result.request.body).toEqual({
			mode: "text",
			text: "name=Ada+Lovelace&role=engineer",
			contentType: "application/x-www-form-urlencoded",
		});
		expect(result.request.headers).toEqual([]);
	});

	test("honors an explicit form content type", () => {
		const result = imported(`curl -d 'a=1' -H 'Content-Type: application/x-www-form-urlencoded; charset=utf-8' ${echo}`);
		expect(result.request.body).toEqual({
			mode: "text",
			text: "a=1",
			contentType: "application/x-www-form-urlencoded; charset=utf-8",
		});
	});

	test("keeps invalid JSON as text with the same content type", () => {
		const result = imported(`curl -d '{"broken":' -H 'Content-Type: application/json' ${echo}`);
		expect(result.request.body).toEqual({ mode: "text", text: '{"broken":', contentType: "application/json" });
		expect(result.warnings.map((warning) => warning.code)).toContain("BODY_NOT_JSON");
	});

	test("joins repeated data options with an ampersand", () => {
		const result = imported(`curl -d 'a=1' -d 'b=2' ${echo}`);
		expect(result.request.body.text).toBe("a=1&b=2");
	});

	test("supports --json with its implicit headers", () => {
		const result = imported(`curl --json '{"ok":true}' ${echo}`);
		expect(result.request.method).toBe("POST");
		expect(result.request.body).toEqual({ mode: "json", text: '{"ok":true}' });
		expect(result.request.headers).toEqual([
			{ key: "Content-Type", value: "application/json" },
			{ key: "Accept", value: "application/json" },
		]);
	});

	test("treats --data-raw @value as literal data but rejects file reads", () => {
		expect(imported(`curl --data-raw '@not-a-file' ${echo}`).request.body.text).toBe("@not-a-file");
		expect(codes(`curl -d @payload.json ${echo}`)).toEqual(["FILE_READ"]);
		expect(codes(`curl --data-binary @payload.bin ${echo}`)).toEqual(["FILE_READ"]);
	});

	test("rejects GET and HEAD bodies that Tracer cannot send", () => {
		expect(codes(`curl -X GET -d 'a=1' ${echo}`)).toEqual(["METHOD_BODY_CONFLICT"]);
		expect(codes(`curl -I -d 'a=1' ${echo}`)).toEqual(["METHOD_BODY_CONFLICT"]);
	});

	test("maps --max-time to the request timeout and clamps it", () => {
		expect(imported(`curl -m 5 ${echo}`).request.settings.timeoutMs).toBe(5000);
		const clamped = imported(`curl --max-time 60 ${echo}`);
		expect(clamped.request.settings.timeoutMs).toBe(30000);
		expect(clamped.warnings.map((warning) => warning.code)).toContain("TIMEOUT_CLAMPED");
		expect(imported(`curl --max-time nope ${echo}`).request.settings.timeoutMs).toBe(15000);
	});
});

describe("cURL import: quoting and line continuations", () => {
	test("handles single, double, and escaped quotes", () => {
		const result = imported(`curl -H "X-Quote: say \\"hi\\"" -d 'single "quoted" $keep' ${echo}`);
		expect(result.request.headers).toEqual([{ key: "X-Quote", value: 'say "hi"' }]);
		expect(result.request.body.text).toBe('single "quoted" $keep');
	});

	test("handles ANSI-C quoted values", () => {
		const result = imported(`curl -d $'line1\\nline2\\tend' ${echo}`);
		expect(result.request.body.text).toBe("line1\nline2\tend");
	});

	test("joins backslash, caret, and backtick continuations", () => {
		const multiline = ["curl -X POST " + echo, "\t-H 'Content-Type: application/json' \\", "\t-d '{\"a\":1}'"].join("\n");
		expect(imported(multiline).request.body).toEqual({ mode: "json", text: '{"a":1}' });

		const caret = "curl -X POST ^\r\n -H \"X-A: 1\" ^\r\n" + echo;
		expect(imported(caret).request.headers).toEqual([{ key: "X-A", value: "1" }]);

		const backtick = "curl `\n -X PUT `\n " + echo;
		expect(imported(backtick).request.method).toBe("PUT");
	});

	test("keeps newlines inside single-quoted bodies", () => {
		expect(imported(`curl -d 'a\nb' ${echo}`).request.body.text).toBe("a\nb");
	});

	test("rejects unterminated quotes", () => {
		expect(codes(`curl ${echo} -H 'X-A: 1`)).toEqual(["MALFORMED_QUOTING"]);
		expect(codes(`curl ${echo} -d "{\"a\":1}`)).toEqual(["MALFORMED_QUOTING"]);
	});
});

describe("cURL import: authentication", () => {
	test("maps -u user:pass to a send-only basic override", () => {
		const result = imported(`curl -u 'ada:secret' ${echo}`);
		expect(result.authOverride).toEqual({ mode: "basic", usernameTemplate: "ada", passwordTemplate: "secret" });
		expect(result.request.auth).toEqual({ mode: "none" });
		expect(result.request.headers).toEqual([]);
	});

	test("splits basic credentials on the first colon only", () => {
		expect(imported(`curl -u 'ada:se:cret' ${echo}`).authOverride).toEqual({
			mode: "basic",
			usernameTemplate: "ada",
			passwordTemplate: "se:cret",
		});
	});

	test("warns when curl would have prompted for a password", () => {
		const result = imported(`curl -u ada ${echo}`);
		expect(result.authOverride).toEqual({ mode: "basic", usernameTemplate: "ada", passwordTemplate: "" });
		expect(result.warnings.map((warning) => warning.code)).toContain("AUTH_PASSWORD_EMPTY");
	});

	test("lets an explicit Authorization header replace --user credentials", () => {
		const result = imported(`curl -u 'ada:secret' -H 'Authorization: Bearer token' ${echo}`);
		expect(result.authOverride).toBeNull();
		expect(result.request.headers).toEqual([{ key: "Authorization", value: "Bearer token" }]);
		expect(result.warnings.map((warning) => warning.code)).toContain("AUTH_CONFLICT");
	});

	test("maps --oauth2-bearer to an Authorization header", () => {
		expect(imported(`curl --oauth2-bearer 'abc' ${echo}`).request.headers).toEqual([{ key: "Authorization", value: "Bearer abc" }]);
	});

	test("rejects mixing --user and --oauth2-bearer", () => {
		expect(codes(`curl -u ada:x --oauth2-bearer abc ${echo}`)).toEqual(["AMBIGUOUS_AUTH"]);
	});
});

describe("cURL import: ignored and unsupported options", () => {
	test("imports through output-only flags with warnings", () => {
		const result = imported(`curl -sS -v --compressed -k -L ${echo}`);
		expect(result.request.method).toBe("GET");
		const messages = result.warnings.map((warning) => warning.message).join(" ");
		expect(messages).toContain("TLS verification cannot be disabled");
		expect(messages).toContain("does not follow redirects");
		expect(result.warnings.every((warning) => warning.code === "IGNORED_FLAG")).toBe(true);
	});

	test("reports ignored flags with values once", () => {
		const result = imported(`curl --connect-timeout 5 --retry 3 ${echo}`);
		expect(result.request.settings.timeoutMs).toBe(15000);
		expect(result.warnings.filter((warning) => warning.option === "--connect-timeout")).toHaveLength(1);
		expect(result.warnings.filter((warning) => warning.option === "--retry")).toHaveLength(1);
	});

	test("rejects file access", () => {
		expect(codes(`curl -o out.json ${echo}`)).toEqual(["UNSUPPORTED_OPTION"]);
		expect(codes(`curl -K curl.conf ${echo}`)).toEqual(["UNSUPPORTED_OPTION"]);
		expect(codes(`curl -T upload.bin ${echo}`)).toEqual(["UNSUPPORTED_OPTION"]);
	});

	test("rejects network-affecting options", () => {
		expect(codes(`curl --proxy http://proxy.local ${echo}`)).toEqual(["UNSUPPORTED_OPTION"]);
		expect(codes(`curl --resolve example.com:443:127.0.0.1 ${echo}`)).toEqual(["UNSUPPORTED_OPTION"]);
		expect(codes(`curl --cert client.pem ${echo}`)).toEqual(["UNSUPPORTED_OPTION"]);
	});

	test("rejects unsupported body formats and auth schemes", () => {
		expect(codes(`curl -F 'file=@a.png' ${echo}`)).toEqual(["UNSUPPORTED_OPTION"]);
		expect(codes(`curl --data-urlencode 'a=1' ${echo}`)).toEqual(["UNSUPPORTED_OPTION"]);
		expect(codes(`curl --digest -u ada:x ${echo}`)).toEqual(["UNSUPPORTED_OPTION"]);
	});

	test("rejects shell substitution and operators", () => {
		expect(codes(`curl "$(cat token)" ${echo}`)).toEqual(["SHELL_SUBSTITUTION"]);
		expect(codes("curl `date` " + echo)).toEqual(["SHELL_SUBSTITUTION"]);
		expect(codes(`curl $TOKEN ${echo}`)).toEqual(["SHELL_SUBSTITUTION"]);
		expect(codes(`curl ${echo} | jq .`)).toEqual(["SHELL_OPERATOR"]);
		expect(codes(`curl ${echo} ; curl http://example.com`)).toEqual(["SHELL_OPERATOR"]);
		expect(codes(`curl ${echo} > out.json`)).toEqual(["SHELL_OPERATOR"]);
		expect(codes(`curl "http://example.com/?a=1" && echo done`)).toEqual(["SHELL_OPERATOR"]);
	});

	test("keeps unquoted ampersands inside URLs", () => {
		expect(imported(`curl http://example.com/?a=1&b=2`).request.urlTemplate).toBe("http://example.com/?a=1&b=2");
	});

	test("rejects unknown options instead of guessing", () => {
		expect(codes(`curl --frobnicate ${echo}`)).toEqual(["UNKNOWN_OPTION"]);
		const unknown = parseCurl(`curl --frobnicate ${echo}`);
		expect(unknown.errors[0].message).toContain("--frobnicate");
	});

	test("rejects dangerous multi-request separators", () => {
		expect(codes(`curl --next ${echo}`)).toEqual(["UNSUPPORTED_OPTION"]);
	});
});

describe("cURL import: malformed commands", () => {
	test("rejects empty input", () => {
		expect(codes("")).toEqual(["NO_INPUT"]);
		expect(codes("   \n  ")).toEqual(["NO_INPUT"]);
	});

	test("rejects commands that are not curl", () => {
		expect(codes("wget http://example.com")).toEqual(["NOT_CURL"]);
		expect(codes("http http://example.com")).toEqual(["NOT_CURL"]);
	});

	test("rejects a command without a URL", () => {
		expect(codes("curl -X POST")).toEqual(["NO_URL"]);
		expect(codes("curl -s")).toEqual(["NO_URL"]);
	});

	test("rejects options missing their value", () => {
		expect(codes("curl -H")).toEqual(["MISSING_VALUE"]);
		expect(codes(`curl ${echo} -X`)).toEqual(["MISSING_VALUE"]);
	});

	test("rejects unsupported methods", () => {
		expect(codes(`curl -X TRACE ${echo}`)).toEqual(["METHOD_INVALID"]);
	});

	test("rejects conflicting head flags", () => {
		expect(codes(`curl -I -X POST ${echo}`)).toEqual(["AMBIGUOUS_METHOD"]);
	});

	test("rejects oversized input", () => {
		const huge = `curl ${echo} -d '${"x".repeat(MAX_CURL_INPUT_BYTES)}'`;
		expect(codes(huge)).toEqual(["INPUT_TOO_LARGE"]);
	});

	test("reports every warning with a code and message and never throws", () => {
		const samples = ["", "curl", "curl --nope", `curl -d @f ${echo}`, `curl '${echo}`, `curl ${echo} -H 'Bad Header: 1'`];
		for (const sample of samples) {
			const result = parseCurl(sample);
			expect(Array.isArray(result.warnings)).toBe(true);
			expect(Array.isArray(result.errors)).toBe(true);
			for (const issue of [...result.warnings, ...result.errors]) {
				expect(issue.code).toBeTruthy();
				expect(issue.message).toBeTruthy();
			}
			if (result.ok) expect(result.errors).toEqual([]);
			else expect(result.request).toBeNull();
		}
	});
});
