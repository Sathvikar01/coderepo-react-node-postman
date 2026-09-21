import mongoose from "mongoose";

const profileCookieSchema = new mongoose.Schema(
	{
		ownerProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
		name: { type: String, required: true, maxlength: 256 },
		value: { type: String, default: "" },
		domain: { type: String, required: true, maxlength: 255 },
		hostOnly: { type: Boolean, default: true },
		path: { type: String, required: true, maxlength: 1024 },
		secure: { type: Boolean, default: false },
		httpOnly: { type: Boolean, default: false },
		expiresAt: { type: Date, default: null },
		// Session cookies live for one backend process; persistent cookies carry an
		// expiry and survive restarts. Session-cookie lifetime is a frozen product
		// decision documented in README.md ("Cookie jar").
		sessionId: { type: String, default: null },
	},
	{ timestamps: true, versionKey: false, minimize: false },
);

profileCookieSchema.index({ ownerProfileId: 1, name: 1, domain: 1, path: 1 }, { unique: true });
profileCookieSchema.index({ ownerProfileId: 1, expiresAt: 1 });

export const ProfileCookie = mongoose.model("ProfileCookie", profileCookieSchema);
