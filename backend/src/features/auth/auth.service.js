import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { getConfig } from "../../shared/config/index.js";
import { profileService } from "../profiles/profile.service.js";
import { authRepository } from "./auth.repository.js";

const publicAccount = (account) => ({ _id: String(account._id), name: account.name, email: account.email });
const publicProfile = (profile) => ({
	_id: String(profile._id),
	name: profile.name,
	email: profile.email,
	avatarColor: profile.avatarColor,
	sortOrder: profile.sortOrder,
});

function sign(account, profileId) {
	const config = getConfig();
	return jwt.sign(
		{ sub: String(account._id), type: profileId ? "profile" : "workspace", ...(profileId ? { profileId: String(profileId) } : {}) },
		config.jwtSecret,
		{ expiresIn: config.jwtExpiresIn, issuer: config.jwtIssuer, audience: config.jwtAudience },
	);
}

export const authService = {
	async login(email, password) {
		const account = await authRepository.findActiveByEmailWithPassword(email.toLowerCase());
		const valid = account ? await bcrypt.compare(password, account.passwordHash) : false;
		if (!valid) throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
		return { account: publicAccount(account), token: sign(account) };
	},
	async authenticate(token) {
		let payload;
		try {
			payload = jwt.verify(token, getConfig().jwtSecret, { issuer: getConfig().jwtIssuer, audience: getConfig().jwtAudience });
		} catch {
			throw new AppError(401, "INVALID_TOKEN", "Your Tracer session is invalid or has expired.");
		}
		if (!mongoose.isValidObjectId(payload.sub))
			throw new AppError(401, "INVALID_TOKEN", "Your Tracer session is invalid or has expired.");
		const account = await authRepository.findActiveById(payload.sub);
		if (!account) throw new AppError(401, "ACCOUNT_UNAVAILABLE", "This workspace account is no longer available.");
		return { account, payload };
	},
	session(account) {
		return { account: publicAccount(account) };
	},
	async switchProfile(account, profileId) {
		if (!mongoose.isValidObjectId(profileId)) throw new AppError(404, "PROFILE_NOT_FOUND", "The requested profile does not exist.");
		if (!account.allowedProfileIds.some((id) => String(id) === String(profileId))) {
			throw new AppError(403, "PROFILE_FORBIDDEN", "This profile is not available in the current workspace.");
		}
		const profile = await profileService.findProfileById(profileId);
		if (!profile) throw new AppError(404, "PROFILE_NOT_FOUND", "The requested profile does not exist.");
		return { profile: publicProfile(profile), token: sign(account, profileId) };
	},
};
