/**
 * Reset-coverage contract test for the documented seed reset.
 *
 * `bash setup.sh --seed` (and therefore every `bun start`) must restore the
 * documented demo state "leaving no extra data behind". Regression guard: every
 * persisted Mongoose model must be cleared by the seed reset block — models
 * added by later phases (runs, cookies, examples, minimizations, local-runtime
 * approvals) previously survived the reset.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import mongoose from "mongoose";

const here = dirname(fileURLToPath(import.meta.url));
const featuresDir = join(here, "..", "features");
const seedSource = readFileSync(join(here, "seed.js"), "utf8");

function collectModelFiles(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) collectModelFiles(full, out);
		else if (entry.name.endsWith(".model.js")) out.push(full);
	}
	return out;
}

describe("seed reset covers every persisted model", () => {
	const modelFiles = collectModelFiles(featuresDir);

	test("feature model files are discovered", () => {
		expect(modelFiles.length).toBeGreaterThanOrEqual(10);
	});

	test("every registered model is cleared by the seed reset block", async () => {
		for (const file of modelFiles) {
			await import(pathToFileURL(file).href);
		}
		const names = mongoose.modelNames().sort();
		expect(names.length).toBeGreaterThanOrEqual(10);
		const missing = names.filter((name) => !seedSource.includes(`${name}.deleteMany({})`));
		expect(missing).toEqual([]);
	});
});
