import { describe, expect, test } from "bun:test";
import {
	exportDomainToFiles,
	filesToProject,
	importFilesToDomain,
	projectToFiles,
	projectFromDomain,
	assertSafeRelPath,
	slugSegment,
	validateProjectFiles,
} from "./index.js";
import {
	RESOLVED,
	collectionDoc,
	domainInput,
	executionState,
	filesToObject,
} from "./test-fixtures.js";

const REQ_PATH = "collections/orders-api/requests/list-orders--11111111.json";

function baseFiles() {
	return filesToObject(exportDomainToFiles(domainInput()));
}

function caught(operation) {
	try {
		operation();
	} catch (error) {
		return error;
	}
	throw new Error("expected the operation to throw");
}

describe("malformed files fail closed", () => {
	test("invalid JSON in a request file is rejected", () => {
		const files = baseFiles();
		files[REQ_PATH] = "{ this is not json ";
		const error = caught(() => filesToProject(new Map(Object.entries(files))));
		expect(error.code).toBe("PROJECT_MALFORMED");
	});

	test("a request file that is not a JSON object is rejected", () => {
		const files = baseFiles();
		files[REQ_PATH] = "[1,2,3]";
		expect(caught(() => filesToProject(new Map(Object.entries(files)))).code).toBe("PROJECT_MALFORMED");
	});

	test("a missing referenced file is rejected", () => {
		const files = baseFiles();
		delete files[REQ_PATH];
		expect(caught(() => filesToProject(new Map(Object.entries(files)))).code).toBe("PROJECT_MISSING_FILE");
	});

	test("an unknown, unreferenced project file is rejected", () => {
		const files = baseFiles();
		files["collections/orders-api/requests/stray--deadbeef.json"] = "{}";
		expect(caught(() => filesToProject(new Map(Object.entries(files)))).code).toBe("PROJECT_UNTRACKED_FILE");
	});

	test("a wrong manifest kind is rejected", () => {
		const files = baseFiles();
		const manifest = JSON.parse(files["project.json"]);
		manifest.kind = "other.project";
		files["project.json"] = JSON.stringify(manifest, null, 2);
		expect(caught(() => filesToProject(new Map(Object.entries(files)))).code).toBe("PROJECT_INVALID");
	});
});

describe("version incompatibility fails closed", () => {
	test("an unsupported manifest schemaVersion is rejected", () => {
		const files = baseFiles();
		const manifest = JSON.parse(files["project.json"]);
		manifest.schemaVersion = 2;
		files["project.json"] = JSON.stringify(manifest, null, 2);
		const error = caught(() => filesToProject(new Map(Object.entries(files))));
		expect(error.code).toBe("PROJECT_VERSION_UNSUPPORTED");
		expect(error.statusCode).toBe(422);
	});

	test("an unsupported manifest layoutVersion is rejected", () => {
		const files = baseFiles();
		const manifest = JSON.parse(files["project.json"]);
		manifest.layoutVersion = 99;
		files["project.json"] = JSON.stringify(manifest, null, 2);
		expect(caught(() => filesToProject(new Map(Object.entries(files)))).code).toBe("PROJECT_VERSION_UNSUPPORTED");
	});

	test("an unsupported request schemaVersion is rejected", () => {
		const files = baseFiles();
		const request = JSON.parse(files[REQ_PATH]);
		request.schemaVersion = 2;
		files[REQ_PATH] = JSON.stringify(request, null, 2);
		expect(caught(() => filesToProject(new Map(Object.entries(files)))).code).toBe("PROJECT_VERSION_UNSUPPORTED");
	});
});

describe("merge conflict text is rejected safely", () => {
	test("conflict markers in a request file fail closed with a conflict error", () => {
		const files = baseFiles();
		files[REQ_PATH] = [
			"{",
			"<<<<<<< HEAD",
			'  "name": "List orders",',
			"=======",
			'  "name": "List all",',
			">>>>>>> branch",
			"}",
		].join("\n");
		const error = caught(() => filesToProject(new Map(Object.entries(files))));
		expect(error.code).toBe("PROJECT_CONFLICT");
		expect(error.statusCode).toBe(409);
	});

	test("conflict markers never leak into the reconstructed project", () => {
		const files = baseFiles();
		files[REQ_PATH] = "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> b\n";
		expect(caught(() => importFilesToDomain(new Map(Object.entries(files)))).code).toBe("PROJECT_CONFLICT");
	});

	test("hasConflictMarkers detects markers without evaluating content", () => {
		const clean = JSON.stringify({ a: "=======" });
		expect(caught(() => filesToProject(new Map([["project.json", clean]])))).toBeTruthy();
	});
});

describe("filename and path traversal attempts are rejected", () => {
	test("assertSafeRelPath rejects traversal, absolute, and backslash paths", () => {
		for (const bad of ["../escape.json", "a/../../b.json", "/etc/passwd", "C:/win.ini", "a\\b.json", ""]) {
			expect(caught(() => assertSafeRelPath(bad)).code).toBe("PROJECT_UNSAFE_PATH");
		}
	});

	test("a hostile collection name collapses to a safe slug", () => {
		expect(slugSegment("../../../etc/passwd")).toBe("etc-passwd");
		expect(slugSegment("..\\..\\windows")).toBe("windows");
	});

	test("exported paths are all bounded even for hostile names", () => {
		const input = domainInput();
		input.collections = [collectionDoc({ name: "../../etc/passwd" })];
		const files = projectToFiles(projectFromDomain(input));
		for (const rel of files.keys()) {
			expect(rel.includes("..")).toBe(false);
			expect(rel.startsWith("/")).toBe(false);
			expect(() => assertSafeRelPath(rel)).not.toThrow();
		}
	});

	test("a traversal request reference in a collection file is rejected", () => {
		const files = baseFiles();
		const collection = JSON.parse(files["collections/orders-api/collection.json"]);
		collection.requests = ["requests/../../../../outside.json"];
		files["collections/orders-api/collection.json"] = JSON.stringify(collection, null, 2);
		expect(caught(() => filesToProject(new Map(Object.entries(files)))).code).toBe("PROJECT_UNSAFE_PATH");
	});

	test("a request reference escaping its requests folder is rejected", () => {
		const files = baseFiles();
		const collection = JSON.parse(files["collections/orders-api/collection.json"]);
		collection.requests = ["../../other-collection/collection.json"];
		files["collections/orders-api/collection.json"] = JSON.stringify(collection, null, 2);
		expect(caught(() => filesToProject(new Map(Object.entries(files)))).code).toBe("PROJECT_UNSAFE_PATH");
	});

	test("a traversal collection folder in the manifest is rejected", () => {
		const files = baseFiles();
		const manifest = JSON.parse(files["project.json"]);
		manifest.collections = ["../../evil"];
		files["project.json"] = JSON.stringify(manifest, null, 2);
		expect(caught(() => filesToProject(new Map(Object.entries(files)))).code).toBe("PROJECT_UNSAFE_PATH");
	});

	test("an unsafe key in the file map is rejected before any read", () => {
		const files = baseFiles();
		files["../escape.json"] = "{}";
		expect(caught(() => filesToProject(new Map(Object.entries(files)))).code).toBe("PROJECT_UNSAFE_PATH");
	});
});

describe("secret leakage scan", () => {
	test("no resolved secret, cookie, history, or Mongo id reaches any file", () => {
		const files = exportDomainToFiles({ ...domainInput(), ...executionState() });
		const all = [...files.values()].join("\n");
		for (const value of Object.values(RESOLVED)) expect(all).not.toContain(value);
		for (const forbidden of ["ownerProfileId", "nameKey", '"revision"', "_id", "authOverride", "resolvedVariables", "cookies", "history", "createdAt", "executionId"]) {
			expect(all).not.toContain(forbidden);
		}
	});

	test("templates and aliases survive so behavior is reconstructable", () => {
		const files = exportDomainToFiles({ ...domainInput(), ...executionState() });
		const all = [...files.values()].join("\n");
		expect(all).toContain("{{orders_token}}");
		expect(all).toContain("local_token");
	});

	test("a request file never carries send-only overrides or cookie jars", () => {
		const files = exportDomainToFiles({ ...domainInput(), ...executionState() });
		const request = files.get(REQ_PATH);
		expect(request).not.toContain("authOverride");
		expect(request).not.toContain("cookieJar");
		expect(request).not.toContain("sendOnly");
	});

	test("validateProjectFiles rejects a file carrying a resolved credential template", () => {
		const files = baseFiles();
		const request = JSON.parse(files[REQ_PATH]);
		request.auth = { mode: "bearer", tokenTemplate: RESOLVED.variable };
		files[REQ_PATH] = JSON.stringify(request, null, 2);
		const error = caught(() => validateProjectFiles(new Map(Object.entries(files))));
		expect(error.statusCode).toBe(422);
		expect(JSON.stringify(error)).not.toContain(RESOLVED.variable);
	});
});
