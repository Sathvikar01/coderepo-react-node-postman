import mongoose from "mongoose";

const collectionSchema = new mongoose.Schema(
	{
		// The workspace is the authorization boundary. `ownerProfileId` records the
		// creating profile for attribution only; collaborators share access through the
		// workspace member list.
		workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		createdByProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		updatedByProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		name: { type: String, required: true, trim: true, maxlength: 80 },
		nameKey: { type: String, required: true, maxlength: 80 },
		description: { type: String, default: "", maxlength: 1000 },
		variables: { type: [mongoose.Schema.Types.Mixed], default: [] },
		auth: { type: mongoose.Schema.Types.Mixed, required: true },
		folders: { type: [mongoose.Schema.Types.Mixed], default: [] },
		requests: { type: [mongoose.Schema.Types.Mixed], default: [] },
		revision: { type: Number, required: true, default: 0 },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

// Names are unique inside a workspace, so two collaborators cannot create colliding
// collections while members of other workspaces may reuse the same name freely. The
// partial filter keeps workspace-less documents (pre-collaboration rows, if any) out of
// the constraint entirely rather than making `null` a single shared namespace.
collectionSchema.index(
	{ workspaceId: 1, nameKey: 1 },
	{ unique: true, partialFilterExpression: { workspaceId: { $type: "objectId" } } },
);

// Legacy rows written before collaboration carry no workspace. They keep their old
// per-profile uniqueness so pre-existing data cannot silently collide, while every
// workspace-scoped row is governed solely by the index above. Without the partial
// filter a profile that edits a shared workspace and owns a private one could not
// reuse the same collection name in both.
collectionSchema.index(
	{ ownerProfileId: 1, nameKey: 1 },
	{ unique: true, partialFilterExpression: { workspaceId: null } },
);

export const Collection = mongoose.model("Collection", collectionSchema);
