import mongoose from "mongoose";

const environmentSchema = new mongoose.Schema(
	{
		// The workspace is the authorization boundary; `ownerProfileId` is attribution.
		workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		createdByProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		updatedByProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		name: { type: String, required: true, trim: true, maxlength: 80 },
		nameKey: { type: String, required: true, maxlength: 80 },
		// Variables are stored as definitions. A secret is stored only as its alias, so
		// sharing an environment never moves a resolved credential to another profile.
		variables: { type: [mongoose.Schema.Types.Mixed], default: [] },
		revision: { type: Number, required: true, default: 0 },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

// Workspace-scoped name uniqueness is the authoritative constraint; workspace-less
// legacy rows fall back to the historical per-profile rule via the partial index below.
environmentSchema.index(
	{ workspaceId: 1, nameKey: 1 },
	{ unique: true, partialFilterExpression: { workspaceId: { $type: "objectId" } } },
);

environmentSchema.index(
	{ ownerProfileId: 1, nameKey: 1 },
	{ unique: true, partialFilterExpression: { workspaceId: null } },
);

export const Environment = mongoose.model("Environment", environmentSchema);
