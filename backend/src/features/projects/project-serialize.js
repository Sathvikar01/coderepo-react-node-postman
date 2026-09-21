// Canonical serialization and fingerprinting for TracerProjectV1.
//
// Same logical project -> same text: object keys are emitted in lexicographic
// order at every level, array order (rows, requests, folders, variables) is
// preserved because it is user-visible behavior, and no timestamps, Mongo ids,
// or random identifiers are ever added.

import { createHash } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.js";
import { utf8Bytes } from "../../shared/utils/limits.js";
import { PROJECT_JSON_MAX_BYTES, TRACER_PROJECT_VERSION, tracerProjectSchema } from "./project-schema.js";

export function projectIssues(error) {
	return (error?.issues ?? []).map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message }));
}

export function projectInvalid(error, code = "PROJECT_INVALID", message = "The project does not match the TracerProjectV1 schema.", details) {
	return new AppError(422, code, message, { issues: projectIssues(error), ...(details ?? {}) });
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	return encoded === undefined ? "null" : encoded;
}

export function serializeProject(project) {
	const result = tracerProjectSchema.safeParse(project);
	if (!result.success) throw projectInvalid(result.error);
	const text = canonicalJson(result.data);
	const size = utf8Bytes(text);
	if (size > PROJECT_JSON_MAX_BYTES)
		throw new AppError(413, "PROJECT_LIMIT", `This project exceeds the ${PROJECT_JSON_MAX_BYTES} byte portable limit.`, {
			limit: PROJECT_JSON_MAX_BYTES,
			actual: size,
			unit: "bytes",
			scope: "project-json",
		});
	return text;
}

export function projectFingerprint(project) {
	return createHash("sha256").update(serializeProject(project), "utf8").digest("hex");
}

export function parseProject(text) {
	if (typeof text !== "string") throw new AppError(400, "PROJECT_MALFORMED", "Provide the serialized project as a JSON string.");
	if (utf8Bytes(text) > PROJECT_JSON_MAX_BYTES)
		throw new AppError(413, "PROJECT_LIMIT", `This project exceeds the ${PROJECT_JSON_MAX_BYTES} byte portable limit.`, {
			limit: PROJECT_JSON_MAX_BYTES,
			actual: utf8Bytes(text),
			unit: "bytes",
			scope: "project-json",
		});
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new AppError(400, "PROJECT_MALFORMED", "The project file is not valid JSON.");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new AppError(400, "PROJECT_MALFORMED", "The project file must contain a single JSON object.");
	if (value.schemaVersion !== TRACER_PROJECT_VERSION)
		throw new AppError(422, "PROJECT_VERSION_UNSUPPORTED", `This project uses an unsupported schemaVersion; this build supports TracerProjectV${TRACER_PROJECT_VERSION}.`, {
			supported: TRACER_PROJECT_VERSION,
			received: typeof value.schemaVersion === "number" ? value.schemaVersion : null,
		});
	const result = tracerProjectSchema.safeParse(value);
	if (!result.success) throw projectInvalid(result.error);
	return result.data;
}
