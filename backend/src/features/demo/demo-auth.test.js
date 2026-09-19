import { describe, expect, test } from "bun:test";
import { requireTargetAuth } from "./demo.service.js";

function fakeRequest(authorization) {
	return { get: (name) => (name.toLowerCase() === "authorization" ? authorization : undefined) };
}

const ORIGINAL = { local: process.env.DEMO_LOCAL_TOKEN, staging: process.env.DEMO_STAGING_TOKEN };

function withTokens(local, staging, run) {
	process.env.DEMO_LOCAL_TOKEN = local;
	process.env.DEMO_STAGING_TOKEN = staging;
	try {
		return run();
	} finally {
		process.env.DEMO_LOCAL_TOKEN = ORIGINAL.local;
		process.env.DEMO_STAGING_TOKEN = ORIGINAL.staging;
	}
}

describe("demo target token validation", () => {
	test("accepts the exact configured token", () => {
		withTokens("local-secret-value", "staging-secret-value", () => {
			expect(() => requireTargetAuth(fakeRequest("Bearer local-secret-value"), "local")).not.toThrow();
			expect(() => requireTargetAuth(fakeRequest("Bearer staging-secret-value"), "staging")).not.toThrow();
		});
	});

	test("rejects a wrong token of the same length", () => {
		withTokens("local-secret-value", "staging-secret-value", () => {
			expect(() => requireTargetAuth(fakeRequest("Bearer local-secret-XXXXX"), "local")).toThrow();
		});
	});

	test("rejects wrong tokens of shorter and longer lengths", () => {
		withTokens("local-secret-value", "staging-secret-value", () => {
			expect(() => requireTargetAuth(fakeRequest("Bearer local"), "local")).toThrow();
			expect(() => requireTargetAuth(fakeRequest("Bearer local-secret-value-and-more"), "local")).toThrow();
		});
	});

	test("rejects a token from the other dataset", () => {
		withTokens("local-secret-value", "staging-secret-value", () => {
			expect(() => requireTargetAuth(fakeRequest("Bearer staging-secret-value"), "local")).toThrow();
		});
	});

	test("rejects a missing or malformed authorization header", () => {
		withTokens("local-secret-value", "staging-secret-value", () => {
			expect(() => requireTargetAuth(fakeRequest(""), "local")).toThrow();
			expect(() => requireTargetAuth(fakeRequest("Basic local-secret-value"), "local")).toThrow();
		});
	});

	test("rejects when no token is configured", () => {
		withTokens("", "", () => {
			expect(() => requireTargetAuth(fakeRequest("Bearer anything"), "local")).toThrow();
		});
	});
});
