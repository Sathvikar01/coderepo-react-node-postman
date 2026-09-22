import mongoose from "mongoose";

const collectionRunSchema = new mongoose.Schema(
	{
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		runId: { type: String, required: true },
		schemaVersion: { type: Number, required: true, default: 1 },
		kind: { type: String, required: true, default: "tracer.collection-run" },
		collectionId: { type: String, required: true },
		collectionRevision: { type: Number, required: true },
		collectionName: { type: String, required: true },
		environmentId: { type: String, default: null },
		environmentRevision: { type: Number, default: null },
		input: { type: mongoose.Schema.Types.Mixed, required: true },
		status: { type: String, enum: ["running", "completed", "cancelled", "failed"], required: true },
		stopReason: { type: String, default: null },
		results: { type: [mongoose.Schema.Types.Mixed], default: [] },
		summary: { type: mongoose.Schema.Types.Mixed, default: null },
		error: { type: mongoose.Schema.Types.Mixed, default: null },
		startedAt: { type: Date, required: true },
		finishedAt: { type: Date, default: null },
		expiresAt: { type: Date, required: true },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

collectionRunSchema.index({ ownerProfileId: 1, runId: 1 }, { unique: true });
collectionRunSchema.index({ ownerProfileId: 1, startedAt: -1 });
collectionRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CollectionRun = mongoose.model("CollectionRun", collectionRunSchema);
