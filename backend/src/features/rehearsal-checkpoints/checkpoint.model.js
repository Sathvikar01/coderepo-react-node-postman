import mongoose from "mongoose";
import { REHEARSAL_CHECKPOINT_KIND, REHEARSAL_CHECKPOINT_SCHEMA_VERSION, CHECKPOINT_LIMITS } from "./checkpoint-schema.js";
import { RUN_STATE_VALUES, STEP_STATE_VALUES } from "./reason-codes.js";

// Phase 46B — Rehearsal checkpoint persistence model.
//
// One document per rehearsal run. The document IS the run's durable state: its
// identity, its ordered step accounting, its ownership generation, and its
// lifecycle state. There is no separate per-step collection on purpose — a step's
// state is only ever meaningful as part of one run's ordered accounting, and
// splitting it would make "exactly-once" a cross-document problem with no
// single-document CAS to enforce it.
//
// Every mutation is guarded by two things at the database level:
//
//   1. `generation` — the ownership epoch. A write names the generation it
//      believes it owns; a stale worker names an old one and matches nothing.
//   2. `runState` — only non-terminal states are writable, as a query predicate,
//      so a terminal run cannot be modified even by a racing write that happens to
//      carry the current generation.
//
// The unique index on (ownerProfileId, runId) is the run-identity guard: a
// duplicate create fails in the database rather than creating a fork.

const identitySchema = new mongoose.Schema(
	{
		workspaceId: { type: String, required: true },
		snapshotId: { type: String, required: true },
		snapshotFingerprint: { type: String, required: true, maxlength: CHECKPOINT_LIMITS.maxFingerprintBytes },
		targetEnvironment: {
			environmentId: { type: String, required: true },
			environmentName: { type: String, default: null, maxlength: CHECKPOINT_LIMITS.maxIdentifierBytes },
			environmentFingerprint: { type: String, required: true, maxlength: CHECKPOINT_LIMITS.maxFingerprintBytes },
		},
		planId: { type: String, required: true },
		planFingerprint: { type: String, required: true, maxlength: CHECKPOINT_LIMITS.maxFingerprintBytes },
		policyId: { type: String, default: null },
		policyFingerprint: { type: String, default: null, maxlength: CHECKPOINT_LIMITS.maxFingerprintBytes },
	},
	{ _id: false },
);

const planStepSchema = new mongoose.Schema(
	{
		stepId: { type: String, required: true },
		refId: { type: String, default: null },
	},
	{ _id: false },
);

const planSchema = new mongoose.Schema(
	{
		steps: { type: [planStepSchema], default: [] },
	},
	{ _id: false },
);

// A step's durable accounting. `completion` is an identity/reference, never a
// response payload: an outcome id plus bounded, flat, secret-screened metadata.
const completionSchema = new mongoose.Schema(
	{
		outcomeId: { type: String, required: true },
		completionFingerprint: { type: String, required: true, maxlength: CHECKPOINT_LIMITS.maxFingerprintBytes },
		ownerGeneration: { type: Number, required: true },
		metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
	},
	{ _id: false },
);

const attemptSchema = new mongoose.Schema(
	{
		attempts: { type: Number, default: 0, min: 0 },
		ownerGeneration: { type: Number, default: null },
		evidenceRefs: { type: [String], default: [] },
	},
	{ _id: false },
);

const stepStateSchema = new mongoose.Schema(
	{
		stepId: { type: String, required: true },
		state: { type: String, enum: STEP_STATE_VALUES, required: true, default: "PENDING" },
		completion: { type: completionSchema, default: null },
		attempt: { type: attemptSchema, default: () => ({ attempts: 0, ownerGeneration: null, evidenceRefs: [] }) },
		lastReasonCode: { type: String, default: null },
	},
	{ _id: false },
);

const rehearsalCheckpointSchema = new mongoose.Schema(
	{
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		runId: { type: String, required: true, maxlength: CHECKPOINT_LIMITS.maxIdentifierBytes },

		schemaVersion: { type: Number, required: true, default: REHEARSAL_CHECKPOINT_SCHEMA_VERSION },
		kind: { type: String, required: true, default: REHEARSAL_CHECKPOINT_KIND },

		// Immutable identity binding. Written once at create; every resume checks it.
		identity: { type: identitySchema, required: true },
		identityFingerprint: { type: String, required: true, maxlength: CHECKPOINT_LIMITS.maxFingerprintBytes },

		// The ordered plan. Written once at create; never rewritten.
		plan: { type: planSchema, required: true },
		planFingerprint: { type: String, required: true, maxlength: CHECKPOINT_LIMITS.maxFingerprintBytes },

		// Lifecycle.
		runState: { type: String, enum: RUN_STATE_VALUES, required: true, default: "CREATED", index: true },
		// Ownership epoch. Starts at 1 on create and increments on every successful
		// claim/reclaim. A worker holding generation N can only write while the row
		// still says N.
		generation: { type: Number, required: true, default: 1, min: 1 },
		// The worker currently holding the lease. Null in CREATED and when paused by
		// an abort path.
		owner: { type: String, default: null },
		// The generation that last wrote progress. Recorded so a resume can prove
		// which worker produced the state it is resuming from.
		lastOwnerGeneration: { type: Number, default: 1 },

		// Ordered step accounting.
		stepStates: { type: [stepStateSchema], default: [] },
		// The set of step ids that are COMPLETED, mirrored as a flat list so the
		// exactly-once read path does not have to walk the step list.
		completedStepIds: { type: [String], default: [] },

		// Derived pointers, stored for fast reads. Never set directly by a caller.
		currentStepId: { type: String, default: null },
		nextStepId: { type: String, default: null },

		// Terminal metadata.
		terminalReasonCode: { type: String, default: null },
		terminalReason: { type: String, default: null, maxlength: CHECKPOINT_LIMITS.maxReasonBytes },
		completedAt: { type: Date, default: null },
		abortedAt: { type: Date, default: null },
		failedAt: { type: Date, default: null },

		// Bounded display label. Never a secret.
		label: { type: String, default: null, maxlength: CHECKPOINT_LIMITS.maxIdentifierBytes },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

// Run identity guard: one row per (profile, runId). A duplicate create fails here.
rehearsalCheckpointSchema.index({ ownerProfileId: 1, runId: 1 }, { unique: true });
// Listing a profile's runs by recency.
rehearsalCheckpointSchema.index({ ownerProfileId: 1, createdAt: -1 });
// Finding resumable (non-terminal) runs for a profile.
rehearsalCheckpointSchema.index({ ownerProfileId: 1, runState: 1 });

export const RehearsalCheckpoint = mongoose.model("RehearsalCheckpoint", rehearsalCheckpointSchema);
