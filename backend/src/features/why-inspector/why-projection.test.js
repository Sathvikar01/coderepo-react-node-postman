import { describe, expect, test } from "bun:test";
import { buildWhyExplanation, deriveVerificationState } from "./why-projection.js";
import { WHY_EXPLANATION_KIND, WHY_EXPLANATION_SCHEMA_VERSION, WHY_REASON, WHY_SECTIONS, VARIABLE_SCOPE_ORDER } from "./why-schema.js";

const EXECUTION_ID = "11111111-2222-4333-8444-555555555555";
const COLLECTION_ID = "64b00000000000000000c001";
const ENVIRONMENT_ID = "64b00000000000000000e001";

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
			requestId: "req-1",
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
		verification: null,
		...overrides,
	};
}

describe("Phase 49 — why projection envelope", () => {
	test("1 — emits the documented envelope shape", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		expect(explanation.kind).toBe(WHY_EXPLANATION_KIND);
		expect(explanation.schemaVersion).toBe(WHY_EXPLANATION_SCHEMA_VERSION);
		expect(explanation.recorded).toBe(true);
		expect(explanation.executionId).toBe(EXECUTION_ID);
		expect(explanation.sections).toEqual([...WHY_SECTIONS]);
		expect(explanation.reasonCode).toBeNull();
		for (const section of WHY_SECTIONS) expect(explanation.availability[section]).toBeDefined();
	});

	test("2 — missing record fails closed with a reason code", () => {
		const explanation = buildWhyExplanation({ record: null, related: {} });
		expect(explanation.recorded).toBe(false);
		expect(explanation.reasonCode).toBe(WHY_REASON.EXECUTION_NOT_RECORDED);
		expect(explanation.availability.change.state).toBe("not_recorded");
		expect(explanation.configuration.entries).toEqual([]);
	});

	test("3 — is deterministic apart from generatedAt", () => {
		const first = buildWhyExplanation({ record: record(), related: related() });
		const second = buildWhyExplanation({ record: record(), related: related() });
		expect(typeof first.generatedAt).toBe("string");
		expect(Number.isNaN(Date.parse(first.generatedAt))).toBe(false);
		expect({ ...first, generatedAt: null }).toEqual({ ...second, generatedAt: null });
	});
});

describe("Phase 49 — configuration", () => {
	test("4 — projects recorded configuration without resolving secrets", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		const ids = explanation.configuration.entries.map((entry) => entry.id);
		expect(ids).toContain("request.method");
		expect(ids).toContain("target.address");
		expect(ids).toContain("auth.mode");
		expect(ids).toContain("policy.decision");
		expect(ids).toContain("source.collection");
		expect(explanation.configuration.state).toBe("recorded");
	});

	test("5 — never emits a literal credential from the stored request", () => {
		const secret = "super-secret-token-value";
		const explanation = buildWhyExplanation({
			record: record({ record: { request: { name: "Auth", method: "GET", settings: { timeoutMs: 15000 }, auth: { mode: "bearer", tokenTemplate: secret } } } }),
			related: related(),
		});
		expect(JSON.stringify(explanation)).not.toContain(secret);
	});

	test("6 — reports a source-revision change as a gap", () => {
		const explanation = buildWhyExplanation({
			record: record(),
			related: related({ collection: { id: COLLECTION_ID, name: "Demo orders", revision: 9 } }),
		});
		expect(explanation.configuration.state).toBe("partial");
		expect(explanation.configuration.gaps.map((gap) => gap.code)).toContain(WHY_REASON.SOURCE_REVISION_CHANGED);
	});

	test("7 — reports a scratch execution with no source reference", () => {
		const built = receipt({ source: { type: "scratch" }, request: { ...receipt().request, variableSources: [] } });
		const explanation = buildWhyExplanation({ record: record({ receipt: built }), related: related({ collection: null, environment: null }) });
		expect(explanation.configuration.gaps.map((gap) => gap.code)).toContain(WHY_REASON.NO_SOURCE_REFERENCE);
	});
});

describe("Phase 49 — dependencies", () => {
	test("8 — orders variables by the compiler's precedence and labels scopes", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		const variables = explanation.dependencies.variables;
		expect(variables.map((variable) => variable.scope)).toEqual(["collection", "environment"]);
		expect(variables[0].precedence).toBeLessThan(variables[1].precedence);
		expect(explanation.dependencies.precedence.order).toEqual([...VARIABLE_SCOPE_ORDER]);
		expect(explanation.dependencies.precedence.appliedScopes).toEqual(["collection", "environment"]);
	});

	test("9 — fails closed when nothing was interpolated", () => {
		const built = receipt({ request: { ...receipt().request, variableSources: [] } });
		const explanation = buildWhyExplanation({ record: record({ receipt: built, record: { compileTrace: [] } }), related: related() });
		expect(explanation.dependencies.state).toBe("partial");
		expect(explanation.dependencies.gaps.map((gap) => gap.code)).toContain(WHY_REASON.NO_VARIABLE_REFERENCES);
	});

	test("10 — lists source references with recorded and current revisions", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		const kinds = explanation.dependencies.references.map((reference) => reference.kind);
		expect(kinds).toContain("collection");
		expect(kinds).toContain("environment");
		const collection = explanation.dependencies.references.find((reference) => reference.kind === "collection");
		expect(collection.revision).toBe(3);
		expect(collection.currentRevision).toBe(3);
	});

	test("11 — bounds the variable list and reports truncation", () => {
		const variableSources = Array.from({ length: 150 }, (_, index) => ({ field: "url", key: `var_${index}`, scope: "collection" }));
		const built = receipt({ request: { ...receipt().request, variableSources } });
		const explanation = buildWhyExplanation({ record: record({ receipt: built }), related: related() });
		expect(explanation.dependencies.variables.length).toBe(100);
		expect(explanation.dependencies.truncated).toBe(true);
	});
});

describe("Phase 49 — execution", () => {
	test("12 — reports each pipeline stage as recorded or not recorded", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		const stages = explanation.execution.stages;
		expect(stages.map((stage) => stage.id)).toEqual(["compile", "policy", "dns", "transport", "capture", "normalize", "history"]);
		expect(stages.every((stage) => stage.state === "recorded")).toBe(true);
	});

	test("13 — records a blocked pre-dispatch execution without a response", () => {
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

describe("Phase 49 — change", () => {
	test("14 — fails closed when no change evidence references the execution", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		expect(explanation.change.recorded).toBe(false);
		expect(explanation.change.reasonCode).toBe(WHY_REASON.NO_CHANGE_EVIDENCE);
		expect(explanation.change.comparisons).toEqual([]);
		expect(explanation.availability.change.state).toBe("not_recorded");
	});

	test("15 — composes a persisted investigation without reinterpreting it", () => {
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
	});
});

describe("Phase 49 — verification", () => {
	test("16 — defaults to UNKNOWN with explicit missing evidence", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		expect(explanation.verification.state).toBe("UNKNOWN");
		expect(explanation.verification.stateBasis).toBe("none");
		expect(explanation.verification.reasonCode).toBe(WHY_REASON.NO_VERIFICATION_EVIDENCE);
		expect(explanation.verification.reasons.length).toBeGreaterThan(0);
		expect(explanation.verification.caveat.length).toBeGreaterThan(0);
	});

	test("17 — reports BLOCKED from the backend's recorded policy decision", () => {
		const built = receipt({ policy: { decision: "blocked", version: 7, local: false }, target: null });
		const explanation = buildWhyExplanation({ record: record({ receipt: built }), related: related() });
		expect(explanation.verification.state).toBe("BLOCKED");
		expect(explanation.verification.stateBasis).toBe("target_policy");
	});

	test("18 — reports VERIFIED from recorded passing assertions", () => {
		const built = receipt({ tests: { counts: { passed: 3, failed: 0, error: 0 }, failureFingerprint: null } });
		const explanation = buildWhyExplanation({ record: record({ receipt: built }), related: related() });
		expect(explanation.verification.state).toBe("VERIFIED");
		expect(explanation.verification.stateBasis).toBe("recorded_assertions");
		expect(explanation.verification.assertions.passed).toBe(3);
	});

	test("19 — reports NEEDS_REHEARSAL from recorded failing assertions", () => {
		const built = receipt({ tests: { counts: { passed: 1, failed: 1, error: 0 }, failureFingerprint: "f".repeat(64) } });
		const explanation = buildWhyExplanation({ record: record({ receipt: built }), related: related() });
		expect(explanation.verification.state).toBe("NEEDS_REHEARSAL");
		expect(explanation.verification.stateBasis).toBe("recorded_assertions");
	});

	test("20 — prefers a linked verification artifact when present", () => {
		const explanation = buildWhyExplanation({
			record: record(),
			related: related({ verification: { state: "VERIFIED", source: "verification-proof", ref: "proof-1" } }),
		});
		expect(explanation.verification.state).toBe("VERIFIED");
		expect(explanation.verification.stateBasis).toBe("linked_verification");
	});

	test("21 — deriveVerificationState is a pure precedence ladder", () => {
		expect(deriveVerificationState({ receipt: null, related: {} }).state).toBe("UNKNOWN");
		expect(deriveVerificationState({ receipt: receipt({ policy: { decision: "blocked" } }), related: {} }).state).toBe("BLOCKED");
		const passing = receipt({ tests: { counts: { passed: 1, failed: 0, error: 0 } } });
		expect(deriveVerificationState({ receipt: passing, related: {} }).state).toBe("VERIFIED");
		expect(
			deriveVerificationState({ receipt: passing, related: { verification: { state: "NEEDS_REHEARSAL", source: "x" } } }).stateBasis,
		).toBe("linked_verification");
	});
});

describe("Phase 49 — evidence chain", () => {
	test("22 — lists the evidence nodes backing the explanation", () => {
		const explanation = buildWhyExplanation({ record: record(), related: related() });
		const kinds = explanation.evidence.chain.map((node) => node.kind);
		expect(kinds).toContain("configuration");
		expect(kinds).toContain("execution-receipt");
		expect(kinds).toContain("compiled-request");
		expect(kinds).toContain("response-body");
		expect(kinds).toContain("verification");
		expect(explanation.evidence.chain.every((node, index) => node.order === index + 1)).toBe(true);
	});

	test("23 — a missing response is an unavailable evidence node", () => {
		const built = receipt({ response: null, transport: null, target: null });
		const explanation = buildWhyExplanation({ record: record({ receipt: built, record: { response: null } }), related: related() });
		const node = explanation.evidence.chain.find((entry) => entry.kind === "response-body");
		expect(node.available).toBe(false);
	});
});
