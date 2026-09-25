import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";
import { canonicalize } from "./canonical.js";

// Phase 24B — deterministic bounded diff over canonicalized snapshots.
//
// Changes are structured paths, never prose:
//   requests[id=<uuid>].method            (changed)
//   requests[id=<uuid>].urlTemplate       (changed)
//   variables[key=base_url]               (added | removed | changed)
//   folders[id=<uuid>].name               (changed)
// Scalar resource fields use bare paths: `name`, `description`, `auth.mode`.
// Canonical ordering is deterministic: requests/folders by id, variables by key,
// then scalar fields alphabetically. Output is bounded; overflow returns a typed
// truncated result instead of silently dropping changes.

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clipValue(value) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text === undefined) return null;
	return utf8Bytes(text) > LIMITS.versionDiffValueBytes ? `${text.slice(0, LIMITS.versionDiffValueBytes)}…` : text;
}

function clipPath(path) {
	return utf8Bytes(path) > LIMITS.versionDiffPathBytes ? `${path.slice(0, LIMITS.versionDiffPathBytes)}…` : path;
}

function indexById(items) {
	const map = new Map();
	for (const item of items ?? []) {
		if (item && typeof item.id === "string") map.set(item.id, item);
	}
	return map;
}

function indexVariables(variables) {
	const map = new Map();
	for (const variable of variables ?? []) {
		if (variable && typeof variable.key === "string") map.set(variable.key, variable);
	}
	return map;
}

// A variable's identity is its key; the value/kind/alias/enabled tuple is content.
function variableContent(variable) {
	return { kind: variable.kind ?? null, value: variable.value ?? null, alias: variable.alias ?? null, enabled: variable.enabled ?? true };
}

function scalarEqual(left, right) {
	return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function diffSnapshots(before, after) {
	const changes = [];
	let truncated = false;
	const push = (entry) => {
		if (changes.length >= LIMITS.versionDiffMaxChanges) {
			truncated = true;
			return false;
		}
		changes.push({ path: clipPath(entry.path), change: entry.change, before: clipValue(entry.before), after: clipValue(entry.after) });
		return true;
	};

	const left = before ?? {};
	const right = after ?? {};

	// Scalar top-level fields first, alphabetical and deterministic.
	for (const field of ["auth", "description", "name"]) {
		if (!scalarEqual(left[field] ?? null, right[field] ?? null)) {
			if (field === "auth" && isPlainObject(left[field]) && isPlainObject(right[field])) {
				for (const key of [...new Set([...Object.keys(left[field]), ...Object.keys(right[field])])].sort()) {
					if (!scalarEqual(left[field][key] ?? null, right[field][key] ?? null)) {
						if (!push({ path: `auth.${key}`, change: "changed", before: left[field][key] ?? null, after: right[field][key] ?? null }))
							break;
					}
				}
			} else if (!push({ path: field, change: left[field] === undefined ? "added" : right[field] === undefined ? "removed" : "changed", before: left[field] ?? null, after: right[field] ?? null })) {
				// bound reached
			}
		}
		if (truncated) break;
	}

	if (!truncated && (left.variables !== undefined || right.variables !== undefined)) {
		const beforeVars = indexVariables(left.variables);
		const afterVars = indexVariables(right.variables);
		for (const key of [...new Set([...beforeVars.keys(), ...afterVars.keys()])].sort()) {
			const was = beforeVars.get(key);
			const is = afterVars.get(key);
			if (was && !is) {
				if (!push({ path: `variables[key=${key}]`, change: "removed", before: variableContent(was), after: null })) break;
			} else if (!was && is) {
				if (!push({ path: `variables[key=${key}]`, change: "added", before: null, after: variableContent(is) })) break;
			} else if (!scalarEqual(variableContent(was), variableContent(is))) {
				if (!push({ path: `variables[key=${key}]`, change: "changed", before: variableContent(was), after: variableContent(is) })) break;
			}
		}
	}

	const diffIdList = (label, beforeItems, afterItems, fields) => {
		const beforeMap = indexById(beforeItems);
		const afterMap = indexById(afterItems);
		for (const id of [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()) {
			const was = beforeMap.get(id);
			const is = afterMap.get(id);
			if (was && !is) {
				if (!push({ path: `${label}[id=${id}]`, change: "removed", before: was.name ?? null, after: null })) return;
			} else if (!was && is) {
				if (!push({ path: `${label}[id=${id}]`, change: "added", before: null, after: is.name ?? null })) return;
			} else {
				for (const field of fields) {
					if (!scalarEqual(was[field] ?? null, is[field] ?? null)) {
						if (!push({ path: `${label}[id=${id}].${field}`, change: "changed", before: was[field] ?? null, after: is[field] ?? null }))
							return;
					}
				}
			}
		}
	};

	if (!truncated && (left.folders !== undefined || right.folders !== undefined)) {
		diffIdList("folders", left.folders, right.folders, ["name"]);
	}
	if (!truncated && (left.requests !== undefined || right.requests !== undefined)) {
		diffIdList("requests", left.requests, right.requests, [
			"folderId",
			"method",
			"name",
			"urlTemplate",
			"query",
			"headers",
			"body",
			"auth",
			"scripts",
			"assertions",
			"settings",
		]);
	}

	return { changes, truncated };
}
