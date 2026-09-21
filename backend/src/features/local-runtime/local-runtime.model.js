import mongoose from "mongoose";

const approvedTargetSchema = new mongoose.Schema(
	{
		id: { type: String, required: true, maxlength: 64 },
		host: { type: String, required: true, maxlength: 253 },
		addedAt: { type: Date, default: Date.now },
	},
	{ _id: false },
);

const localRuntimeSchema = new mongoose.Schema(
	{
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true },
		enabled: { type: Boolean, required: true, default: false },
		targets: { type: [approvedTargetSchema], default: [] },
		revision: { type: Number, required: true, default: 1 },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

localRuntimeSchema.index({ ownerProfileId: 1 }, { unique: true });

export const LocalRuntimeSetting = mongoose.model("LocalRuntimeSetting", localRuntimeSchema);
