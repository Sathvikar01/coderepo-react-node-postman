// Phase 46A — cross-process determinism probe.
//
// Runs the planner in a fresh process over the identical input the in-process
// suite uses, and prints the plan fingerprint plus its canonical JSON. The test
// suite spawns this file and asserts byte-stability across processes, which is
// stronger than repeating the call in one process: it proves plan identity does
// not depend on module load order, heap layout, or any per-process state.
//
// No clock, no randomness, no persistence, no network.

import { initConfig } from "../../shared/config/index.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase46_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase46-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase46-test-jwt-secret";
initConfig();

import { canonicalPlanJson, planRehearsal } from "./index.js";

const SNAPSHOT_FP = "fp-snapshot-1";

const plan = planRehearsal({
	workspaceId: "ws-1",
	snapshot: { snapshotId: "snap-1", snapshotFingerprint: SNAPSHOT_FP },
	source: { environmentId: "env-local", snapshotFingerprint: SNAPSHOT_FP },
	target: { environmentId: "env-staging", snapshotFingerprint: SNAPSHOT_FP },
	impact: {
		kind: "tracer.change-impact",
		resolved: true,
		truncated: false,
		requests: {
			direct: [{ requestId: "r1", nodeKind: "request", collectionId: "col-1", impact: "direct", hop: 1, confidence: "exact" }],
			indirect: [],
		},
		unknown: [],
	},
	drift: {
		kind: "tracer.environment-drift",
		source: { environmentId: "env-local" },
		target: { environmentId: "env-staging" },
		identical: false,
		summary: { total: 1, byCategory: { VARIABLE_CHANGED: 1 }, bySeverity: { high: 1 } },
		drift: [{ category: "VARIABLE_CHANGED", path: "variables.baseUrl", severity: "high", status: "confirmed" }],
	},
	blastRadius: {
		kind: "tracer.blast-radius-envelope",
		version: 1,
		policy: { kind: "tracer.blast-radius-policy", version: 1, identity: "policy-identity-1" },
		workspace: { workspaceId: "ws-1", snapshotId: "snap-1" },
		environment: { environmentId: "env-local", targetEnvironmentId: "env-staging" },
		admissionState: "ADMITTED",
		allowedRequests: [
			{
				requestId: "r1",
				host: "api.test",
				hostKey: "api.test",
				port: null,
				method: "GET",
				classification: "NON_MUTATING",
				mutating: false,
				admission: "ADMITTED",
				reasonCodes: [],
			},
		],
	},
	candidates: [{ requestId: "r1", collectionId: "col-1", host: "api.test", method: "GET" }],
});

process.stdout.write(`${JSON.stringify({ planFingerprint: plan.identity.planFingerprint, canonical: canonicalPlanJson(plan) })}\n`);
