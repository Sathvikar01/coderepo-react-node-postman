import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";
import { nameKey } from "../../shared/utils/names.js";
import { environmentRepository } from "../environments/environment.repository.js";
import { historyService } from "../history/history.service.js";
import { SENSITIVE_MATCH_HEADERS } from "../mocks/mock-matcher.js";
import { matchRulesFromRequest } from "../mocks/match-target.js";
import { exampleRepository } from "./example.repository.js";

const MAX_MATCH_PATH_BYTES = 2048;
const MAX_MATCH_ROWS = 100;

function assertId(id) {
	if (!mongoose.isValidObjectId(id)) throw new AppError(404, "EXAMPLE_NOT_FOUND", "The requested example does not exist.");
}

function ensureMatch(match) {
	if (!match || typeof match !== "object") throw new AppError(400, "EXAMPLE_MATCH_INVALID", "Provide the request rules the example should match.");
	if (utf8Bytes(match.path ?? "") > MAX_MATCH_PATH_BYTES)
		throw new AppError(413, "EXAMPLE_MATCH_LIMIT", "Example match paths are limited to 2 KiB.");
	if ((match.query?.length ?? 0) > MAX_MATCH_ROWS || (match.headers?.length ?? 0) > MAX_MATCH_ROWS)
		throw new AppError(413, "EXAMPLE_MATCH_LIMIT", "An example may match on at most 100 query parameters and 100 headers.");
	for (const rule of match.headers ?? []) {
		const name = String(rule.key ?? "").toLowerCase();
		if (SENSITIVE_MATCH_HEADERS.has(name))
			throw new AppError(400, "EXAMPLE_MATCH_SENSITIVE", `"${rule.key}" cannot be a mock match rule because it carries credentials.`, {
				header: name,
			});
	}
}

function responseHeaderBytes(response) {
	return (response.headers ?? []).reduce((total, header) => total + utf8Bytes(header.name) + utf8Bytes(header.value) + 4, 0);
}

function capBody(value, encoding) {
	const limit = encoding === "base64" ? LIMITS.historyBodyBytes - (LIMITS.historyBodyBytes % 4) : LIMITS.historyBodyBytes;
	if (encoding === "base64") return value.slice(0, limit);
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= limit) return value;
	return new TextDecoder("utf-8").decode(bytes.subarray(0, limit), { stream: true });
}

function ensureResponse(response, { truncateBody }) {
	if (utf8Bytes(responseHeaderBytes(response)) > LIMITS.responseHeaderBytes)
		throw new AppError(413, "EXAMPLE_RESPONSE_LIMIT", "Example response headers are limited to 32 KiB.");
	const body = response.body ?? { encoding: "utf8", value: "" };
	if (body.encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(body.value ?? ""))
		throw new AppError(400, "EXAMPLE_BODY_INVALID", "Base64 example bodies may only contain base64 characters.");
	if (body.encoding === "base64" && (body.value ?? "").length % 4 !== 0)
		throw new AppError(400, "EXAMPLE_BODY_INVALID", "Base64 example bodies must use complete four-character groups.");
	if (utf8Bytes(body.value ?? "") <= LIMITS.historyBodyBytes) return response;
	if (!truncateBody)
		throw new AppError(413, "EXAMPLE_BODY_LIMIT", "Manual example bodies are limited to 256 KiB.", {
			limit: LIMITS.historyBodyBytes,
			actual: utf8Bytes(body.value ?? ""),
			unit: "bytes",
			scope: "example-body",
		});
	return {
		...response,
		body: { ...body, value: capBody(body.value ?? "", body.encoding), truncated: true, omittedReason: body.omittedReason ?? "example_limit" },
	};
}

function contentTypeOf(headers = []) {
	return headers.find((header) => String(header.name ?? "").toLowerCase() === "content-type")?.value?.split(";")[0]?.trim() ?? "";
}

function documentFrom({ profileId, name, source, match, response }) {
	return {
		ownerProfileId: profileId,
		name: String(name).trim(),
		nameKey: nameKey(name),
		source,
		match: {
			method: String(match.method).toUpperCase(),
			path: match.path ?? "",
			query: (match.query ?? []).map((rule) => ({ key: String(rule.key), value: String(rule.value ?? "") })),
			headers: (match.headers ?? []).map((rule) => ({ key: String(rule.key), value: String(rule.value ?? "") })),
		},
		response: {
			status: response.status,
			statusText: response.statusText ?? "",
			contentType: response.contentType || contentTypeOf(response.headers) || response.body?.mediaType || "",
			headers: (response.headers ?? []).map((header) => ({ name: String(header.name), value: String(header.value ?? "") })),
			body: {
				encoding: response.body?.encoding === "base64" ? "base64" : "utf8",
				value: response.body?.value ?? "",
				mediaType: response.body?.mediaType ?? "",
				truncated: Boolean(response.body?.truncated),
				omittedReason: response.body?.omittedReason ?? null,
			},
		},
	};
}

async function withNameConflictBoundary(operation) {
	try {
		return await operation();
	} catch (error) {
		if (error?.code === 11000) throw new AppError(409, "EXAMPLE_NAME_CONFLICT", "An example with this name already exists in this profile.");
		throw error;
	}
}

export function createExampleService({ repository = exampleRepository, environments = environmentRepository, history = historyService } = {}) {
	async function ensureUniqueName(name, profileId, excludedId) {
		const conflict = await repository.findByNameKey(nameKey(name), profileId, excludedId);
		if (conflict) throw new AppError(409, "EXAMPLE_NAME_CONFLICT", "An example with this name already exists in this profile.");
	}

	async function getExample(profileId, exampleId) {
		assertId(exampleId);
		const example = await repository.findById(exampleId, profileId);
		if (!example) throw new AppError(404, "EXAMPLE_NOT_FOUND", "The requested example does not exist.");
		return example;
	}

	async function admit(profileId, { name, source, match, response }, { truncateBody }) {
		const count = await repository.count(profileId);
		if (count >= LIMITS.examplesPerProfile)
			throw new AppError(413, "PROFILE_LIMIT", `This profile has reached the ${LIMITS.examplesPerProfile} example limit.`, {
				limit: LIMITS.examplesPerProfile,
				actual: count,
				unit: "examples",
				scope: "profile",
			});
		await ensureUniqueName(name, profileId, null);
		ensureMatch(match);
		const checkedResponse = ensureResponse(response, { truncateBody });
		return withNameConflictBoundary(() => repository.create(documentFrom({ profileId, name, source, match, response: checkedResponse })));
	}

	return {
		list: (profileId) => repository.list(profileId),
		get: getExample,
		async createFromResponse(profileId, input) {
			const record = await history.get(profileId, input.source.executionId);
			if (!record || record.expired)
				throw new AppError(404, "EXAMPLE_SOURCE_NOT_FOUND", "The execution this example would come from is no longer available.");
			const environment = input.environmentId ? await environments.findById(input.environmentId, profileId) : null;
			const match = matchRulesFromRequest({
				request: input.request,
				environment,
				selectQueryIds: input.selectQueryIds,
				selectHeaderIds: input.selectHeaderIds,
			});
			return admit(
				profileId,
				{
					name: input.name,
					source: {
						type: "response",
						executionId: input.source.executionId,
						requestId: input.source.requestId ?? input.request?.id ?? null,
						collectionId: input.source.collectionId ?? null,
						requestName: input.source.requestName ?? input.request?.name ?? null,
					},
					match,
					response: input.response,
				},
				{ truncateBody: true },
			);
		},
		createManual(profileId, input) {
			return admit(
				profileId,
				{
					name: input.name,
					source: { type: "manual", executionId: null, requestId: null, collectionId: null, requestName: input.source?.requestName ?? null },
					match: input.match,
					response: input.response,
				},
				{ truncateBody: false },
			);
		},
		async replace(profileId, exampleId, input) {
			const existing = await getExample(profileId, exampleId);
			await ensureUniqueName(input.name, profileId, existing._id);
			ensureMatch(input.match);
			const checkedResponse = ensureResponse(input.response, { truncateBody: false });
			const document = documentFrom({ profileId, name: input.name, source: existing.source, match: input.match, response: checkedResponse });
			const updated = await withNameConflictBoundary(() =>
				repository.replaceById(exampleId, profileId, {
					name: document.name,
					nameKey: document.nameKey,
					match: document.match,
					response: document.response,
				}),
			);
			if (!updated) throw new AppError(404, "EXAMPLE_NOT_FOUND", "The requested example does not exist.");
			return updated;
		},
		async remove(profileId, exampleId) {
			assertId(exampleId);
			const removed = await repository.removeById(exampleId, profileId);
			if (!removed) throw new AppError(404, "EXAMPLE_NOT_FOUND", "The requested example does not exist.");
		},
	};
}

export const exampleService = createExampleService();
