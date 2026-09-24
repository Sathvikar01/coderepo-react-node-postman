import { describe, expect, test } from "bun:test";
import { analyzeChange, analyzeWorkspaceDiff } from "../change-impact/index.js";
import { analyzeEnvironmentDrift } from "../environment-drift/index.js";
import { verifyCrossEnvironment, VERIFICATION_STATE } from "../cross-env-verification/index.js";
import {
	changeImpactFromWorkspaceDiff,
	environmentDriftFromEnvironments,
	hasDiffEnvelope,
	hasDriftEnvelope,
	hasImpactEnvelope,
	projectChangeImpact,
	projectEnvironmentDrift,
	verifyMove,
} from "./index.js";

// Phase 44 — Cross-core integration test suite.
//
// Proves the three merged backend cores coexist through their public interfaces:
//
//   Snapshot/Diff  ->  Change Impact  ->  Environment Drift  ->  Verification
//
// These tests deliberately use the *real* Phase 39 and Phase 40 services and feed
// their real envelopes through the projection adapter into the *real* Phase 41
// engine. Nothing here reimplements impact, drift, or verification, and nothing
// performs a rehearsal execution.

const PROFILE_ID = "profile-1";
const ENV_SOURCE = "env-local";
const ENV_TARGET = "env-staging";

function variable(id, key, value) {
	return { id, key, kind: "plain", value, enabled: true };
}

// A small but realistic workspace: a collection variable that two requests read,
// and a request that reads nothing the change touches.
function workspace({ region = "us", requestUrl = "{{BASE_URL}}/orders" } = {}) {
	return {
		ownerProfileId: PROFILE_ID,
		environmentId: ENV_SOURCE,
		collections: [
			{
				id: "col-1",
				ownerProfileId: PROFILE_ID,
				name: "Orders",
				auth: { mode: "none" },
				variables: [variable("cv-1", "REGION", region)],
				requests: [
					{
						id: "req-affected",
						name: "List orders",
						method: "GET",
						urlTemplate: requestUrl,
						headers: [{ id: "h-1", key: "X-Region", value: "{{REGION}}" }],
						auth: { mode: "none" },
					},
					{
						id: "req-unaffected",
						name: "Health",
						method: "GET",
						urlTemplate: "{{BASE_URL}}/health",
						auth: { mode: "none" },
					},
				],
			},
		],
		environments: [
			{ id: ENV_SOURCE, ownerProfileId: PROFILE_ID, name: "Local", variables: [variable("e-1", "BASE_URL", "http://127.0.0.1:8000")] },
			{ id: ENV_TARGET, ownerProfileId: PROFILE_ID, name: "Staging", variables: [variable("e-2", "BASE_URL", "http://127.0.0.1:8000")] },
		],
	};
}

// A change to the collection variable REGION. `req-affected` reads it directly,
// so the impact result names it as a direct impact row.
function regionChange() {
	return {
		operation: "changed",
		target: { kind: "collectionVariable", collectionId: "col-1", key: "REGION" },
		after: { value: "eu" },
	};
}

function impactResult() {
	return analyzeChange({ workspace: workspace(), change: regionChange() });
}

// Drift between two environment states. `bySeverity` decides whether verification
// can succeed: a high-severity BASE_URL change is a blocker.
function driftResult({ targetBaseUrl = "http://127.0.0.1:8000" } = {}) {
	const collection = workspace().collections[0];
	return analyzeEnvironmentDrift({
		collection,
		sourceEnvironment: { id: ENV_SOURCE, name: "Local", variables: [variable("e-1", "BASE_URL", "http://127.0.0.1:8000")] },
		targetEnvironment: { id: ENV_TARGET, name: "Staging", variables: [variable("e-2", "BASE_URL", targetBaseUrl)] },
	});
}

// A drift result with no differences. Both sides carry the same environment
// identity and the same effective configuration, so the comparator reports zero
// entries. This is the only shape that can accompany a VERIFIED outcome.
function identicalDriftResult() {
	return analyzeEnvironmentDrift({
		collection: workspace().collections[0],
		sourceEnvironment: { id: ENV_SOURCE, name: "Local", variables: [variable("e-1", "BASE_URL", "http://127.0.0.1:8000")] },
		targetEnvironment: { id: ENV_SOURCE, name: "Local", variables: [variable("e-1", "BASE_URL", "http://127.0.0.1:8000")] },
	});
}

// Evidence bound to the target side for a request.
function execution(requestId) {
	return {
		executionId: `exec-${requestId}`,
		requestId,
		collectionId: "col-1",
		snapshotFingerprint: "fp-target",
		snapshotId: "snap-target",
		environmentId: ENV_TARGET,
		environmentName: "Staging",
		outcome: "response",
		complete: true,
		startedAt: "2026-09-24T00:00:00.000Z",
		finishedAt: "2026-09-24T00:00:01.000Z",
	};
}

const IDENTITY = {
	source: { collectionId: "col-1", environmentId: ENV_SOURCE, environmentName: "Local", snapshotFingerprint: "fp-source" },
	target: {
		collectionId: "col-1",
		environmentId: ENV_TARGET,
		environmentName: "Staging",
		snapshotId: "snap-target",
		snapshotFingerprint: "fp-target",
	},
};

// ---------------------------------------------------------------------------
// Projection guards
// ---------------------------------------------------------------------------
describe("core integration — envelope guards", () => {
	test("recognises a real Phase 39 impact envelope and a workspace-diff envelope", () => {
		const impact = impactResult();
		const diff = analyzeWorkspaceDiff({ before: workspace(), after: workspace({ region: "eu" }) });
		expect(hasImpactEnvelope(impact)).toBe(true);
		expect(hasDiffEnvelope(diff)).toBe(true);
		expect(hasImpactEnvelope(diff)).toBe(false);
		expect(hasImpactEnvelope({ kind: "tracer.change-impact" })).toBe(false);
		expect(hasImpactEnvelope(null)).toBe(false);
	});

	test("recognises a real Phase 40 drift envelope", () => {
		const drift = driftResult();
		expect(hasDriftEnvelope(drift)).toBe(true);
		expect(hasDriftEnvelope(impactResult())).toBe(false);
		expect(hasDriftEnvelope({ kind: "tracer.environment-drift" })).toBe(false);
	});

	test("projecting a non-core value yields null so the engine treats it as missing", () => {
		expect(projectChangeImpact(undefined)).toBeNull();
		expect(projectChangeImpact({ kind: "something-else" })).toBeNull();
		expect(projectEnvironmentDrift({ kind: "tracer.change-impact" })).toBeNull();
		expect(projectEnvironmentDrift(null)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Projection fidelity
// ---------------------------------------------------------------------------
describe("core integration — projections keep only what Phase 41 reads", () => {
	test("the impact projection drops envelope-only fields and keeps the request rows", () => {
		const projected = projectChangeImpact(impactResult());
		expect(Object.keys(projected).sort()).toEqual(["requests", "resolved", "summary", "truncated", "unknown"]);
		expect(projected.requests.direct.map((row) => row.requestId)).toEqual(["req-affected"]);
		expect(projected.resolved).toBe(true);
	});

	test("the impact summary is reduced to the three counts Phase 41 accepts", () => {
		const projected = projectChangeImpact(impactResult());
		expect(Object.keys(projected.summary).sort()).toEqual(["directRequests", "indirectRequests", "unknownReferences"]);
	});

	test("the drift projection preserves severity and status per entry", () => {
		const projected = projectEnvironmentDrift(driftResult());
		expect(Object.keys(projected).sort()).toEqual(["drift", "identical", "summary"]);
		expect(projected.drift.every((entry) => typeof entry.severity === "string" && typeof entry.status === "string")).toBe(true);
	});

	test("a projected envelope passes Phase 41's own strict input contract", () => {
		// The whole point of the projection: raw envelopes are rejected, projected
		// ones are accepted, and the engine returns a result instead of a 400.
		const raw = () => {
			try {
				verifyCrossEnvironment({ ...IDENTITY, changeImpact: impactResult(), environmentDrift: driftResult() });
				return "accepted";
			} catch (error) {
				return error.code ?? error.name;
			}
		};
		expect(raw()).toBe("CROSS_ENV_VERIFICATION_INVALID_INPUT");

		const result = verifyMove({ ...IDENTITY, changeImpact: impactResult(), environmentDrift: driftResult() });
		expect(result.kind).toBe("tracer.cross-env-verification");
		expect(result.state).toBe(VERIFICATION_STATE.NEEDS_REHEARSAL);
	});
});

// ---------------------------------------------------------------------------
// Phase 39 -> Phase 41
// ---------------------------------------------------------------------------
describe("core integration — Phase 39 impact consumed by Phase 41", () => {
	test("an affected request with no evidence yields NEEDS_REHEARSAL", () => {
		const result = verifyMove({ ...IDENTITY, changeImpact: impactResult(), environmentDrift: driftResult(), executions: [] });
		expect(result.state).toBe(VERIFICATION_STATE.NEEDS_REHEARSAL);
		expect(result.requiredRehearsalRequestIds).toContain("req-affected");
		expect(result.state).not.toBe(VERIFICATION_STATE.VERIFIED);
	});

	test("the required rehearsal set is derived from the real impact rows", () => {
		const result = verifyMove({ ...IDENTITY, changeImpact: impactResult(), environmentDrift: driftResult() });
		expect(result.requiredRehearsalRequestIds).toEqual(["req-affected"]);
		// The unaffected request must not be forced into rehearsal by the core.
		expect(result.requiredRehearsalRequestIds).not.toContain("req-unaffected");
	});

	test("a workspace-diff envelope is accepted through the same entry point", () => {
		const diff = analyzeWorkspaceDiff({ before: workspace(), after: workspace({ region: "eu" }) });
		expect(diff.kind).toBe("tracer.change-impact.diff");
		const result = verifyMove({ ...IDENTITY, changeImpact: diff, environmentDrift: driftResult() });
		expect(result.state).toBe(VERIFICATION_STATE.NEEDS_REHEARSAL);
		expect(result.requiredRehearsalRequestIds.length).toBeGreaterThan(0);
	});

	test("the composition source runs the real core and projects its result", () => {
		// The source returns the narrow Phase 41 input shape, not a full Phase 39
		// envelope: projection is the whole point of the seam.
		const projected = changeImpactFromWorkspaceDiff({ before: workspace(), after: workspace({ region: "eu" }) });
		expect(Object.keys(projected).sort()).toEqual(["requests", "resolved", "summary", "truncated", "unknown"]);
		expect(projected.requests.direct.map((row) => row.requestId)).toContain("req-affected");
	});
});

// ---------------------------------------------------------------------------
// Phase 40 -> Phase 41
// ---------------------------------------------------------------------------
describe("core integration — Phase 40 drift consumed by Phase 41", () => {
	test("high-severity drift cannot yield VERIFIED even with complete evidence", () => {
		const drift = driftResult({ targetBaseUrl: "http://127.0.0.1:9999" });
		expect(drift.identical).toBe(false);
		expect(drift.summary.bySeverity.high).toBeGreaterThan(0);

		const result = verifyMove({
			...IDENTITY,
			changeImpact: impactResult(),
			environmentDrift: drift,
			executions: [execution("req-affected")],
		});
		expect(result.state).toBe(VERIFICATION_STATE.BLOCKED);
		expect(result.state).not.toBe(VERIFICATION_STATE.VERIFIED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain("HIGH_SEVERITY_DRIFT");
	});

	test("identical drift does not block and the evidence can verify the move", () => {
		const drift = identicalDriftResult();
		expect(drift.identical).toBe(true);

		const result = verifyMove({
			...IDENTITY,
			changeImpact: impactResult(),
			environmentDrift: drift,
			executions: [execution("req-affected")],
		});
		expect(result.state).toBe(VERIFICATION_STATE.VERIFIED);
		expect(result.verifiedRequestIds).toEqual(["req-affected"]);
	});

	test("the composition source runs the real core and projects its result", () => {
		// The source returns the narrow Phase 41 input shape, not a full Phase 40
		// envelope: projection is the whole point of the seam.
		const projected = environmentDriftFromEnvironments({
			collection: workspace().collections[0],
			sourceEnvironment: { id: ENV_SOURCE, name: "Local", variables: [variable("e-1", "BASE_URL", "http://127.0.0.1:8000")] },
			targetEnvironment: { id: ENV_SOURCE, name: "Local", variables: [variable("e-1", "BASE_URL", "http://127.0.0.1:8000")] },
		});
		expect(Object.keys(projected).sort()).toEqual(["drift", "identical", "summary"]);
		expect(projected.identical).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Fail-closed invariants
// ---------------------------------------------------------------------------
describe("core integration — missing or malformed evidence never verifies", () => {
	test("missing impact is a blocker, never VERIFIED", () => {
		const result = verifyMove({ ...IDENTITY, environmentDrift: driftResult(), executions: [execution("req-affected")] });
		expect(result.state).not.toBe(VERIFICATION_STATE.VERIFIED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain("CHANGE_IMPACT_MISSING");
	});

	test("missing drift is a blocker, never VERIFIED", () => {
		const result = verifyMove({ ...IDENTITY, changeImpact: impactResult(), executions: [execution("req-affected")] });
		expect(result.state).not.toBe(VERIFICATION_STATE.VERIFIED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain("ENVIRONMENT_DRIFT_MISSING");
	});

	test("both cores missing fails closed", () => {
		const result = verifyMove({ ...IDENTITY });
		expect(result.state).not.toBe(VERIFICATION_STATE.VERIFIED);
		expect(result.blockers.length).toBeGreaterThan(0);
	});

	test("a supplied-but-unusable impact value is rejected rather than silently ignored", () => {
		expect(() => verifyMove({ ...IDENTITY, changeImpact: { kind: "not-a-core" }, environmentDrift: driftResult() })).toThrow(TypeError);
	});

	test("a supplied-but-unusable drift value is rejected rather than silently ignored", () => {
		expect(() => verifyMove({ ...IDENTITY, changeImpact: impactResult(), environmentDrift: { kind: "not-a-core" } })).toThrow(TypeError);
	});

	test("unresolved impact keeps the move out of VERIFIED", () => {
		// A change whose target does not exist in the workspace resolves as false.
		const unresolved = analyzeChange({
			workspace: workspace(),
			change: { operation: "removed", target: { kind: "collectionVariable", collectionId: "col-1", key: "NOPE" } },
		});
		expect(unresolved.resolved).toBe(false);
		const result = verifyMove({ ...IDENTITY, changeImpact: unresolved, environmentDrift: driftResult() });
		expect(result.state).not.toBe(VERIFICATION_STATE.VERIFIED);
	});
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
describe("core integration — deterministic composition", () => {
	test("two identical compositions produce byte-identical results", () => {
		const compose = () =>
			verifyMove({
				...IDENTITY,
				changeImpact: impactResult(),
				environmentDrift: driftResult({ targetBaseUrl: "http://127.0.0.1:9999" }),
				executions: [execution("req-affected")],
			});
		expect(JSON.stringify(compose())).toBe(JSON.stringify(compose()));
	});

	test("shuffling the evidence array does not change the result", () => {
		const forward = verifyMove({
			...IDENTITY,
			changeImpact: impactResult(),
			environmentDrift: identicalDriftResult(),
			executions: [execution("req-affected"), execution("req-unaffected")],
		});
		const reversed = verifyMove({
			...IDENTITY,
			changeImpact: impactResult(),
			environmentDrift: identicalDriftResult(),
			executions: [execution("req-unaffected"), execution("req-affected")],
		});
		expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
	});

	test("the four-core chain is reproducible end to end", () => {
		const chain = () => {
			const before = workspace();
			const after = workspace({ region: "eu" });
			const diff = analyzeWorkspaceDiff({ before, after });
			return verifyMove({
				...IDENTITY,
				changeImpact: diff,
				environmentDrift: identicalDriftResult(),
				executions: [execution("req-affected")],
			});
		};
		const first = chain();
		const second = chain();
		expect(first.state).toBe(VERIFICATION_STATE.VERIFIED);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});
