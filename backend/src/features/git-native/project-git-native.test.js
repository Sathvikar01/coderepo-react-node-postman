import { describe, expect, test } from "bun:test";
import { exportDomainToFiles, importFilesToDomain, projectFromDomain, projectToFiles, filesToProject, projectFingerprint, validateProjectFiles, hashProjectFiles, projectToDomain } from "./index.js";
import { diffProjectFiles, diffChangeCount } from "./project-diff.js";
import {
	ASSERTIONS,
	FOLDER_1,
	REQUEST_1,
	REQUEST_2,
	collectionDoc,
	domainInput,
	environmentDoc,
	exampleDoc,
	filesToObject,
} from "./test-fixtures.js";

describe("deterministic git-native layout", () => {
	test("export twice yields byte-identical files", () => {
		const a = exportDomainToFiles(domainInput());
		const b = exportDomainToFiles(domainInput());
		expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
		for (const [rel, text] of a) expect(b.get(rel)).toBe(text);
	});

	test("uses the preferred tracer-project layout with one request per file", () => {
		const files = exportDomainToFiles(domainInput());
		const paths = [...files.keys()].sort();
		expect(paths).toContain("project.json");
		expect(paths).toContain("collections/orders-api/collection.json");
		expect(paths).toContain("collections/orders-api/requests/list-orders--11111111.json");
		expect(paths).toContain("collections/orders-api/requests/create-order--22222222.json");
		expect(paths).toContain("environments/local.json");
		expect(paths).toContain("examples/list-orders-example.json");
	});

	test("project.json exposes the fingerprint and ordered file manifest", () => {
		const project = projectFromDomain(domainInput());
		const files = projectToFiles(project);
		const manifest = JSON.parse(files.get("project.json"));
		expect(manifest.kind).toBe("tracer.project");
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.layoutVersion).toBe(1);
		expect(manifest.fingerprint).toBe(projectFingerprint(project));
		expect(manifest.collections).toEqual(["orders-api"]);
		expect(manifest.environments).toEqual(["local.json"]);
		expect(manifest.examples).toEqual(["list-orders-example.json"]);
	});
});

describe("round trip preserves the required invariants", () => {
	test("preserves ordered query params and duplicate headers", () => {
		const applied = importFilesToDomain(exportDomainToFiles(domainInput()));
		const request = applied.collections[0].requests[0];
		expect(request.query.map((row) => row.key)).toEqual(["status", "status", "page"]);
		expect(request.query.map((row) => row.enabled)).toEqual([true, true, false]);
		expect(request.headers.map((row) => row.key)).toEqual(["Accept", "Accept", "X-Tenant"]);
		expect(request.headers.map((row) => row.enabled)).toEqual([true, false, true]);
	});

	test("preserves request/folder IDs, variables, and auth references", () => {
		const applied = importFilesToDomain(exportDomainToFiles(domainInput()));
		const collection = applied.collections[0];
		expect(collection.requests.map((r) => r.id)).toEqual([REQUEST_1, REQUEST_2]);
		expect(collection.folders).toEqual([{ id: FOLDER_1, name: "Read" }]);
		expect(collection.requests[0].folderId).toBe(FOLDER_1);
		expect(collection.variables[1]).toEqual({ id: expect.any(String), key: "orders_token", kind: "secretRef", alias: "local_token", enabled: true });
		expect(collection.requests[0].auth).toEqual({ mode: "bearer", tokenTemplate: "{{orders_token}}" });
	});

	test("preserves scripts and assertions", () => {
		const applied = importFilesToDomain(exportDomainToFiles(domainInput()));
		const request = applied.collections[0].requests[0];
		expect(request.scripts.preRequest).toContain("tracer.variables.set");
		expect(request.scripts.test).toContain("tracer.test");
		expect(request.assertions).toEqual(ASSERTIONS);
	});

	test("preserves examples and environments", () => {
		const applied = importFilesToDomain(exportDomainToFiles(domainInput()));
		expect(applied.environments[0].name).toBe("Local");
		expect(applied.examples[0].name).toBe("List orders example");
		expect(applied.examples[0].match.method).toBe("GET");
		expect(applied.examples[0].response.status).toBe(200);
	});

	test("re-exports identically after a full round trip", () => {
		const first = exportDomainToFiles(domainInput());
		const domain = importFilesToDomain(first);
		const second = projectToFiles(
			projectFromDomain({ collections: domain.collections, environments: domain.environments, examples: domain.examples }),
		);
		for (const [rel, text] of first) expect(second.get(rel)).toBe(text);
	});
});

describe("identity across rename and move", () => {
	test("a rename changes only the slug while the request id is preserved", () => {
		const before = exportDomainToFiles(domainInput());
		const renamed = domainInput();
		renamed.collections[0].requests[0] = { ...renamed.collections[0].requests[0], name: "List every order" };
		const after = exportDomainToFiles(renamed);

		// Same stable id suffix in the filename even though the human slug moved.
		const beforeReq = [...before.keys()].find((p) => p.includes("--11111111.json"));
		const afterReq = [...after.keys()].find((p) => p.includes("--11111111.json"));
		expect(beforeReq).toContain("list-orders--11111111.json");
		expect(afterReq).toContain("list-every-order--11111111.json");

		const project = filesToProject(after);
		expect(project.collections[0].requests[0].id).toBe(REQUEST_1);
		expect(project.collections[0].requests[0].name).toBe("List every order");
	});

	test("a folder move changes only folderId while the request id is preserved", () => {
		const moved = domainInput();
		moved.collections[0].requests[0] = { ...moved.collections[0].requests[0], folderId: null };
		const project = filesToProject(exportDomainToFiles(moved));
		expect(project.collections[0].requests[0].id).toBe(REQUEST_1);
		expect(project.collections[0].requests[0].folderId).toBeNull();
	});
});

describe("meaningful diffs", () => {
	test("a small request edit produces a small, localized diff", () => {
		const before = exportDomainToFiles(domainInput());
		const edited = domainInput();
		edited.collections[0].requests[0] = { ...edited.collections[0].requests[0], urlTemplate: "{{baseUrl}}/orders/all" };
		const after = exportDomainToFiles(edited);

		const diff = diffProjectFiles(before, after);
		// Small: only the fingerprint line and the urlTemplate line really change.
		expect(diffChangeCount(diff)).toBeLessThanOrEqual(4);
		expect(diff).toContain('+  "urlTemplate": "{{baseUrl}}/orders/all"');
		expect(diff).toContain("collections/orders-api/requests/list-orders--11111111.json");
	});

	test("a rename shows as a file rename plus a single name change", () => {
		const before = exportDomainToFiles(domainInput());
		const renamed = domainInput();
		renamed.collections[0].requests[0] = { ...renamed.collections[0].requests[0], name: "List every order" };
		const after = exportDomainToFiles(renamed);
		const diff = diffProjectFiles(before, after);
		// A rename is detected by id suffix: it renders as a small rename diff
		// (name line + fingerprint + the collection's request reference), not a
		// full delete + add of the request file.
		expect(diff).toContain("--- a/collections/orders-api/requests/list-orders--11111111.json");
		expect(diff).toContain("+++ b/collections/orders-api/requests/list-every-order--11111111.json");
		expect(diffChangeCount(diff)).toBeLessThanOrEqual(10);
	});
});

describe("fingerprint and hash visibility", () => {
	test("validateProjectFiles reports the fingerprint and name", () => {
		const files = exportDomainToFiles(domainInput());
		const { fingerprint, name, project } = validateProjectFiles(files);
		expect(typeof fingerprint).toBe("string");
		expect(fingerprint).toHaveLength(64);
		expect(name).toBeNull();
		expect(project.collections[0].name).toBe("Orders API");
	});

	test("hashProjectFiles is deterministic and keyed by path", () => {
		const files = exportDomainToFiles(domainInput());
		const h1 = hashProjectFiles(files);
		const h2 = hashProjectFiles(files);
		expect([...h1.keys()]).toEqual([...h2.keys()]);
		for (const key of h1.keys()) expect(h1.get(key)).toBe(h2.get(key));
		expect(h1.get("project.json")).toHaveLength(64);
	});

	test("an edit changes the project fingerprint", () => {
		const before = exportDomainToFiles(domainInput());
		const edited = domainInput();
		edited.collections[0].requests[0] = { ...edited.collections[0].requests[0], urlTemplate: "{{baseUrl}}/other" };
		const after = exportDomainToFiles(edited);
		expect(validateProjectFiles(before).fingerprint).not.toBe(validateProjectFiles(after).fingerprint);
	});
});

describe("import after a valid external edit", () => {
	test("picks up an externally edited request", () => {
		const files = exportDomainToFiles(domainInput());
		const object = filesToObject(files);
		const reqPath = "collections/orders-api/requests/list-orders--11111111.json";
		const request = JSON.parse(object[reqPath]);
		request.urlTemplate = "{{baseUrl}}/orders/edited";
		object[reqPath] = `${JSON.stringify(request, null, 2)}\n`;
		// project.json fingerprint is now stale but import must not gate on it.
		const applied = importFilesToDomain(new Map(Object.entries(object)));
		expect(applied.collections[0].requests[0].urlTemplate).toBe("{{baseUrl}}/orders/edited");
	});

	test("still exposes the old fingerprint until re-exported", () => {
		const files = exportDomainToFiles(domainInput());
		const staleFingerprint = JSON.parse(files.get("project.json")).fingerprint;
		const object = filesToObject(files);
		const reqPath = "collections/orders-api/requests/list-orders--11111111.json";
		const request = JSON.parse(object[reqPath]);
		request.urlTemplate = "{{baseUrl}}/orders/edited";
		object[reqPath] = `${JSON.stringify(request, null, 2)}\n`;
		const recomputed = validateProjectFiles(new Map(Object.entries(object))).fingerprint;
		expect(recomputed).not.toBe(staleFingerprint);
	});
});

describe("domain and portable seams stay intact", () => {
	test("projectToDomain accepts the reconstructed project", () => {
		const files = exportDomainToFiles(domainInput());
		const project = filesToProject(files);
		const applied = projectToDomain(project);
		expect(applied.collections[0].requests).toHaveLength(2);
	});

	test("a project with a name round-trips it", () => {
		const files = projectToFiles(projectFromDomain({ ...domainInput(), name: "Orders workspace" }));
		expect(filesToProject(files).name).toBe("Orders workspace");
		expect(validateProjectFiles(files).name).toBe("Orders workspace");
	});

	test("environment-only variable edits stay in the environment file", () => {
		const before = exportDomainToFiles(domainInput());
		const edited = domainInput();
		edited.environments = [environmentDoc({ variables: [{ id: "66666666-6666-4666-8666-666666666661", key: "host", kind: "plain", value: "10.0.0.5:8000", enabled: true }] })];
		const after = exportDomainToFiles(edited);
		const diff = diffProjectFiles(before, after);
		expect(diff).toContain("+      \"value\": \"10.0.0.5:8000\"");
		expect(diffChangeCount(diff)).toBeLessThanOrEqual(4);
	});
});
