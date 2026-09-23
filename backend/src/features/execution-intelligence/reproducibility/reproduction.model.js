import mongoose from "mongoose";

const reproductionSeriesSchema = new mongoose.Schema(
	{
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		seriesId: { type: String, required: true },
		schemaVersion: { type: Number, required: true, default: 1 },
		kind: { type: String, required: true, default: "tracer.reproduction-series" },
		sourceExecutionId: { type: String, required: true },
		status: { type: String, enum: ["running", "completed", "failed", "cancelled"], required: true },
		predicate: { type: mongoose.Schema.Types.Mixed, required: true },
		targetMode: { type: String, enum: ["execution", "mock"], required: true },
		probeBudget: { type: Number, required: true },
		result: { type: mongoose.Schema.Types.Mixed, default: null },
		error: { type: mongoose.Schema.Types.Mixed, default: null },
		startedAt: { type: Date, required: true },
		finishedAt: { type: Date, default: null },
		expiresAt: { type: Date, required: true },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

reproductionSeriesSchema.index({ ownerProfileId: 1, seriesId: 1 }, { unique: true });
reproductionSeriesSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ReproductionSeries = mongoose.model("ReproductionSeries", reproductionSeriesSchema);
