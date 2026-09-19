import mongoose from "mongoose";

const collectionSchema = new mongoose.Schema(
    {
        ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
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

collectionSchema.index({ ownerProfileId: 1, nameKey: 1 }, { unique: true });

export const Collection = mongoose.model("Collection", collectionSchema);
