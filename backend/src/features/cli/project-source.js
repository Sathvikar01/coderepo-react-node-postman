// Project loading and run-target resolution for the CLI.
//
// A CLI project is exactly the git-native / portable project a workspace exports:
// either a directory of git-native files or a single TracerProjectV1 JSON file.
// Nothing here is CLI-specific storage, and nothing is written back to disk, so
// the CLI never creates a second project format.
//
// Target resolution turns user-friendly selectors (collection names, folder
// names, request names) into the ids the collection runner expects. Ids for
// collections and environments are derived deterministically from the project,
// so a given project always produces the same run wiring.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { nameKey } from "../../shared/utils/names.js";
import { readProjectDir } from "../git-native/project-fs.js";
import { filesToProject } from "../git-native/project-layout.js";
import { projectToDomain } from "../projects/project-import.js";
import { parseProject, projectFingerprint } from "../projects/project-serialize.js";
import { CliError } from "./cli-errors.js";

export const CLI_PROFILE_ID = "tracer-cli";

// 24 hex characters, matching the ObjectId shape the rest of the domain uses,
// derived from stable project content so the same project always wires up the
// same ids across invocations and across the CLI and any host that imports it.
function deterministicId(kind, name, index) {
	return createHash("sha256").update(`${kind}:${index}:${nameKey(String(name ?? ""))}`).digest("hex").slice(0, 24);
}

function selectionError(message, code = "CLI_SELECTION_UNKNOWN", details = null) {
	return new CliError(message, { code, details });
}

function isNumeric(value) {
	return /^\d+$/.test(value);
}

export function resolveByNameOrIndex(items, raw, label) {
	const value = String(raw).trim();
	if (isNumeric(value)) {
		const index = Number(value) - 1;
		if (index < 0 || index >= items.length)
			throw selectionError(`There is no ${label} at position ${value}.`, "CLI_SELECTION_UNKNOWN", {
				available: items.map((item) => item.name),
			});
		return items[index];
	}
	const key = nameKey(value);
	const matches = items.filter((item) => nameKey(item.name) === key);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0)
		throw selectionError(`No ${label} named "${value}".`, "CLI_SELECTION_UNKNOWN", { available: items.map((item) => item.name) });
	throw selectionError(`More than one ${label} matches "${value}".`, "CLI_SELECTION_AMBIGUOUS", { matches: matches.map((item) => item.name) });
}

export function resolveRequest(collection, raw) {
	const value = String(raw).trim();
	const byId = (collection.requests ?? []).find((request) => request.id === value);
	if (byId) return byId;
	const key = nameKey(value);
	const matches = (collection.requests ?? []).filter((request) => nameKey(request.name) === key);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0)
		throw selectionError(`No request named or identified by "${value}" in this collection.`, "CLI_SELECTION_UNKNOWN", {
			available: (collection.requests ?? []).map((request) => request.name),
		});
	throw selectionError(`More than one request matches "${value}". Use the request id instead.`, "CLI_SELECTION_AMBIGUOUS", {
		matches: matches.map((request) => request.name),
	});
}

export function loadProjectSource(projectPath, { cwd = process.cwd() } = {}) {
	if (!projectPath) throw new CliError("A project path is required.", { code: "CLI_NO_PROJECT" });
	const absolute = path.resolve(cwd, String(projectPath));
	let stats;
	try {
		stats = statSync(absolute);
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
			throw new CliError(`Project not found: ${absolute}`, { code: "CLI_PROJECT_NOT_FOUND" });
		throw error;
	}

	let kind;
	let project;
	if (stats.isDirectory()) {
		kind = "directory";
		project = filesToProject(readProjectDir(absolute));
	} else if (stats.isFile()) {
		kind = "portable";
		project = parseProject(readFileSync(absolute, "utf8"));
	} else {
		throw new CliError(`The project path is neither a file nor a directory: ${absolute}`, {
			code: "CLI_PROJECT_NOT_FOUND",
		});
	}

	const domain = projectToDomain(project);
	return {
		path: absolute,
		kind,
		project,
		fingerprint: projectFingerprint(project),
		name: project.name ?? path.basename(absolute),
		domain,
	};
}

// Build profile-scoped in-memory documents from the validated domain. The
// runner and execution service expect documents shaped like their Mongo
// counterparts (an _id, an ownerProfileId, and a revision), so we provide them.
export function buildDomainDocuments({ domain, profileId = CLI_PROFILE_ID }) {
	const collections = domain.collections.map((collection, index) => ({
		...collection,
		_id: deterministicId("collection", collection.name, index),
		ownerProfileId: profileId,
		revision: 1,
	}));
	const environments = domain.environments.map((environment, index) => ({
		...environment,
		_id: deterministicId("environment", environment.name, index),
		ownerProfileId: profileId,
		revision: 1,
	}));
	return { collections, environments };
}

export function resolveRunTargets(source, options) {
	const collections = source.domain.collections;
	if (collections.length === 0) throw new CliError("The project does not contain any collections.", { code: "CLI_PROJECT_EMPTY" });

	const collection = options.collection ? resolveByNameOrIndex(collections, options.collection, "collection") : collections[0];
	let environment = null;
	if (options.environment) environment = resolveByNameOrIndex(source.domain.environments, options.environment, "environment");

	let selection = { mode: "collection" };
	let selectionLabel = `collection "${collection.name}"`;
	if (options.requests.length > 0) {
		const requests = options.requests.map((token) => resolveRequest(collection, token));
		selection = { mode: "requests", requestIds: requests.map((request) => request.id) };
		selectionLabel = `requests ${requests.map((request) => `"${request.name}"`).join(", ")}`;
	} else if (options.folder) {
		const folder = resolveFolder(collection, options.folder);
		selection = { mode: "folder", folderId: folder.id };
		selectionLabel = `folder "${folder.name}"`;
	}

	return { collection, environment, selection, selectionLabel };
}

function resolveFolder(collection, raw) {
	const value = String(raw).trim();
	const folders = collection.folders ?? [];
	const byId = folders.find((folder) => folder.id === value);
	if (byId) return byId;
	const key = nameKey(value);
	const matches = folders.filter((folder) => nameKey(folder.name) === key);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0)
		throw selectionError(`No folder named or identified by "${value}" in this collection.`, "CLI_SELECTION_UNKNOWN", {
			available: folders.map((folder) => folder.name),
		});
	throw selectionError(`More than one folder matches "${value}".`, "CLI_SELECTION_AMBIGUOUS", {
		matches: matches.map((folder) => folder.name),
	});
}
