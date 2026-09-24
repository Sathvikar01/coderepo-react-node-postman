import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductDialog } from "./ProductDialog.jsx";
import { WorkflowProgression } from "./WorkflowProgression.jsx";
import { INVESTIGATION_WORKFLOW, PRODUCT_SURFACE_IDS, VERIFICATION_WORKFLOW } from "./product-content.js";

const readRepoFile = (relative) => readFileSync(join(import.meta.dir, "../../../..", relative), "utf8");

const render = (initialSurface) => renderToStaticMarkup(<ProductDialog initialSurface={initialSurface} onClose={() => {}} />);

describe("WorkflowProgression", () => {
	test("renders every step as an ordered landmark", () => {
		const html = renderToStaticMarkup(<WorkflowProgression workflow={VERIFICATION_WORKFLOW} currentStep="rehearse" />);
		expect(html).toContain("Edit");
		expect(html).toContain("Snapshot");
		expect(html).toContain("Proof");
		// One list item per step: the strip must not silently drop steps.
		expect((html.match(/<li/g) || []).length).toBe(VERIFICATION_WORKFLOW.length);
	});

	test("marks exactly the current step with aria-current and no others", () => {
		const html = renderToStaticMarkup(<WorkflowProgression workflow={VERIFICATION_WORKFLOW} currentStep="rehearse" />);
		expect((html.match(/aria-current="step"/g) || []).length).toBe(1);
		const index = html.indexOf('aria-current="step"');
		expect(html.slice(index, index + 260)).toContain("Rehearse");
	});

	test("renders no current step when the caller passes an unknown step", () => {
		const html = renderToStaticMarkup(<WorkflowProgression workflow={VERIFICATION_WORKFLOW} currentStep="nope" />);
		expect(html).not.toContain('aria-current="step"');
		// With no current step the hint paragraph is omitted rather than showing a false step.
		expect(html).not.toContain("workflow-current-hint");
	});

	test("compact mode drops the hint paragraph but keeps every label accessible", () => {
		const html = renderToStaticMarkup(<WorkflowProgression compact currentStep="proof" label="Verification workflow" workflow={VERIFICATION_WORKFLOW} />);
		expect(html).not.toContain("workflow-current-hint");
		expect(html).toContain("Contract Check");
		expect(html).toContain('aria-label="Verification workflow"');
	});

	test("an empty workflow renders nothing instead of an empty shell", () => {
		expect(renderToStaticMarkup(<WorkflowProgression workflow={[]} />)).toBe("");
		expect(renderToStaticMarkup(<WorkflowProgression />)).toBe("");
	});

	test("the investigation workflow renders without claiming a verification state", () => {
		const html = renderToStaticMarkup(<WorkflowProgression workflow={INVESTIGATION_WORKFLOW} currentStep="compare" />);
		expect(html).toContain("Failure");
		expect(html).toContain("Reproduce");
		expect(html.toLowerCase()).not.toContain("verified");
	});
});

describe("ProductDialog", () => {
	test("renders a titled, labelled dialog with a close control", () => {
		const html = render("help");
		expect(html).toContain('aria-label="Tracer — Getting Started"');
		expect(html).toContain("Getting Started");
		expect(html).toContain("Close product information");
	});

	test("exposes all five surfaces as a single tablist with the active one selected", () => {
		const html = render("security");
		expect(html).toContain('role="tablist"');
		expect((html.match(/role="tab"/g) || []).length).toBe(PRODUCT_SURFACE_IDS.length);
		expect((html.match(/aria-selected="true"/g) || []).length).toBe(1);
		const index = html.indexOf('aria-selected="true"');
		expect(html.slice(index, index + 420)).toContain("Security &amp; Safety");
	});

	test("renders each registered surface body without throwing", () => {
		for (const surface of PRODUCT_SURFACE_IDS) {
			const html = render(surface);
			expect(html.length, surface).toBeGreaterThan(400);
			expect(html, surface).toContain('role="tabpanel"');
		}
	});

	test("falls back to Getting Started for an unknown surface instead of rendering blank", () => {
		const html = render("does-not-exist");
		expect(html).toContain("Getting Started");
		expect(html).toContain("Quick start");
	});

	test("the data surface never prints a secret value, only aliases and rules", () => {
		const html = render("data");
		expect(html).toContain("Secret references are stored as aliases");
		expect(html).not.toContain("password123");
		expect(html).not.toContain("alex.morgan@example.test");
	});

	test("the security surface states its disclaimer verbatim", () => {
		const html = render("security");
		expect(html).toContain("not a certification");
	});

	test("the about surface presents the four-part model and both workflows", () => {
		const html = render("about");
		expect(html).toContain("Execute → Understand → Compare → Verify");
		expect(html).toContain("Edit → Snapshot → Impact → Drift → Rehearse → Contract Check → Verify → Proof");
	});

	test("the usage surface renders every practical rule", () => {
		const html = render("usage");
		expect(html).toContain("Send only to systems you are authorized to access");
		expect(html).toContain("Mutating requests can cause side effects");
		expect(html).toContain("not attorney-reviewed");
	});

	test("owns its roving-tab keyboard contract instead of taking it as a prop", () => {
		// Regression: the dialog previously accepted a `tabs` prop that the app never
		// passed, so pressing a tab key threw inside SurfaceTabs. The dialog must wire
		// the keyboard contract itself.
		const source = readRepoFile("frontend/src/features/product/ProductDialog.jsx");
		expect(source).toContain("useRovingTabs()");
		expect(source).not.toContain("tabs,");
		// And the rendered markup must carry the tablist that contract needs.
		expect(render("about")).toContain('role="tablist"');
	});
});
