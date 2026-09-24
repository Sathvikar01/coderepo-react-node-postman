import { describe, expect, test } from "bun:test";
import { buildWhyExplanation, deriveVerificationState } from "./why-projection.js";
import {
	LINK_SOURCE,
	WHY_EXPLANATION_KIND,
	WHY_EXPLANATION_SCHEMA_VERSION,
	WHY_REASON,
	WHY_SECTIONS,
	VARIABLE_SCOPE_ORDER,
} from "./why-schema.js";

const EXECUTION_ID = "11111111-2222-4333-8444-555555555555";
const COLLECTION_ID = "64b00000000000000000c001";
const ENVIRONMENT_ID = "64b00000000000000000e001";
const REQUEST_ID = "req-1";

/* -------------------------------------------------------------------------- */
/* Fixtures — the projection consumes link envelopes, so the suite builds them */
/* in exactly the shape `why-evidence.js` emits.                              */
/* -------------------------------------------------------------------------- */

function makeLink(status, source, reasonCode, reason, extra = {}) {
	return {
		status,
		source,
		identity: extra.identity ?? [],
		reasonCode,
		reason,
		observedAt: extra.observedAt ?? null,
		fingerprint: extra.fingerprint ?? null,
	};
}

function links(overrides = {}) {
	const base = {
		rehearsal: {
			link: makeLink("not_recorded", LINK_SOURCE.PHASE46B_RUN, WHY_REASON.REHEARSAL_NOT_RECORDED, "No persisted rehearsal run records this execution or its request."),
			run: null,
			runs: [],
			step: null,
			truncated: false,
		},
		proof: {
			link: makeLink("not_recorded", LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_NOT_RECORDED, "No verification proof is linked to this execution."),
			detail: null,
			parseError: null,
		},
		impact: {
			link: makeLink("not_recorded", LINK_SOURCE.PHASE39_IMPACT, WHY_REASON.IMPACT_NOT_RECORDED, "No Phase 39 change-impact envelope is linked to this execution."),
			detail: null,
		},
		drift: {
			link: makeLink("not_recorded", LINK_SOURCE.PHASE40_DRIFT, WHY_REASON.DRIFT_NOT_RECORDED, "No Phase 40 environment-drift envelope is linked to this execution."),
			detail: null,
		},
		contract: {
			link: makeLink("not_recorded", LINK_SOURCE.PHASE43_CONTRACT, WHY_REASON.CONTRACT_NOT_RECORDED, "No Phase 43 contract comparison is linked to this execution."),
			detail: null,
		},
		verification: {
			link: makeLink("not_recorded", LINK_SOURCE.PHASE41_VERIFICATION, WHY_REASON.VERIFICATION_NOT_RECORDED, "No Phase 41 verification result is linked to this execution, so no verification state can be reported."),
			state: "UNKNOWN",
			authoritative: false,
			detail: null,
		},
	};
	return { ...base, ...overrides };
}

const PROOF_FP = "f".repeat(64);

/** The link envelope a recorded, request-naming proof produces. */
function recordedProofLinks({ state = "VERIFIED" } = {}) {
	return links({
		proof: {
			link: makeLink("recorded", LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_RECORDED, "The proof names this request in this environment and passed its integrity check.", { fingerprint: PROOF_FP }),
			detail: { proofId: "proof_1", fingerprint: PROOF_FP, state },
			parseError: null,
		},
		impact: {
			link: makeLink("recorded", LINK_SOURCE.PHASE39_IMPACT, WHY_REASON.LINKED_PHASE41_STATE, "Phase 39 change impact is linked through the proof; the envelope is copied, not recomputed.", { fingerprint: PROOF_FP }),
			detail: { present: true, resolved: true, directRequestIds: [REQUEST_ID], indirectRequestIds: [], unknownCount: 0, fingerprint: PROOF_FP },
		},
		drift: {
			link: makeLink("recorded", LINK_SOURCE.PHASE40_DRIFT, WHY_REASON.LINKED_PHASE41_STATE, "Phase 40 environment drift is linked through the proof; the envelope is copied, not recomputed.", { fingerprint: PROOF_FP }),
			detail: { present: true, identical: true, blockingCount: 0, blocking: [], fingerprint: PROOF_FP },
		},
		contract: {
			link: makeLink("recorded", LINK_SOURCE.PHASE43_CONTRACT, WHY_REASON.LINKED_PHASE41_STATE, "Phase 43 contract compatibility is linked through the proof and the rehearsal step metadata; it is copied, not recomputed.", { fingerprint: PROOF_FP }),
			detail: { present: true, compared: 1, compatible: 1, incompatible: 0, unknown: 0 },
		},
		verification: {
			link: makeLink("recorded", LINK_SOURCE.PHASE41_VERIFICATION, WHY_REASON.LINKED_PHASE41_STATE, `A Phase 41 result is linked through the proof. The state ${state} is restated verbatim.`, { fingerprint: PROOF_FP }),
			state,
			authoritative: true,
			detail: {
				state,
				fingerprint: PROOF_FP,
				verifiedRequestIds: [REQUEST_ID],
				affectedRequestIds: [REQUEST_ID],
				requiredRehearsalRequestIds: [REQUEST_ID],
				blockers: [],
				warnings: [],
				summary: null,
				requestVerified: true,
			},
		},
	});
}

/** A stale proof keeps its links but every derived node loses authority. */
function staleProofLinks() {
	return links({
		proof: {
			link: makeLink("stale", LINK_SOURCE.PHASE47_PROOF, WHY_REASON.PROOF_STALE, "The proof is intact, but it was recorded against a different snapshot or environment than the run linked to this execution."),
			detail: { proofId: "proof_1", fingerprint: PROOF_FP, state: "VERIFIED" },
			parseError: null,
		},
		impact: { link: makeLink("stale", LINK_SOURCE.PHASE39_IMPACT, WHY_REASON.LINKED_PHASE41_STATE, "stale"), detail: null },
		drift: { link: makeLink("stale", LINK_SOURCE.PHASE40_DRIFT, WHY_REASON.LINKED_PHASE41_STATE, "stale"), detail: null },
		contract: { link: makeLink("stale", LINK_SOURCE.PHASE43_CONTRACT, WHY_REASON.LINKED_PHASE41_STATE, "stale"), detail: null },
		verification: {
			link: makeLink("stale", LINK_SOURCE.PHASE41_VERIFICATION, WHY_REASON.PROOF_STALE, "The Phase 41 result is intact but was recorded against a different identity, so it is not reported as this execution's state."),
			state: "UNKNOWN",
			authoritative: false,
			detail: { state: "VERIFIED", fingerprint: PROOF_FP },
		},
	});
}

function receipt(overrides = {}) {
	return {
		schemaVersion: 1,
		kind: "tracer.execution-receipt",
		executionId: EXECUTION_ID,
		fingerprint: "a".repeat(64),
		fingerprintKeyId: "test-key-1",
		startedAt: "2026-09-17T10:00:00.000Z",
		finishedAt: "2026-09-17T10:00:01.000Z",
		outcome: "response",
		effectCertainty: "may_have_reached_target",
		request: {
			method: "GET",
			displayUrl: "http://127.0.0.1:8000/demo/orders?status={{status_filter}}",
			executedUrl: "http://127.0.0.1:8000/demo/orders?status=paid",
			authoredFingerprint: "b".repeat(64),
			compiledFingerprint: "c".repeat(64),
			headerNames: ["accept"],
			queryKeys: ["status"],
			body: { mode: "none", sizeBytes: 0, fingerprint: null },
			auth: { mode: "none", source: "request", referenceKeys: [] },
			variableSources: [
				{ field: "query.value", key: "status_filter", scope: "environment" },
				{ field: "url", key: "base_url", scope: "collection" },
			],
		},
		source: {
			type: "collection",
			collectionId: COLLECTION_ID,
			collectionRevision: 3,
			requestId: REQUEST_ID,
			environmentId: ENVIRONMENT_ID,
			environmentRevision: 2,
		},
		policy: { decision: "allowed", version: 7, local: false },
		target: { scheme: "http", hostname: "127.0.0.1", port: 8000, address: "127.0.0.1", family: 4 },
		redirects: [],
		transport: { httpVersion: "HTTP/1.1", durationMs: 12.4, firstByteMs: 10.1, receivedBodyBytes: 120, capturedBodyBytes: 120 },
		response: {
			bodyFingerprint: "d".repeat(64),
			truncated: false,
			binary: false,
			contract: { status: 200, headers: [{ name: "content-type", count: 1 }], bodyShape: [{ path: "$.id", type: "string" }] },
		},
		error: null,
		tests: { counts: { passed: 0, failed: 0, error: 0 }, failureFingerprint: "e".repeat(64) },
		warnings: [],
		...overrides,
	};
}

function record(overrides = {}) {
	const built = receipt(overrides.receipt);
	return {
		executionId: EXECUTION_ID,
		status: "terminal",
		outcome: "response",
		effectCertainty: "may_have_reached_target",
		persistence: { state: "saved" },
		visible: true,
		request: {
			name: "List orders",
			method: "GET",
			settings: { timeoutMs: 15000 },
			auth: { mode: "none" },
			body: { mode: "none" },
		},
		snapshot: { displayUrl: "http://127.0.0.1:8000/demo/orders?status={{status_filter}}" },
		compileTrace: [
			{ field: "url", variable: "base_url", scope: "collection" },
			{ field: "query.value", variable: "status_filter", scope: "environment" },
		],
		warnings: [],
		error: null,
		response: { status: 200 },
		startedAt: new Date("2026-09-17T10:00:00.000Z"),
		finishedAt: new Date("2026-09-17T10:00:01.000Z"),
		receipt: built,
		...overrides.record,
	};
}

function related(overrides = {}) {
	return {
		collection: { id: COLLECTION_ID, name: "Demo orders", revision: 3 },
		environment: { id: ENVIRONMENT_ID, name: "Local", revision: 2 },
		investigations: [],
		links: links(),
		...overrides,
	};
}

describe("Phase 49B — why projection envelope", () => {
	test("1 — emits the documented version 2 envelope shape", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		expect(explanation.kind).toBe(WHY_EXPLANATION_KIND);
		expect(explanation.schemaVersion).toBe(WHY_EXPLANATION_SCHEMA_VERSION);
		expect(explanation.schemaVersion).toBe(2);
		expect(explanation.recorded).toBe(true);
		expect(explanation.executionId).toBe(EXECUTION_ID);
		expect(explanation.sections).toEqual([...WHY_SECTIONS]);
		expect(explanation.reasonCode).toBeNull();
		for (const section of WHY_SECTIONS) expect(explanation.availability[section]).toBeDefined();
	});

	test("2 — exposes the full causal chain with owning phases", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		expect(explanation.chain.map((node) => node.id)).toEqual([
			"configuration",
			"execution",
			"impact",
			"drift",
			"rehearsal",
			"contract",
			"verification",
			"proof",
		]);
		expect(explanation.chain.find((node) => node.id === "verification").owner).toBe("Phase 41");
		expect(explanation.chain.find((node) => node.id === "impact").section).toBe("change");
	});

	test("3 — missing record fails closed with a reason code", () => {
		const explanation = buildWhyExplanation({ record: null, related: {} });
		expect(explanation.recorded).toBe(false);
		expect(explanation.reasonCode).toBe(WHY_REASON.EXECUTION_NOT_RECORDED);
		expect(explanation.availability.change.state).toBe("not_recorded");
		expect(explanation.configuration.entries).toEqual([]);
	});

	test("4 — is deterministic apart from generatedAt", () => {
		const first = buildWhyExplanation({ record: record(), related: related() });
		const second = buildWhyExplanation({ record: record(), related: related() });
		expect(typeof first.generatedAt).toBe("string");
		expect(Number.isNaN(Date.parse(first.generatedAt))).toBe(false);
		expect({ ...first, generatedAt: null }).toEqual({ ...second, generatedAt: null });
	});
});

describe("Phase 49B — configuration", () => {
	test("5 — projects recorded configuration without resolving secrets", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		const ids = explanation.configuration.entries.map((entry) => entry.id);
		expect(ids).toContain("request.method");
		expect(ids).toContain("target.address");
		expect(ids).toContain("auth.mode");
		expect(ids).toContain("policy.decision");
		expect(ids).toContain("source.collection");
		expect(explanation.configuration.state).toBe("recorded");
	});

	test("6 — never emits a literal credential from the stored request", () => {
		const secret = "super-secret-token-value";
		const explanation = buildWhyExplanation({
			record: record({ record: { request: { name: "Auth", method: "GET", settings: { timeoutMs: 15000 }, auth: { mode: "bearer", tokenTemplate: secret } } } }),
			related: related(),
		});
		expect(JSON.stringify(explanation)).not.toContain(secret);
	});

	test("7 — reports a source-revision change as a gap", () => {
		const explanation = buildWhyExplanation({
			record: record(),
			related: related({ collection: { id: COLLECTION_ID, name: "Demo orders", revision: 9 } }),
		});
		expect(explanation.configuration.state).toBe("partial");
		expect(explanation.configuration.gaps.map((gap) => gap.code)).toContain(WHY_REASON.SOURCE_REVISION_CHANGED);
	});

	test("8 — reports a scratch execution with no source reference", () => {
		const built = receipt({ source: { type: "scratch" }, request: { ...receipt().request, variableSources: [] } });
		const explanation = buildWhyExplanation({ record: record({ receipt: built }), related: related({ collection: null, environment: null }) });
		expect(explanation.configuration.gaps.map((gap) => gap.code)).toContain(WHY_REASON.NO_SOURCE_REFERENCE);
	});
});

describe("Phase 49B — dependencies", () => {
	test("9 — orders variables by the compiler's precedence and labels scopes", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		const variables = explanation.dependencies.variables;
		expect(variables.map((variable) => variable.scope)).toEqual(["collection", "environment"]);
		expect(variables[0].precedence).toBeLessThan(variables[1].precedence);
		expect(explanation.dependencies.precedence.order).toEqual([...VARIABLE_SCOPE_ORDER]);
		expect(explanation.dependencies.precedence.appliedScopes).toEqual(["collection", "environment"]);
	});

	test("10 — fails closed when nothing was interpolated", () => {
		const built = receipt({ request: { ...receipt().request, variableSources: [] } });
		const explanation = buildWhyExplanation({ record: record({ receipt: built, record: { compileTrace: [] } }), related: related() });
		expect(explanation.dependencies.state).toBe("partial");
		expect(explanation.dependencies.gaps.map((gap) => gap.code)).toContain(WHY_REASON.NO_VARIABLE_REFERENCES);
	});

	test("11 — lists source references with recorded and current revisions", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		const kinds = explanation.dependencies.references.map((reference) => reference.kind);
		expect(kinds).toContain("collection");
		expect(kinds).toContain("environment");
		const collection = explanation.dependencies.references.find((reference) => reference.kind === "collection");
		expect(collection.revision).toBe(3);
		expect(collection.currentRevision).toBe(3);
	});

	test("12 — bounds the variable list and reports truncation", () => {
		const variableSources = Array.from({ length: 150 }, (_, index) => ({ field: "url", key: `var_${index}`, scope: "collection" }));
		const built = receipt({ request: { ...receipt().request, variableSources } });
		const explanation = buildWhyExplanation({ record: record({ receipt: built }), related: related() });
		expect(explanation.dependencies.variables.length).toBe(100);
		expect(explanation.dependencies.truncated).toBe(true);
	});
});

describe("Phase 49B — execution", () => {
	test("13 — reports each pipeline stage as recorded or not recorded", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		const stages = explanation.execution.stages;
		expect(stages.map((stage) => stage.id)).toEqual(["compile", "policy", "dns", "transport", "capture", "normalize", "history"]);
		expect(stages.every((stage) => stage.state === "recorded")).toBe(true);
	});

	test("14 — records a blocked pre-dispatch execution without a response", () => {
		const built = receipt({
			outcome: "validation_error",
			effectCertainty: "not_dispatched",
			policy: { decision: "blocked", version: 7, local: false },
			target: null,
			transport: null,
			response: null,
			error: { code: "TARGET_BLOCKED" },
		});
		const explanation = buildWhyExplanation({
			record: record({ receipt: built, record: { outcome: "validation_error", response: null, error: { code: "TARGET_BLOCKED", message: "blocked" } } }),
			related: related(),
		});
		expect(explanation.execution.state).toBe("partial");
		const policy = explanation.execution.stages.find((stage) => stage.id === "policy");
		const dns = explanation.execution.stages.find((stage) => stage.id === "dns");
		expect(policy.state).toBe("recorded");
		expect(dns.state).toBe("not_recorded");
		expect(explanation.execution.gaps.map((gap) => gap.code)).toContain(WHY_REASON.RESPONSE_NOT_RECORDED);
	});
});

describe("Phase 49B — change composes Phase 39 + Phase 40 + investigations", () => {
	test("15 — fails closed when no change evidence references the execution", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		expect(explanation.change.recorded).toBe(false);
		expect(explanation.change.reasonCode).toBe(WHY_REASON.NO_CHANGE_EVIDENCE);
		expect(explanation.change.comparisons).toEqual([]);
		expect(explanation.change.impact.link.status).toBe("not_recorded");
		expect(explanation.change.drift.link.status).toBe("not_recorded");
		expect(explanation.availability.change.state).toBe("not_recorded");
	});

	test("16 — composes a persisted investigation without reinterpreting it", () => {
		const investigations = [
			{
				investigationId: "inv-1",
				status: "completed",
				startedAt: new Date("2026-09-17T11:00:00.000Z"),
				finishedAt: new Date("2026-09-17T11:01:00.000Z"),
				result: {
					summary: { text: "One verified cause." },
					comparison: {
						available: true,
						baseExecutionId: "base-1",
						candidateExecutionId: EXECUTION_ID,
						firstDivergence: { category: "environment", path: "environment.status_filter", message: "status_filter changed" },
						changes: [{ category: "environment", path: "environment.status_filter", message: "paid -> pending" }],
					},
					verifiedCauses: [{ label: "verified cause", path: "environment.status_filter", executionIds: ["probe-1", "probe-2"] }],
					unverifiedChanges: [{ label: "unverified" }],
					regressionBoundary: { resolved: true, goodExecutionId: "good-1" },
					reproducibility: { status: "completed", classification: "reproducible", statement: "Reproduced 3/3." },
				},
			},
		];
		const explanation = buildWhyExplanation({ record: record(), related: related({ investigations }) });
		expect(explanation.change.recorded).toBe(true);
		expect(explanation.change.reasonCode).toBe(WHY_REASON.CHANGE_EVIDENCE_RECORDED);
		expect(explanation.change.comparisons[0].verifiedCauses[0].label).toBe("verified cause");
		expect(explanation.change.comparisons[0].firstDivergence.message).toBe("status_filter changed");
		expect(explanation.change.comparisons[0].unverifiedChangeCount).toBe(1);
		expect(explanation.change.state).toBe("partial");
	});

	test("17 — surfaces a linked Phase 39 impact and Phase 40 drift verbatim", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related({ links: recordedProofLinks() }) });
		expect(explanation.change.state).toBe("partial");
		expect(explanation.change.impact.link.status).toBe("recorded");
		expect(explanation.change.impact.detail.directRequestIds).toEqual([REQUEST_ID]);
		expect(explanation.change.drift.link.status).toBe("recorded");
		expect(explanation.change.drift.detail.identical).toBe(true);
		expect(explanation.change.reason).toContain("Not recorded");
	});

	test("18 — reports not_recorded with a distinct reason per missing source", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		expect(explanation.change.impact.link.reasonCode).toBe(WHY_REASON.IMPACT_NOT_RECORDED);
		expect(explanation.change.drift.link.reasonCode).toBe(WHY_REASON.DRIFT_NOT_RECORDED);
		expect(explanation.change.recorded).toBe(false);
	});
});

describe("Phase 49B — verification is Phase 41's, never the inspector's", () => {
	test("19 — defaults to UNKNOWN with an explicit missing-evidence reason", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		expect(explanation.verification.state).toBe("UNKNOWN");
		expect(explanation.verification.stateBasis).toBe("none");
		expect(explanation.verification.reasonCode).toBe(WHY_REASON.VERIFICATION_NOT_RECORDED);
		expect(explanation.verification.reasons.length).toBeGreaterThan(0);
		expect(explanation.verification.caveat.length).toBeGreaterThan(0);
		expect(explanation.verification.authoritative).toBe(false);
	});

	test("20 — a blocked policy decision stays UNKNOWN and is shown as an observation only", () => {
		const built = receipt({ policy: { decision: "blocked", version: 7, local: false }, target: null });
		const explanation = buildWhyExplanation({ record: record({ receipt: built }), related: related() });
		expect(explanation.verification.state).toBe("UNKNOWN");
		expect(explanation.verification.stateBasis).toBe("none");
		const observation = explanation.verification.observations.find((item) => item.id === "target_policy");
		expect(observation.value).toBe("blocked");
		expect(observation.authoritative).toBe(false);
		expect(explanation.verification.reasons.map((reason) => reason.code)).toContain(WHY_REASON.OBSERVATION_ONLY);
	});

	test("21 — passing recorded assertions never yield VERIFIED", () => {
		const built = receipt({ tests: { counts: { passed: 3, failed: 0, error: 0 }, failureFingerprint: null } });
		const explanation = buildWhyExplanation({ record: record({ receipt: built }), related: related() });
		expect(explanation.verification.state).toBe("UNKNOWN");
		expect(explanation.verification.stateBasis).toBe("none");
		const observation = explanation.verification.observations.find((item) => item.id === "recorded_assertions");
		expect(observation.value.passed).toBe(3);
		expect(explanation.verification.assertions.passed).toBe(3);
	});

	test("22 — failing recorded assertions never yield NEEDS_REHEARSAL", () => {
		const built = receipt({ tests: { counts: { passed: 1, failed: 1, error: 0 }, failureFingerprint: "9".repeat(64) } });
		const explanation = buildWhyExplanation({ record: record({ receipt: built }), related: related() });
		expect(explanation.verification.state).toBe("UNKNOWN");
		expect(explanation.verification.assertions.failed).toBe(1);
	});

	test("23 — restates a linked Phase 41 state verbatim and marks it authoritative", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related({ links: recordedProofLinks({ state: "VERIFIED" }) }) });
		expect(explanation.verification.state).toBe("VERIFIED");
		expect(explanation.verification.stateBasis).toBe("linked_verification");
		expect(explanation.verification.authoritative).toBe(true);
		expect(explanation.verification.basisLabel).toBe("Linked Phase 41 result");
		expect(explanation.verification.linked.requestVerified).toBe(true);
		expect(explanation.verification.link.fingerprint).toBe(PROOF_FP);
	});

	test("24 — a stale proof keeps the observation but reports UNKNOWN", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related({ links: staleProofLinks() }) });
		expect(explanation.verification.state).toBe("UNKNOWN");
		expect(explanation.verification.stateBasis).toBe("none");
		expect(explanation.verification.link.status).toBe("stale");
		expect(explanation.verification.reasonCode).toBe(WHY_REASON.PROOF_STALE);
	});

	test("25 — deriveVerificationState only ever reports a linked Phase 41 state", () => {
		expect(deriveVerificationState({ receipt: null, related: {} }).state).toBe("UNKNOWN");
		expect(deriveVerificationState({ receipt: null, related: {} }).stateBasis).toBe("none");

		const blocked = deriveVerificationState({ receipt: receipt({ policy: { decision: "blocked" } }), related: {} });
		expect(blocked.state).toBe("UNKNOWN");
		expect(blocked.reasons.map((reason) => reason.code)).toContain(WHY_REASON.OBSERVATION_ONLY);

		const passing = receipt({ tests: { counts: { passed: 1, failed: 0, error: 0 } } });
		expect(deriveVerificationState({ receipt: passing, related: {} }).state).toBe("UNKNOWN");

		const linked = deriveVerificationState({
			receipt: passing,
			related: { links: recordedProofLinks({ state: "NEEDS_REHEARSAL" }) },
		});
		expect(linked.state).toBe("NEEDS_REHEARSAL");
		expect(linked.stateBasis).toBe("linked_verification");

		const stale = deriveVerificationState({ receipt: passing, related: { links: staleProofLinks() } });
		expect(stale.state).toBe("UNKNOWN");
	});

	test("26 — the verification basis vocabulary no longer contains self-derived bases", async () => {
		const schema = await import("./why-schema.js");
		expect(schema.VERIFICATION_STATE_BASIS).toEqual(["linked_verification", "none"]);
		expect(schema.VERIFICATION_STATE_BASIS).not.toContain("target_policy");
		expect(schema.VERIFICATION_STATE_BASIS).not.toContain("recorded_assertions");
	});
});

describe("Phase 49B — evidence chain", () => {
	test("27 — lists the causal chain nodes with a status and a bounded ref", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		const kinds = explanation.evidence.chain.map((node) => node.kind);
		expect(kinds).toEqual(["configuration", "execution", "impact", "drift", "rehearsal", "contract", "verification", "proof"]);
		expect(explanation.evidence.chain.every((node, index) => node.order === index + 1)).toBe(true);
		const configuration = explanation.evidence.chain.find((node) => node.kind === "configuration");
		const proof = explanation.evidence.chain.find((node) => node.kind === "proof");
		expect(configuration.status).toBe("recorded");
		expect(proof.status).toBe("not_recorded");
		expect(proof.available).toBe(false);
	});

	test("28 — makes the derived nodes recorded when a proof links the chain", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related({ links: recordedProofLinks() }) });
		const byKind = Object.fromEntries(explanation.evidence.chain.map((node) => [node.kind, node]));
		expect(byKind.proof.status).toBe("recorded");
		expect(byKind.impact.status).toBe("recorded");
		expect(byKind.drift.status).toBe("recorded");
		expect(byKind.contract.status).toBe("recorded");
		expect(byKind.verification.status).toBe("recorded");
		expect(explanation.evidence.state).toBe("partial");
		expect(explanation.evidence.proof.link.status).toBe("recorded");
	});

	test("29 — exposes the rehearsal, contract, verification and proof sub-objects", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		expect(explanation.evidence.rehearsal.link.source).toBe(LINK_SOURCE.PHASE46B_RUN);
		expect(explanation.evidence.contract.link.source).toBe(LINK_SOURCE.PHASE43_CONTRACT);
		expect(explanation.evidence.verification.state).toBe("UNKNOWN");
		expect(explanation.evidence.proof.link.source).toBe(LINK_SOURCE.PHASE47_PROOF);
		expect(explanation.evidence.rehearsal.runsTruncated).toBe(false);
	});

	test("30 — never emits an unbounded linked run or proof list", () => {
		const runs = Array.from({ length: 9 }, (_, index) => ({
			runId: `run-${index}`,
			stepStates: [],
			plan: { steps: [] },
			identity: {},
		}));
		const links = recordedProofLinks();
		const explanation = buildWhyExplanation({ record: record(), related: related({ links: { ...links, rehearsal: { ...links.rehearsal, runs, run: null, truncated: true } } }) });
		expect(explanation.evidence.rehearsal.runsTruncated).toBe(true);
		expect(JSON.stringify(explanation).length).toBeLessThan(200_000);
	});
});
