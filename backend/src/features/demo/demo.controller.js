import { gzipSync } from "node:zlib";
import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { datasetToken, demoService, requireTargetAuth } from "./demo.service.js";

const statusSchema = z.enum(["pending", "paid", "shipped", "cancelled"]);
const itemSchema = z.object({ name: z.string().trim().min(1).max(120), quantity: z.number().int().min(1).max(1000), unitCents: z.number().int().min(0).max(100000000) }).strict();
const createSchema = z.object({ customer: z.string().trim().min(1).max(120), items: z.array(itemSchema).min(1).max(20), status: statusSchema.optional() }).strict();
const updateSchema = z
    .object({ customer: z.string().trim().min(1).max(120).optional(), items: z.array(itemSchema).min(1).max(20).optional(), status: statusSchema.optional() })
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
        response.json({ data: { method: request.method, path: request.path, query: request.query, headers, body: request.body ?? null, receivedAt: new Date().toISOString() } });
    } catch (error) {
        next(error);
    }
}

export function statusCode(request, response, next) {
    try {
        const code = Number.parseInt(request.params.code, 10);
        if (!Number.isInteger(code) || code < 100 || code > 599) throw new AppError(400, "STATUS_INVALID", "Provide a status code between 100 and 599.");
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
        const payload = Buffer.from(JSON.stringify({ data: { note: "This response is gzip-compressed when the client accepts it.", padding: "request-desk".repeat(400) } }), "utf8");
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
            response.type("application/xml").send('<?xml version="1.0" encoding="UTF-8"?><orders><order id="ord_0001"><customer>Ada Lovelace</customer><totalCents>4200</totalCents></order></orders>');
            return;
        }
        if (kind === "html") {
            response.type("text/html").send("<!doctype html><html><head><title>Request Desk</title></head><body><h1>Demo page</h1><p>This markup is never rendered as live HTML.</p></body></html>");
            return;
        }
        if (kind === "text") {
            response.type("text/plain").send("Request Desk demo target\nline two\nline three\n");
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
    response.json({ data: { local: Boolean(datasetToken("local")), staging: Boolean(datasetToken("staging")), hint: "Demo target tokens are generated locally by setup.sh and shown to the signed-in profile as secret references." } });
}
