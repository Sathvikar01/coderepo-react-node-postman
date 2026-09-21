import mongoose from "mongoose";
import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { requestDefinitionSchema } from "../../shared/utils/schemas.js";
import { mockService } from "./mock.service.js";

const TRANSPORT_HEADERS = new Set(["content-length", "transfer-encoding", "connection", "keep-alive", "host", "upgrade"]);

const resolveSchema = z
	.object({
		request: requestDefinitionSchema,
		environmentId: z
			.string()
			.regex(/^[a-f\d]{24}$/i)
			.optional(),
		executionId: z.uuid().optional(),
	})
	.strict();

export function applyExampleToResponse(response, example) {
	for (const header of example.response.headers ?? []) {
		if (TRANSPORT_HEADERS.has(String(header.name).toLowerCase())) continue;
		try {
			response.set(header.name, header.value);
		} catch {
			// Invalid or unsafe header names in a saved example are skipped.
		}
	}
	response.set("x-tracer-mock", "matched");
	response.set("x-tracer-example", encodeURIComponent(String(example.name ?? "")));
	const contentType = example.response.contentType || example.response.body?.mediaType;
	if (contentType && !(example.response.headers ?? []).some((header) => String(header.name).toLowerCase() === "content-type"))
		response.type(contentType);
	const body = example.response.body ?? { encoding: "utf8", value: "" };
	response.status(example.response.status);
	response.send(body.encoding === "base64" ? Buffer.from(body.value ?? "", "base64") : (body.value ?? ""));
}

function headerPairs(headers = {}) {
	return Object.entries(headers).map(([key, value]) => ({
		key,
		value: Array.isArray(value) ? value.join(", ") : String(value ?? ""),
	}));
}

function queryPairs(query = {}) {
	const pairs = [];
	for (const [key, value] of Object.entries(query)) {
		if (Array.isArray(value)) pairs.push(...value.map((item) => ({ key, value: String(item ?? "") })));
		else pairs.push({ key, value: String(value ?? "") });
	}
	return pairs;
}

function subPathOf(request) {
	const raw = String(request.originalUrl ?? "").slice(String(request.baseUrl ?? "").length).split("?")[0];
	if (!raw || raw === "/") return "/";
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

export async function resolveMock(request, response, next) {
	try {
		const input = resolveSchema.parse(request.body);
		const resolved = await mockService.resolve(request.profileId, input);
		response.json({
			data: {
				matched: resolved.matched,
				considered: resolved.considered,
				route: resolved.route,
				target: resolved.target,
				example: resolved.example
					? { exampleId: String(resolved.example._id), name: resolved.example.name, match: resolved.example.match }
					: null,
				result: resolved.result,
			},
		});
	} catch (error) {
		next(error);
	}
}

export async function getMockMeta(request, response, next) {
	try {
		const meta = await mockService.meta(request.profileId);
		response.json({ data: { ...meta, profileId: request.profileId } });
	} catch (error) {
		next(error);
	}
}

export async function serveMockRoute(request, response, next) {
	try {
		const { profileId, token } = request.params;
		if (!mongoose.isValidObjectId(profileId)) throw new AppError(404, "MOCK_ROUTE_NOT_FOUND", "This mock route does not exist.");
		const candidate = {
			method: request.method,
			path: subPathOf(request),
			query: queryPairs(request.query),
			headers: headerPairs(request.headers),
		};
		const { example } = await mockService.serve(profileId, token, candidate);
		applyExampleToResponse(response, example);
	} catch (error) {
		next(error);
	}
}
