import { fingerprintOf } from "../history/fingerprint.js";

export const EXECUTION_RECEIPT_KIND = "tracer.execution-receipt";
export const EXECUTION_RECEIPT_VERSION = 1;

const REFERENCE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const MAX_SHAPE_ENTRIES = 200;
const MAX_SHAPE_DEPTH = 16;
const SENSITIVE_QUERY_KEY = /(^|[-_.])(auth|authorization|cookie|key|password|secret|session|token)([-_.]|$)/i;

function iso(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function references(value) {
	const found = new Set();
	for (const match of String(value ?? "").matchAll(REFERENCE)) found.add(match[1]);
	return [...found].sort();
}

function authEvidence(compiled, request) {
	const auth = compiled?.authTemplate ?? request?.auth ?? { mode: "none" };
	const values = [];
	if (auth.mode === "bearer") values.push(auth.tokenTemplate);
	if (auth.mode === "basic") values.push(auth.usernameTemplate, auth.passwordTemplate);
	if (auth.mode === "apiKey") values.push(auth.valueTemplate);
	return {
		mode: compiled?.authMode ?? auth.mode ?? "none",
		source: compiled?.authSource ?? (auth.mode === "inherit" ? "collection" : "request"),
		referenceKeys: [...new Set(values.flatMap(references))].sort(),
	};
}

function queryKeys(url) {
	try {
		return [...new URL(String(url ?? "")).searchParams.keys()].map((key) => key.toLowerCase());
	} catch {
		return [];
	}
}

function redactDisplayUrl(url, redaction = {}) {
	let output = String(url ?? "");
	const sensitiveKeys = new Set((redaction.queryKeys ?? []).map((key) => String(key).toLowerCase()));
	output = output.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator, rawKey, rawValue) => {
		let key = rawKey;
		try {
			key = decodeURIComponent(rawKey.replace(/\+/g, " "));
		} catch {
			// Keep the raw key. Malformed percent escapes are not a reason to expose its value.
		}
		if (sensitiveKeys.has(key.toLowerCase()) || SENSITIVE_QUERY_KEY.test(key)) return `${separator}${rawKey}=[REDACTED]`;
		let value = rawValue;
		for (const secret of redaction.values ?? []) {
			if (secret && secret.length >= 3) value = value.split(secret).join("[REDACTED]");
		}
		return `${separator}${rawKey}=${value}`;
	});
	return output;
}

function headerNames(headers) {
	return (headers ?? []).map((header) => String(header?.name ?? "").trim().toLowerCase()).filter(Boolean);
}

function headerContract(headers) {
	const counts = new Map();
	for (const name of headerNames(headers)) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, count]) => ({ name, count }));
}

function valueType(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

export function jsonShape(value) {
	const shape = [];
	const stack = [{ path: "$", value, depth: 0 }];
	while (stack.length > 0 && shape.length < MAX_SHAPE_ENTRIES) {
		const current = stack.pop();
		const type = valueType(current.value);
		shape.push({ path: current.path, type });
		if (current.depth >= MAX_SHAPE_DEPTH || current.value === null || typeof current.value !== "object") continue;
		if (Array.isArray(current.value)) {
			const unique = new Map();
			for (const item of current.value) {
				const itemType = valueType(item);
				if (!unique.has(itemType)) unique.set(itemType, item);
			}
			const samples = [...unique.values()];
			for (let index = samples.length - 1; index >= 0; index -= 1) {
				stack.push({ path: `${current.path}[]`, value: samples[index], depth: current.depth + 1 });
			}
			continue;
		}
		const keys = Object.keys(current.value).sort();
		for (let index = keys.length - 1; index >= 0; index -= 1) {
			const key = keys[index];
			stack.push({ path: `${current.path}.${key}`, value: current.value[key], depth: current.depth + 1 });
		}
	}
	return shape;
}

function responseShape(response) {
	const body = response?.body;
	if (!body || body.encoding !== "utf8" || body.truncated || !body.value) return [];
	try {
		return jsonShape(JSON.parse(body.value));
	} catch {
		return [];
	}
}

function requestBodyEvidence(compiled, request) {
	const bytes = compiled?.body;
	return {
		mode: request?.body?.mode ?? "none",
		sizeBytes: bytes ? Buffer.byteLength(bytes) : 0,
		fingerprint: bytes ? fingerprintOf({ kind: "compiled-request-body", value: Buffer.from(bytes).toString("base64") }) : null,
	};
}

function responseBodyFingerprint(response) {
	const body = response?.body;
	if (!body || !body.value) return null;
	return fingerprintOf({ kind: "response-body", encoding: body.encoding ?? "utf8", value: body.value });
}

export function buildExecutionReceipt(input) {
	const request = input.request ?? null;
	const compiled = input.compiled ?? null;
	const response = input.response ?? null;
	const source = input.source ?? {};
	const environment = input.environment ?? {};
	const executedUrl = compiled?.executedUrl ?? response?.executedUrl ?? null;
	const compiledHeaders = compiled?.headers ?? [];
	const variableSources = (compiled?.trace ?? []).map((entry) => ({
		field: String(entry?.field ?? ""),
		key: String(entry?.variable ?? ""),
		scope: String(entry?.scope ?? ""),
	}));
	const target = input.target
		? {
			scheme: input.target.scheme,
			hostname: input.target.originalHostname,
			port: input.target.port,
			address: input.target.ip,
			family: input.target.family,
		}
		: null;
	const policyDecision = input.target ? "allowed" : compiled ? "blocked" : "not_evaluated";
	const authoredFingerprint = request ? fingerprintOf({ kind: "authored-request", request }) : null;
	const compiledFingerprint = compiled
		? fingerprintOf({
				kind: "compiled-request",
				method: compiled.method,
				url: executedUrl,
				headers: compiledHeaders,
				body: compiled.body ? Buffer.from(compiled.body).toString("base64") : null,
			})
		: null;

	return {
		schemaVersion: EXECUTION_RECEIPT_VERSION,
		kind: EXECUTION_RECEIPT_KIND,
		executionId: input.executionId,
		fingerprint: input.fingerprint ?? null,
		fingerprintKeyId: input.fingerprintKeyId ?? null,
		startedAt: iso(input.startedAt),
		finishedAt: iso(input.finishedAt),
		outcome: input.outcome ?? null,
		effectCertainty: input.effectCertainty ?? "not_dispatched",
		request: {
			method: compiled?.method ?? request?.method ?? null,
			displayUrl: request?.urlTemplate ? redactDisplayUrl(request.urlTemplate, compiled?.redaction) : null,
			executedUrl,
			authoredFingerprint,
			compiledFingerprint,
			headerNames: headerNames(compiledHeaders),
			queryKeys: queryKeys(compiled?.url),
			body: requestBodyEvidence(compiled, request),
			auth: authEvidence(compiled, request),
			variableSources,
		},
		source: {
			type: source.type ?? "scratch",
			collectionId: source.collectionId ?? null,
			collectionRevision: source.collectionRevision ?? null,
			requestId: source.requestId ?? null,
			environmentId: environment.environmentId ?? null,
			environmentRevision: environment.environmentRevision ?? null,
		},
		policy: {
			decision: policyDecision,
			version: input.target?.policyVersion ?? null,
			local: input.target?.local === true,
		},
		target,
		redirects: [],
		transport: response
			? {
				httpVersion: response.httpVersion ?? null,
				durationMs: response.timing?.totalMs ?? null,
				firstByteMs: response.timing?.firstByteMs ?? null,
				receivedBodyBytes: response.size?.receivedBodyBytes ?? null,
				capturedBodyBytes: response.size?.capturedBodyBytes ?? null,
			}
			: null,
		response: response
			? {
				bodyFingerprint: responseBodyFingerprint(response),
				truncated: response.body?.truncated === true,
				binary: response.body?.encoding === "base64",
				contract: {
					status: response.status,
					headers: headerContract(response.headers),
					bodyShape: responseShape(response),
				},
			}
			: null,
		error: input.error ? { code: input.error.code ?? "UNKNOWN_ERROR" } : null,
		tests: {
			counts: input.scriptResults?.counts ?? { passed: 0, failed: 0, error: 0 },
			failureFingerprint: fingerprintOf({
				kind: "test-failures",
				tests: (input.scriptResults?.tests ?? []).filter((test) => test?.status !== "passed"),
			}),
		},
		warnings: (input.warnings ?? []).map((warning) => ({ code: warning?.code ?? "WARNING" })),
	};
}
