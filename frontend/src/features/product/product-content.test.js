import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONCEPTS,
	DATA_CATEGORIES,
	DATA_MINIMIZATION,
	DATA_NOTE,
	DEFAULT_PRODUCT_SURFACE,
	INVESTIGATION_WORKFLOW,
	PRODUCT_MODEL,
	PRODUCT_ONE_LINER,
	PRODUCT_SURFACE_IDS,
	PRODUCT_SURFACES,
	PRODUCT_TAGLINE,
	QUICK_START,
	SECURITY_FACTS,
	SECURITY_NOTE,
	USAGE_NOTE,
	USAGE_TERMS,
	VERIFICATION_WORKFLOW,
	concept,
	reportStatusPhrase,
	workflowStepIndex,
} from "./product-content.js";

const readRepoFile = (relative) => readFileSync(join(import.meta.dir, "../../../..", relative), "utf8");

describe("product identity content", () => {
	test("states the locked identity once, without overselling", () => {
		expect(PRODUCT_TAGLINE).toBe("API execution, investigation, and change-verification workspace");
		expect(PRODUCT_ONE_LINER).toContain("verify an affected workflow");
	});

	test("covers exactly the four-part mental model in order", () => {
		expect(PRODUCT_MODEL.map((part) => part.label)).toEqual(["Execute", "Understand", "Compare", "Verify"]);
	});

	test("every model part names at least one real surface and explains itself", () => {
		for (const part of PRODUCT_MODEL) {
			expect(part.summary.length).toBeGreaterThan(10);
			expect(part.detail.length).toBeGreaterThan(30);
			expect(part.surfaces.length).toBeGreaterThan(0);
		}
	});

	test("the mental model is Execute then Understand then Compare then Verify, never verify before compare", () => {
		const ids = PRODUCT_MODEL.map((part) => part.id);
		expect(ids).toEqual(["execute", "understand", "compare", "verify"]);
		expect(ids.indexOf("verify")).toBeGreaterThan(ids.indexOf("compare"));
	});
});

describe("workflow content", () => {
	test("verification workflow ends in Proof and never claims a state itself", () => {
		expect(VERIFICATION_WORKFLOW.at(-1).id).toBe("proof");
		expect(VERIFICATION_WORKFLOW.map((step) => step.id)).toEqual([
			"edit",
			"snapshot",
			"impact",
			"drift",
			"rehearse",
			"contract",
			"verify",
			"proof",
		]);
	});

	test("investigation workflow follows failure-first ordering", () => {
		expect(INVESTIGATION_WORKFLOW[0].id).toBe("failure");
		expect(INVESTIGATION_WORKFLOW.at(-1).id).toBe("reproduce");
	});

	test("every workflow step carries a one-line hint", () => {
		for (const step of [...VERIFICATION_WORKFLOW, ...INVESTIGATION_WORKFLOW]) {
			expect(step.hint.length).toBeGreaterThan(8);
			expect(step.label.length).toBeGreaterThan(0);
		}
	});

	test("workflowStepIndex returns -1 for an unknown step instead of guessing step 1", () => {
		expect(workflowStepIndex(VERIFICATION_WORKFLOW, "snapshot")).toBe(1);
		expect(workflowStepIndex(VERIFICATION_WORKFLOW, "not-a-step")).toBe(-1);
		expect(workflowStepIndex([], "snapshot")).toBe(-1);
	});
});

describe("concept glossary", () => {
	test("exposes a concept lookup that returns null instead of an empty tooltip", () => {
		expect(concept("proof").label).toBe("Verification Proof");
		expect(concept("missing")).toBeNull();
	});

	test("processesDeterminism: states are described as the backend's answer, never the UI's", () => {
		expect(CONCEPTS.verified.long).toContain("backend");
		expect(CONCEPTS.verified.long).toContain("never");
	});

	test("STALE is documented as neither a pass nor a failure", () => {
		expect(CONCEPTS.stale.long).toContain("not a pass and not a failure");
		expect(CONCEPTS.stale.label).toBe("STALE");
	});

	test("every concept has both a short and a long explanation", () => {
		for (const [key, entry] of Object.entries(CONCEPTS)) {
			expect(entry.label.length, key).toBeGreaterThan(0);
			expect(entry.short.length, key).toBeGreaterThan(15);
			expect(entry.long.length, key).toBeGreaterThan(60);
		}
	});
});

describe("quick start", () => {
	test("teaches Send and Save as separate actions", () => {
		const text = QUICK_START.map((step) => `${step.title} ${step.body}`).join(" ").toLowerCase();
		expect(text).toContain("send");
		expect(text).toContain("save");
	});

	test("every step has a title and a body", () => {
		for (const step of QUICK_START) {
			expect(step.title.length).toBeGreaterThan(4);
			expect(step.body.length).toBeGreaterThan(15);
		}
	});
});

describe("security, data, and usage surfaces", () => {
	test("security facts describe mechanisms the repository actually implements", () => {
		const ids = SECURITY_FACTS.map((fact) => fact.id);
		expect(ids).toContain("ssrf");
		expect(ids).toContain("secrets");
		expect(ids).toContain("hmac");
		expect(ids).toContain("failclosed");
		for (const fact of SECURITY_FACTS) {
			expect(fact.title.length).toBeGreaterThan(8);
			expect(fact.body.length).toBeGreaterThan(40);
		}
	});

	test("no security or usage copy claims a certification", () => {
		const text = [SECURITY_NOTE, ...SECURITY_FACTS.map((fact) => fact.body), USAGE_NOTE].join(" ").toLowerCase();
		expect(text).not.toContain("certified");
		expect(text).not.toContain("iso 27001");
		expect(text).not.toContain("soc 2");
		expect(text).not.toContain("gdpr compliant");
		expect(text).not.toContain("hipaa");
	});

	test("the security note explicitly disclaims certification", () => {
		expect(SECURITY_NOTE).toContain("not a certification");
	});

	test("data categories cover the persisted domains without promising a retention policy", () => {
		expect(DATA_CATEGORIES.length).toBeGreaterThanOrEqual(6);
		for (const category of DATA_CATEGORIES) {
			expect(category.body.length).toBeGreaterThan(30);
		}
		expect(DATA_NOTE).toContain("No retention period");
	});

	test("minimization rules include the no-bodies, no-secrets, and no-side-effect guarantees", () => {
		const text = DATA_MINIMIZATION.join(" ").toLowerCase();
		expect(text).toContain("no raw request or response bodies");
		expect(text).toContain("never executed, sent, or saved");
	});

	test("usage terms state that safety controls do not remove risk", () => {
		const safety = USAGE_TERMS.find((term) => term.id === "safety");
		expect(safety.body).toContain("do not make side effects impossible");
	});

	test("the usage note does not claim an attorney-reviewed contract or a corporate entity", () => {
		expect(USAGE_NOTE).toContain("not attorney-reviewed");
		expect(USAGE_NOTE).toContain("no corporate entity");
	});
});

describe("surface registry", () => {
	test("registers the five required surfaces", () => {
		expect(PRODUCT_SURFACE_IDS).toEqual(["help", "about", "security", "data", "usage"]);
		expect(DEFAULT_PRODUCT_SURFACE).toBe("help");
	});

	test("every surface id has a title used by the dialog", () => {
		const source = readRepoFile("frontend/src/features/product/ProductDialog.jsx");
		for (const surface of PRODUCT_SURFACES) {
			// The dialog must render a body and a title for every registered surface.
			expect(source).toContain(`${surface.id}: `);
		}
	});
});

describe("report status phrasing", () => {
	test("never upgrades an unknown status into a pass", () => {
		expect(reportStatusPhrase("VALID")).toBe("Valid");
		expect(reportStatusPhrase("STALE")).toBe("Stale");
		expect(reportStatusPhrase("MISMATCH")).toBe("Mismatch");
		expect(reportStatusPhrase("INVALID")).toBe("Invalid");
		expect(reportStatusPhrase("UNKNOWN")).toBe("Unknown");
		expect(reportStatusPhrase(undefined)).toBe("Unknown");
		expect(reportStatusPhrase("something-else")).toBe("Unknown");
	});

	test("no phrase is a green-success synonym", () => {
		for (const status of ["VALID", "STALE", "MISMATCH", "INVALID", "UNKNOWN", undefined]) {
			const phrase = reportStatusPhrase(status).toLowerCase();
			expect(phrase).not.toContain("verified");
			expect(phrase).not.toContain("success");
			expect(phrase).not.toContain("passed");
		}
	});
});

describe("truthfulness guard", () => {
	test("no surface copy uses absolute or unverifiable marketing language", () => {
		const blobs = [
			PRODUCT_TAGLINE,
			PRODUCT_ONE_LINER,
			SECURITY_NOTE,
			DATA_NOTE,
			USAGE_NOTE,
			...PRODUCT_MODEL.map((part) => part.detail),
			...SECURITY_FACTS.map((fact) => fact.body),
			...DATA_CATEGORIES.map((category) => category.body),
			...USAGE_TERMS.map((term) => term.body),
		];
		const text = blobs.join(" ").toLowerCase();
		expect(text).not.toContain("we guarantee");
		expect(text).not.toContain("100% secure");
		expect(text).not.toContain("bank-level");
		expect(text).not.toContain("industry-leading");
		expect(text).not.toContain("best-in-class");
	});

	test("no product surface injects HTML, which would allow untrusted markup", () => {
		const source = readRepoFile("frontend/src/features/product/ProductDialog.jsx");
		expect(source).not.toContain("dangerouslySetInnerHTML");
		expect(source).not.toContain("innerHTML");
	});
});
