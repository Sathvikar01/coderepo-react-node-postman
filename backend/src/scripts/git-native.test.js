import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGitNative } from "./git-native.js";
import { projectFromDomain } from "../features/projects/project-export.js";
import { serializeProject } from "../features/projects/project-serialize.js";
import { domainInput } from "../features/git-native/test-fixtures.js";

function tmpdir() {
	return mkdtempSync(path.join(os.tmpdir(), "tracer-git-cli-"));
}

function portableFile(dir) {
	const portable = serializeProject(projectFromDomain(domainInput()));
	const file = path.join(dir, "portable.json");
	writeFileSync(file, portable, "utf8");
	return file;
}

function capture(fn) {
	const logs = [];
	const errlogs = [];
	const origLog = console.log;
	const origErr = console.error;
	const origWrite = process.stdout.write;
	console.log = (...args) => logs.push(args.join(" "));
	console.error = (...args) => errlogs.push(args.join(" "));
	process.stdout.write = (chunk) => {
		logs.push(String(chunk));
		return true;
	};
	try {
		const code = fn();
		return { code, logs, errlogs };
	} finally {
		console.log = origLog;
		console.error = origErr;
		process.stdout.write = origWrite;
	}
}

describe("git-native CLI (never runs Git)", () => {
	test("export splits a portable project into the layout", () => {
		const dir = tmpdir();
		try {
			const source = portableFile(dir);
			const out = path.join(dir, "tree");
			const { code } = capture(() => runGitNative(["export", source, out]));
			expect(code).toBe(0);
			expect(existsSync(path.join(out, "project.json"))).toBe(true);
			expect(existsSync(path.join(out, "collections", "orders-api", "requests", "list-orders--11111111.json"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("validate reports a fingerprint for a valid tree", () => {
		const dir = tmpdir();
		try {
			const source = portableFile(dir);
			const out = path.join(dir, "tree");
			capture(() => runGitNative(["export", source, out]));
			const { code, logs } = capture(() => runGitNative(["validate", out]));
			expect(code).toBe(0);
			expect(logs.join("\n")).toContain("fingerprint:");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("import reassembles a portable project identical to the source", () => {
		const dir = tmpdir();
		try {
			const source = portableFile(dir);
			const out = path.join(dir, "tree");
			const round = path.join(dir, "roundtrip.json");
			capture(() => runGitNative(["export", source, out]));
			const { code } = capture(() => runGitNative(["import", out, round]));
			expect(code).toBe(0);
			expect(readFileSync(round, "utf8")).toBe(readFileSync(source, "utf8"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("diff exits 0 on identical trees and reports changes otherwise", () => {
		const dir = tmpdir();
		try {
			const source = portableFile(dir);
			const a = path.join(dir, "a");
			const b = path.join(dir, "b");
			capture(() => runGitNative(["export", source, a]));
			capture(() => runGitNative(["export", source, b]));
			expect(capture(() => runGitNative(["diff", a, b])).code).toBe(0);

			const reqFile = path.join(b, "collections", "orders-api", "requests", "list-orders--11111111.json");
			const request = JSON.parse(readFileSync(reqFile, "utf8"));
			request.urlTemplate = "{{baseUrl}}/orders/cli";
			writeFileSync(reqFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");
			const { code, errlogs } = capture(() => runGitNative(["diff", a, b]));
			expect(code).toBe(0);
			expect(errlogs.join("\n")).toContain("changed lines");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("fingerprint prints the project hash and per-file hashes", () => {
		const dir = tmpdir();
		try {
			const source = portableFile(dir);
			const out = path.join(dir, "tree");
			capture(() => runGitNative(["export", source, out]));
			const { code, logs } = capture(() => runGitNative(["fingerprint", out]));
			expect(code).toBe(0);
			const text = logs.join("\n");
			expect(text).toContain("fingerprint:");
			expect(text).toContain("project.json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("validate fails closed on a corrupted tree with a nonzero exit", () => {
		const dir = tmpdir();
		try {
			const source = portableFile(dir);
			const out = path.join(dir, "tree");
			capture(() => runGitNative(["export", source, out]));
			writeFileSync(path.join(out, "collections", "orders-api", "requests", "list-orders--11111111.json"), "{ bad json", "utf8");
			const { code, errlogs } = capture(() => runGitNative(["validate", out]));
			expect(code).toBe(1);
			expect(errlogs.join("\n")).toContain("PROJECT_MALFORMED");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a merge-conflicted tree is rejected with a conflict code", () => {
		const dir = tmpdir();
		try {
			const source = portableFile(dir);
			const out = path.join(dir, "tree");
			capture(() => runGitNative(["export", source, out]));
			writeFileSync(
				path.join(out, "collections", "orders-api", "requests", "list-orders--11111111.json"),
				"<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> b\n",
				"utf8",
			);
			const { code, errlogs } = capture(() => runGitNative(["validate", out]));
			expect(code).toBe(1);
			expect(errlogs.join("\n")).toContain("PROJECT_CONFLICT");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("missing arguments and unknown commands exit nonzero", () => {
		expect(capture(() => runGitNative([])).code).toBe(2);
		expect(capture(() => runGitNative(["export"])).code).toBe(2);
		expect(capture(() => runGitNative(["explode"])).code).toBe(2);
		expect(capture(() => runGitNative(["help"])).code).toBe(0);
	});
});
