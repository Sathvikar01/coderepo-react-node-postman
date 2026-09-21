import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.js";
import { environmentRepository } from "../environments/environment.repository.js";
import { exampleRepository } from "../examples/example.repository.js";
import { matchTargetFromRequest } from "./match-target.js";
import { normalizeTarget, selectExampleMatch } from "./mock-matcher.js";
import { mockBasePath, verifyMockToken } from "./mock-token.js";

function byteSize(value) {
	return Buffer.byteLength(String(value ?? ""), "utf8");
}

function queryString(query = []) {
	const encoded = new URLSearchParams();
	for (const row of query) encoded.append(row.key, row.value);
	const value = encoded.toString();
	return value ? `?${value}` : "";
}

function mockResult({ executionId, request, target, example, route, considered, matched }) {
	const executedUrl = `${route}${target.path}${queryString(target.query)}`;
	const startedAt = new Date().toISOString();
	const base = {
		executionId,
		outcome: matched ? "mock" : "mock_miss",
		effectCertainty: "not_dispatched",
		executedUrl,
		request,
		snapshot: {
			displayUrl: request.urlTemplate,
			source: { type: "mock", exampleId: matched ? String(example._id) : null },
			environment: null,
			collectionDefaults: null,
		},
		compileTrace: [],
		warnings: [
			{
				code: "MOCK_RESPONSE",
				message: matched
					? `Served from the saved example "${example.name}". No network request was made.`
					: "No network request was made; the mock route could not find a matching example.",
			},
		],
		persistence: { state: "not_persisted", warning: "Mock responses are never written to history." },
		historyId: null,
		visible: true,
		mock: {
			matched,
			route,
			exampleId: matched ? String(example._id) : null,
			exampleName: matched ? example.name : null,
			target,
			considered,
		},
		response: null,
		error: null,
		startedAt,
		finishedAt: startedAt,
	};
	if (!matched) {
		return {
			...base,
			error: {
				code: "MOCK_MISS",
				message: `No saved example matches ${target.method} ${target.path || "/"}.`,
				details: { method: target.method, path: target.path, query: target.query, headers: target.headers, considered },
			},
		};
	}
	const body = example.response?.body ?? { encoding: "utf8", value: "" };
	const bytes = byteSize(body.value ?? "");
	return {
		...base,
		response: {
			status: example.response.status,
			statusText: example.response.statusText ?? "",
			httpVersion: null,
			executedUrl,
			headers: (example.response.headers ?? []).map((header) => ({ name: header.name, value: header.value })),
			body: {
				encoding: body.encoding === "base64" ? "base64" : "utf8",
				value: body.value ?? "",
				mediaType: body.mediaType || example.response.contentType || "",
				truncated: Boolean(body.truncated),
				omittedReason: body.omittedReason ?? null,
			},
			timing: { totalMs: 0, firstByteMs: 0 },
			size: { receivedBodyBytes: bytes, decodedBodyBytes: bytes, capturedBodyBytes: bytes, persistedBodyBytes: bytes },
			timeoutMs: null,
			warnings: [
				{
					code: "MOCK_RESPONSE",
					message: `This result came from the saved example "${example.name}". Nothing was sent over the network.`,
				},
			],
		},
	};
}

export function createMockService({ examples = exampleRepository, environments = environmentRepository } = {}) {
	return {
		async resolve(profileId, { request, environmentId, executionId }) {
			const environment = environmentId ? await environments.findById(environmentId, profileId) : null;
			const target = matchTargetFromRequest({ request, environment });
			const candidates = await examples.findMatchable(profileId, target.method, target.path);
			const match = selectExampleMatch(candidates, target);
			const route = mockBasePath(profileId);
			return {
				matched: match.matched,
				example: match.example,
				target,
				considered: candidates.length,
				route,
				result: mockResult({
					executionId: executionId ?? randomUUID(),
					request,
					target,
					example: match.example,
					route,
					considered: candidates.length,
					matched: match.matched,
				}),
			};
		},
		async serve(profileId, token, candidate) {
			if (!verifyMockToken(profileId, token)) throw new AppError(404, "MOCK_ROUTE_NOT_FOUND", "This mock route does not exist.");
			const target = normalizeTarget(candidate);
			const candidates = await examples.findMatchable(profileId, target.method, target.path);
			const match = selectExampleMatch(candidates, target);
			if (!match.matched)
				throw new AppError(404, "MOCK_MISS", `No saved example matches ${target.method} ${target.path || "/"}.`, {
					method: target.method,
					path: target.path,
					considered: candidates.length,
				});
			return { example: match.example, target };
		},
		async meta(profileId) {
			return { route: mockBasePath(profileId), exampleCount: await examples.count(profileId) };
		},
	};
}

export const mockService = createMockService();
