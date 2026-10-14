/**
 * Root test-command contract (issue #80).
 *
 * Reviewers previously could not tell whether `bun test` or `bun run test`
 * executed the complete committed suite: the root `test` script ran only
 * `cd backend && bun test`, silently leaving the frontend suite out.
 *
 * This guard locks the canonical contract in place without pinning test counts
 * or formatting: the root `test` script must run both component suites, and
 * each component script must invoke Bun's test runner inside its workspace.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const scripts = rootPackage.scripts ?? {};

describe("root test command contract", () => {
	test("exposes a component command for each workspace", () => {
		expect(typeof scripts["test:backend"]).toBe("string");
		expect(typeof scripts["test:frontend"]).toBe("string");
	});

	test("the backend component runs Bun's test runner inside backend", () => {
		expect(scripts["test:backend"]).toContain("backend");
		expect(scripts["test:backend"]).toContain("bun test");
	});

	test("the frontend component runs Bun's test runner inside frontend", () => {
		expect(scripts["test:frontend"]).toContain("frontend");
		expect(scripts["test:frontend"]).toContain("bun test");
	});

	test("the canonical test command runs both component suites", () => {
		expect(scripts.test).toContain("test:backend");
		expect(scripts.test).toContain("test:frontend");
	});

	test("the canonical test command is not backend-only", () => {
		expect(scripts.test).not.toBe("cd backend && bun test");
	});
});
