/**
 * Reset-coverage contract test for the documented seed reset.
 *
 * `bash setup.sh --seed` (and therefore every `bun start`) must restore the
 * documented demo state "leaving no extra data behind". Regression guard: every
 * persisted Mongoose model must be cleared by the seed reset block — models
 * added by later phases (runs, cookies, examples, minimizations, local-runtime
 * approvals, workspaces) previously survived the reset.
 *
 * The reset now spans two files: the baseline `src/scripts/seed.js` (a HackerRank
 * read-only path) and the collaboration wrapper `src/features/workspaces/seed.js`
 * that `bun run seed` actually executes. Both are inspected so the contract still
 * covers every registered model end to end.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import mongoose from "mongoose";

const here = dirname(fileURLToPath(import.meta.url));
const featuresDir = join(here, "..", "features");
const seedSource = [
	readFileSync(join(here, "seed.js"), "utf8"),
	readFileSync(join(featuresDir, "workspaces", "seed.js"), "utf8"),
].join("\n");

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

	test("seeded environment variable rows use UUID identifiers, not ObjectIds", () => {
		// The API validates environment variable rows with `variableSchema`, whose
		// `id` is `z.uuid()`. A seeded row with a `new mongoose.Types.ObjectId()` id
		// therefore fails `PUT /api/v1/environments/:id` with VALIDATION_ERROR and
		// makes the seeded Local environment un-editable (this broke the documented
		// `bun run demo:flight-recorder` flow). Guard against reintroducing it.
		const objectIdVariableId = /id:\s*new mongoose\.Types\.ObjectId\(\)[\s\S]{0,80}?key:/;
		expect(objectIdVariableId.test(seedSource)).toBe(false);
	});
});
