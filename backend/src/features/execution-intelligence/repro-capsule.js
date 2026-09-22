import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";
import { requestDefinitionSchema } from "../../shared/utils/schemas.js";
import { executionFailurePredicate } from "../scripts/assertions.js";

export const REPRO_CAPSULE_KIND = "tracer.repro-capsule";
export const REPRO_CAPSULE_VERSION = 1;
export const CAPSULE_MAX_BYTES = 512 * 1024;

const SENSITIVE_NAME = /(^|[-_.])(auth|authorization|cookie|key|password|secret|session|token)([-_.]|$)/i;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function slug(value) {
	const normalized = String(value ?? "input")
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 48);
	return normalized || "input";
}

function placeholder(name) {
	return `{{${name}}}`;
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function addInput(state, name, source, secretValue = null) {
	if (!state.inputs.has(name)) state.inputs.set(name, { name, source });
	if (secretValue && secretValue.length >= 3 && !secretValue.includes("{{")) state.secrets.add(secretValue);
	return placeholder(name);
}

function registerExistingInputs(state, value) {
	for (const match of String(value ?? "").matchAll(PLACEHOLDER)) {
		if (!state.inputs.has(match[1])) state.inputs.set(match[1], { name: match[1], source: "variable" });
	}
}

function scrubKnown(value, secrets) {
	let output = String(value ?? "");
	for (const secret of secrets) {
		if (secret.length >= 3) output = output.split(secret).join("[REDACTED]");
	}
	return output;
}

function sanitizeUrl(state, value) {
	const output = String(value ?? "").replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator, rawKey, rawValue) => {
		let key = rawKey;
		try {
			key = decodeURIComponent(rawKey.replace(/\+/g, " "));
		} catch {
			// Treat malformed keys as opaque; only known secret values are scrubbed.
		}
		if (SENSITIVE_NAME.test(key)) {
			const name = `capsule_query_${slug(key)}`;
			return `${separator}${rawKey}=${addInput(state, name, `query:${key}`, rawValue)}`;
		}
		registerExistingInputs(state, rawValue);
		return `${separator}${rawKey}=${scrubKnown(rawValue, state.secrets)}`;
	});
	registerExistingInputs(state, output);
	return output;
}

function sanitizeRows(state, rows, source) {
	return (rows ?? []).map((row) => {
		const key = String(row?.key ?? "");
		const value = String(row?.value ?? "");
		if (SENSITIVE_NAME.test(key)) {
			const name = `capsule_${source}_${slug(key)}`;
			return { ...row, value: addInput(state, name, `${source}:${key}`, value) };
		}
		registerExistingInputs(state, value);
		return { ...row, value: scrubKnown(value, state.secrets) };
	});
}

function sanitizeAuth(state, auth) {
	const value = auth ?? { mode: "none" };
	if (["none", "inherit"].includes(value.mode)) return { mode: value.mode };
	if (value.mode === "bearer") {
		if (String(value.tokenTemplate ?? "").match(PLACEHOLDER)) {
			registerExistingInputs(state, value.tokenTemplate);
			return { mode: "bearer", tokenTemplate: value.tokenTemplate };
		}
		return { mode: "bearer", tokenTemplate: addInput(state, "capsule_auth_token", "auth:bearer", value.tokenTemplate) };
	}
	if (value.mode === "basic") {
		const field = (key) => {
			const raw = String(value[key] ?? "");
			if (raw.match(PLACEHOLDER)) {
				registerExistingInputs(state, raw);
				return raw;
			}
			const name = key === "usernameTemplate" ? "capsule_auth_username" : "capsule_auth_password";
			return addInput(state, name, `auth:${key}`, raw);
		};
		return { mode: "basic", usernameTemplate: field("usernameTemplate"), passwordTemplate: field("passwordTemplate") };
	}
	if (value.mode === "apiKey") {
		const raw = String(value.valueTemplate ?? "");
		if (raw.match(PLACEHOLDER)) registerExistingInputs(state, raw);
		return {
			mode: "apiKey",
			key: value.key,
			valueTemplate: raw.match(PLACEHOLDER) ? raw : addInput(state, "capsule_auth_api_key", "auth:apiKey", raw),
			in: value.in,
		};
	}
	return { mode: "none" };
}

function sanitizeJsonValue(state, value, path = "body") {
	if (Array.isArray(value)) return value.map((item, index) => sanitizeJsonValue(state, item, `${path}_${index}`));
	if (value && typeof value === "object") {
		const output = {};
		for (const key of Object.keys(value).sort()) {
			if (SENSITIVE_NAME.test(key) && typeof value[key] === "string") {
				const name = `capsule_body_${slug(key)}`;
				output[key] = addInput(state, name, `body:${key}`, value[key]);
			} else output[key] = sanitizeJsonValue(state, value[key], `${path}_${key}`);
		}
		return output;
	}
	if (typeof value === "string") {
		registerExistingInputs(state, value);
		return scrubKnown(value, state.secrets);
	}
	return value;
}

function sanitizeBody(state, body) {
	if (!body || body.mode === "none") return { mode: "none" };
	if (body.mode === "urlencoded") return { mode: "urlencoded", rows: sanitizeRows(state, body.rows, "body") };
	if (body.mode === "json") {
		try {
			return { mode: "json", text: JSON.stringify(sanitizeJsonValue(state, JSON.parse(body.text ?? ""))) };
		} catch {
			const name = "capsule_body_text";
			return { mode: "json", text: JSON.stringify(addInput(state, name, "body:json", String(body.text ?? ""))) };
		}
	}
	registerExistingInputs(state, body.text);
	return {
		mode: "text",
		text: scrubKnown(body.text, state.secrets),
		contentType: body.contentType || "text/plain",
	};
}

export function sanitizeCapsuleRequest(request) {
	const state = { inputs: new Map(), secrets: new Set() };
	const auth = sanitizeAuth(state, request?.auth);
	const query = sanitizeRows(state, request?.query, "query");
	const headers = sanitizeRows(state, request?.headers, "header");
	const urlTemplate = sanitizeUrl(state, request?.urlTemplate);
	const body = sanitizeBody(state, request?.body);
	const scripts = {
		preRequest: scrubKnown(request?.scripts?.preRequest, state.secrets),
		test: scrubKnown(request?.scripts?.test, state.secrets),
	};
	const sanitized = {
		...request,
		urlTemplate,
		query,
		headers,
		body,
		auth,
		scripts,
		assertions: request?.assertions ?? [],
	};
	return { request: requestDefinitionSchema.parse(sanitized), state };
}

export function failurePredicateForRecord(record) {
	const failures = executionFailurePredicate(record?.snapshot?.scriptResults);
	const first = failures.failures[0];
	if (first?.assertionId)
		return { type: "assertion", assertionId: first.assertionId, failureFingerprint: record?.receipt?.tests?.failureFingerprint ?? null };
	if (record?.response?.status) return { type: "status", equals: record.response.status };
	return { type: "outcome", equals: record?.outcome ?? "unknown" };
}

function receiptSummary(receipt) {
	return {
		executionId: receipt.executionId,
		fingerprint: receipt.fingerprint ?? null,
		outcome: receipt.outcome,
		effectCertainty: receipt.effectCertainty,
		request: {
			authoredFingerprint: receipt.request?.authoredFingerprint ?? null,
			compiledFingerprint: receipt.request?.compiledFingerprint ?? null,
		},
		policy: receipt.policy ?? null,
		target: receipt.target ?? null,
		contract: receipt.response?.contract ?? null,
		error: receipt.error ?? null,
	};
}

const requiredInputSchema = z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), source: z.string().max(256) }).strict();
const predicateSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("assertion"), assertionId: z.string().min(1).max(128), failureFingerprint: z.string().nullable() }).strict(),
	z.object({ type: z.literal("status"), equals: z.number().int().min(100).max(599) }).strict(),
	z.object({ type: z.literal("outcome"), equals: z.string().min(1).max(64) }).strict(),
]);
const responseSchema = z
	.object({
		status: z.number().int().min(100).max(599),
		headers: z.array(z.object({ name: z.string().max(256), count: z.number().int().min(1) }).strict()).max(LIMITS.responseHeaderPairs),
		body: z
			.object({
				encoding: z.enum(["utf8", "base64"]),
				value: z.string().refine((value) => utf8Bytes(value) <= LIMITS.historyBodyBytes),
				mediaType: z.string().max(200),
				truncated: z.boolean(),
			})
			.strict(),
	})
	.strict();
const capsuleSchema = z
	.object({
		schemaVersion: z.literal(REPRO_CAPSULE_VERSION),
		kind: z.literal(REPRO_CAPSULE_KIND),
		request: requestDefinitionSchema,
		requiredInputs: z.array(requiredInputSchema).max(LIMITS.variablesPerScope),
		predicate: predicateSchema,
		receipt: z.unknown(),
		response: responseSchema.optional(),
	})
	.strict();

export function buildReproCapsule(record, { includeResponseBody = false } = {}) {
	if (!record?.receipt) throw new AppError(409, "RECEIPT_UNAVAILABLE", "This history entry has no execution passport.");
	const sanitized = sanitizeCapsuleRequest(record.request);
	const capsule = {
		schemaVersion: REPRO_CAPSULE_VERSION,
		kind: REPRO_CAPSULE_KIND,
		request: sanitized.request,
		requiredInputs: [...sanitized.state.inputs.values()].sort((left, right) => left.name.localeCompare(right.name)),
		predicate: failurePredicateForRecord(record),
		receipt: receiptSummary(record.receipt),
	};
	if (includeResponseBody && record.response?.body) {
		capsule.response = {
			status: record.response.status,
			headers: record.receipt.response?.contract?.headers ?? [],
			body: {
				encoding: record.response.body.encoding === "base64" ? "base64" : "utf8",
				value: scrubKnown(record.response.body.value, sanitized.state.secrets).slice(0, LIMITS.historyBodyBytes),
				mediaType: String(record.response.body.mediaType ?? "").slice(0, 200),
				truncated: record.response.body.truncated === true,
			},
		};
	}
	return capsuleSchema.parse(capsule);
}

export function serializeReproCapsule(capsule) {
	const parsed = capsuleSchema.parse(capsule);
	const text = canonicalJson(parsed);
	if (utf8Bytes(text) > CAPSULE_MAX_BYTES)
		throw new AppError(413, "CAPSULE_LIMIT", "The reproduction capsule exceeds the 512 KiB limit.");
	return text;
}

export function parseReproCapsule(text) {
	if (typeof text !== "string") throw new AppError(400, "CAPSULE_MALFORMED", "Provide a serialized reproduction capsule.");
	if (utf8Bytes(text) > CAPSULE_MAX_BYTES)
		throw new AppError(413, "CAPSULE_LIMIT", "The reproduction capsule exceeds the 512 KiB limit.");
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new AppError(400, "CAPSULE_MALFORMED", "The reproduction capsule is not valid JSON.");
	}
	if (value?.schemaVersion !== REPRO_CAPSULE_VERSION || value?.kind !== REPRO_CAPSULE_KIND)
		throw new AppError(422, "CAPSULE_VERSION_UNSUPPORTED", "This reproduction capsule version is not supported.");
	const parsed = capsuleSchema.safeParse(value);
	if (!parsed.success)
		throw new AppError(422, "CAPSULE_INVALID", "The reproduction capsule does not match ReproCapsuleV1.", {
			issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
		});
	return parsed.data;
}
