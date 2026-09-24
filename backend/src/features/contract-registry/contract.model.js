import mongoose from "mongoose";
import { CONTRACT_LIMITS, CONTRACT_SCHEMA_VERSION, CONTRACT_STATES } from "./contract-schema.js";

// Phase 42A — API contract persistence model.
//
// Historical versions are immutable by construction: a version row is created once
// and only ever transitions DRAFT -> PUBLISHED -> SUPERSEDED. No field of a
// published row is rewritten. Content changes create a new row with the next
// sequence, never an update of an existing one.
//
// Sequence allocation is concurrency-safe through a unique index on
// (ownerProfileId, contractId, sequence) plus an atomic counter document, so two
// racing publications cannot claim the same version number.

const expectedHeaderSchema = new mongoose.Schema(
	{
		name: { type: String, required: true, maxlength: 256 },
		value: { type: String, default: null, maxlength: CONTRACT_LIMITS.maxHeaderValueBytes },
		required: { type: Boolean, default: false },
	},
	{ _id: false },
);

// Contract content is stored as a validated mixed document rather than a deep
// Mongoose schema: the recursive type node would otherwise need a self-referencing
// schema, and the contract schema already validates it authoritatively.
const contractContentSchema = new mongoose.Schema(
	{
		schemaVersion: { type: Number, required: true, default: CONTRACT_SCHEMA_VERSION },
		kind: { type: String, required: true },
		provenance: { type: String, enum: ["explicit", "inferred"], required: true },
		name: { type: String, required: true, maxlength: CONTRACT_LIMITS.maxNameBytes },
		description: { type: String, default: "", maxlength: 1000 },
		body: {
			status: { type: Number, default: null },
			statuses: { type: [Number], default: [] },
			headers: { type: [expectedHeaderSchema], default: [] },
			bodyType: { type: String, default: null },
			body: { type: mongoose.Schema.Types.Mixed, default: null },
		},
	},
	{ _id: false },
);

const contractVersionSchema = new mongoose.Schema(
	{
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		collectionId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
		workspaceId: { type: mongoose.Schema.Types.ObjectId, default: null },
		requestId: { type: String, required: true, index: true },
		snapshotId: { type: mongoose.Schema.Types.ObjectId, default: null },
		snapshotFingerprint: { type: String, default: null, maxlength: 128 },

		// Stable identity of a contract across its versions.
		contractId: { type: String, required: true, index: true },
		// Monotonic version number within (ownerProfileId, contractId).
		sequence: { type: Number, required: true, min: 1 },
		state: { type: String, enum: CONTRACT_STATES, required: true, default: "DRAFT", index: true },

		contentFingerprint: { type: String, required: true },
		fingerprintKeyId: { type: String, required: true },
		content: { type: contractContentSchema, required: true },

		createdBy: { type: String, default: null, maxlength: 128 },
		publishedBy: { type: String, default: null, maxlength: 128 },
		publishedAt: { type: Date, default: null },
		supersededBySequence: { type: Number, default: null },
		supersededAt: { type: Date, default: null },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

// One row per (profile, contract, sequence). This is the concurrency guard: a
// racing duplicate insert fails here rather than silently creating version skew.
contractVersionSchema.index({ ownerProfileId: 1, contractId: 1, sequence: 1 }, { unique: true });
// At most one PUBLISHED row per (profile, contract). This is the lifecycle guard:
// two racing publications cannot both remain current.
contractVersionSchema.index(
	{ ownerProfileId: 1, contractId: 1, state: 1 },
	{ unique: true, partialFilterExpression: { state: "PUBLISHED" } },
);
contractVersionSchema.index({ ownerProfileId: 1, requestId: 1, state: 1 });
contractVersionSchema.index({ ownerProfileId: 1, contractId: 1, sequence: -1 });

// Atomic sequence allocator. A single findOneAndUpdate with $inc allocates a
// version number in one round trip, so concurrent publishers serialize on the
// counter document rather than on a read-then-write race in application code.
const contractCounterSchema = new mongoose.Schema(
	{
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, required: true },
		contractId: { type: String, required: true },
		nextSequence: { type: Number, required: true, default: 1 },
	},
	{ timestamps: true, versionKey: false },
);

contractCounterSchema.index({ ownerProfileId: 1, contractId: 1 }, { unique: true });

export const ContractVersion = mongoose.model("ContractVersion", contractVersionSchema);
export const ContractCounter = mongoose.model("ContractCounter", contractCounterSchema);
