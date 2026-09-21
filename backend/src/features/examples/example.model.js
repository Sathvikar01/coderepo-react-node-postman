import mongoose from "mongoose";

const ruleSchema = new mongoose.Schema(
	{
		key: { type: String, required: true, maxlength: 256 },
		value: { type: String, default: "", maxlength: 8192 },
	},
	{ _id: false },
);

const responseHeaderSchema = new mongoose.Schema(
	{
		name: { type: String, required: true, maxlength: 256 },
		value: { type: String, default: "", maxlength: 8192 },
	},
	{ _id: false },
);

const sourceSchema = new mongoose.Schema(
	{
		type: { type: String, enum: ["response", "manual"], required: true },
		executionId: { type: String, default: null },
		requestId: { type: String, default: null },
		collectionId: { type: mongoose.Schema.Types.ObjectId, default: null },
		requestName: { type: String, default: null, maxlength: 80 },
	},
	{ _id: false },
);

const bodySchema = new mongoose.Schema(
	{
		encoding: { type: String, enum: ["utf8", "base64"], required: true },
		value: { type: String, default: "" },
		mediaType: { type: String, default: "", maxlength: 200 },
		truncated: { type: Boolean, default: false },
		omittedReason: { type: String, default: null, maxlength: 64 },
	},
	{ _id: false },
);

const exampleSchema = new mongoose.Schema(
	{
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		name: { type: String, required: true, trim: true, maxlength: 80 },
		nameKey: { type: String, required: true, maxlength: 80 },
		source: { type: sourceSchema, required: true },
		match: {
			method: { type: String, required: true },
			path: { type: String, default: "", maxlength: 2048 },
			query: { type: [ruleSchema], default: [] },
			headers: { type: [ruleSchema], default: [] },
		},
		response: {
			status: { type: Number, required: true },
			statusText: { type: String, default: "", maxlength: 120 },
			contentType: { type: String, default: "", maxlength: 200 },
			headers: { type: [responseHeaderSchema], default: [] },
			body: { type: bodySchema, required: true },
		},
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

exampleSchema.index({ ownerProfileId: 1, nameKey: 1 }, { unique: true });
exampleSchema.index({ ownerProfileId: 1, "match.method": 1, "match.path": 1, createdAt: 1, _id: 1 });

export const Example = mongoose.model("Example", exampleSchema);
