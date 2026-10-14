import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../../phase30-workbench.css", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("../../App.jsx", import.meta.url)), "utf8");
const header = readFileSync(fileURLToPath(new URL("./WorkspaceHeader.jsx", import.meta.url)), "utf8");
const productCss = readFileSync(fileURLToPath(new URL("../product/product.css", import.meta.url)), "utf8");
const baseCss = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");
const whyCss = readFileSync(fileURLToPath(new URL("../why-inspector/why-inspector.css", import.meta.url)), "utf8");
const historyPanel = readFileSync(fileURLToPath(new URL("../history/HistoryPanel.jsx", import.meta.url)), "utf8");
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
		expect(app).toContain("workspaceCommand={");
		expect(header).toContain("{workspaceCommand}");
		expect(switcher).toContain('trigger="workspaces"');
		expect(switcher).not.toContain("SelectMenu");
		expect(switcher).not.toContain("workspace-role-badge");
	});

	test("read-only roles still get an explicit, non-destructive explanation", () => {
		expect(app).toContain("workspace-readonly-banner");
		expect(app).toContain("read-only access");
	});

	test("collaboration stays inside the Figma rail and four-slot resource index", () => {
		expect(app).toContain("WorkspaceDialog");
		expect(app).toContain('openWorkspaceDialog("activity")');
		expect(app).not.toContain('setSidebarTab("activity")');
		expect(css).toContain("grid-template-columns: repeat(4, 1fr)");
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

// Regressions found by the UI functional audit in a real browser. Each rule here
// was observed broken at 375, 768, 1024, or 1440 before the fix.
describe("UI audit layout contracts", () => {
	const block = (source, selector) => {
		const start = source.indexOf(`${selector} {`);
		return start === -1 ? "" : source.slice(start, source.indexOf("}", start));
	};

	test("the phone URL bar keeps method, URL, and Send in their own grid tracks", () => {
		expect(block(css, "	.url-bar .url-input")).toContain("order: 0");
		expect(block(css, "	.url-bar .method-select")).toContain("width: auto");
	});

	test("key-value rows reserve room for both row actions", () => {
		expect(block(baseCss, ".kv-head")).toContain("minmax(0, 1.4fr) 56px");
		expect(block(baseCss, ".kv-row")).toContain("minmax(0, 1.4fr) 56px");
	});

	test("history row actions wrap instead of scrolling the panel sideways", () => {
		expect(historyPanel).toContain('className="history-item-meta history-item-actions"');
		expect(block(baseCss, ".history-item-actions")).toContain("flex-wrap: wrap");
	});

	test("wide dialogs out-rank the shared 560px form-dialog width", () => {
		expect(whyCss).toContain(".form-dialog.why-dialog {");
		expect(productCss).toContain(".form-dialog.product-dialog {");
	});

	test("the sign-in headline stays in flow so it cannot overlap the card", () => {
		const headline = block(css, ".profile-picker-page::before");
		expect(headline).toContain("margin-bottom: auto");
		expect(headline).not.toContain("position: absolute");
	});

	test("the phone command bar is two rows and the resource panel opens below it", () => {
		expect(css).toContain("--phone-header-height: 104px");
		expect(css).toContain("top: var(--phone-header-height);");
		expect(block(css, "	.rail-primary")).toContain("grid-row: 2");
	});

	test("the overlay scrim never takes a desktop grid cell", () => {
		// Clicking the rail's Collections command at 1440px pushed the request
		// canvas below the viewport because the scrim became a grid item.
		expect(block(css, ".sidebar-scrim")).toContain("display: none");
		expect(block(css, "	.sidebar-scrim")).toContain("display: block");
	});

	test("the rail environment list opens beside the rail, inside the viewport", () => {
		// It opened below a trigger that sits near the bottom of the rail, so the
		// last environment was cut off at 1440 x 900.
		const list = block(css, ".app-header .environment-picker .select-menu-list");
		expect(list).toContain("bottom: 0");
		expect(list).toContain("left: calc(100% + 8px)");
		expect(list).toContain("max-height: calc(100dvh - 24px)");
	});

	test("the request tab strip scrolls sideways only", () => {
		expect(block(css, ".request-tab-list")).toContain("overflow-y: hidden");
	});

	test("profile rows keep the avatar initials centered", () => {
		expect(baseCss).toContain(".profile-account span:not(.profile-avatar, .icon-button) {");
	});
});
