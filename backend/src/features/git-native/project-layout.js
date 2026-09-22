// Deterministic git-native file layout for TracerProjectV1.
//
// A portable project is laid out as a small tree so that Git shows meaningful,
// line-based diffs and cleanly auto-merges concurrent edits to different
// entities. One request per file is the crux: two people editing two requests
// of the same collection touch two different files and never collide, and a
// one-line request edit produces a one-line diff.
//
//   tracer-project/
//     project.json                            manifest + metadata + fingerprint
//     collections/<collection-slug>/
//       collection.json                       name, description, auth, variables, folders + ordered request refs
//       requests/<request-slug>--<id8>.json   one request (stable id inside)
//     environments/<environment-slug>.json
//     examples/<example-slug>.json
//
// Filenames embed a stable id suffix for requests (which own UUIDs), so a
// rename or folder move changes only the human slug / a single field while the
// identity -- and the file it lives in -- is preserved. Collections,
// environments, and examples are name-keyed (their portable schema has no id);
// name collisions are disambiguated deterministically by project order.
//
// Ordering is carried explicitly (manifest lists + each collection's ordered
// request refs) so array order survives the round trip and shows up as a small,
// readable reorder diff rather than a silent shuffle.
//
// This module is pure: it maps a validated portable project <-> a Map of
// relative file paths to text. It never touches disk and never runs Git.

import {
	LAYOUT_VERSION,
	assertSafeRelPath,
	assertSafeSegment,
	fileStem,
	missing,
	parseFileJson,
	slugSegment,
	stableStringify,
	untracked,
	unsupportedVersion,
} from "./project-text.js";
import { TRACER_PROJECT_KIND, TRACER_PROJECT_VERSION, tracerProjectSchema } from "../projects/project-schema.js";
import { projectFingerprint, projectInvalid } from "../projects/project-serialize.js";

const MANIFEST = "project.json";

function uniqueSlug(used, name, label, fallback) {
	let base;
	try {
		base = slugSegment(name, label);
	} catch {
		base = fallback;
	}
	let slug = base;
	let n = 2;
	while (used.has(slug)) slug = `${base}--${n++}`;
	used.add(slug);
	return slug;
}

// ---------------------------------------------------------------------------
// project -> files
// ---------------------------------------------------------------------------

export function projectToFiles(project) {
	const result = tracerProjectSchema.safeParse(project);
	if (!result.success) throw projectInvalid(result.error);
	const value = result.data;
	const files = new Map();

	const collectionDirs = [];
	const usedCollectionDirs = new Set();
	for (const collection of value.collections) {
		const dir = uniqueSlug(usedCollectionDirs, collection.name, "collection name", "collection");
		collectionDirs.push(dir);
		const requestRefs = [];
		for (const request of collection.requests) {
			const stem = fileStem(request.name, request.id);
			const fileName = `${stem}.json`;
			assertSafeSegment(fileName, "request file name");
			requestRefs.push(`requests/${fileName}`);
			files.set(`collections/${dir}/requests/${fileName}`, stableStringify(request));
		}
		files.set(
			`collections/${dir}/collection.json`,
			stableStringify({
				name: collection.name,
				description: collection.description,
				auth: collection.auth,
				variables: collection.variables,
				folders: collection.folders,
				requests: requestRefs,
			}),
		);
	}

	const environmentFiles = [];
	const usedEnvironments = new Set();
	for (const environment of value.environments) {
		const slug = uniqueSlug(usedEnvironments, environment.name, "environment name", "environment");
		const fileName = `${slug}.json`;
		assertSafeSegment(fileName, "environment file name");
		environmentFiles.push(fileName);
		files.set(`environments/${fileName}`, stableStringify({ name: environment.name, variables: environment.variables }));
	}

	const exampleFiles = [];
	const usedExamples = new Set();
	for (const example of value.examples) {
		const slug = uniqueSlug(usedExamples, example.name, "example name", "example");
		const fileName = `${slug}.json`;
		assertSafeSegment(fileName, "example file name");
		exampleFiles.push(fileName);
		files.set(`examples/${fileName}`, stableStringify(example));
	}

	const manifest = {
		kind: TRACER_PROJECT_KIND,
		layoutVersion: LAYOUT_VERSION,
		schemaVersion: TRACER_PROJECT_VERSION,
		description: value.description,
		fingerprint: projectFingerprint(value),
		collections: collectionDirs,
		environments: environmentFiles,
		examples: exampleFiles,
	};
	if (value.name !== undefined) manifest.name = value.name;
	files.set(MANIFEST, stableStringify(manifest));

	return files;
}

// ---------------------------------------------------------------------------
// files -> project
// ---------------------------------------------------------------------------

function readText(files, rel, label) {
	assertSafeRelPath(rel, label);
	if (!files.has(rel)) throw missing(rel);
	return files.get(rel);
}

function segmentList(raw, key, label) {
	const list = raw[key];
	if (list === undefined) return [];
	if (!Array.isArray(list)) throw malformedList(key, `The ${label} list must be an array of file names.`);
	for (const entry of list) assertSafeSegment(entry, label);
	return list;
}

function malformedList(key, message) {
	return projectInvalid({ issues: [{ path: [key], code: "custom", message }] });
}

function malformedKind() {
	return malformedList("kind", `The manifest kind must be "${TRACER_PROJECT_KIND}".`);
}

function malformedRef(dir) {
	return malformedList("requests", `A request reference in "${dir}" must point inside its requests folder.`);
}

export function filesToProject(files) {
	const map = files instanceof Map ? files : new Map(Object.entries(files ?? {}));
	// Reject unsafe keys before doing anything: a traversal or absolute path must
	// fail closed, never be read or matched against the manifest.
	for (const rel of map.keys()) assertSafeRelPath(rel, "project file name");

	const manifestRaw = parseFileJson(readText(map, MANIFEST, "manifest"), MANIFEST);
	if (manifestRaw.kind !== TRACER_PROJECT_KIND) throw malformedKind();
	if (manifestRaw.schemaVersion !== TRACER_PROJECT_VERSION)
		throw unsupportedVersion(MANIFEST, manifestRaw.schemaVersion, TRACER_PROJECT_VERSION);
	if (manifestRaw.layoutVersion !== LAYOUT_VERSION) throw unsupportedVersion(MANIFEST, manifestRaw.layoutVersion, LAYOUT_VERSION);

	const referenced = new Set([MANIFEST]);
	const collectionDirs = segmentList(manifestRaw, "collections", "collection folder name");
	const environmentFiles = segmentList(manifestRaw, "environments", "environment file name");
	const exampleFiles = segmentList(manifestRaw, "examples", "example file name");

	const collections = collectionDirs.map((dir) => {
		const collPath = `collections/${dir}/collection.json`;
		referenced.add(collPath);
		const raw = parseFileJson(readText(map, collPath, "collection file"), collPath);
		const refs = raw.requests === undefined ? [] : raw.requests;
		if (!Array.isArray(refs)) throw malformedList("requests", `The request reference list in "${dir}" must be an array.`);
		const requests = refs.map((ref) => {
			const reqPath = assertSafeRelPath(`collections/${dir}/${String(ref)}`, "request reference");
			if (!reqPath.startsWith(`collections/${dir}/requests/`)) throw malformedRef(dir);
			referenced.add(reqPath);
			const req = parseFileJson(readText(map, reqPath, "request file"), reqPath);
			if (req.schemaVersion !== TRACER_PROJECT_VERSION) throw unsupportedVersion(reqPath, req.schemaVersion, TRACER_PROJECT_VERSION);
			return req;
		});
		return {
			name: raw.name,
			description: raw.description,
			auth: raw.auth,
			variables: raw.variables,
			folders: raw.folders,
			requests,
		};
	});

	const environments = environmentFiles.map((fileName) => {
		const envPath = `environments/${fileName}`;
		referenced.add(envPath);
		return parseFileJson(readText(map, envPath, "environment file"), envPath);
	});

	const examples = exampleFiles.map((fileName) => {
		const exPath = `examples/${fileName}`;
		referenced.add(exPath);
		return parseFileJson(readText(map, exPath, "example file"), exPath);
	});

	// Fail closed on unknown project-shaped files: a stray *.json that the
	// manifest does not reference is either corrupt or hostile and is never
	// silently imported. Non-JSON tooling files (README, .gitignore) are ignored.
	for (const rel of map.keys()) {
		if (referenced.has(rel)) continue;
		if (rel.toLowerCase().endsWith(".json")) throw untracked(rel);
	}

	const project = {
		schemaVersion: TRACER_PROJECT_VERSION,
		kind: TRACER_PROJECT_KIND,
		description: manifestRaw.description ?? "",
		collections,
		environments,
		examples,
	};
	if (typeof manifestRaw.name === "string" && manifestRaw.name.trim()) project.name = manifestRaw.name;

	const result = tracerProjectSchema.safeParse(project);
	if (!result.success) throw projectInvalid(result.error);
	return result.data;
}

export { MANIFEST };
