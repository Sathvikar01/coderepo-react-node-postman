import mongoose from "mongoose";

const historySchema = new mongoose.Schema(
	{
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		executionId: { type: String, required: true },
		fingerprint: { type: String, required: true },
		fingerprintKeyId: { type: String, required: true },
		instanceId: { type: String, required: true },
		status: { type: String, enum: ["running", "terminal"], required: true },
		outcome: { type: String, default: null },
		effectCertainty: { type: String, enum: ["not_dispatched", "may_have_reached_target"], required: true },
		persistence: { type: mongoose.Schema.Types.Mixed, default: null },
		request: { type: mongoose.Schema.Types.Mixed, required: true },
		context: { type: mongoose.Schema.Types.Mixed, required: true },
		snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
		response: { type: mongoose.Schema.Types.Mixed, default: null },
		error: { type: mongoose.Schema.Types.Mixed, default: null },
		compileTrace: { type: [mongoose.Schema.Types.Mixed], default: [] },
		warnings: { type: [mongoose.Schema.Types.Mixed], default: [] },
		receipt: { type: mongoose.Schema.Types.Mixed, default: null },
		startedAt: { type: Date, required: true },
		finishedAt: { type: Date, default: null },
		expiresAt: { type: Date, default: null },
		visible: { type: Boolean, default: true },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

historySchema.index({ ownerProfileId: 1, executionId: 1 }, { unique: true });
historySchema.index({ ownerProfileId: 1, visible: 1, startedAt: -1, _id: -1 });
historySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ExecutionHistory = mongoose.model("ExecutionHistory", historySchema);
