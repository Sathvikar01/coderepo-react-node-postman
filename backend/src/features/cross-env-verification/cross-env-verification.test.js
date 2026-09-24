import { describe, expect, test } from "bun:test";
import {
	BINDING,
	REASON_CODES,
	REQUEST_VERDICT,
	VERIFICATION_STATE,
	classifyBinding,
	computeRehearsalSet,
	dedupeEvidence,
	evaluateRequestEvidence,
	normalizeEvidence,
	verifyCrossEnvironment,
} from "./index.js";
import { parseVerificationInput } from "./verification-schema.js";

// Phase 41A — Cross-Environment Verification Core test suite.
//
// The suite is organised around the 20 required correctness cases plus the rule
// modules in isolation. Every case is deterministic: no clock, no network, no
// database, no execution. Freshness cases supply an explicit instant rather than
// reading the system clock, so the suite cannot become time-dependent.

// A minimal workspace identity pair. `target` is what evidence must bind to.
const SOURCE = { collectionId: "collection-1", snapshotFingerprint: "fp-source", snapshotId: "snap-source", environmentId: "env-dev", environmentName: "Development" };
const TARGET = { collectionId: "collection-1", snapshotFingerprint: "fp-target", snapshotId: "snap-target", environmentId: "env-staging", environmentName: "Staging" };

// No drift, no impact, no evidence — the neutral baseline each case adjusts.
function baseInput(overrides = {}) {
	return {
		source: { ...SOURCE },
		target: { ...TARGET },
		environmentDrift: { identical: true, summary: { total: 0, bySeverity: {}, byCategory: {} }, drift: [] },
		changeImpact: { resolved: true, truncated: false, requests: { direct: [], indirect: [] }, unknown: [] },
		executions: [],
		assertions: [],
		...overrides,
	};
}

function execution(overrides = {}) {
	return {
		executionId: "exec-1",
		requestId: "request-1",
		collectionId: "collection-1",
		snapshotFingerprint: "fp-target",
		snapshotId: "snap-target",
		environmentId: "env-staging",
		environmentName: "Staging",
		outcome: "response",
		complete: true,
		finishedAt: "2026-09-20T10:00:00.000Z",
		assertions: { required: 1, passed: 1, failed: 0, errors: 0 },
		...overrides,
	};
}

function directImpact(requestIds) {
	return {
		resolved: true,
		truncated: false,
		requests: { direct: requestIds.map((requestId) => ({ requestId, nodeKind: "request", impact: "direct", hop: 1, confidence: "exact" })), indirect: [] },
		unknown: [],
	};
}

function indirectImpact(rows) {
	return {
		resolved: true,
		truncated: false,
		requests: { direct: [], indirect: rows.map((row) => ({ nodeKind: "request", impact: "indirect", hop: 2, ...row })) },
		unknown: [],
	};
}

// ---------------------------------------------------------------------------
// 1. Unchanged workspace + valid matching evidence -> VERIFIED
// ---------------------------------------------------------------------------
describe("1. unchanged workspace with matching evidence is VERIFIED", () => {
	test("identical snapshots and one verified request yields VERIFIED", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				source: { ...SOURCE, snapshotFingerprint: "fp-same", snapshotId: "snap-same" },
				target: { ...TARGET, snapshotFingerprint: "fp-same", snapshotId: "snap-same" },
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ snapshotFingerprint: "fp-same", snapshotId: "snap-same" })],
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.VERIFIED);
		expect(result.verifiedRequestIds).toEqual(["request-1"]);
		expect(result.blockers).toEqual([]);
	});

	test("no evidence required (empty rehearsal set) still yields VERIFIED with a warning", () => {
		const result = verifyCrossEnvironment(baseInput());
		expect(result.state).toBe(VERIFICATION_STATE.VERIFIED);
		expect(result.warnings.map((warning) => warning.code)).toContain(REASON_CODES.NO_REHEARSAL_EVIDENCE);
		expect(result.summary.requiredRehearsals).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 2. Changed snapshot + old execution -> wrong-snapshot rejection
// ---------------------------------------------------------------------------
describe("2. changed snapshot rejects old execution evidence", () => {
	test("evidence bound to the source snapshot cannot verify the target snapshot", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ snapshotFingerprint: "fp-source", snapshotId: "snap-source" })],
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.NEEDS_REHEARSAL);
		expect(result.rejectedEvidenceIds).toEqual(["exec-1"]);
		expect(result.warnings.map((warning) => warning.code)).toContain(REASON_CODES.EVIDENCE_WRONG_SNAPSHOT);
		expect(result.warnings.map((warning) => warning.code)).toContain(REASON_CODES.AFFECTED_REQUEST_UNVERIFIED);
	});

	test("a matching snapshot id is accepted even when the fingerprint is absent", () => {
		const classification = classifyBinding(
			{ snapshotId: "snap-target", snapshotFingerprint: null, environmentId: "env-staging", collectionId: "collection-1", workspaceId: null },
			TARGET,
			null,
		);
		expect(classification.binding).toBe(BINDING.ACCEPTED);
	});
});

// ---------------------------------------------------------------------------
// 3. Correct snapshot + wrong environment -> rejected evidence
// ---------------------------------------------------------------------------
describe("3. wrong environment rejects evidence", () => {
	test("execution against Development does not verify Staging", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ environmentId: "env-dev", environmentName: "Development" })],
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.NEEDS_REHEARSAL);
		expect(result.rejectedEvidenceIds).toEqual(["exec-1"]);
		expect(result.warnings.map((warning) => warning.code)).toContain(REASON_CODES.EVIDENCE_WRONG_ENVIRONMENT);
	});

	test("environment name is only decisive when no id is available on either side", () => {
		const byName = classifyBinding(
			{ snapshotFingerprint: "fp-target", snapshotId: null, environmentId: null, environmentName: "Staging", collectionId: "collection-1", workspaceId: null },
			{ ...TARGET, environmentId: null },
			null,
		);
		expect(byName.binding).toBe(BINDING.ACCEPTED);
	});
});

// ---------------------------------------------------------------------------
// 4. Affected request without evidence -> NEEDS_REHEARSAL
// ---------------------------------------------------------------------------
describe("4. affected request without evidence needs rehearsal", () => {
	test("a direct impact row with no evidence produces NEEDS_REHEARSAL", () => {
		const result = verifyCrossEnvironment(baseInput({ changeImpact: directImpact(["request-1"]) }));
		expect(result.state).toBe(VERIFICATION_STATE.NEEDS_REHEARSAL);
		expect(result.requiredRehearsalRequestIds).toEqual(["request-1"]);
		expect(result.warnings.map((warning) => warning.code)).toContain(REASON_CODES.AFFECTED_REQUEST_UNVERIFIED);
		expect(result.verifiedRequestIds).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 5. Direct affected request verified -> accepted
// ---------------------------------------------------------------------------
describe("5. direct affected request with valid evidence is accepted", () => {
	test("the request appears in verifiedRequestIds and not in requiredRehearsal-only failures", () => {
		const result = verifyCrossEnvironment(
			baseInput({ changeImpact: directImpact(["request-1"]), executions: [execution()] }),
		);
		expect(result.state).toBe(VERIFICATION_STATE.VERIFIED);
		expect(result.acceptedEvidenceIds).toEqual(["exec-1"]);
		expect(result.verifiedRequestIds).toEqual(["request-1"]);
	});
});

// ---------------------------------------------------------------------------
// 6. Indirect affected request requires verification
// ---------------------------------------------------------------------------
describe("6. indirect affected requests are handled by confidence", () => {
	test("an indirect row with conditional confidence is required", () => {
		const result = verifyCrossEnvironment(baseInput({ changeImpact: indirectImpact([{ requestId: "request-2", confidence: "conditional" }]) }));
		expect(result.state).toBe(VERIFICATION_STATE.NEEDS_REHEARSAL);
		expect(result.requiredRehearsalRequestIds).toEqual(["request-2"]);
	});

	test("an indirect row with unknown confidence is required", () => {
		const rehearsal = computeRehearsalSet(indirectImpact([{ requestId: "request-3", confidence: "unknown" }]));
		expect(rehearsal.required).toEqual(["request-3"]);
	});

	test("an indirect row with exact confidence is proven reachable but not required", () => {
		const rehearsal = computeRehearsalSet(indirectImpact([{ requestId: "request-4", confidence: "exact" }]));
		expect(rehearsal.required).toEqual([]);
		expect(rehearsal.optional).toEqual(["request-4"]);
	});
});

// ---------------------------------------------------------------------------
// 7. High drift blocks
// ---------------------------------------------------------------------------
describe("7. high-severity drift blocks", () => {
	test("a single high-severity drift entry produces BLOCKED", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				environmentDrift: {
					identical: false,
					summary: { total: 1, bySeverity: { high: 1 }, byCategory: { BASE_URL_CHANGED: 1 } },
					drift: [{ category: "BASE_URL_CHANGED", path: "base_url", severity: "high", status: "confirmed" }],
				},
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.BLOCKED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.HIGH_SEVERITY_DRIFT);
	});
});

// ---------------------------------------------------------------------------
// 8. Unknown drift prevents VERIFIED
// ---------------------------------------------------------------------------
describe("8. unknown drift prevents VERIFIED", () => {
	test("an unknown-severity entry blocks rather than passing", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				environmentDrift: {
					identical: false,
					summary: { total: 1, bySeverity: { unknown: 1 }, byCategory: { UNRESOLVED_REFERENCE: 1 } },
					drift: [{ category: "UNRESOLVED_REFERENCE", path: "{{dynamic}}", severity: "unknown", status: "unknown" }],
				},
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.BLOCKED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.UNKNOWN_DRIFT);
	});

	test("an unknown status alone also prevents VERIFIED", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				environmentDrift: {
					identical: false,
					summary: { total: 1, bySeverity: { low: 1 }, byCategory: { VARIABLE_CHANGED: 1 } },
					drift: [{ category: "VARIABLE_CHANGED", path: "tenant", severity: "low", status: "unknown" }],
				},
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.BLOCKED);
	});
});

// ---------------------------------------------------------------------------
// 9. Failed assertion blocks
// ---------------------------------------------------------------------------
describe("9. failed assertions block", () => {
	test("a successful execution carrying a failed required assertion does not verify", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ assertions: { required: 1, passed: 0, failed: 1, errors: 0 } })],
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.BLOCKED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.ASSERTION_FAILED);
		expect(result.verifiedRequestIds).toEqual([]);
	});

	test("a standalone failed assertion record blocks the request", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				assertions: [
					{
						assertionId: "assert-1",
						requestId: "request-1",
						status: "failed",
						required: true,
						collectionId: "collection-1",
						snapshotFingerprint: "fp-target",
						environmentId: "env-staging",
						observedAt: "2026-09-20T10:00:00.000Z",
					},
				],
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.BLOCKED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.ASSERTION_FAILED);
	});
});

// ---------------------------------------------------------------------------
// 10. Failed execution blocks
// ---------------------------------------------------------------------------
describe("10. failed execution blocks", () => {
	test("a non-success outcome blocks the request", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ outcome: "network_error", assertions: null })],
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.BLOCKED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.EXECUTION_FAILED);
	});
});

// ---------------------------------------------------------------------------
// 11. Incomplete execution blocks
// ---------------------------------------------------------------------------
describe("11. incomplete execution does not verify", () => {
	test("an incomplete record produces EXECUTION_INCOMPLETE", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ outcome: "incomplete", complete: false, assertions: null })],
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.BLOCKED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.EXECUTION_INCOMPLETE);
		expect(result.verifiedRequestIds).toEqual([]);
	});

	test("incomplete evidence never produces a VERIFIED request verdict", () => {
		const evaluated = evaluateRequestEvidence({
			requestId: "request-1",
			records: [{ evidence: { kind: "execution", id: "exec-1", requestId: "request-1", outcome: "response", complete: false, outcomeTerminal: true, assertions: null } }],
		});
		expect(evaluated.verdict).toBe(REQUEST_VERDICT.INCOMPLETE);
	});
});

// ---------------------------------------------------------------------------
// 12. Stale evidence rejected when cutoff supplied
// ---------------------------------------------------------------------------
describe("12. stale evidence is rejected when a cutoff is supplied", () => {
	test("evidence older than maxAgeMs is stale and does not verify", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ finishedAt: "2026-09-01T00:00:00.000Z" })],
				freshness: { now: "2026-09-20T00:00:00.000Z", maxAgeMs: 24 * 60 * 60 * 1000 },
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.NEEDS_REHEARSAL);
		expect(result.staleEvidenceIds).toEqual(["exec-1"]);
		expect(result.warnings.map((warning) => warning.code)).toContain(REASON_CODES.EVIDENCE_STALE);
	});

	test("evidence newer than the cutoff is accepted", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ finishedAt: "2026-09-19T23:00:00.000Z" })],
				freshness: { now: "2026-09-20T00:00:00.000Z", maxAgeMs: 24 * 60 * 60 * 1000 },
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.VERIFIED);
		expect(result.staleEvidenceIds).toEqual([]);
	});

	test("an explicit staleBefore instant is honoured", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ finishedAt: "2026-09-10T00:00:00.000Z" })],
				freshness: { staleBefore: "2026-09-15T00:00:00.000Z", now: "2026-09-20T00:00:00.000Z" },
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.NEEDS_REHEARSAL);
		expect(result.staleEvidenceIds).toEqual(["exec-1"]);
	});
});

// ---------------------------------------------------------------------------
// 13. No hidden freshness rule when none supplied
// ---------------------------------------------------------------------------
describe("13. no hidden freshness rule", () => {
	test("an ancient record is still accepted when no policy is supplied", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ finishedAt: "1999-01-01T00:00:00.000Z" })],
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.VERIFIED);
		expect(result.staleEvidenceIds).toEqual([]);
	});

	test("a policy with no age bound is treated as no policy", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ finishedAt: "1999-01-01T00:00:00.000Z" })],
				freshness: { now: "2026-09-20T00:00:00.000Z" },
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.VERIFIED);
	});
});

// ---------------------------------------------------------------------------
// 14. Duplicate evidence deduped
// ---------------------------------------------------------------------------
describe("14. duplicate evidence is deduped deterministically", () => {
	test("the same execution id collapses to one record", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution(), execution()],
			}),
		);
		expect(result.acceptedEvidenceIds).toEqual(["exec-1"]);
		expect(result.summary.acceptedEvidence).toBe(1);
	});

	test("a duplicate failure outranks a duplicate success so the failure survives", () => {
		const deduped = dedupeEvidence(
			normalizeEvidence({
				executions: [
					execution({ assertions: { required: 1, passed: 1, failed: 0, errors: 0 } }),
					execution({ assertions: { required: 1, passed: 0, failed: 1, errors: 0 } }),
				],
			}),
		);
		expect(deduped).toHaveLength(1);
		expect(deduped[0].evidence.assertions.failed).toBe(1);
	});

	test("distinct execution ids are preserved", () => {
		const deduped = dedupeEvidence(
			normalizeEvidence({ executions: [execution({ executionId: "exec-a" }), execution({ executionId: "exec-b" })] }),
		);
		expect(deduped.map((record) => record.evidence.id)).toEqual(["exec-a", "exec-b"]);
	});
});

// ---------------------------------------------------------------------------
// 15. Deterministic minimal rehearsal set
// ---------------------------------------------------------------------------
describe("15. minimal rehearsal set is deterministic", () => {
	test("direct rows are required, unaffected rows are not", () => {
		const rehearsal = computeRehearsalSet(directImpact(["request-9", "request-1", "request-5"]));
		expect(rehearsal.required).toEqual(["request-1", "request-5", "request-9"]);
		expect(rehearsal.complete).toBe(true);
	});

	test("a request appearing in both buckets is only required once", () => {
		const rehearsal = computeRehearsalSet({
			resolved: true,
			truncated: false,
			requests: {
				direct: [{ requestId: "request-1", nodeKind: "request", impact: "direct", hop: 1, confidence: "exact" }],
				indirect: [{ requestId: "request-1", nodeKind: "request", impact: "indirect", hop: 2, confidence: "unknown" }],
			},
			unknown: [],
		});
		expect(rehearsal.required).toEqual(["request-1"]);
		expect(rehearsal.optional).toEqual([]);
	});

	test("no input yields an unavailable, incomplete set", () => {
		const rehearsal = computeRehearsalSet(null);
		expect(rehearsal.available).toBe(false);
		expect(rehearsal.complete).toBe(false);
		expect(rehearsal.required).toEqual([]);
	});

	test("a truncated impact result marks the set incomplete", () => {
		const rehearsal = computeRehearsalSet({ resolved: true, truncated: true, requests: { direct: [], indirect: [] }, unknown: [] });
		expect(rehearsal.complete).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 16. Dynamic/unknown references handled conservatively
// ---------------------------------------------------------------------------
describe("16. dynamic references are handled conservatively", () => {
	test("an unnamed dynamic reference makes the set incomplete and blocks", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: { resolved: true, truncated: false, requests: { direct: [], indirect: [] }, unknown: [{ code: "computed-name", requestId: null }] },
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.BLOCKED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.DYNAMIC_REFERENCE_UNRESOLVED);
	});

	test("a named dynamic boundary request becomes required", () => {
		const rehearsal = computeRehearsalSet({
			resolved: true,
			truncated: false,
			requests: { direct: [], indirect: [] },
			unknown: [{ code: "computed-name", requestId: "request-7" }],
		});
		expect(rehearsal.required).toEqual(["request-7"]);
		expect(rehearsal.dynamicBoundaryRequestIds).toEqual(["request-7"]);
	});

	test("an unresolved impact result prevents a positive conclusion", () => {
		const result = verifyCrossEnvironment(
			baseInput({ changeImpact: { resolved: false, truncated: false, requests: { direct: [], indirect: [] }, unknown: [] } }),
		);
		expect(result.state).toBe(VERIFICATION_STATE.BLOCKED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.CHANGE_IMPACT_MISSING);
	});
});

// ---------------------------------------------------------------------------
// 17. Stable output ordering
// ---------------------------------------------------------------------------
describe("17. output ordering is stable", () => {
	test("ids and findings are sorted regardless of input order", () => {
		const input = baseInput({
			changeImpact: directImpact(["request-3", "request-1", "request-2"]),
			executions: [
				execution({ executionId: "exec-c", requestId: "request-3" }),
				execution({ executionId: "exec-a", requestId: "request-1" }),
				execution({ executionId: "exec-b", requestId: "request-2" }),
			],
		});
		const result = verifyCrossEnvironment(input);
		expect(result.requiredRehearsalRequestIds).toEqual(["request-1", "request-2", "request-3"]);
		expect(result.verifiedRequestIds).toEqual(["request-1", "request-2", "request-3"]);
		expect(result.acceptedEvidenceIds).toEqual(["exec-a", "exec-b", "exec-c"]);
	});

	test("findings are ordered by code then request id", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: { resolved: true, truncated: false, requests: { direct: [], indirect: [] }, unknown: [{ code: "x", requestId: null }] },
				executions: [execution({ requestId: "request-2", outcome: "network_error", assertions: null })],
			}),
		);
		const codes = result.blockers.map((blocker) => blocker.code);
		const sorted = [...codes].sort();
		expect(codes).toEqual(sorted);
	});
});

// ---------------------------------------------------------------------------
// 18. Malformed input fails closed
// ---------------------------------------------------------------------------
describe("18. malformed input fails closed", () => {
	test("a non-object input throws a typed error", () => {
		expect(() => verifyCrossEnvironment(null)).toThrow();
		try {
			verifyCrossEnvironment(null);
		} catch (error) {
			expect(error.code).toBe("CROSS_ENV_VERIFICATION_INVALID_INPUT");
			expect(error.statusCode).toBe(400);
		}
	});

	test("an unknown evidence field throws instead of being ignored", () => {
		expect(() =>
			verifyCrossEnvironment(
				baseInput({ executions: [{ ...execution(), unexpectedField: true }] }),
			),
		).toThrow();
	});

	test("an unknown outcome value throws", () => {
		expect(() => verifyCrossEnvironment(baseInput({ executions: [execution({ outcome: "definitely_not_an_outcome" })] }))).toThrow();
	});

	test("an invalid freshness policy throws", () => {
		expect(() => verifyCrossEnvironment(baseInput({ freshness: { maxAgeMs: -5 } }))).toThrow();
	});

	test("parseVerificationInput rejects a top-level array", () => {
		expect(() => parseVerificationInput([])).toThrow();
	});
});

// ---------------------------------------------------------------------------
// 19. Profile/workspace isolation
// ---------------------------------------------------------------------------
describe("19. profile isolation is enforced", () => {
	test("evidence owned by another profile is refused", () => {
		try {
			verifyCrossEnvironment(
				baseInput({
					ownerProfileId: "profile-1",
					executions: [{ ...execution(), ownerProfileId: "profile-2" }],
				}),
			);
			throw new Error("expected a profile mismatch");
		} catch (error) {
			expect(error.code).toBe("CROSS_ENV_VERIFICATION_PROFILE_MISMATCH");
			expect(error.statusCode).toBe(403);
		}
	});

	test("evidence from a different collection is rejected as wrong workspace", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [execution({ collectionId: "collection-999" })],
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.NEEDS_REHEARSAL);
		expect(result.warnings.map((warning) => warning.code)).toContain(REASON_CODES.EVIDENCE_WRONG_WORKSPACE);
	});
});

// ---------------------------------------------------------------------------
// 20. Repeated invocation is byte-stable
// ---------------------------------------------------------------------------
describe("20. repeated invocation is byte-stable", () => {
	test("two identical invocations serialize identically", () => {
		const input = baseInput({
			changeImpact: directImpact(["request-2", "request-1"]),
			executions: [execution({ requestId: "request-1" }), execution({ executionId: "exec-2", requestId: "request-2" })],
		});
		const first = JSON.stringify(verifyCrossEnvironment(input));
		const second = JSON.stringify(verifyCrossEnvironment(input));
		expect(first).toBe(second);
	});

	test("shuffling the evidence array does not change the output", () => {
		const input = baseInput({
			changeImpact: directImpact(["request-1", "request-2"]),
			executions: [execution({ executionId: "exec-1", requestId: "request-1" }), execution({ executionId: "exec-2", requestId: "request-2" })],
		});
		const forward = JSON.stringify(verifyCrossEnvironment(input));
		const backward = JSON.stringify(
			verifyCrossEnvironment({ ...input, executions: [...input.executions].reverse() }),
		);
		expect(forward).toBe(backward);
	});
});

// ---------------------------------------------------------------------------
// Additional coverage: contradiction, missing inputs, binding precedence
// ---------------------------------------------------------------------------
describe("contradictory and missing evidence", () => {
	test("contradictory outcomes for the same request produce BLOCKED", () => {
		const result = verifyCrossEnvironment(
			baseInput({
				changeImpact: directImpact(["request-1"]),
				executions: [
					execution({ executionId: "exec-pass", outcome: "response", assertions: { failed: 0, errors: 0 } }),
					execution({ executionId: "exec-fail", outcome: "network_error", assertions: null }),
				],
			}),
		);
		expect(result.state).toBe(VERIFICATION_STATE.BLOCKED);
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.EVIDENCE_CONTRADICTORY);
	});

	test("missing drift yields a blocker rather than a silent pass", () => {
		const result = verifyCrossEnvironment(baseInput({ environmentDrift: null }));
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.ENVIRONMENT_DRIFT_MISSING);
		expect(result.state).not.toBe(VERIFICATION_STATE.VERIFIED);
	});

	test("missing impact yields a blocker rather than a silent pass", () => {
		const result = verifyCrossEnvironment(baseInput({ changeImpact: null }));
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.CHANGE_IMPACT_MISSING);
		expect(result.state).not.toBe(VERIFICATION_STATE.VERIFIED);
	});

	test("a target without snapshot identity is UNKNOWN", () => {
		const result = verifyCrossEnvironment(
			baseInput({ target: { collectionId: "collection-1", environmentId: "env-staging" } }),
		);
		expect(result.state).toBe(VERIFICATION_STATE.UNKNOWN);
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.SNAPSHOT_IDENTITY_MISSING);
	});

	test("a target without environment identity is UNKNOWN", () => {
		const result = verifyCrossEnvironment(
			baseInput({ target: { collectionId: "collection-1", snapshotFingerprint: "fp-target" } }),
		);
		expect(result.state).toBe(VERIFICATION_STATE.UNKNOWN);
		expect(result.blockers.map((blocker) => blocker.code)).toContain(REASON_CODES.ENVIRONMENT_IDENTITY_MISSING);
	});

	test("binding precedence reports wrong-workspace before wrong-snapshot", () => {
		const classification = classifyBinding(
			{ collectionId: "collection-999", snapshotFingerprint: "fp-nope", environmentId: "env-service", workspaceId: null },
			TARGET,
			null,
		);
		expect(classification.binding).toBe(BINDING.WRONG_WORKSPACE);
	});

	test("changed snapshots are reported as a warning, not a blocker", () => {
		const result = verifyCrossEnvironment(baseInput());
		expect(result.warnings.map((warning) => warning.code)).toContain(REASON_CODES.SNAPSHOT_CHANGED);
		expect(result.blockers.map((blocker) => blocker.code)).not.toContain(REASON_CODES.SNAPSHOT_CHANGED);
	});

	test("evidence with no timestamp is never judged stale", () => {
		const classification = classifyBinding(
			{ snapshotFingerprint: "fp-target", snapshotId: null, environmentId: "env-staging", collectionId: "collection-1", workspaceId: null, startedAt: null, finishedAt: null },
			TARGET,
			{ maxAgeMs: 1, now: "2026-09-20T00:00:00.000Z" },
		);
		expect(classification.binding).toBe(BINDING.ACCEPTED);
	});
});

// ---------------------------------------------------------------------------
// Injectable integration seam
// ---------------------------------------------------------------------------
describe("injectable integration seam", () => {
	test("a supplied change-impact source is used when no result is passed", async () => {
		const { createCrossEnvVerifier } = await import("./index.js");
		const verify = createCrossEnvVerifier({ changeImpactSource: () => directImpact(["request-1"]) });
		const result = verify({ ...baseInput(), changeImpact: undefined, workspaceDiff: {}, executions: [execution()] });
		expect(result.state).toBe(VERIFICATION_STATE.VERIFIED);
	});

	test("without a source or an explicit result the seam refuses to guess", async () => {
		const { createCrossEnvVerifier } = await import("./index.js");
		const verify = createCrossEnvVerifier({});
		expect(() => verify({ ...baseInput(), changeImpact: undefined, environmentDrift: undefined })).toThrow();
	});
});
