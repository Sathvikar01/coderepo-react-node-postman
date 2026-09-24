import { describe, expect, test } from "bun:test";
import {
	SUPPORTED_WHY_SCHEMA_VERSION,
	configurationGroups,
	evidenceKindLabel,
	hasRecordedChange,
	isExplanation,
	linkStatusLabel,
	linkStatusTone,
	precedenceLadder,
	sectionStateLabel,
	sectionStateTone,
	toSuppliedProof,
	variableRows,
	verificationBasisLabel,
	verificationTone,
	WHY_TABS,
	whyErrorMessage,
} from "./why-inspector-model.js";

const explanation = {
	kind: "tracer.why-explanation",
	schemaVersion: 2,
};

describe("Phase 49 — Why? Inspector view helpers", () => {
	test("1 — exposes the four documented sections in order", () => {
		expect(WHY_TABS.map((tab) => tab.id)).toEqual(["configuration", "execution", "change", "evidence"]);
	});

	test("2 — labels every section state and never invents one", () => {
		expect(sectionStateLabel("recorded")).toBe("Recorded");
		expect(sectionStateLabel("partial")).toBe("Partial");
		expect(sectionStateLabel("not_recorded")).toBe("Not recorded");
		expect(sectionStateLabel(undefined)).toBe("Not recorded");
		expect(sectionStateLabel("something_new")).toBe("Not recorded");
		expect(sectionStateTone("recorded")).toBe("success");
		expect(sectionStateTone("partial")).toBe("warning");
		expect(sectionStateTone(undefined)).toBe("neutral");
	});

	test("3 — maps only the backend's verification vocabulary to tones", () => {
		expect(verificationTone("VERIFIED")).toBe("success");
		expect(verificationTone("NEEDS_REHEARSAL")).toBe("warning");
		expect(verificationTone("BLOCKED")).toBe("danger");
		expect(verificationTone("UNKNOWN")).toBe("neutral");
		expect(verificationTone("INVENTED")).toBe("neutral");
	});

	test("4 — labels only the v2 verification bases; old self-derived bases are unknown", () => {
		expect(verificationBasisLabel("linked_verification")).toBe("Linked Phase 41 verification");
		expect(verificationBasisLabel("none")).toBe("No verification evidence");
		expect(verificationBasisLabel("target_policy")).toBe("Unknown basis");
		expect(verificationBasisLabel("recorded_assertions")).toBe("Unknown basis");
		expect(verificationBasisLabel(undefined)).toBe("Unknown basis");
	});

	test("5 — groups configuration entries in the fixed backend order", () => {
		const groups = configurationGroups([
			{ id: "source.collection", group: "source", label: "Collection", value: "Demo" },
			{ id: "request.method", group: "request", label: "Method", value: "GET" },
			{ id: "target.address", group: "target", label: "Address", value: "127.0.0.1" },
			{ id: "request.url", group: "request", label: "URL", value: "http://x" },
			{ id: "custom.thing", group: "custom", label: "Custom", value: "y" },
		]);
		expect(groups.map((group) => group.group)).toEqual(["request", "target", "source", "custom"]);
		expect(groups[0].entries).toHaveLength(2);
		expect(groups.at(-1).label).toBe("Other");
		expect(configurationGroups(null)).toEqual([]);
	});

	test("6 — renders the backend's precedence order and labels verbatim", () => {
		const ladder = precedenceLadder({
			order: ["initial", "collection", "environment"],
			labels: [
				{ scope: "initial", label: "Initial (draft)" },
				{ scope: "collection", label: "Collection" },
				{ scope: "environment", label: "Environment" },
			],
			appliedScopes: ["collection"],
		});
		expect(ladder.map((step) => step.rank)).toEqual([1, 2, 3]);
		expect(ladder.map((step) => step.scope)).toEqual(["initial", "collection", "environment"]);
		expect(ladder[1].label).toBe("Collection");
		expect(ladder[1].applied).toBe(true);
		expect(ladder[0].applied).toBe(false);
		expect(precedenceLadder(null)).toEqual([]);
	});

	test("7 — variable rows carry the backend's scope label and rank", () => {
		const rows = variableRows({
			variables: [
				{ field: "query.value", key: "status_filter", scope: "environment", scopeLabel: "Environment", precedence: 3 },
				{ field: "url", key: "base_url", scope: "collection", scopeLabel: "Collection", precedence: 1 },
			],
		});
		expect(rows[0].scopeText).toBe("Environment");
		expect(rows[0].precedenceText).toBe("#4");
		expect(rows[1].precedenceText).toBe("#2");
		expect(variableRows({ variables: [{ key: "x" }] })[0].scopeText).toBe("Unknown scope");
		expect(variableRows(null)).toEqual([]);
	});

	test("8 — change evidence is only reported when the backend recorded it", () => {
		expect(hasRecordedChange({ recorded: true, comparisons: [{}] })).toBe(true);
		expect(hasRecordedChange({ recorded: true, comparisons: [] })).toBe(false);
		expect(hasRecordedChange({ recorded: false, comparisons: [{}] })).toBe(false);
		expect(hasRecordedChange(null)).toBe(false);
	});

	test("9 — accepts only the v2 envelope; v1 and unknown versions are refused", () => {
		expect(SUPPORTED_WHY_SCHEMA_VERSION).toBe(2);
		expect(isExplanation(explanation)).toBe(true);
		expect(isExplanation({ kind: "tracer.why-explanation", schemaVersion: 1 })).toBe(false);
		expect(isExplanation({ kind: "tracer.why-explanation", schemaVersion: 3 })).toBe(false);
		expect(isExplanation({ kind: "something-else", schemaVersion: 2 })).toBe(false);
		expect(isExplanation(null)).toBe(false);
		expect(isExplanation({})).toBe(false);
	});

	test("10 — labels evidence nodes and defaults to a generic label", () => {
		expect(evidenceKindLabel("execution-receipt")).toBe("Execution receipt");
		expect(evidenceKindLabel("change-analysis")).toBe("Change analysis");
		expect(evidenceKindLabel("impact")).toBe("Impact");
		expect(evidenceKindLabel("drift")).toBe("Drift");
		expect(evidenceKindLabel("rehearsal")).toBe("Rehearsal");
		expect(evidenceKindLabel("contract")).toBe("Contract");
		expect(evidenceKindLabel("verification")).toBe("Verification state");
		expect(evidenceKindLabel("proof")).toBe("Proof");
		expect(evidenceKindLabel("unknown-kind")).toBe("Evidence");
	});

	test("12 — link statuses stay explicit and never render as success unless recorded", () => {
		expect(linkStatusLabel("recorded")).toBe("Recorded");
		expect(linkStatusLabel("partial")).toBe("Partial");
		expect(linkStatusLabel("not_recorded")).toBe("Not recorded");
		expect(linkStatusLabel("stale")).toBe("Stale");
		expect(linkStatusLabel("invalid")).toBe("Invalid");
		expect(linkStatusLabel("identity_mismatch")).toBe("Identity mismatch");
		expect(linkStatusLabel("unknown")).toBe("Unknown");
		expect(linkStatusLabel("something_new")).toBe("Unknown");
		expect(linkStatusTone("recorded")).toBe("success");
		expect(linkStatusTone("partial")).toBe("warning");
		expect(linkStatusTone("stale")).toBe("warning");
		expect(linkStatusTone("identity_mismatch")).toBe("danger");
		expect(linkStatusTone("invalid")).toBe("danger");
		expect(linkStatusTone("not_recorded")).toBe("neutral");
		expect(linkStatusTone("unknown")).toBe("neutral");
	});

	test("13 — proof text is transport-opaque: blank means no proof, otherwise passed through untouched", () => {
		expect(toSuppliedProof(null)).toBeNull();
		expect(toSuppliedProof(undefined)).toBeNull();
		expect(toSuppliedProof("   ")).toBeNull();
		const artifact = '{"proof":{"proofId":"p1"},"secret":"hunter2-value"}';
		expect(toSuppliedProof(artifact)).toBe(artifact);
	});

	test("14 — verification states render without inventing a basis", () => {
		for (const state of ["VERIFIED", "BLOCKED", "NEEDS_REHEARSAL", "UNKNOWN"]) {
			expect(verificationTone(state)).not.toBe(undefined);
		}
		expect(verificationTone("VERIFIED")).toBe("success");
		expect(verificationTone("BLOCKED")).toBe("danger");
	});

	test("11 — maps backend error codes to actionable text", () => {
		expect(whyErrorMessage({ code: "EXECUTION_NOT_FOUND" })).toContain("no longer in history");
		expect(whyErrorMessage({ code: "VALIDATION_ERROR" })).toContain("identifier");
		expect(whyErrorMessage({ message: "boom" })).toBe("boom");
		expect(whyErrorMessage(null)).toBe("The explanation could not be loaded.");
	});
});
