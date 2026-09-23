/**
 * Phase 31 — deterministic material-delta compiler.
 *
 * Given the request definitions behind a known-good execution and a failing
 * execution, enumerate the *material* differences in a fixed order and mark
 * each one as replayable or not. A delta is replayable only when the factor can
 * be faithfully reconstructed and re-applied through the normal execution
 * pipeline without reconstructing a resolved secret.
 *
 * The compiler is pure: it never touches the network, the database, or the
 * probe callback. It returns plain descriptors the engine can apply.
 */

import { AppError } from "../../../shared/errors/app-error.js";
import { REDACTED, canonicalEqual, isPlainObject, isSecretField, isSecretValue, isSensitiveName } from "./counterfactual-model.js";

function makeDelta({ id, path, kind, replayable, reason = null, op = null, before = null, after = null, displayBefore = null, displayAfter = null }) {
	return { id, path, kind, replayable, reason, op, before, after, displayBefore, displayAfter };
}

/* -------------------------------------------------------------------------- */
/* Secret-safe display                                                         */
/* -------------------------------------------------------------------------- */

function redactJson(value, name = "") {
	if (isPlainObject(value)) {
		const out = {};
		for (const key of Object.keys(value)) out[key] = redactJson(value[key], key);
		return out;
	}
	if (Array.isArray(value)) return value.map((entry) => redactJson(entry, name));
	return isSecretField(name, value) ? REDACTED : value;
}

function subtreeHasSecret(value, name = "") {
	if (isPlainObject(value)) return Object.keys(value).some((key) => subtreeHasSecret(value[key], key));
	if (Array.isArray(value)) return value.some((entry) => subtreeHasSecret(entry, name));
	return isSecretField(name, value);
}

function displayRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		key: row.key,
		value: isSecretField(row.key, row.value) ? REDACTED : row.value,
		enabled: row.enabled !== false,
	};
}

function rowIsSecret(row) {
	return Boolean(row) && isSecretField(row.key, row.value);
}

function rowEqual(left, right) {
	return (
		left?.key === right?.key &&
		left?.value === right?.value &&
		(left?.enabled !== false) === (right?.enabled !== false)
	);
}

/* -------------------------------------------------------------------------- */
/* Row-list deltas (query, headers, urlencoded body)                           */
/* -------------------------------------------------------------------------- */

function orderedRowIds(baseRows, candidateRows) {
	const ids = [];
	const seen = new Set();
	for (const row of baseRows) {
		if (row?.id && !seen.has(row.id)) {
			seen.add(row.id);
			ids.push(row.id);
		}
	}
	for (const row of candidateRows) {
		if (row?.id && !seen.has(row.id)) {
			seen.add(row.id);
			ids.push(row.id);
		}
	}
	return ids;
}

function rowDeltas({ listPath, kind, pathPrefix, baseRows = [], candidateRows = [] }) {
	const deltas = [];
	const baseById = new Map();
	const candidateById = new Map();
	baseRows.forEach((row, index) => row?.id && baseById.set(row.id, { row, index }));
	candidateRows.forEach((row, index) => row?.id && candidateById.set(row.id, { row, index }));

	for (const id of orderedRowIds(baseRows, candidateRows)) {
		const base = baseById.get(id);
		const candidate = candidateById.get(id);
		const label = base?.row?.key ?? candidate?.row?.key ?? "row";
		const path = `${pathPrefix}.${label}`;

		if (base && candidate) {
			if (rowEqual(base.row, candidate.row)) continue;
			const replayable = !rowIsSecret(base.row) && !rowIsSecret(candidate.row);
			deltas.push(
				makeDelta({
					id: `${kind}:${id}`,
					path,
					kind,
					replayable,
					reason: replayable ? null : "sensitive_value_not_reconstructable",
					op: replayable ? { type: "row", path: [...listPath], rowId: id, index: candidate.index } : null,
					before: replayable ? base.row : displayRow(base.row),
					after: replayable ? candidate.row : displayRow(candidate.row),
					displayBefore: displayRow(base.row),
					displayAfter: displayRow(candidate.row),
				}),
			);
			continue;
		}

		if (candidate && !base) {
			const replayable = !rowIsSecret(candidate.row);
			deltas.push(
				makeDelta({
					id: `${kind}:${id}`,
					path,
					kind,
					replayable,
					reason: replayable ? null : "sensitive_value_not_reconstructable",
					op: replayable ? { type: "row", path: [...listPath], rowId: id, index: candidate.index } : null,
					before: null,
					after: replayable ? candidate.row : displayRow(candidate.row),
					displayBefore: null,
					displayAfter: displayRow(candidate.row),
				}),
			);
			continue;
		}

		const replayable = !rowIsSecret(base.row);
		deltas.push(
			makeDelta({
				id: `${kind}:${id}`,
				path,
				kind,
				replayable,
				reason: replayable ? null : "sensitive_value_not_reconstructable",
				op: replayable ? { type: "row", path: [...listPath], rowId: id, index: base.index } : null,
				before: replayable ? base.row : displayRow(base.row),
				after: null,
				displayBefore: displayRow(base.row),
				displayAfter: null,
			}),
		);
	}
	return deltas;
}

/* -------------------------------------------------------------------------- */
/* JSON body deltas                                                            */
/* -------------------------------------------------------------------------- */

function jsonPresence(root, path) {
	let current = root;
	for (const segment of path) {
		if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return { present: false, value: null };
		current = current[segment];
	}
	return { present: true, value: current };
}

function collectJsonDeltas(baseRoot, candidateRoot, path, out) {
	const before = jsonPresence(baseRoot, path);
	const after = jsonPresence(candidateRoot, path);
	if (!before.present && !after.present) return;

	const beforeObject = before.present && isPlainObject(before.value);
	const afterObject = after.present && isPlainObject(after.value);
	if (beforeObject && afterObject) {
		const keys = [...new Set([...Object.keys(before.value), ...Object.keys(after.value)])].sort();
		for (const key of keys) collectJsonDeltas(baseRoot, candidateRoot, [...path, key], out);
		return;
	}

	if (before.present === after.present && canonicalEqual(before.value, after.value)) return;
	out.push({ path, before, after });
}

function parseJsonBody(request) {
	try {
		return JSON.parse(request?.body?.text ?? "");
	} catch {
		return undefined;
	}
}

function jsonDeltas(baseRequest, candidateRequest) {
	const baseRoot = parseJsonBody(baseRequest);
	const candidateRoot = parseJsonBody(candidateRequest);
	if (baseRoot === undefined || candidateRoot === undefined) {
		// Malformed JSON cannot be compared structurally; fail closed rather
		// than guess which bytes matter.
		return [
			makeDelta({
				id: "body.json",
				path: "request.body.json",
				kind: "body.json",
				replayable: false,
				reason: "json_body_not_parseable",
				displayBefore: null,
				displayAfter: null,
			}),
		];
	}

	const collected = [];
	collectJsonDeltas(baseRoot, candidateRoot, [], collected);
	return collected.map(({ path, before, after }) => {
		const key = String(path[path.length - 1] ?? "");
		const replayable =
			!isSensitiveName(key) &&
			!(before.present && subtreeHasSecret(before.value, key)) &&
			!(after.present && subtreeHasSecret(after.value, key));
		return makeDelta({
			id: `body.json:${JSON.stringify(path)}`,
			path: `request.body.$${path.length ? `.${path.join(".")}` : ""}`,
			kind: "body.json",
			replayable,
			reason: replayable ? null : "sensitive_value_not_reconstructable",
			op: replayable ? { type: "json", path } : null,
			before: replayable ? before : { present: before.present, value: redactJson(before.value, key) },
			after: replayable ? after : { present: after.present, value: redactJson(after.value, key) },
			displayBefore: before.present ? redactJson(before.value, key) : null,
			displayAfter: after.present ? redactJson(after.value, key) : null,
		});
	});
}

/* -------------------------------------------------------------------------- */
/* Body mode + scalar deltas                                                   */
/* -------------------------------------------------------------------------- */

function bodyDeltas(baseRequest, candidateRequest) {
	const baseBody = baseRequest?.body ?? { mode: "none" };
	const candidateBody = candidateRequest?.body ?? { mode: "none" };

	if (baseBody.mode !== candidateBody.mode) {
		return [
			makeDelta({
				id: "body.mode",
				path: "request.body.mode",
				kind: "body.mode",
				replayable: false,
				reason: "body_mode_not_reconstructable",
				displayBefore: { mode: baseBody.mode ?? "none" },
				displayAfter: { mode: candidateBody.mode ?? "none" },
			}),
		];
	}

	if (baseBody.mode === "json") return jsonDeltas(baseRequest, candidateRequest);

	if (baseBody.mode === "urlencoded")
		return rowDeltas({
			listPath: ["body", "rows"],
			kind: "body.urlencoded",
			pathPrefix: "request.body.urlencoded",
			baseRows: baseBody.rows ?? [],
			candidateRows: candidateBody.rows ?? [],
		});

	if (baseBody.mode === "text") {
		if ((baseBody.text ?? "") === (candidateBody.text ?? "")) return [];
		const replayable = !isSecretValue(baseBody.text) && !isSecretValue(candidateBody.text);
		return [
			makeDelta({
				id: "body.text",
				path: "request.body.text",
				kind: "body.text",
				replayable,
				reason: replayable ? null : "sensitive_value_not_reconstructable",
				op: replayable ? { type: "set", path: ["body", "text"] } : null,
				before: replayable ? baseBody.text : REDACTED,
				after: replayable ? candidateBody.text : REDACTED,
				displayBefore: replayable ? baseBody.text : REDACTED,
				displayAfter: replayable ? candidateBody.text : REDACTED,
			}),
		];
	}

	return [];
}

function scalarDelta({ id, path, kind, baseRequest, candidateRequest, field, read, display }) {
	const before = read(baseRequest);
	const after = read(candidateRequest);
	if (canonicalEqual(before, after)) return null;
	return makeDelta({
		id,
		path,
		kind,
		replayable: true,
		op: { type: "set", path: [...field] },
		before,
		after,
		displayBefore: display ? display(before) : before,
		displayAfter: display ? display(after) : after,
	});
}

function urlHasSensitiveQuery(url) {
	const matches = String(url ?? "").match(/[?&]([^=&#]+)=/g) ?? [];
	return matches.some((part) => {
		let name = part.slice(1, -1);
		try {
			name = decodeURIComponent(name);
		} catch {
			/* keep the raw name */
		}
		return isSensitiveName(name);
	});
}

/* -------------------------------------------------------------------------- */
/* Receipt-derived deltas                                                      */
/* -------------------------------------------------------------------------- */

function receiptDeltas(baseReceipt, candidateReceipt, { hasRequestDelta }) {
	if (!baseReceipt || !candidateReceipt) return [];
	const deltas = [];
	const baseSource = baseReceipt.source ?? {};
	const candidateSource = candidateReceipt.source ?? {};

	if (
		baseSource.environmentId !== candidateSource.environmentId ||
		baseSource.environmentRevision !== candidateSource.environmentRevision
	) {
		deltas.push(
			makeDelta({
				id: "environment",
				path: "context.environment",
				kind: "environment",
				replayable: false,
				reason: "environment_not_reconstructable",
				displayBefore: { environmentId: baseSource.environmentId ?? null, revision: baseSource.environmentRevision ?? null },
				displayAfter: { environmentId: candidateSource.environmentId ?? null, revision: candidateSource.environmentRevision ?? null },
			}),
		);
	}

	if (
		baseSource.collectionId !== candidateSource.collectionId ||
		baseSource.collectionRevision !== candidateSource.collectionRevision
	) {
		deltas.push(
			makeDelta({
				id: "collection",
				path: "context.collection",
				kind: "collection",
				replayable: false,
				reason: "collection_context_not_reconstructable",
				displayBefore: { collectionId: baseSource.collectionId ?? null, revision: baseSource.collectionRevision ?? null },
				displayAfter: { collectionId: candidateSource.collectionId ?? null, revision: candidateSource.collectionRevision ?? null },
			}),
		);
	}

	const baseCompiled = baseReceipt.request?.compiledFingerprint ?? null;
	const candidateCompiled = candidateReceipt.request?.compiledFingerprint ?? null;
	if (baseCompiled !== candidateCompiled && !hasRequestDelta) {
		deltas.push(
			makeDelta({
				id: "compiled",
				path: "request.compiledFingerprint",
				kind: "compiled",
				replayable: false,
				reason: "compiled_request_not_reconstructable",
				displayBefore: { fingerprint: baseCompiled },
				displayAfter: { fingerprint: candidateCompiled },
			}),
		);
	}

	return deltas;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compute the ordered list of material deltas between two request definitions.
 *
 * @param {{ baseRequest: object, candidateRequest: object, baseReceipt?: object|null, candidateReceipt?: object|null }} input
 * @returns {Array<object>} deterministic, secret-safe delta descriptors
 */
export function computeCounterfactualDeltas({ baseRequest, candidateRequest, baseReceipt = null, candidateReceipt = null } = {}) {
	if (!isPlainObject(baseRequest) || !isPlainObject(candidateRequest))
		throw new AppError(400, "COUNTERFACTUAL_INPUT", "Both base and candidate request definitions are required.");

	const deltas = [];

	const method = scalarDelta({
		id: "method",
		path: "request.method",
		kind: "method",
		baseRequest,
		candidateRequest,
		field: ["method"],
		read: (request) => String(request.method ?? "").toUpperCase(),
	});
	if (method) deltas.push(method);

	const url = scalarDelta({
		id: "url",
		path: "request.url",
		kind: "url",
		baseRequest,
		candidateRequest,
		field: ["urlTemplate"],
		read: (request) => request.urlTemplate ?? "",
	});
	if (url) {
		const replayable = !isSecretValue(url.before) && !isSecretValue(url.after) && !urlHasSensitiveQuery(url.before) && !urlHasSensitiveQuery(url.after);
		if (!replayable) {
			url.replayable = false;
			url.reason = "sensitive_value_not_reconstructable";
			url.op = null;
			url.before = REDACTED;
			url.after = REDACTED;
			url.displayBefore = REDACTED;
			url.displayAfter = REDACTED;
		}
		deltas.push(url);
	}

	deltas.push(
		...rowDeltas({
			listPath: ["query"],
			kind: "query",
			pathPrefix: "request.query",
			baseRows: baseRequest.query ?? [],
			candidateRows: candidateRequest.query ?? [],
		}),
	);
	deltas.push(
		...rowDeltas({
			listPath: ["headers"],
			kind: "header",
			pathPrefix: "request.headers",
			baseRows: baseRequest.headers ?? [],
			candidateRows: candidateRequest.headers ?? [],
		}),
	);

	deltas.push(...bodyDeltas(baseRequest, candidateRequest));

	const timeout = scalarDelta({
		id: "settings.timeoutMs",
		path: "request.settings.timeoutMs",
		kind: "settings",
		baseRequest,
		candidateRequest,
		field: ["settings", "timeoutMs"],
		read: (request) => request.settings?.timeoutMs ?? null,
	});
	if (timeout) deltas.push(timeout);

	if (!canonicalEqual(baseRequest.auth, candidateRequest.auth)) {
		deltas.push(
			makeDelta({
				id: "auth",
				path: "request.auth",
				kind: "auth",
				replayable: false,
				reason: "authentication_not_reconstructable",
				displayBefore: { mode: baseRequest.auth?.mode ?? "none" },
				displayAfter: { mode: candidateRequest.auth?.mode ?? "none" },
			}),
		);
	}

	if (!canonicalEqual(baseRequest.scripts, candidateRequest.scripts)) {
		deltas.push(
			makeDelta({
				id: "scripts",
				path: "request.scripts",
				kind: "scripts",
				replayable: false,
				reason: "scripts_not_reconstructable",
				displayBefore: { preRequestBytes: String(baseRequest.scripts?.preRequest ?? "").length, testBytes: String(baseRequest.scripts?.test ?? "").length },
				displayAfter: { preRequestBytes: String(candidateRequest.scripts?.preRequest ?? "").length, testBytes: String(candidateRequest.scripts?.test ?? "").length },
			}),
		);
	}

	if (!canonicalEqual(baseRequest.assertions, candidateRequest.assertions)) {
		deltas.push(
			makeDelta({
				id: "assertions",
				path: "request.assertions",
				kind: "assertions",
				replayable: false,
				reason: "assertions_not_reconstructable",
				displayBefore: { count: Array.isArray(baseRequest.assertions) ? baseRequest.assertions.length : 0 },
				displayAfter: { count: Array.isArray(candidateRequest.assertions) ? candidateRequest.assertions.length : 0 },
			}),
		);
	}

	const hasRequestDelta = deltas.length > 0;
	deltas.push(...receiptDeltas(baseReceipt, candidateReceipt, { hasRequestDelta }));

	return deltas;
}

/* -------------------------------------------------------------------------- */
/* Applying a delta to a request                                               */
/* -------------------------------------------------------------------------- */

function containerAt(root, path) {
	let current = root;
	for (let index = 0; index < path.length - 1; index += 1) {
		const segment = path[index];
		if (current[segment] === null || typeof current[segment] !== "object") current[segment] = {};
		current = current[segment];
	}
	return { container: current, key: path[path.length - 1] };
}

function setAtPath(root, path, value) {
	if (path.length === 0) return value;
	const { container, key } = containerAt(root, path);
	if (value === undefined) delete container[key];
	else container[key] = value;
	return root;
}

function setJsonAtPath(root, path, presence) {
	if (path.length === 0) return presence.present ? presence.value : null;
	const { container, key } = containerAt(root, path);
	if (presence.present) container[key] = structuredClone(presence.value);
	else delete container[key];
	return root;
}

/**
 * Produce a copy of `request` with exactly one delta factor set to the given
 * side. `side` is `"after"` when applying the candidate value onto the base
 * request and `"before"` when reverting the candidate back to the base value.
 */
export function applyCounterfactualDelta(request, delta, side) {
	const next = structuredClone(request);
	const value = delta?.[side];
	const op = delta?.op;
	if (!op) return next;

	if (op.type === "row") {
		const { container, key } = containerAt(next, op.path);
		const rows = Array.isArray(container[key]) ? container[key] : [];
		const index = rows.findIndex((row) => row?.id === op.rowId);
		if (value === null) {
			if (index >= 0) rows.splice(index, 1);
		} else if (index >= 0) {
			rows[index] = structuredClone(value);
		} else {
			const at = Math.min(Math.max(op.index ?? rows.length, 0), rows.length);
			rows.splice(at, 0, structuredClone(value));
		}
		container[key] = rows;
		return next;
	}

	if (op.type === "json") {
		const root = JSON.parse(next.body.text);
		const updated = setJsonAtPath(root, op.path, value);
		next.body = { ...next.body, text: JSON.stringify(updated) };
		return next;
	}

	if (op.type === "set") {
		setAtPath(next, op.path, value);
		return next;
	}

	return next;
}
