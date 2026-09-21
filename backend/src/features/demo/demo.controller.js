import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { datasetToken, demoService, matchesAnyDemoToken, requireTargetAuth } from "./demo.service.js";

const statusSchema = z.enum(["pending", "paid", "shipped", "cancelled"]);
const itemSchema = z
	.object({
		name: z.string().trim().min(1).max(120),
		quantity: z.number().int().min(1).max(1000),
		unitCents: z.number().int().min(0).max(100000000),
	})
	.strict();
const createSchema = z
	.object({ customer: z.string().trim().min(1).max(120), items: z.array(itemSchema).min(1).max(20), status: statusSchema.optional() })
	.strict();
const updateSchema = z
	.object({
		customer: z.string().trim().min(1).max(120).optional(),
		items: z.array(itemSchema).min(1).max(20).optional(),
		status: statusSchema.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one field to update.");
const listQuerySchema = z.object({ status: statusSchema.optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();

export async function listOrders(request, response, next) {
	try {
		const { dataset } = request.params;
		requireTargetAuth(request, dataset);
		response.json({ data: await demoService.list(dataset, listQuerySchema.parse(request.query)) });
	} catch (error) {
		next(error);
	}
}

export async function getOrder(request, response, next) {
	try {
		const { dataset, orderId } = request.params;
		requireTargetAuth(request, dataset);
		response.json({ data: await demoService.get(dataset, orderId) });
	} catch (error) {
		next(error);
	}
}

export async function createOrder(request, response, next) {
	try {
		const { dataset } = request.params;
		requireTargetAuth(request, dataset);
		response.status(201).json({ data: await demoService.create(dataset, createSchema.parse(request.body)) });
	} catch (error) {
		next(error);
	}
}

export async function updateOrder(request, response, next) {
	try {
		const { dataset, orderId } = request.params;
		requireTargetAuth(request, dataset);
		response.json({ data: await demoService.update(dataset, orderId, updateSchema.parse(request.body)) });
	} catch (error) {
		next(error);
	}
}

export async function deleteOrder(request, response, next) {
	try {
		const { dataset, orderId } = request.params;
		requireTargetAuth(request, dataset);
		await demoService.remove(dataset, orderId);
		response.status(204).send();
	} catch (error) {
		next(error);
	}
}

export function echo(request, response, next) {
	try {
		requireTargetAuth(request, "local");
		const raw = request.rawHeaders;
		const headers = [];
		for (let index = 0; index < raw.length; index += 2) headers.push({ name: raw[index], value: raw[index + 1] });
		response.json({
			data: {
				method: request.method,
				path: request.path,
				query: request.query,
				headers,
				body: request.body ?? null,
				receivedAt: new Date().toISOString(),
			},
		});
	} catch (error) {
		next(error);
	}
}

export function statusCode(request, response, next) {
	try {
		const code = Number.parseInt(request.params.code, 10);
		if (!Number.isInteger(code) || code < 100 || code > 599)
			throw new AppError(400, "STATUS_INVALID", "Provide a status code between 100 and 599.");
		response.status(code).json({ data: { code, message: `Requested status ${code}.` } });
	} catch (error) {
		next(error);
	}
}

export async function slow(request, response, next) {
	try {
		const ms = Math.min(Math.max(Number.parseInt(request.query.ms ?? "1000", 10) || 1000, 1), 30000);
		await new Promise((resolve) => setTimeout(resolve, ms));
		response.json({ data: { waitedMs: ms } });
	} catch (error) {
		next(error);
	}
}

export function gzip(request, response, next) {
	try {
		const payload = Buffer.from(
			JSON.stringify({
				data: { note: "This response is gzip-compressed when the client accepts it.", padding: "request-desk".repeat(400) },
			}),
			"utf8",
		);
		if (!String(request.get("accept-encoding") || "").includes("gzip")) {
			response.type("application/json").send(payload);
			return;
		}
		response.set("Content-Encoding", "gzip").set("Content-Type", "application/json").send(gzipSync(payload));
	} catch (error) {
		next(error);
	}
}

export function formatSamples(request, response, next) {
	try {
		const kind = request.params.kind;
		if (kind === "xml") {
			response
				.type("application/xml")
				.send(
					'<?xml version="1.0" encoding="UTF-8"?><orders><order id="ord_0001"><customer>Ada Lovelace</customer><totalCents>4200</totalCents></order></orders>',
				);
			return;
		}
		if (kind === "html") {
			response
				.type("text/html")
				.send(
					"<!doctype html><html><head><title>Tracer</title></head><body><h1>Demo page</h1><p>This markup is never rendered as live HTML.</p></body></html>",
				);
			return;
		}
		if (kind === "text") {
			response.type("text/plain").send("Tracer demo target\nline two\nline three\n");
			return;
		}
		if (kind === "binary") {
			response.type("application/octet-stream").send(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x80, 0x00, 0x10]));
			return;
		}
		throw new AppError(404, "FORMAT_NOT_FOUND", "The requested demo format does not exist.");
	} catch (error) {
		next(error);
	}
}

export function datasetTokens(request, response) {
	response.json({
		data: {
			local: Boolean(datasetToken("local")),
			staging: Boolean(datasetToken("staging")),
			hint: "Demo target tokens are generated locally by setup.sh and shown to the signed-in profile as secret references.",
		},
	});
}


export function authExample(request, response, next) {
	try {
		const kind = request.params.kind;
		let candidate = "";
		if (kind === "bearer") {
			const authorization = request.get("authorization") || "";
			if (!authorization.startsWith("Bearer ")) throw new AppError(401, "TARGET_AUTH_REQUIRED", "Bearer authentication is required.");
			candidate = authorization.slice(7).trim();
		} else if (kind === "basic") {
			const authorization = request.get("authorization") || "";
			if (!authorization.startsWith("Basic ")) throw new AppError(401, "TARGET_AUTH_REQUIRED", "Basic authentication is required.");
			let decoded = "";
			try {
				decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
			} catch {
				throw new AppError(401, "TARGET_AUTH_INVALID", "The Basic credential is invalid.");
			}
			const colon = decoded.indexOf(":");
			if (colon === -1 || decoded.slice(0, colon) !== "tracer")
				throw new AppError(401, "TARGET_AUTH_INVALID", "The Basic credential is invalid.");
			candidate = decoded.slice(colon + 1);
		} else if (kind === "api-key-header") {
			candidate = request.get("x-api-key") || "";
		} else if (kind === "api-key-query") {
			candidate = String(request.query.api_key || "");
		} else {
			throw new AppError(404, "AUTH_EXAMPLE_NOT_FOUND", "The requested authentication example does not exist.");
		}
		if (!matchesAnyDemoToken(candidate)) throw new AppError(401, "TARGET_AUTH_INVALID", "The target credential is not valid.");
		response.json({ data: { authenticated: true, kind } });
	} catch (error) {
		next(error);
	}
}

export function exampleEcho(request, response) {
	const raw = request.rawHeaders;
	const headers = [];
	for (let index = 0; index < raw.length; index += 2) headers.push({ name: raw[index], value: raw[index + 1] });
	if (request.method === "HEAD") return response.status(200).end();
	response.json({ data: { method: request.method, query: request.query, headers, body: request.body ?? null } });
}

export function exampleStatus(request, response, next) {
	try {
		const code = Number.parseInt(request.params.code, 10);
		if (![200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500, 503].includes(code))
			throw new AppError(400, "STATUS_INVALID", "This demo exposes only the documented status fixtures.");
		if (code === 204) return response.status(204).end();
		response.status(code).json({ data: { code } });
	} catch (error) {
		next(error);
	}
}

export async function exampleDelay(request, response) {
	const ms = Math.min(Math.max(Number.parseInt(request.params.ms, 10) || 0, 0), 30000);
	await new Promise((resolve) => setTimeout(resolve, ms));
	response.json({ data: { waitedMs: ms } });
}

export function exampleText(request, response) {
	response.type("text/plain").send("Tracer demo target\nline two\nline three\n");
}

export function exampleHtml(request, response) {
	response.type("text/html").send("<!doctype html><html><body><h1>Tracer</h1><p>Safe source fixture.</p></body></html>");
}

export function exampleXml(request, response) {
	response.type("application/xml").send('<?xml version="1.0"?><orders><order id="ord_0001"><customer>Ada</customer></order></orders>');
}

export function exampleInvalidJson(request, response) {
	response.set("Content-Type", "application/json").send('{"invalid":');
}

export function exampleEmpty(request, response) {
	response.status(204).end();
}

export function compressedExample(request, response, next) {
	try {
		const kind = request.params.kind;
		const payload = Buffer.from(JSON.stringify({ data: { kind, padding: "tracer".repeat(400) } }), "utf8");
		const encoded =
			kind === "gzip" ? gzipSync(payload) : kind === "deflate" ? deflateSync(payload) : kind === "br" ? brotliCompressSync(payload) : null;
		if (!encoded) throw new AppError(404, "COMPRESSION_NOT_FOUND", "The requested compression fixture does not exist.");
		response.set("Content-Encoding", kind).set("Content-Type", "application/json").send(encoded);
	} catch (error) {
		next(error);
	}
}

const cookieSetSchema = z
	.object({
		name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).default("tracer_session"),
		value: z.string().regex(/^[A-Za-z0-9_.-]{0,128}$/).default("demo-value"),
		path: z.string().regex(/^\/[A-Za-z0-9_./-]{0,64}$/).default("/"),
		maxAge: z.coerce.number().int().min(-1).max(86400).optional(),
		secure: z.enum(["true", "false"]).optional(),
	})
	.strict();

// Sets one cookie from query parameters plus a path-scoped marker cookie, so a
// single send demonstrates multiple Set-Cookie headers, scope, and deletion
// (maxAge=0). Values are echoed back as names only; the jar viewer shows values.
export function setCookies(request, response, next) {
	try {
		const input = cookieSetSchema.parse(request.query);
		const attributes = [`Path=${input.path}`];
		if (input.maxAge !== undefined) attributes.push(`Max-Age=${input.maxAge}`);
		if (input.secure === "true") attributes.push("Secure");
		response.append("Set-Cookie", `${input.name}=${input.value}; ${attributes.join("; ")}`);
		response.append("Set-Cookie", `tracer_last_set=${input.name}; Path=/demo`);
		response.json({ data: { name: input.name, path: input.path, maxAge: input.maxAge ?? null, secure: input.secure === "true" } });
	} catch (error) {
		next(error);
	}
}

export function cookieEcho(request, response) {
	const names = String(request.headers.cookie ?? "")
		.split(";")
		.map((pair) => pair.trim().split("=")[0])
		.filter(Boolean);
	response.json({ data: { cookieNames: names, count: names.length, path: request.path, secure: Boolean(request.secure) } });
}
