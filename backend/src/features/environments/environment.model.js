import mongoose from "mongoose";

const environmentSchema = new mongoose.Schema(
	{
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		name: { type: String, required: true, trim: true, maxlength: 80 },
		nameKey: { type: String, required: true, maxlength: 80 },
		variables: { type: [mongoose.Schema.Types.Mixed], default: [] },
		revision: { type: Number, required: true, default: 0 },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

environmentSchema.index({ ownerProfileId: 1, nameKey: 1 }, { unique: true });

export const Environment = mongoose.model("Environment", environmentSchema);
