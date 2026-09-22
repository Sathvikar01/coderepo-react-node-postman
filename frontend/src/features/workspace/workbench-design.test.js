import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../../phase30-workbench.css", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("../../App.jsx", import.meta.url)), "utf8");
const header = readFileSync(fileURLToPath(new URL("./WorkspaceHeader.jsx", import.meta.url)), "utf8");

describe("Phase 30 workbench contracts", () => {
	test("styles the classes the real request/response UI renders", () => {
		expect(css).toContain(".url-bar");
		expect(css).toContain(".editor-tab");
		expect(css).toContain(".request-editor-body");
		expect(css).not.toContain(".request-url-row");
		expect(css).not.toContain(".request-editor-tab");
		expect(css).not.toContain(".response-tab");
	});

	test("does not corrupt the legacy header offset token", () => {
		expect(css).not.toContain("--header-height: 100vh");
	});

	test("keeps every primary rail command reachable on phones", () => {
		expect(css).not.toContain(".rail-primary .rail-command:nth-child(n + 3)");
	});

	test("Collections command has an observable action on every viewport", () => {
		expect(header).toContain('aria-label="Open collections"');
		expect(header).toContain("onClick={onToggleSidebar}");
		expect(app).toContain('setSidebarTab("collections")');
		expect(app).toContain("setSidebarOpen(true)");
	});

	test("ships light/dark, tablet/phone, reduced-motion contracts", () => {
		expect(css).toContain(':root[data-theme="light"]');
		expect(css).toContain("@media (max-width: 1179px)");
		expect(css).toContain("@media (max-width: 767px)");
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
	});
});
