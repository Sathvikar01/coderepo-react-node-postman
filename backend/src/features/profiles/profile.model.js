import mongoose from "mongoose";

const profileSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: 120 },
        email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
        avatarColor: { type: String, required: true, match: /^#[0-9A-Fa-f]{6}$/ },
        sortOrder: { type: Number, required: true, default: 0 },
    },
    { timestamps: true, versionKey: false },
);

export const Profile = mongoose.model("Profile", profileSchema);
