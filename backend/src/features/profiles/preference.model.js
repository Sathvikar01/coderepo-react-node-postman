import mongoose from "mongoose";

const preferenceSchema = new mongoose.Schema(
    {
        ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true },
        activeEnvironmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Environment", default: null },
        lastSavedRequest: {
            collectionId: { type: mongoose.Schema.Types.ObjectId, ref: "Collection", default: null },
            requestId: { type: String, default: null },
        },
        collectionOrder: [{ type: mongoose.Schema.Types.ObjectId, ref: "Collection" }],
        theme: { type: String, enum: ["dark", "light"], default: "dark" },
        sidebarCollapsed: { type: Boolean, default: false },
        responseView: { type: String, enum: ["pretty", "raw"], default: "pretty" },
    },
    { timestamps: true, versionKey: false },
);

preferenceSchema.index({ ownerProfileId: 1 }, { unique: true });

export const ProfilePreference = mongoose.model("ProfilePreference", preferenceSchema);
