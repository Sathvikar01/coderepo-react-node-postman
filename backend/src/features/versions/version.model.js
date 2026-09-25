import mongoose from "mongoose";

// Phase 24B — immutable version history for shared collections and environments.
//
// One row per saved revision. Rows are append-only: restore creates a NEW revision
// (never rewrites an old row), and retention prunes only the oldest rows beyond the
// per-resource bound. The unique (resourceType, resourceId, revision) key makes
// retried writes idempotent instead of duplicating history.
export const VERSION_RESOURCE_TYPES = ["collection", "environment"];
export const VERSION_ACTIONS = ["CREATED", "UPDATED", "RESTORED"];

const resourceVersionSchema = new mongoose.Schema(
	{
		workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
		resourceType: { type: String, enum: VERSION_RESOURCE_TYPES, required: true },
		resourceId: { type: String, required: true, maxlength: 120 },
		revision: { type: Number, required: true, min: 1 },
		actorProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		action: { type: String, enum: VERSION_ACTIONS, required: true },
		// Deterministic sha256 over the canonicalized snapshot. Two identical
		// definitions always share a fingerprint, so equality needs no diff walk.
		fingerprint: { type: String, required: true, maxlength: 64 },
		// The saved canonical definition, scrubbed of credential-bearing values
		// (see snapshot.js). Never holds resolved secrets, auth headers, or cookies.
		snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
		// Restore provenance only: which revision was restored, and what the tip was.
		sourceRevision: { type: Number, default: null },
		previousRevision: { type: Number, default: null },
		createdAt: { type: Date, default: Date.now },
	},
	{ versionKey: false, minimize: false },
);

// Revision rows are read newest-first per resource and paged by revision.
resourceVersionSchema.index({ resourceType: 1, resourceId: 1, revision: -1 });
resourceVersionSchema.index(
	{ resourceType: 1, resourceId: 1, revision: 1 },
	{ unique: true },
);

export const ResourceVersion = mongoose.model("ResourceVersion", resourceVersionSchema);
