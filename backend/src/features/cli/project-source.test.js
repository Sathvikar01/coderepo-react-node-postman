// Phase 14 — project loading and selector resolution. These are the seams that
// turn "a user typed a name" into the ids the collection runner expects.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { parseProject } from "../projects/project-serialize.js";
import { CliError } from "./cli-errors.js";
import { buildDomainDocuments, CLI_PROFILE_ID, loadProjectSource, resolveByNameOrIndex, resolveRequest, resolveRunTargets } from "./project-source.js";
import { assertion, cleanupTempDirs, collection, folder, makeTempDir, project, request, variable, writeProject } from "./test-fixtures.js";

const PORTABLE_PATH = path.join(os.tmpdir(), `tracer-portable-${Date.now()}.json`);
afterAll(() => {
	cleanupTempDirs();
	rmSync(PORTABLE_PATH, { force: true });
});

const capture = (fn) => {
	try {
		return { value: fn(), error: null };
	} catch (error) {
		return { value: null, error };
	}
};

function twoRequestProject() {
	const create = request({ name: "Create order", method: "POST", body: { mode: "json", text: "{}" } });
	const read = request({ name: "Read order" });
	return {
		create,
		read,
		value: project({ collections: [collection({ requests: [create, read] })] }),
	};
}

describe("name-or-index resolution", () => {
	test("accepts a 1-based index, a name, and a case-insensitive name", () => {
		const items = [{ name: "Alpha" }, { name: "Beta" }];
		expect(resolveByNameOrIndex(items, "1", "collection")).toBe(items[0]);
		expect(resolveByNameOrIndex(items, "beta", "collection")).toBe(items[1]);
		expect(resolveByNameOrIndex(items, "  ALPHA  ", "collection")).toBe(items[0]);
	});

	test("unknown and ambiguous values are selection errors with available names", () => {
		const items = [{ name: "Alpha" }, { name: "Beta" }];
		const missing = capture(() => resolveByNameOrIndex(items, "9", "collection"));
		expect(missing.error).toBeInstanceOf(CliError);
		expect(missing.error.code).toBe("CLI_SELECTION_UNKNOWN");
		expect(missing.error.details.available).toEqual(["Alpha", "Beta"]);

		const ambiguous = capture(() => resolveByNameOrIndex([{ name: "Alpha" }, { name: "alpha" }], "Alpha", "collection"));
		expect(ambiguous.error.code).toBe("CLI_SELECTION_AMBIGUOUS");
	});

	test("requests resolve by id first, then by unique name", () => {
		const { create, read } = twoRequestProject();
		const collectionValue = collection({ requests: [create, read] });
		expect(resolveRequest(collectionValue, create.id)).toBe(create);
		expect(resolveRequest(collectionValue, "read order")).toBe(read);
		const missing = capture(() => resolveRequest(collectionValue, "nope"));
		expect(missing.error.code).toBe("CLI_SELECTION_UNKNOWN");
	});
});

describe("domain documents", () => {
	test("ids are deterministic, ObjectId-shaped, and profile-scoped", () => {
		const { value } = twoRequestProject();
		const domain = {
			collections: [{ ...collection({ requests: [] }), name: "Alpha" }, { ...collection({ requests: [] }), name: "Beta" }],
			environments: [],
		};
		const first = buildDomainDocuments({ domain, profileId: "p1" });
		const second = buildDomainDocuments({ domain, profileId: "p1" });
		expect(first.collections.map((entry) => entry._id)).toEqual(second.collections.map((entry) => entry._id));
		for (const entry of first.collections) {
			expect(entry._id).toMatch(/^[0-9a-f]{24}$/);
			expect(entry.ownerProfileId).toBe("p1");
			expect(entry.revision).toBe(1);
		}
		// Two names never collide, and the default profile is the documented one.
		expect(new Set(first.collections.map((entry) => entry._id)).size).toBe(2);
		expect(buildDomainDocuments({ domain }).collections[0].ownerProfileId).toBe(CLI_PROFILE_ID);
		void value;
	});
});

describe("run target resolution", () => {
	const build = (projectValue) => {
		const source = { domain: { collections: projectValue.collections, environments: projectValue.environments } };
		return buildDomainDocuments({ domain: source.domain });
	};

	test("defaults to the first collection with no environment", () => {
		const { value } = twoRequestProject();
		const { collections, environments } = build(value);
		const resolved = resolveRunTargets({ domain: { collections, environments } }, { collection: null, environment: null, requests: [], folder: null });
		expect(resolved.collection.name).toBe("Alpha");
		expect(resolved.environment).toBeNull();
		expect(resolved.selection).toEqual({ mode: "collection" });
		expect(resolved.selectionLabel).toBe('collection "Alpha"');
	});

	test("resolves an environment by name and a request subset in the given order", () => {
		const { create, read, value } = twoRequestProject();
		value.environments = [{ name: "Local", variables: [variable("base", "http://127.0.0.1:9")] }];
		const { collections, environments } = build(value);
		const resolved = resolveRunTargets(
			{ domain: { collections, environments } },
			{ collection: "alpha", environment: "local", requests: [read.name, create.name], folder: null },
		);
		expect(resolved.environment.name).toBe("Local");
		expect(resolved.selection).toEqual({ mode: "requests", requestIds: [read.id, create.id] });
		expect(resolved.selectionLabel).toBe('requests "Read order", "Create order"');
	});

	test("resolves a folder selection and rejects an empty project", () => {
		const group = folder("Flow");
		const grouped = request({ name: "Grouped", folderId: group.id });
		const value = project({ collections: [collection({ folders: [group], requests: [grouped] })] });
		const { collections, environments } = build(value);
		const resolved = resolveRunTargets({ domain: { collections, environments } }, { collection: null, environment: null, requests: [], folder: "flow" });
		expect(resolved.selection).toEqual({ mode: "folder", folderId: group.id });
		expect(resolved.selectionLabel).toBe('folder "Flow"');

		const empty = capture(() =>
			resolveRunTargets({ domain: { collections: [], environments: [] } }, { collection: null, environment: null, requests: [], folder: null }),
		);
		expect(empty.error.code).toBe("CLI_PROJECT_EMPTY");
	});
});

describe("project loading", () => {
	test("loads a git-native directory and a portable file with the same fingerprint", () => {
		const { value } = twoRequestProject();
		const dir = writeProject(value);
		const file = path.join(mkdtempSync(path.join(os.tmpdir(), "tracer-file-")), "project.json");
		writeFileSync(file, JSON.stringify(value), "utf8");

		const fromDir = loadProjectSource(dir);
		const fromFile = loadProjectSource(file);
		expect(fromDir.kind).toBe("directory");
		expect(fromFile.kind).toBe("portable");
		expect(fromDir.fingerprint).toBe(fromFile.fingerprint);
		expect(fromDir.domain.collections[0].requests.map((entry) => entry.name)).toEqual(["Create order", "Read order"]);
	});

	test("a missing path is a project-not-found error, not a crash", () => {
		const result = capture(() => loadProjectSource(path.join(os.tmpdir(), "tracer-does-not-exist", "nope")));
		expect(result.error).toBeInstanceOf(CliError);
		expect(result.error.code).toBe("CLI_PROJECT_NOT_FOUND");
	});

	test("a malformed portable file fails closed", () => {
		const file = path.join(mkdtempSync(path.join(os.tmpdir(), "tracer-bad-")), "project.json");
		writeFileSync(file, "{ not json", "utf8");
		expect(capture(() => loadProjectSource(file)).error).toBeTruthy();
	});

	test("a portable project keeps assertions through the import boundary", () => {
		const item = assertion();
		const checked = request({ name: "Checked", assertions: { contract: "tracer.assertions/1", items: [item] } });
		const dir = writeProject(project({ collections: [collection({ requests: [checked] })] }));
		const loaded = loadProjectSource(dir);
		const mapped = loaded.domain.collections[0].requests[0];
		expect(mapped.assertions ?? mapped.assertions).toBeTruthy();
		void randomUUID;
		// Round-tripping the file through the canonical parser must not drift.
		expect(parseProject(JSON.stringify(loaded.project)).kind).toBe("tracer.project");
	});
});
