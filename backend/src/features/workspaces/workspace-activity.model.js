import mongoose from "mongoose";

// A bounded, append-only audit feed for a workspace. Entries describe *who* changed
// *what* and the revision transition. They never carry secret values, authorization
// headers, cookies, or request/response bodies; `metadata` is whitelisted on write.
export const WORKSPACE_ACTIVITY_ACTIONS = [
	"workspace.created",
	"workspace.renamed",
	"member.added",
	"member.removed",
	"member.role_changed",
	"collection.created",
	"collection.updated",
	"collection.deleted",
	"collection.restored",
	"environment.created",
	"environment.updated",
	"environment.deleted",
	"environment.restored",
];

const workspaceActivitySchema = new mongoose.Schema(
	{
		workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
		actorProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", default: null },
		action: { type: String, enum: WORKSPACE_ACTIVITY_ACTIONS, required: true },
		targetType: { type: String, enum: ["workspace", "member", "collection", "environment"], required: true },
		targetId: { type: String, default: null, maxlength: 120 },
		targetLabel: { type: String, default: null, maxlength: 120 },
		previousRevision: { type: Number, default: null },
		newRevision: { type: Number, default: null },
		summary: { type: String, required: true, maxlength: 300 },
		metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
		createdAt: { type: Date, default: Date.now },
	},
	{ versionKey: false, minimize: false },
);

// The feed is read newest-first and paged by `createdAt`.
workspaceActivitySchema.index({ workspaceId: 1, createdAt: -1, _id: -1 });

export const WorkspaceActivity = mongoose.model("WorkspaceActivity", workspaceActivitySchema);
