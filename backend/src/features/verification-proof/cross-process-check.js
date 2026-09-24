// Phase 47A — cross-process determinism probe.
//
// Builds the canonical proof in a fresh process and prints its fingerprint plus
// its canonical JSON. The suite spawns this file and asserts byte-stability across
// processes, which is stronger than repeating the call in one process: it proves
// proof identity does not depend on module load order, heap layout, or any
// per-process state.
//
// No clock, no randomness, no database, no network.

import { initConfig } from "../../shared/config/index.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase47_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase47-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase47-test-jwt-secret";
initConfig();

import { buildVerificationProof, canonicalProofJsonOf } from "./index.js";
import { proofInput } from "./proof-fixtures.js";

const proof = buildVerificationProof(proofInput());

process.stdout.write(`${JSON.stringify({ fingerprint: proof.fingerprint, proofId: proof.proofId, canonical: canonicalProofJsonOf(proof) })}\n`);
