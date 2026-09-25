import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../../phase30-workbench.css", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("../../App.jsx", import.meta.url)), "utf8");
const header = readFileSync(fileURLToPath(new URL("./WorkspaceHeader.jsx", import.meta.url)), "utf8");
const productCss = readFileSync(fileURLToPath(new URL("../product/product.css", import.meta.url)), "utf8");
const proofDialog = readFileSync(fileURLToPath(new URL("../verification-proof/VerificationProofDialog.jsx", import.meta.url)), "utf8");

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

describe("Phase 24 collaboration contracts", () => {
	const workspaceCss = readFileSync(fileURLToPath(new URL("../workspaces/workspace.css", import.meta.url)), "utf8");
	const switcher = readFileSync(fileURLToPath(new URL("../workspaces/WorkspaceSwitcher.jsx", import.meta.url)), "utf8");

	test("the workspace stylesheet never reintroduces a banned class name", () => {
		expect(workspaceCss).not.toContain(".request-url-row");
		expect(workspaceCss).not.toContain(".request-editor-tab");
		expect(workspaceCss).not.toContain(".response-tab");
		expect(workspaceCss).not.toContain("--header-height: 100vh");
	});

	test("the workspace surfaces inherit the shared theme tokens and respect reduced motion", () => {
		expect(workspaceCss).toContain("var(--surface");
		expect(workspaceCss).toContain("var(--border");
		expect(workspaceCss).toContain("@media (prefers-reduced-motion: reduce)");
	});

	test("the active-workspace control is reachable from the header rail", () => {
		expect(app).toContain("<WorkspaceSwitcher");
		expect(app).toContain("workspaceSwitcher={");
		expect(header).toContain("{workspaceSwitcher}");
		expect(switcher).toContain('ariaLabel="Active workspace"');
	});

	test("read-only roles still get an explicit, non-destructive explanation", () => {
		expect(app).toContain("workspace-readonly-banner");
		expect(app).toContain("read-only access");
	});

	test("the Activity view and Manage dialog are wired into the shell", () => {
		expect(app).toContain("WorkspaceActivityPanel");
		expect(app).toContain("WorkspaceDialog");
		expect(app).toContain('setSidebarTab("activity")');
	});
});

describe("Phase 48A product identity contracts", () => {
	test("the header exposes product information through the existing menu control", () => {
		expect(header).toContain("onOpenProduct");
		expect(header).toContain('label="Help and product information"');
		expect(header).toContain("PRODUCT_SURFACES.map");
	});

	test("the product dialog is wired into the app shell and participates in the dialog stack", () => {
		expect(app).toContain("ProductDialog");
		expect(app).toContain('setProductSurface("help")');
		// A product dialog must suppress the workspace shortcuts like every other dialog.
		expect(app).toContain("productSurface)");
	});

	test("the product surfaces own their styling and never rely on the workbench stylesheet", () => {
		expect(productCss).toContain(".product-modal");
		expect(productCss).toContain(".product-tabs");
		expect(productCss).toContain(".workflow-progression");
	});

	test("product tokens stay theme-aware and motion-respectful", () => {
		// The surfaces inherit the shared design tokens rather than hardcoding color.
		expect(productCss).toContain("var(--brand)");
		expect(productCss).toContain("var(--surface-raised)");
		expect(productCss).toContain("@media (prefers-reduced-motion: reduce)");
		expect(productCss).toContain("@media (max-width: 640px)");
	});

	test("the Verification Proof surface explains itself without deciding any state", () => {
		expect(proofDialog).toContain("How verification works");
		expect(proofDialog).toContain("WorkflowProgression");
		expect(proofDialog).toContain('currentStep="proof"');
		// The explanation must state that Tracer never upgrades a state itself.
		expect(proofDialog).toContain("Tracer never upgrades a state");
	});
});
