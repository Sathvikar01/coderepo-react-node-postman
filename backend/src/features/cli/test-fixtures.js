// Phase 14 test support. Not production code: it only builds portable projects
// and temp directories so the CLI tests can exercise real project loading,
// selection, planning, and execution without hand-writing git-native trees.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectToFiles, writeProjectDir } from "../git-native/index.js";

const tempDirs = [];

export function makeTempDir(prefix = "tracer-cli-") {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

export function cleanupTempDirs() {
	while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
}

export function variable(key, value, overrides = {}) {
	return { id: randomUUID(), key, kind: "plain", value, enabled: true, ...overrides };
}

export function secretVariable(key, alias) {
	return { id: randomUUID(), key, kind: "secretRef", alias, enabled: true };
}

export function row(key, value, overrides = {}) {
	return { id: randomUUID(), key, value, enabled: true, ...overrides };
}

export function folder(name, overrides = {}) {
	return { id: randomUUID(), name, ...overrides };
}

export function request(overrides = {}) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name: "Request",
		method: "GET",
		urlTemplate: "{{base}}/probe",
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "inherit" },
		scripts: { preRequest: "", test: "" },
		settings: { timeoutMs: 5000 },
		...overrides,
	};
}

export function assertion(overrides = {}) {
	return {
		id: randomUUID(),
		name: "Status is 200",
		enabled: true,
		target: "status",
		operator: "equals",
		path: "",
		expected: "200",
		valueType: "number",
		...overrides,
	};
}

export function collection(overrides = {}) {
	return {
		name: "Alpha",
		description: "",
		variables: [variable("base", "http://127.0.0.1:4399")],
		auth: { mode: "none" },
		folders: [],
		requests: [],
		...overrides,
	};
}

export function environment(overrides = {}) {
	return { name: "Local", variables: [], ...overrides };
}

export function project(overrides = {}) {
	return {
		schemaVersion: 1,
		kind: "tracer.project",
		name: "CLI fixtures",
		description: "",
		collections: [collection()],
		environments: [],
		examples: [],
		...overrides,
	};
}

export function writeProject(projectValue, dir = makeTempDir()) {
	// writeProjectDir takes the Map produced by projectToFiles, and it also
	// validates the project, so an invalid fixture fails loudly here.
	writeProjectDir(dir, projectToFiles(projectValue));
	return dir;
}
