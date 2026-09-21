import crypto from "node:crypto";
import { getConfig } from "../../shared/config/index.js";

export function mockTokenFor(profileId) {
	return crypto
		.createHmac("sha256", getConfig().fingerprintKey)
		.update(`tracer-mock-route:${profileId}`)
		.digest("base64url")
		.slice(0, 22);
}

export function verifyMockToken(profileId, token) {
	const expected = mockTokenFor(profileId);
	const provided = String(token ?? "");
	if (provided.length !== expected.length) return false;
	return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function mockBasePath(profileId) {
	return `/api/v1/mocks/${profileId}/${mockTokenFor(profileId)}`;
}
