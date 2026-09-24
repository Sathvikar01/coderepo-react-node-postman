// Phase 47B test bootstrap.
//
// The route suite exercises a real Express app, real middleware, and a real HTTP
// server, but it does not need a database. Two seams are stubbed here, and only
// here:
//
//   1. `authService.authenticate` accepts the suite's own bearer token shape and
//      returns an in-memory workspace account.
//   2. `profileService.findProfileById` returns an in-memory profile document with
//      an ObjectId-shaped id, so `resolveProfileContext` resolves normally.
//
// The Phase 47A fixtures describe evidence owned by a synthetic profile id, so the
// proof API's ownership check is told that this synthetic id is the resolved
// profile. Nothing in `src/` reads this file; `app.js` is untouched.

import mongoose from "mongoose";

// Configuration must be initialized before any module that reads a fingerprint key
// is imported. The route tests run under `--preload`, so this happens first.
process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase47b_routes_test";
process.env.EXECUTION_FINGERPRINT_KEY =
	process.env.EXECUTION_FINGERPRINT_KEY || "phase47b-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase47b-test-jwt-secret";

const { initConfig } = await import("../src/shared/config/index.js");
initConfig();

import {
	SYNTHETIC_EVIDENCE_OWNER,
	__setSyntheticEvidenceOwnerForTests,
} from "../src/features/verification-proof-api/verification-proof.service.js";

export const profileId = new mongoose.Types.ObjectId();
export const otherProfileId = new mongoose.Types.ObjectId();
export const accountId = new mongoose.Types.ObjectId();

export const TEST_TOKEN = "phase47b-test-token";

const profile = {
	_id: profileId,
	name: "Phase 47B Test Profile",
	email: "phase47b@test.dev",
	avatarColor: "#2F6F5F",
	sortOrder: 0,
};

export const account = {
	_id: accountId,
	name: "Phase 47B Test Workspace",
	email: "phase47b-workspace@test.dev",
	allowedProfileIds: [profileId],
};

__setSyntheticEvidenceOwnerForTests(true);

const authModule = await import("../src/features/auth/auth.service.js");
const authPatched = Object.create(authModule.authService);
// The stub only intercepts this suite's synthetic token. Every other token falls
// through to the real implementation. `bun test` evaluates every suite in one
// process against one shared module registry, so an unconditional replacement
// would silently break real-JWT suites that are evaluated after this one.
const realAuthenticate = authModule.authService.authenticate;
authPatched.authenticate = async (token) => {
	if (String(token) !== TEST_TOKEN) return realAuthenticate.call(authModule.authService, token);
	return { account, payload: { sub: String(accountId), type: "profile", profileId: String(profileId) } };
};
authModule.authService.authenticate = authPatched.authenticate;

const profileModule = await import("../src/features/profiles/profile.service.js");
const profilePatched = Object.create(profileModule.profileService);
// Same rule: answer only for the synthetic profile, delegate everything else.
const realFindProfileById = profileModule.profileService.findProfileById;
profilePatched.findProfileById = async (id) => {
	if (String(id) === String(profileId)) return profile;
	return realFindProfileById.call(profileModule.profileService, id);
};
profileModule.profileService.findProfileById = profilePatched.findProfileById;

export { profile, SYNTHETIC_EVIDENCE_OWNER };
