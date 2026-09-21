import { z } from "zod";
import { METHODS, requestDefinitionSchema } from "../../shared/utils/schemas.js";
import { exampleService } from "./example.service.js";

const ruleSchema = z
	.object({
		key: z.string().trim().min(1).max(256),
		value: z.string().max(8192).default(""),
	})
	.strict();
const matchSchema = z
	.object({
		method: z.enum(METHODS),
		path: z.string().max(2048).default(""),
		query: z.array(ruleSchema).max(100).default([]),
		headers: z.array(ruleSchema).max(100).default([]),
	})
	.strict();
const bodySchema = z
	.object({
		encoding: z.enum(["utf8", "base64"]).default("utf8"),
		value: z.string().default(""),
		mediaType: z.string().max(200).default(""),
		truncated: z.boolean().default(false),
		omittedReason: z.string().max(64).nullish(),
	})
	.strict();
const responseSchema = z
	.object({
		status: z.number().int().min(100).max(599),
		statusText: z.string().max(120).default(""),
		contentType: z.string().max(200).default(""),
		headers: z
			.array(
				z
					.object({
						name: z.string().trim().min(1).max(256),
						value: z.string().max(8192).default(""),
					})
					.strict(),
			)
			.max(200)
			.default([]),
		body: bodySchema.default({}),
	})
	.strict();
const sourceSchema = z
	.object({
		executionId: z.uuid(),
		requestId: z.uuid().optional(),
		collectionId: z
			.string()
			.regex(/^[a-f\d]{24}$/i)
			.optional(),
		requestName: z.string().trim().max(80).optional(),
	})
	.strict();
const createSchema = z.discriminatedUnion("mode", [
	z
		.object({
			mode: z.literal("from-response"),
			name: z.string().trim().min(1).max(80),
			source: sourceSchema,
			request: requestDefinitionSchema,
			environmentId: z
				.string()
				.regex(/^[a-f\d]{24}$/i)
				.optional(),
			selectQueryIds: z.array(z.string().max(64)).max(100).optional(),
			selectHeaderIds: z.array(z.string().max(64)).max(100).optional(),
			response: responseSchema,
		})
		.strict(),
	z
		.object({
			mode: z.literal("manual"),
			name: z.string().trim().min(1).max(80),
			requestName: z.string().trim().max(80).optional(),
			match: matchSchema,
			response: responseSchema,
		})
		.strict(),
]);
const updateSchema = z
	.object({
		name: z.string().trim().min(1).max(80),
		match: matchSchema,
		response: responseSchema,
	})
	.strict();

export async function listExamples(request, response, next) {
	try {
		response.json({ data: await exampleService.list(request.profileId) });
	} catch (error) {
		next(error);
	}
}

export async function getExample(request, response, next) {
	try {
		response.json({ data: await exampleService.get(request.profileId, request.params.exampleId) });
	} catch (error) {
		next(error);
	}
}

export async function createExample(request, response, next) {
	try {
		const input = createSchema.parse(request.body);
		const data =
			input.mode === "from-response"
				? await exampleService.createFromResponse(request.profileId, input)
				: await exampleService.createManual(request.profileId, input);
		response.status(201).json({ data });
	} catch (error) {
		next(error);
	}
}

export async function updateExample(request, response, next) {
	try {
		const input = updateSchema.parse(request.body);
		response.json({ data: await exampleService.replace(request.profileId, request.params.exampleId, input) });
	} catch (error) {
		next(error);
	}
}

export async function deleteExample(request, response, next) {
	try {
		await exampleService.remove(request.profileId, request.params.exampleId);
		response.status(204).send();
	} catch (error) {
		next(error);
	}
}
