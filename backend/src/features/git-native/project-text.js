// Text, naming, and safety primitives for the git-native project file layout.
//
// Everything here is pure and deterministic. Same logical value -> same text,
// same name -> same path segment. Nothing in this module shells out, touches
// the filesystem, or interprets project content as code, so untrusted project
// data can never steer a command or escape its project boundary.
//
// Serialization is pretty-printed JSON with lexicographic key order at every
// level and preserved array order (rows, requests, folders, variables keep
// their user-visible order). Pretty + stable is what makes `git diff` output
// line-based and human-readable instead of one changed blob per file.
//
// Path safety fails closed. Every path that reaches the layout is validated to
// be a bounded, relative, forward-slashed path of safe segments: no traversal,
// no absolute/drive roots, no backslashes, no NUL, no dot segments.

import { createHash } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.js";

export const LAYOUT_VERSION = 1;

// Git merge conflict markers. `<<<<<<<` / `>>>>>>>` at the start of a physical
// line are unambiguous: pretty JSON keeps every string value on a single line
// (newlines are escaped), so a line-leading run of `<` or `>` can only be a
// conflict marker and never legitimate serialized content.
const CONFLICT_MARKER = /(?:^|\n)(?:<{7}|>{7})/;

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SEGMENT = 100;
const MAX_PATH = 512;

export function hasConflictMarkers(text) {
	return CONFLICT_MARKER.test(String(text ?? ""));
}

export function sha256Hex(text) {
	return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

// Pretty, key-sorted JSON. Array order is preserved; object keys are sorted
// lexicographically at every depth. `undefined` values are dropped.
function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			if (value[key] === undefined) continue;
			out[key] = canonicalize(value[key]);
		}
		return out;
	}
	return value;
}

export function stableStringify(value) {
	return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

// A single safe path segment: letters, digits, dot, underscore, hyphen; cannot
// be a dot segment; cannot start with a separator-adjacent character.
export function assertSafeSegment(segment, label = "path") {
	const value = String(segment ?? "");
	if (!value || value.length > MAX_SEGMENT) throw unsafePath(label, value);
	if (value === "." || value === "..") throw unsafePath(label, value);
	if (!SAFE_SEGMENT.test(value)) throw unsafePath(label, value);
	return value;
}

// A bounded, relative, forward-slashed project path. Rejects traversal,
// absolute and drive-rooted paths, backslashes, NUL, empty/dot segments.
export function assertSafeRelPath(rel, label = "path") {
	const value = String(rel ?? "");
	if (!value || value.length > MAX_PATH) throw unsafePath(label, value);
	if (value.includes("\0") || value.includes("\\")) throw unsafePath(label, value);
	if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) throw unsafePath(label, value);
	for (const segment of value.split("/")) assertSafeSegment(segment, label);
	return value;
}

function unsafePath(label, value) {
	// Never echo the raw path back: it may contain hostile content. Report the
	// reason and the offending shape only.
	return new AppError(400, "PROJECT_UNSAFE_PATH", `A ${label} must be a bounded relative path of safe segments.`, {
		reason: /[/\\]/.test(String(value)) ? "separator-or-traversal" : "unsafe-segment",
	});
}

function unsafeName(label) {
	return new AppError(400, "PROJECT_UNSAFE_PATH", `A ${label} cannot be turned into a safe file name.`);
}

// Deterministic, filesystem-safe slug from a display name. Strips everything
// outside [a-z0-9] so a hostile name such as "../../etc/passwd" collapses to a
// harmless segment ("etc-passwd") that can never traverse out of the boundary.
export function slugSegment(name, label = "name") {
	const slug = String(name ?? "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	if (!slug) throw unsafeName(label);
	return slug;
}

// Optional slug that tolerates blank/unknown names by falling back.
export function slugSegmentOr(fallback, name) {
	try {
		return slugSegment(name);
	} catch {
		return fallback;
	}
}

// Short, stable identity suffix taken from a request/folder UUID. Survives
// renames and moves: the id never changes, so the suffix never changes.
export function idSuffix(id) {
	const hex = String(id ?? "").replace(/-/g, "").toLowerCase();
	if (!/^[a-f0-9]{8,}$/.test(hex)) throw unsafeName("identifier");
	return hex.slice(0, 8);
}

export function fileStem(name, id) {
	return `${slugSegment(name)}--${idSuffix(id)}`;
}

// Parse one project file's text -> JSON object. Fails closed on merge conflict
// markers, invalid JSON, and non-object roots. Never evaluates content.
export function parseFileJson(text, label) {
	if (typeof text !== "string") throw malformed(label, "not text");
	if (hasConflictMarkers(text)) throw conflict(label);
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw malformed(label, "invalid JSON");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw malformed(label, "not a JSON object");
	return value;
}

export function malformed(label, reason) {
	return new AppError(400, "PROJECT_MALFORMED", `The project file "${label}" is malformed.`, { reason });
}

export function conflict(label) {
	return new AppError(409, "PROJECT_CONFLICT", `The project file "${label}" contains unresolved merge conflict markers.`, {
		file: label,
	});
}

export function missing(label) {
	return new AppError(400, "PROJECT_MISSING_FILE", `The project file "${label}" is referenced but missing.`, { file: label });
}

export function untracked(label) {
	return new AppError(400, "PROJECT_UNTRACKED_FILE", `The project file "${label}" is present but not referenced by the manifest.`, {
		file: label,
	});
}

export function unsupportedVersion(label, received, supported) {
	return new AppError(422, "PROJECT_VERSION_UNSUPPORTED", `The project file "${label}" uses an unsupported schemaVersion.`, {
		file: label,
		supported,
		received: typeof received === "number" ? received : null,
	});
}
