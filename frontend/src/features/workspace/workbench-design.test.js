import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cssPath = fileURLToPath(new URL("../../phase30-workbench.css", import.meta.url));

describe("Phase 30 workbench design contract", () => {
	test("defines the new rail, resource index, canvas, and evidence deck", () => {
		const css = readFileSync(cssPath, "utf8");
		expect(css).toContain("--rail-width");
		expect(css).toContain("--resource-width");
		expect(css).toContain(".app-header");
		expect(css).toContain(".sidebar");
		expect(css).toContain(".workspace");
		expect(css).toContain(".request-pane-bottom");
	});

	test("ships light, dark, responsive, and reduced-motion contracts", () => {
		const css = readFileSync(cssPath, "utf8");
		expect(css).toContain(':root[data-theme="light"]');
		expect(css).toContain("@media (max-width: 1179px)");
		expect(css).toContain("@media (max-width: 767px)");
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
	});

	test("avoids broad transitions and preserves visible focus", () => {
		const css = readFileSync(cssPath, "utf8");
		expect(css).not.toContain("transition: all");
		expect(css).toContain(":focus-visible");
	});
});
