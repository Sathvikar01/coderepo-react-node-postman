import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProjectDir, writeProjectDir, exportDomainToFiles, filesToProject, diffProjectFiles, diffText, diffChangeCount } from "./index.js";
import { domainInput, filesToObject } from "./test-fixtures.js";

function tmpdir() {
	return mkdtempSync(path.join(os.tmpdir(), "tracer-git-native-"));
}

function caught(operation) {
	try {
		operation();
	} catch (error) {
		return error;
	}
	throw new Error("expected the operation to throw");
}

describe("bounded project filesystem", () => {
	test("write then read reproduces the exact files", () => {
		const dir = tmpdir();
		try {
			const files = exportDomainToFiles(domainInput());
			writeProjectDir(dir, files);
			const readBack = readProjectDir(dir);
			expect([...readBack.keys()].sort()).toEqual([...files.keys()].sort());
			for (const [rel, text] of files) expect(readBack.get(rel)).toBe(text);
			// And the on-disk tree round-trips to the same project.
			expect(filesToProject(readBack).collections[0].name).toBe("Orders API");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("write rejects a traversal file name and writes nothing outside the root", () => {
		const dir = tmpdir();
		const outside = path.join(path.dirname(dir), "outside-canary.txt");
		try {
			const files = new Map([["../outside-canary.txt", "pwned"]]);
			const error = caught(() => writeProjectDir(dir, files));
			expect(error.code).toBe("PROJECT_UNSAFE_PATH");
			expect(existsSync(outside)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outside, { force: true });
		}
	});

	test("write rejects an absolute file name", () => {
		const dir = tmpdir();
		try {
			const error = caught(() => writeProjectDir(dir, new Map([["/etc/passwd", "x"]])));
			expect(error.code).toBe("PROJECT_UNSAFE_PATH");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("read ignores dotfiles and .git but reads project data", () => {
		const dir = tmpdir();
		try {
			writeProjectDir(dir, exportDomainToFiles(domainInput()));
			mkdirSync(path.join(dir, ".git"), { recursive: true });
			writeFileSync(path.join(dir, ".git", "config"), "secret", "utf8");
			writeFileSync(path.join(dir, ".gitignore"), "node_modules", "utf8");
			const readBack = readProjectDir(dir);
			expect(readBack.has(".git/config")).toBe(false);
			expect(readBack.has(".gitignore")).toBe(false);
			expect(readBack.has("project.json")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an externally edited file on disk re-imports", () => {
		const dir = tmpdir();
		try {
			writeProjectDir(dir, exportDomainToFiles(domainInput()));
			const reqFile = path.join(dir, "collections", "orders-api", "requests", "list-orders--11111111.json");
			const request = JSON.parse(readFileSync(reqFile, "utf8"));
			request.urlTemplate = "{{baseUrl}}/orders/from-disk";
			writeFileSync(reqFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");
			const applied = filesToProject(readProjectDir(dir));
			expect(applied.collections[0].requests[0].urlTemplate).toBe("{{baseUrl}}/orders/from-disk");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("diffs stay deterministic and human readable", () => {
	test("diffText of identical text is empty", () => {
		expect(diffText("a\nb\n", "a\nb\n")).toBe("");
	});

	test("diffText shows a localized change", () => {
		const diff = diffText('{\n  "a": 1\n}\n', '{\n  "a": 2\n}\n', "f.json");
		expect(diff).toContain("--- a/f.json");
		expect(diff).toContain('-  "a": 1');
		expect(diff).toContain('+  "a": 2');
		expect(diffChangeCount(diff)).toBe(2);
	});

	test("diffText marks an added and a removed file", () => {
		const added = diffText(undefined, "hello\n", "new.json");
		expect(added).toContain("--- /dev/null");
		expect(added).toContain("+++ b/new.json");
		expect(added).toContain("+hello");
		const removed = diffText("bye\n", undefined, "old.json");
		expect(removed).toContain("--- a/old.json");
		expect(removed).toContain("+++ /dev/null");
		expect(removed).toContain("-bye");
	});

	test("diffProjectFiles is deterministic across identical trees", () => {
		const a = exportDomainToFiles(domainInput());
		const b = exportDomainToFiles(domainInput());
		expect(diffProjectFiles(a, b)).toBe("");
	});

	test("a request file rename is detected by id suffix, not shown as delete + add", () => {
		const before = filesToObject(exportDomainToFiles(domainInput()));
		const after = { ...before };
		const request = JSON.parse(after["collections/orders-api/requests/list-orders--11111111.json"]);
		request.name = "List every order";
		delete after["collections/orders-api/requests/list-orders--11111111.json"];
		after["collections/orders-api/requests/list-every-order--11111111.json"] = `${JSON.stringify(request, null, 2)}\n`;

		const diff = diffProjectFiles(new Map(Object.entries(before)), new Map(Object.entries(after)));
		// Rename renders as a single before/after pair, so the body is tiny and
		// neither /dev/null side appears.
		expect(diff).toContain("--- a/collections/orders-api/requests/list-orders--11111111.json");
		expect(diff).toContain("+++ b/collections/orders-api/requests/list-every-order--11111111.json");
		expect(diff).not.toContain("/dev/null");
		expect(diffChangeCount(diff)).toBe(2);
	});
});
