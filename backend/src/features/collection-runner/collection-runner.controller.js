import { z } from "zod";
import { utf8Bytes } from "../../shared/utils/limits.js";
import { collectionRunnerService } from "./collection-runner.service.js";
import { RUN_LIMITS } from "./run-limits.js";

const runIdSchema = z.uuid("Provide a valid run identifier.");
const mongoIdSchema = z
	.string()
	.regex(/^[a-f\d]{24}$/i, "Provide a valid identifier.");

const runVariableSchema = z
	.object({
		key: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.regex(
				/^[A-Za-z_][A-Za-z0-9_]*$/,
				"Variable names start with a letter or underscore and contain letters, digits, or underscores.",
			),
		value: z
			.string()
			.refine((value) => utf8Bytes(value) <= RUN_LIMITS.variableValueBytes, "Run variable values are limited to 8 KiB."),
	})
	.strict();

const selectionSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("collection") }).strict(),
	z.object({ mode: z.literal("folder"), folderId: z.uuid("Provide a valid folder identifier.") }).strict(),
	z
	.object({
			mode: z.literal("requests"),
			requestIds: z
				.array(z.uuid("Provide a valid request identifier."))
				.min(1, "Select at least one request.")
				.max(RUN_LIMITS.requestsPerRun, `A run may include at most ${RUN_LIMITS.requestsPerRun} requests.`),
		})
		.strict(),
]);

const startSchema = z
	.object({
		collectionId: mongoIdSchema,
		collectionRevision: z.number().int().min(1),
		selection: selectionSchema,
		environmentId: mongoIdSchema.optional(),
		environmentRevision: z.number().int().min(1).optional(),
		iterations: z.number().int().min(1).max(RUN_LIMITS.iterationsPerRun).default(1),
		stopOnFailure: z.boolean().default(true),
		variables: z.array(runVariableSchema).max(RUN_LIMITS.variablesPerRun).default([]),
	})
	.strict();

export const parseRunStartInput = (value) => startSchema.parse(value);

export async function startRun(request, response, next) {
	try {
		const input = parseRunStartInput(request.body);
		response.status(201).json({ data: await collectionRunnerService.start(request.profileId, input) });
	} catch (error) {
		next(error);
	}
}

export async function getRun(request, response, next) {
	try {
		const runId = runIdSchema.parse(request.params.runId);
		response.json({ data: await collectionRunnerService.status(request.profileId, runId) });
	} catch (error) {
		next(error);
	}
}

export async function cancelRun(request, response, next) {
	try {
		const runId = runIdSchema.parse(request.params.runId);
		response.json({ data: await collectionRunnerService.cancel(request.profileId, runId) });
	} catch (error) {
		next(error);
	}
}

export async function rerunRun(request, response, next) {
	try {
		const runId = runIdSchema.parse(request.params.runId);
		response.status(201).json({ data: await collectionRunnerService.rerun(request.profileId, runId) });
	} catch (error) {
		next(error);
	}
}

export async function listRuns(request, response, next) {
	try {
		const query = z
			.object({ collectionId: mongoIdSchema.optional(), limit: z.coerce.number().int().min(1).max(RUN_LIMITS.recentRunsLimit).optional() })
			.parse(request.query ?? {});
		response.json({ data: await collectionRunnerService.list(request.profileId, query) });
	} catch (error) {
		next(error);
	}
}
