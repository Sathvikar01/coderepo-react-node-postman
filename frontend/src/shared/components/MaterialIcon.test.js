import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MATERIAL_ICON_NAMES } from "./MaterialIcon.jsx";

const SOURCE_ROOT = join(import.meta.dir, "../..");

function sourceFiles(directory) {
	return readdirSync(directory).flatMap((entry) => {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(jsx|js)$/.test(entry) && !/\.test\.jsx?$/.test(entry) ? [path] : [];
	});
}

// Icon names reach MaterialIcon as literal children, as `icon`/`trigger` props on
// Menu items and triggers, as string branches of conditional children, and through
// small lookup tables. Collect every literal in those positions.
function referencedIconNames(source) {
	const names = new Set();
	for (const match of source.matchAll(/<MaterialIcon[^>]*>\s*([a-z_]+)\s*<\/MaterialIcon>/g)) names.add(match[1]);
	for (const match of source.matchAll(/<MaterialIcon[^>]*>\s*\{([^}]*)\}\s*<\/MaterialIcon>/g)) {
		// Only branch results, not the comparands in `state === "failed" ? ...`.
		for (const literal of match[1].matchAll(/(?:^|[?:])\s*"([a-z_]+)"/g)) names.add(literal[1]);
	}
	for (const match of source.matchAll(/\b(?:icon|trigger)(?::\s*|=)(?:[^,"\n]*\?\s*)?"([a-z_]+)"(?:\s*:\s*"([a-z_]+)")?/g)) {
		names.add(match[1]);
		if (match[2]) names.add(match[2]);
	}
	for (const match of source.matchAll(/const [A-Z_]+_ICONS?\s*=\s*\{([^}]*)\}/g)) {
		for (const literal of match[1].matchAll(/:\s*"([a-z_]+)"/g)) names.add(literal[1]);
	}
	return names;
}

describe("MaterialIcon registry", () => {
	test("every icon referenced by the frontend has a path, so no control renders an empty glyph", () => {
		const known = new Set(MATERIAL_ICON_NAMES);
		const missing = [];
		let referenced = 0;
		for (const file of sourceFiles(SOURCE_ROOT)) {
			for (const name of referencedIconNames(readFileSync(file, "utf8"))) {
				referenced += 1;
				if (!known.has(name)) missing.push(`${name} (${file.slice(SOURCE_ROOT.length + 1)})`);
			}
		}
		expect(referenced).toBeGreaterThan(50);
		expect(missing).toEqual([]);
	});

	test("the sidebar section tabs and the workspace rail command have glyphs", () => {
		for (const name of ["cookie", "bookmark", "workspaces", "code", "play_arrow", "replay"]) {
			expect(MATERIAL_ICON_NAMES).toContain(name);
		}
	});
});
