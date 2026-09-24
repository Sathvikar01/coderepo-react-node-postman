import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";

// The planner reads no configuration. The repository fingerprint primitive it
// reuses for plan identity does, because plan fingerprints and execution
// fingerprints share one HMAC key. Initializing it here keeps the suite
// self-contained and deterministic without touching the planner's purity.
process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase46_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase46-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase46-test-jwt-secret";
initConfig();

import {
	CYCLE_KINDS,
	CYCLE_KIND_VALUES,
	DEPENDENCY_KINDS,
	PLAN_REASON_CODES,
	PLAN_STATES,
	REHEARSAL_PLANNING_ERROR_CODES,
	STEP_STATES,
	acceptsRehearsalPlanBlastRadiusShape,
	acceptsRehearsalPlanDriftShape,
	acceptsRehearsalPlanImpactShape,
	assertRehearsalPlanResult,
	canonicalPlanJson,
	canonicalizePlanValue,
	createRehearsalPlanner,
	detectCycles,
	planDisplayDigest,
	planFingerprintKeyId,
	planIdentityOf,
	planRehearsal,
	topologicalOrder,
} from "./index.js";

// Phase 46A — Checkpointed Rehearsal Planning Core test suite.
//
// Every case is deterministic: no clock, no network, no database, no execution.
// Consumed envelopes are built in the shapes the Phase 39/40/45 cores produce,
// so the suite exercises the real structural seam rather than a fixture
// invented for the planner.

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-1";
const SNAPSHOT_ID = "snap-1";
const SNAPSHOT_FP = "fp-snapshot-1";
const SOURCE_ENV = "env-local";
const TARGET_ENV = "env-staging";
const POLICY_IDENTITY = "policy-identity-1";

function impactResult({ direct = [], indirect = [], resolved = true, truncated = false, unknown = [] } = {}) {
	const toRow = (requestId) => ({ requestId, nodeKind: "request", collectionId: "col-1" });
	return {
		kind: "tracer.change-impact",
		schemaVersion: 1,
		resolved,
		truncated,
		summary: {
			directRequests: direct.length,
			indirectRequests: indirect.length,
			unknownReferences: unknown.length,
		},
		requests: {
			direct: direct.map((id) => ({ ...toRow(id), impact: "direct", hop: 1, confidence: "exact" })),
			indirect: indirect.map((id) => ({ ...toRow(id), impact: "indirect", hop: 2, confidence: "exact" })),
		},
		unknown,
	};
}

function driftResult({ identical = false, targetEnvironmentId = TARGET_ENV, entries } = {}) {
	const drift = entries ?? [
		{ category: "VARIABLE_CHANGED", path: "variables.baseUrl", severity: "high", status: "confirmed" },
	];
	return {
		kind: "tracer.environment-drift",
		schemaVersion: 1,
		source: { environmentId: SOURCE_ENV, name: "local", revision: 1 },
		target: { environmentId: targetEnvironmentId, name: "staging", revision: 2 },
		identical,
		summary: {
			total: drift.length,
			byCategory: { VARIABLE_CHANGED: drift.length },
			bySeverity: { high: drift.filter((entry) => entry.severity === "high").length },
		},
		drift,
	};
}

// Build a Phase 45 envelope from a per-request admission map.
function blastRadiusResult({
	decisions,
	workspaceId = WORKSPACE_ID,
	snapshotId = SNAPSHOT_ID,
	environmentId = SOURCE_ENV,
	targetEnvironmentId = TARGET_ENV,
	admissionState = "ADMITTED",
	policyIdentity = POLICY_IDENTITY,
} = {}) {
	const entries = Object.entries(decisions).map(([requestId, decision]) => ({
		requestId,
		host: decision.host ?? "api.test",
		hostKey: decision.hostKey ?? "api.test",
		port: decision.port ?? null,
		method: decision.method ?? "GET",
		classification: decision.classification ?? "NON_MUTATING",
		mutating: decision.mutating === true,
		admission: decision.admission,
		reasonCodes: decision.reasonCodes ?? [],
	}));
	const byState = (state) => entries.filter((entry) => entry.admission === state);
	return {
		kind: "tracer.blast-radius-envelope",
		version: 1,
		policy: { kind: "tracer.blast-radius-policy", version: 1, identity: policyIdentity },
		workspace: { workspaceId, snapshotId },
		environment: { environmentId, targetEnvironmentId },
		admissionState,
		requests: {
			proposed: entries.length,
			admitted: byState("ADMITTED").length,
			blocked: byState("BLOCKED").length,
			unknown: byState("UNKNOWN").length,
			requiresConfirmation: byState("REQUIRES_CONFIRMATION").length,
		},
		allowedRequests: byState("ADMITTED"),
		blockedRequests: byState("BLOCKED"),
		unknownRequests: byState("UNKNOWN"),
		confirmationRequests: byState("REQUIRES_CONFIRMATION"),
	};
}

function baseInput(overrides = {}) {
	const input = {
		workspaceId: WORKSPACE_ID,
		snapshot: { snapshotId: SNAPSHOT_ID, snapshotFingerprint: SNAPSHOT_FP },
		source: { environmentId: SOURCE_ENV, snapshotFingerprint: SNAPSHOT_FP },
		target: { environmentId: TARGET_ENV, snapshotFingerprint: SNAPSHOT_FP },
		impact: impactResult({ direct: ["r1"] }),
		drift: driftResult(),
		blastRadius: undefined,
		candidates: [{ requestId: "r1", collectionId: "col-1", host: "api.test", method: "GET" }],
		...overrides,
	};
	// `undefined` means "build a default ADMITTED envelope for every impacted
	// request", so individual cases only declare the decisions they intend to test.
	// An explicit `null` means "no envelope", which the caller is testing.
	if (input.blastRadius === undefined) {
		const impacted = [
			...(input.impact?.requests?.direct ?? []),
			...(input.impact?.requests?.indirect ?? []),
		].map((row) => row.requestId);
		const decisions = {};
		for (const requestId of impacted) {
			const candidate = (input.candidates ?? []).find((entry) => entry.requestId === requestId);
			decisions[requestId] = {
				admission: "ADMITTED",
				host: candidate?.host ?? "api.test",
				method: candidate?.method ?? "GET",
			};
		}
		input.blastRadius = blastRadiusResult({ decisions });
	}
	return input;
}

function planOf(input) {
	return planRehearsal(input);
}

function stepIds(plan) {
	return plan.steps.map((step) => step.requestId);
}

// ---------------------------------------------------------------------------
// 1. One impacted request
// ---------------------------------------------------------------------------

describe("Phase 46A — single impacted request", () => {
	test("plans exactly one executable step and fingerprints it", () => {
		const plan = planOf(baseInput());
		expect(plan.state).toBe(PLAN_STATES.PLANNED);
		expect(stepIds(plan)).toEqual(["r1"]);
		expect(plan.steps[0].state).toBe(STEP_STATES.EXECUTABLE);
		expect(plan.steps[0].ordinal).toBe(0);
		expect(plan.steps[0].admitted).toBe(true);
		expect(plan.impactedRequestIds).toEqual(["r1"]);
		expect(plan.executableRequestIds).toEqual(["r1"]);
		expect(plan.identity.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(plan.summary.executable).toBe(1);
	});

	test("a step carries stable identity and no payload", () => {
		const plan = planOf(baseInput());
		const step = plan.steps[0];
		expect(step.stepId).toBe("step:r1");
		expect(Object.keys(step).sort()).toEqual(
			[
				"admitted",
				"blastRadiusAdmission",
				"collectionId",
				"confidence",
				"dependencies",
				"dependents",
				"hop",
				"host",
				"hostKey",
				"impact",
				"method",
				"mutationClassification",
				"mutating",
				"ordinal",
				"port",
				"reasonCodes",
				"requestId",
				"state",
				"stepId",
			].sort(),
		);
	});
});

// ---------------------------------------------------------------------------
// 2. Several independent requests
// ---------------------------------------------------------------------------

describe("Phase 46A — several independent requests", () => {
	test("orders independent requests deterministically by requestId", () => {
		const plan = planOf(
			baseInput({
				impact: impactResult({ direct: ["r3", "r1", "r2"] }),
				blastRadius: blastRadiusResult({
					decisions: { r1: { admission: "ADMITTED" }, r2: { admission: "ADMITTED" }, r3: { admission: "ADMITTED" } },
				}),
				candidates: [
					{ requestId: "r3", host: "api.test", method: "GET" },
					{ requestId: "r1", host: "api.test", method: "GET" },
					{ requestId: "r2", host: "api.test", method: "GET" },
				],
			}),
		);
		expect(plan.state).toBe(PLAN_STATES.PLANNED);
		expect(stepIds(plan)).toEqual(["r1", "r2", "r3"]);
		expect(plan.steps.map((step) => step.ordinal)).toEqual([0, 1, 2]);
	});
});

// ---------------------------------------------------------------------------
// 3 & 4. Dependency ordering and transitive dependency ordering
// ---------------------------------------------------------------------------

describe("Phase 46A — dependency ordering", () => {
	test("a dependency appears before its dependent", () => {
		const plan = planOf(
			baseInput({
				impact: impactResult({ direct: ["a", "b"] }),
				blastRadius: blastRadiusResult({
					decisions: { a: { admission: "ADMITTED" }, b: { admission: "ADMITTED" } },
				}),
				candidates: [
					{ requestId: "b", host: "api.test", method: "GET", dependsOn: ["a"] },
					{ requestId: "a", host: "api.test", method: "GET" },
				],
			}),
		);
		expect(stepIds(plan)).toEqual(["a", "b"]);
		const stepB = plan.steps.find((step) => step.requestId === "b");
		expect(stepB.dependencies).toEqual([{ requestId: "a", marker: null, kind: DEPENDENCY_KINDS.RESOLVED }]);
		expect(plan.steps.find((step) => step.requestId === "a").dependents).toEqual(["b"]);
	});

	test("transitive dependencies are all ordered before the leaf", () => {
		const plan = planOf(
			baseInput({
				impact: impactResult({ direct: ["a", "b", "c"] }),
				blastRadius: blastRadiusResult({
					decisions: { a: { admission: "ADMITTED" }, b: { admission: "ADMITTED" }, c: { admission: "ADMITTED" } },
				}),
				candidates: [
					{ requestId: "c", host: "api.test", method: "GET", dependsOn: ["b"] },
					{ requestId: "b", host: "api.test", method: "GET", dependsOn: ["a"] },
					{ requestId: "a", host: "api.test", method: "GET" },
				],
			}),
		);
		expect(stepIds(plan)).toEqual(["a", "b", "c"]);
	});
});

// ---------------------------------------------------------------------------
// 5 & 6. Deterministic tie-break and input-order independence
// ---------------------------------------------------------------------------

describe("Phase 46A — determinism", () => {
	test("deterministic tie-break: independent requests order by requestId even when supplied shuffled", () => {
		const decisions = { a: { admission: "ADMITTED" }, b: { admission: "ADMITTED" }, c: { admission: "ADMITTED" } };
		const forward = planOf(
			baseInput({
				impact: impactResult({ direct: ["a", "b", "c"] }),
				blastRadius: blastRadiusResult({ decisions }),
				candidates: [
					{ requestId: "a", host: "api.test", method: "GET" },
					{ requestId: "b", host: "api.test", method: "GET" },
					{ requestId: "c", host: "api.test", method: "GET" },
				],
			}),
		);
		const reverse = planOf(
			baseInput({
				impact: impactResult({ direct: ["c", "b", "a"] }),
				blastRadius: blastRadiusResult({ decisions }),
				candidates: [
					{ requestId: "c", host: "api.test", method: "GET" },
					{ requestId: "b", host: "api.test", method: "GET" },
					{ requestId: "a", host: "api.test", method: "GET" },
				],
			}),
		);
		expect(stepIds(forward)).toEqual(["a", "b", "c"]);
		expect(stepIds(reverse)).toEqual(["a", "b", "c"]);
		expect(forward.identity.planFingerprint).toBe(reverse.identity.planFingerprint);
		expect(canonicalPlanJson(forward)).toBe(canonicalPlanJson(reverse));
	});

	test("input-order independence across dependency declaration order", () => {
		const decisions = { a: { admission: "ADMITTED" }, b: { admission: "ADMITTED" }, c: { admission: "ADMITTED" } };
		const asCandidates = planOf(
			baseInput({
				impact: impactResult({ direct: ["a", "b", "c"] }),
				blastRadius: blastRadiusResult({ decisions }),
				candidates: [
					{ requestId: "a", host: "api.test", method: "GET" },
					{ requestId: "b", host: "api.test", method: "GET", dependsOn: ["a"] },
					{ requestId: "c", host: "api.test", method: "GET", dependsOn: ["a"] },
				],
			}),
		);
		const asDependencies = planOf(
			baseInput({
				impact: impactResult({ direct: ["c", "a", "b"] }),
				blastRadius: blastRadiusResult({ decisions }),
				candidates: [
					{ requestId: "c", host: "api.test", method: "GET" },
					{ requestId: "b", host: "api.test", method: "GET" },
					{ requestId: "a", host: "api.test", method: "GET" },
				],
				dependencies: [
					{ requestId: "b", dependsOn: ["a"] },
					{ requestId: "c", dependsOn: ["a"] },
				],
			}),
		);
		expect(stepIds(asCandidates)).toEqual(["a", "b", "c"]);
		expect(stepIds(asDependencies)).toEqual(["a", "b", "c"]);
		expect(asCandidates.identity.planFingerprint).toBe(asDependencies.identity.planFingerprint);
	});
});

// ---------------------------------------------------------------------------
// 7. Cycle detection
// ---------------------------------------------------------------------------

describe("Phase 46A — cycles", () => {
	test("a mutual dependency is detected and represented, and neither is executable", () => {
		const plan = planOf(
			baseInput({
				impact: impactResult({ direct: ["a", "b"] }),
				blastRadius: blastRadiusResult({
					decisions: { a: { admission: "ADMITTED" }, b: { admission: "ADMITTED" } },
				}),
				candidates: [
					{ requestId: "a", host: "api.test", method: "GET", dependsOn: ["b"] },
					{ requestId: "b", host: "api.test", method: "GET", dependsOn: ["a"] },
				],
			}),
		);
		expect(plan.state).toBe(PLAN_STATES.EMPTY);
		expect(plan.executableRequestIds).toEqual([]);
		expect(plan.cycleRequestIds).toEqual(["a", "b"]);
		expect(plan.cycles).toEqual([{ kind: CYCLE_KINDS.MUTUAL, requestIds: ["a", "b"] }]);
		expect(plan.reasonCodes).toContain(PLAN_REASON_CODES.DEPENDENCY_CYCLE);
	});

	test("a self dependency is a degenerate cycle", () => {
		const plan = planOf(
			baseInput({
				impact: impactResult({ direct: ["a"] }),
				blastRadius: blastRadiusResult({ decisions: { a: { admission: "ADMITTED" } } }),
				candidates: [{ requestId: "a", host: "api.test", method: "GET", dependsOn: ["a"] }],
			}),
		);
		expect(plan.state).toBe(PLAN_STATES.EMPTY);
		expect(plan.cycleRequestIds).toEqual(["a"]);
		expect(plan.cycles).toEqual([{ kind: CYCLE_KINDS.SELF, requestIds: ["a"] }]);
	});

	test("detectCycles finds cycles independent of input order", () => {
		const candidateIds = new Set(["a", "b", "c"]);
		const edges = [
			{ owner: "a", requestId: "b", target: "b", kind: DEPENDENCY_KINDS.RESOLVED },
			{ owner: "b", requestId: "a", target: "a", kind: DEPENDENCY_KINDS.RESOLVED },
			{ owner: "c", requestId: "c", target: "c", kind: DEPENDENCY_KINDS.SELF },
		];
		const cycles = detectCycles(candidateIds, edges);
		expect(cycles).toEqual([
			{ kind: CYCLE_KINDS.MUTUAL, requestIds: ["a", "b"] },
			{ kind: CYCLE_KINDS.SELF, requestIds: ["c"] },
		]);
	});
});

// ---------------------------------------------------------------------------
// 8. Unknown dependency
// ---------------------------------------------------------------------------

describe("Phase 46A — unresolved dependencies", () => {
	test("an external dependency is preserved and keeps the dependent out of the executable set", () => {
		const plan = planOf(
			baseInput({
				impact: impactResult({ direct: ["a"] }),
				blastRadius: blastRadiusResult({ decisions: { a: { admission: "ADMITTED" } } }),
				candidates: [{ requestId: "a", host: "api.test", method: "GET", dependsOn: ["missing"] }],
			}),
		);
		expect(plan.state).toBe(PLAN_STATES.EMPTY);
		expect(plan.unresolvedDependencyRequestIds).toEqual(["a"]);
		expect(plan.reasonCodes).toContain(PLAN_REASON_CODES.DEPENDENCY_TARGET_EXTERNAL);
		expect(plan.excluded.find((entry) => entry.requestId === "a").state).toBe(STEP_STATES.DEPENDENCY_UNRESOLVED);
	});

	test("a dynamic dependency is preserved and keeps the dependent out of the executable set", () => {
		const plan = planOf(
			baseInput({
				impact: impactResult({ direct: ["a"] }),
				blastRadius: blastRadiusResult({ decisions: { a: { admission: "ADMITTED" } } }),
				candidates: [{ requestId: "a", host: "api.test", method: "GET", dynamicDependencies: ["{{dynamicBaseUrl}}"] }],
			}),
		);
		expect(plan.state).toBe(PLAN_STATES.EMPTY);
		expect(plan.reasonCodes).toContain(PLAN_REASON_CODES.DYNAMIC_DEPENDENCY_UNRESOLVED);
		expect(plan.excluded.find((entry) => entry.requestId === "a").state).toBe(STEP_STATES.DEPENDENCY_UNRESOLVED);
	});

	test("topologicalOrder leaves cyclic nodes as leftover", () => {
		const { order, leftover } = topologicalOrder(
			["a", "b", "c"],
			[
				{ owner: "a", requestId: "b", target: "b", kind: DEPENDENCY_KINDS.RESOLVED },
				{ owner: "b", requestId: "a", target: "a", kind: DEPENDENCY_KINDS.RESOLVED },
			],
		);
		expect(order).toEqual(["c"]);
		expect(leftover).toEqual(["a", "b"]);
	});

	test("a request whose resolved dependency is blocked is not executable", () => {
		const plan = planOf(
			baseInput({
				impact: impactResult({ direct: ["a", "b"] }),
				blastRadius: blastRadiusResult({
					decisions: {
						a: { admission: "BLOCKED", reasonCodes: ["HOST_NOT_ALLOWED"] },
						b: { admission: "ADMITTED" },
					},
				}),
				candidates: [
					{ requestId: "a", host: "api.test", method: "GET" },
					{ requestId: "b", host: "api.test", method: "GET", dependsOn: ["a"] },
				],
			}),
		);
		expect(stepIds(plan)).toEqual([]);
		expect(plan.executableRequestIds).toEqual([]);
		const stepB = plan.excluded.find((entry) => entry.requestId === "b");
		expect(stepB.state).toBe(STEP_STATES.DEPENDENCY_UNRESOLVED);
		expect(stepB.reasonCodes).toContain(PLAN_REASON_CODES.DEPENDENCY_TARGET_NOT_EXECUTABLE);
	});

	test("dependency unsatifiability propagates transitively to a fixpoint", () => {
		const plan = planOf(
			baseInput({
				impact: impactResult({ direct: ["a", "b", "c"] }),
				blastRadius: blastRadiusResult({
					decisions: {
						a: { admission: "REQUIRES_CONFIRMATION", method: "POST", mutating: true },
						b: { admission: "ADMITTED" },
						c: { admission: "ADMITTED" },
					},
				}),
				candidates: [
					{ requestId: "a", host: "api.test", method: "POST" },
					{ requestId: "b", host: "api.test", method: "GET", dependsOn: ["a"] },
					{ requestId: "c", host: "api.test", method: "GET", dependsOn: ["b"] },
				],
			}),
		);
		expect(plan.executableRequestIds).toEqual([]);
		expect(plan.requiresConfirmationRequestIds).toEqual(["a"]);
		for (const id of ["b", "c"]) {
			expect(plan.excluded.find((entry) => entry.requestId === id).state).toBe(STEP_STATES.DEPENDENCY_UNRESOLVED);
		}
	});
});

// ---------------------------------------------------------------------------
// 9 & 10 & 11. Blocked / unknown / confirmation-required blast radius states
// ---------------------------------------------------------------------------

describe("Phase 46A — blast-radius states", () => {
	test("a BLOCKED request cannot become executable", () => {
		const plan = planOf(
			baseInput({
				blastRadius: blastRadiusResult({
					decisions: { r1: { admission: "BLOCKED", reasonCodes: ["HOST_NOT_ALLOWED"] } },
				}),
			}),
		);
		expect(plan.executableRequestIds).toEqual([]);
		expect(plan.blockedRequestIds).toEqual(["r1"]);
		expect(plan.state).toBe(PLAN_STATES.EMPTY);
		expect(plan.reasonCodes).toContain(PLAN_REASON_CODES.BLAST_RADIUS_NOT_ADMITTED);
	});

	test("an UNKNOWN blast-radius request cannot silently become executable", () => {
		const plan = planOf(
			baseInput({
				blastRadius: blastRadiusResult({
					decisions: { r1: { admission: "UNKNOWN", reasonCodes: ["UNKNOWN_HOST"] } },
				}),
			}),
		);
		expect(plan.executableRequestIds).toEqual([]);
		expect(plan.unknownRequestIds).toEqual(["r1"]);
		expect(plan.reasonCodes).toContain(PLAN_REASON_CODES.UNKNOWN_SAFETY);
		expect(plan.excluded.find((entry) => entry.requestId === "r1").state).toBe(STEP_STATES.UNKNOWN);
	});

	test("a REQUIRES_CONFIRMATION request stays explicit and is not executable", () => {
		const plan = planOf(
			baseInput({
				blastRadius: blastRadiusResult({
					decisions: {
					r1: {
						admission: "REQUIRES_CONFIRMATION",
						reasonCodes: ["MUTATING_CONFIRMATION_REQUIRED"],
						method: "POST",
						mutating: true,
					},
				},
				}),
			}),
		);
		expect(plan.executableRequestIds).toEqual([]);
		expect(plan.requiresConfirmationRequestIds).toEqual(["r1"]);
		expect(plan.reasonCodes).toContain(PLAN_REASON_CODES.REQUIRES_CONFIRMATION);
		expect(plan.excluded.find((entry) => entry.requestId === "r1").state).toBe(STEP_STATES.REQUIRES_CONFIRMATION);
	});

	test("a request absent from the blast-radius envelope is not admitted (fail closed)", () => {
		const plan = planOf(
			baseInput({
				blastRadius: blastRadiusResult({ decisions: {} }),
			}),
		);
		expect(plan.executableRequestIds).toEqual([]);
		expect(plan.unknownRequestIds).toEqual(["r1"]);
		expect(plan.reasonCodes).toContain(PLAN_REASON_CODES.BLAST_RADIUS_NOT_ADMITTED);
	});

	test("a missing blast-radius envelope admits nothing", () => {
		const plan = planOf(baseInput({ blastRadius: null }));
		expect(plan.executableRequestIds).toEqual([]);
		expect(plan.state).toBe(PLAN_STATES.EMPTY);
		expect(plan.reasonCodes).toContain(PLAN_REASON_CODES.BLAST_RADIUS_MISSING);
		expect(plan.blastRadius.policyIdentity).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 12. Zero admitted requests
// ---------------------------------------------------------------------------

describe("Phase 46A — zero admitted requests", () => {
	test("an empty candidate set cannot be planned (schema rejects it)", () => {
		expect(() => planOf(baseInput({ candidates: [] }))).toThrow();
	});

	test("impacted requests that are all excluded produce an explicit EMPTY plan", () => {
		const plan = planOf(
			baseInput({
				impact: impactResult({ resolved: false }),
				blastRadius: blastRadiusResult({ decisions: { r1: { admission: "ADMITTED" } } }),
			}),
		);
		// impact present but no request rows -> nothing impacted
		expect(plan.executableRequestIds).toEqual([]);
		expect(plan.state).toBe(PLAN_STATES.EMPTY);
		expect(plan.reasonCodes).toContain(PLAN_REASON_CODES.NO_ADMITTED_REQUESTS);
		expect(plan.excluded.find((entry) => entry.requestId === "r1").state).toBe(STEP_STATES.EXCLUDED);
	});
});

// ---------------------------------------------------------------------------
// 13 & 14. Missing impact / missing drift
// ---------------------------------------------------------------------------

describe("Phase 46A — missing evidence", () => {
	test("a missing impact result yields an EMPTY plan with an explicit reason", () => {
		const plan = planOf(baseInput({ impact: null }));
		expect(plan.state).toBe(PLAN_STATES.EMPTY);
		expect(plan.reasonCodes).toContain(PLAN_REASON_CODES.IMPACT_MISSING);
		expect(plan.executableRequestIds).toEqual([]);
		expect(plan.impactedRequestIds).toEqual([]);
	});

	test("a missing drift result is recorded as a prerequisite (not silently safe)", () => {
		const plan = planOf(baseInput({ drift: null }));
		expect(plan.reasonCodes).toContain(PLAN_REASON_CODES.DRIFT_MISSING);
		expect(plan.prerequisites.some((entry) => entry.code === PLAN_REASON_CODES.DRIFT_MISSING)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 15 & 16. Stale snapshot identity / wrong target environment
// ---------------------------------------------------------------------------

describe("Phase 46A — identity binding", () => {
	test("a stale/wrong snapshot identity fails closed", () => {
		expect(() =>
			planOf(
				baseInput({
					source: { environmentId: SOURCE_ENV, snapshotFingerprint: "fp-other-snapshot" },
				}),
			),
		).toThrow();
		try {
			planOf(baseInput({ target: { environmentId: TARGET_ENV, snapshotFingerprint: "fp-other-snapshot" } }));
		} catch (error) {
			expect(error.code).toBe(REHEARSAL_PLANNING_ERROR_CODES.SNAPSHOT_STALE);
		}
	});

	test("a snapshot identity with neither id nor fingerprint is rejected", () => {
		expect(() => planOf(baseInput({ snapshot: {} }))).toThrow();
	});

	test("a drift result describing a different target environment fails closed", () => {
		expect(() =>
			planOf(baseInput({ drift: driftResult({ targetEnvironmentId: "env-production" }) })),
		).toThrow();
		try {
			planOf(baseInput({ drift: driftResult({ targetEnvironmentId: "env-production" }) }));
		} catch (error) {
			expect(error.code).toBe(REHEARSAL_PLANNING_ERROR_CODES.TARGET_ENVIRONMENT_MISMATCH);
		}
	});

	test("a blast-radius envelope evaluated for a different workspace/snapshot/target fails closed", () => {
		try {
			planOf(
				baseInput({
					blastRadius: blastRadiusResult({
						decisions: { r1: { admission: "ADMITTED" } },
						workspaceId: "ws-other",
					}),
				}),
			);
			throw new Error("expected throw");
		} catch (error) {
			expect(error.code).toBe(REHEARSAL_PLANNING_ERROR_CODES.MALFORMED_INPUT);
		}
	});
});

// ---------------------------------------------------------------------------
// 17. Duplicate request identity
// ---------------------------------------------------------------------------

describe("Phase 46A — duplicate identity", () => {
	test("duplicate candidate request ids fail closed", () => {
		try {
			planOf(
				baseInput({
					candidates: [
						{ requestId: "r1", host: "api.test", method: "GET" },
						{ requestId: "r1", host: "api.test", method: "GET" },
					],
				}),
			);
			throw new Error("expected throw");
		} catch (error) {
			expect(error.code).toBe(REHEARSAL_PLANNING_ERROR_CODES.DUPLICATE_REQUEST_ID);
		}
	});
});

// ---------------------------------------------------------------------------
// 18. Payload / secret leakage attempts
// ---------------------------------------------------------------------------

describe("Phase 46A — data minimization", () => {
	test("payloads, secrets, and credentials supplied on candidates never reach the plan", () => {
		const plan = planOf(
			baseInput({
				candidates: [
					{
						requestId: "r1",
						collectionId: "col-1",
						host: "api.test",
						method: "POST",
						// These fields are not part of the planner's trust surface. They
						// must never appear in any output.
						body: '{"password":"hunter2"}',
						url: "https://user:pass@api.test/v1?token=abc",
						headers: { Authorization: "Bearer super-secret-token", Cookie: "session=deadbeef" },
						credentials: { apiKey: "sk-live-1234567890" },
					},
				],
				blastRadius: blastRadiusResult({
					decisions: { r1: { admission: "ADMITTED", method: "POST", mutating: true } },
				}),
			}),
		);
		const serialized = JSON.stringify(plan);
		for (const secret of ["hunter2", "super-secret-token", "deadbeef", "sk-live-1234567890", "user:pass", "token=abc"]) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).not.toContain("Authorization");
		expect(serialized).not.toContain("Cookie");
	});

	test("privileged caller text in dependencies is preserved as a marker but never interpreted", () => {
		const plan = planOf(
			baseInput({
				candidates: [
					{ requestId: "r1", host: "api.test", method: "GET", dynamicDependencies: ["{{env.API_TOKEN}}"] },
				],
			}),
		);
		// The marker is a name, not a resolved value; it stays opaque and the
		// request stays unresolved.
		expect(plan.excluded.find((entry) => entry.requestId === "r1").state).toBe(STEP_STATES.DEPENDENCY_UNRESOLVED);
		expect(JSON.stringify(plan)).toContain("{{env.API_TOKEN}}");
	});
});

// ---------------------------------------------------------------------------
// 19 & 20. Deterministic repeated output and cross-process determinism
// ---------------------------------------------------------------------------

describe("Phase 46A — repeated and cross-process determinism", () => {
	test("repeated identical input produces byte-stable output", () => {
		const first = planOf(baseInput());
		const second = planOf(baseInput());
		expect(canonicalPlanJson(first)).toBe(canonicalPlanJson(second));
		expect(first.identity.planFingerprint).toBe(second.identity.planFingerprint);
	});

	// Booting a second Bun process is inherently slower than an in-process call,
	// so this case gets an explicit budget rather than the runner default.
	test(
		"cross-process determinism: a spawned process produces the identical fingerprint",
		() => {
		const here = planOf(baseInput());
		const scriptPath = fileURLToPath(new URL("./cross-process-check.js", import.meta.url));
		const backendRoot = fileURLToPath(new URL("../../../", import.meta.url));
		// `process.execPath` is the running Bun binary, which is the only interpreter
		// guaranteed to be present in the environment that is already running this
		// suite. `Bun.which("bun")` can resolve to an npm shim that is not directly
		// spawnable on Windows, so it is deliberately not used. Paths go through
		// `fileURLToPath` because a raw URL `pathname` keeps the leading `/C:/` form
		// that Windows `spawn` cannot use as a working directory.
		const result = spawnSync(process.execPath, ["run", scriptPath], {
			cwd: backendRoot,
			encoding: "utf8",
			env: {
				...process.env,
				EXECUTION_FINGERPRINT_KEY: process.env.EXECUTION_FINGERPRINT_KEY,
				JWT_SECRET: process.env.JWT_SECRET,
				MONGODB_URI: process.env.MONGODB_URI,
			},
		});
		if (result.status !== 0) {
			throw new Error(`cross-process check failed: ${result.stderr ?? ""}`);
		}
		const parsed = JSON.parse(result.stdout.trim());
		expect(parsed.planFingerprint).toBe(here.identity.planFingerprint);
		expect(parsed.canonical).toBe(canonicalPlanJson(here));
		},
		20_000,
	);
});

// ---------------------------------------------------------------------------
// Plan identity helpers and the closed result schema
// ---------------------------------------------------------------------------

describe("Phase 46A — identity primitives", () => {
	test("canonicalizePlanValue sorts keys, drops undefined, and preserves array order", () => {
		const canonical = canonicalizePlanValue({ b: 1, a: { d: 2, c: undefined }, list: [3, 1] });
		expect(Object.keys(canonical)).toEqual(["a", "b", "list"]);
		expect(Object.keys(canonical.a)).toEqual(["d"]);
		expect(canonical.list).toEqual([3, 1]);
	});

	test("planIdentityOf is stable across key insertion order and reports the key id", () => {
		const left = planIdentityOf({ steps: ["a"], state: "PLANNED" });
		const right = planIdentityOf({ state: "PLANNED", steps: ["a"] });
		expect(left).toBe(right);
		expect(left).toMatch(/^[a-f0-9]{64}$/);
		expect(planFingerprintKeyId()).toBe("v1");
	});

	test("planDisplayDigest is a display-only digest, never an identity", () => {
		const identity = planOf(baseInput()).identity.planFingerprint;
		const digest = planDisplayDigest(identity);
		expect(digest).toMatch(/^plan:[0-9a-f]{8}:\d+$/);
		expect(digest).not.toBe(identity);
		expect(planDisplayDigest(identity)).toBe(digest);
	});
});

describe("Phase 46A — result schema", () => {
	test("the closed vocabulary rejects an unknown plan reason code", () => {
		const plan = planOf(baseInput());
		expect(() => assertRehearsalPlanResult({ ...plan, reasonCodes: ["NOT_A_REAL_REASON"] })).toThrow();
	});

	test("the closed vocabulary rejects an unknown step state and cycle kind", () => {
		const plan = planOf(baseInput());
		expect(() =>
			assertRehearsalPlanResult({ ...plan, steps: [{ ...plan.steps[0], state: "MAYBE" }] }),
		).toThrow();
		expect(() =>
			assertRehearsalPlanResult({ ...plan, cycles: [{ kind: "TANGLE", requestIds: ["a"] }] }),
		).toThrow();
	});

	test("a valid plan round-trips through the result schema", () => {
		const plan = planOf(baseInput());
		expect(() => assertRehearsalPlanResult(plan)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Integration seam
// ---------------------------------------------------------------------------

describe("Phase 46A — integration seam", () => {
	test("createRehearsalPlanner composes injected sources and runs the same pure planner", () => {
		const plan = createRehearsalPlanner({
			impactSource: () => impactResult({ direct: ["r1"] }),
			driftSource: () => driftResult(),
			blastRadiusSource: ({ requests }) =>
				blastRadiusResult({ decisions: Object.fromEntries(requests.map((request) => [request.requestId, { admission: "ADMITTED" }])) }),
		})({
			workspaceId: WORKSPACE_ID,
			snapshot: { snapshotId: SNAPSHOT_ID, snapshotFingerprint: SNAPSHOT_FP },
			source: { environmentId: SOURCE_ENV, snapshotFingerprint: SNAPSHOT_FP },
			target: { environmentId: TARGET_ENV, snapshotFingerprint: SNAPSHOT_FP },
			workspaceDiff: { changes: [] },
			collection: { id: "col-1" },
			sourceEnvironment: { id: SOURCE_ENV },
			targetEnvironment: { id: TARGET_ENV },
			policy: {},
			candidates: [{ requestId: "r1", host: "api.test", method: "GET" }],
		});
		expect(plan.state).toBe(PLAN_STATES.PLANNED);
		expect(stepIds(plan)).toEqual(["r1"]);
	});

	test("structural shape guards accept the real envelopes and reject garbage", () => {
		expect(acceptsRehearsalPlanImpactShape(impactResult())).toBe(true);
		expect(acceptsRehearsalPlanDriftShape(driftResult())).toBe(true);
		expect(acceptsRehearsalPlanBlastRadiusShape(blastRadiusResult({ decisions: {} }))).toBe(true);
		expect(acceptsRehearsalPlanImpactShape(null)).toBe(false);
		expect(acceptsRehearsalPlanDriftShape(42)).toBe(false);
		expect(acceptsRehearsalPlanBlastRadiusShape("nope")).toBe(false);
	});
});
