import mongoose from "mongoose";

const workspaceMemberSchema = new mongoose.Schema(
	{
		profileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true },
		role: { type: String, enum: ["OWNER", "EDITOR", "VIEWER"], required: true },
		addedByProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		addedAt: { type: Date, default: Date.now },
	},
	{ _id: false },
);

const workspaceSchema = new mongoose.Schema(
	{
		// `ownerProfileId` records who created the workspace. It is attribution, not an
		// authorization boundary: access is decided by the member list below.
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		name: { type: String, required: true, trim: true, maxlength: 80 },
		nameKey: { type: String, required: true, maxlength: 80 },
		members: { type: [workspaceMemberSchema], default: [] },
		// A personal workspace is auto-provisioned per profile and reused for legacy
		// single-profile flows. The sparse-unique index keeps it one-per-profile and
		// lets shared workspaces leave the field unset.
		personalForProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		revision: { type: Number, required: true, default: 1 },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

workspaceSchema.index({ "members.profileId": 1 });
workspaceSchema.index({ ownerProfileId: 1, nameKey: 1 }, { unique: true });
workspaceSchema.index(
	{ personalForProfileId: 1 },
	{ unique: true, partialFilterExpression: { personalForProfileId: { $type: "objectId" } } },
);

export const Workspace = mongoose.model("Workspace", workspaceSchema);
