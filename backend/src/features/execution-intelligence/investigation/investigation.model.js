import mongoose from "mongoose";

const investigationSchema = new mongoose.Schema(
	{
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		investigationId: { type: String, required: true },
		schemaVersion: { type: Number, required: true, default: 1 },
		kind: { type: String, required: true, default: "tracer.investigation" },
		failingExecutionId: { type: String, required: true },
		status: { type: String, enum: ["running", "completed", "failed", "cancelled"], required: true },
		stage: { type: String, required: true, default: "preparing" },
		result: { type: mongoose.Schema.Types.Mixed, default: null },
		error: { type: mongoose.Schema.Types.Mixed, default: null },
		startedAt: { type: Date, required: true },
		finishedAt: { type: Date, default: null },
		expiresAt: { type: Date, required: true },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

investigationSchema.index({ ownerProfileId: 1, investigationId: 1 }, { unique: true });
investigationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Investigation = mongoose.model("Investigation", investigationSchema);
