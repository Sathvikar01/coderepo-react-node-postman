import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../../app.js";
import { getConfig, initConfig } from "../../shared/config/index.js";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { WorkspaceAccount } from "../auth/workspace-account.model.js";
import { Collection } from "../collections/collection.model.js";
import { Environment } from "../environments/environment.model.js";
import { Investigation } from "../execution-intelligence/investigation/investigation.model.js";
import { ExecutionHistory } from "../history/history.model.js";
import { fingerprintKeyId, fingerprintOf } from "../history/fingerprint.js";
import { Profile } from "../profiles/profile.model.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase49_routes_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase49-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase49-test-jwt-secret";
initConfig();

const ready = await connectTestDatabase();
if (ready)
	await Promise.all([
		Collection.init(),
		Environment.init(),
		Investigation.init(),
		ExecutionHistory.init(),
		Profile.init(),
		WorkspaceAccount.init(),
	]);

const TEST_TIMEOUT_MS = 20000;
const mtest = (name, fn) => test(name, fn, TEST_TIMEOUT_MS);

let server = null;
let baseUrl = "";
let account = null;
let profileA = null;
let profileB = null;
let tokenA = "";
let tokenB = "";

function signToken(profileId) {
	const config = getConfig();
	return jwt.sign(
		{ sub: String(account._id), type: "profile", profileId: String(profileId) },
		config.jwtSecret,
		{ expiresIn: config.jwtExpiresIn, issuer: config.jwtIssuer, audience: config.jwtAudience },
	);
}

async function api(path, { method = "GET", token = tokenA } = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
	const text = await response.text();
	return { status: response.status, payload: text ? JSON.parse(text) : null };
}

function requestDefinition(overrides = {}) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		folderId: null,
		name: "List orders",
		method: "GET",
		urlTemplate: "http://127.0.0.1:8000/demo/orders",
		query: [{ id: randomUUID(), key: "status", value: "paid", enabled: true }],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		settings: { timeoutMs: 15000 },
		...overrides,
	};
}

function storedReceipt(executionId, overrides = {}) {
	const request = requestDefinition();
	return {
		schemaVersion: 1,
		kind: "tracer.execution-receipt",
		executionId,
		fingerprint: "a".repeat(64),
		fingerprintKeyId: fingerprintKeyId(),
		startedAt: "2026-09-17T10:00:00.000Z",
		finishedAt: "2026-09-17T10:00:01.000Z",
		outcome: "response",
		effectCertainty: "may_have_reached_target",
		request: {
			method: "GET",
			displayUrl: "http://127.0.0.1:8000/demo/orders?status={{status_filter}}",
			executedUrl: "http://127.0.0.1:8000/demo/orders?status=paid",
			authoredFingerprint: fingerprintOf({ request, context: {} }),
			compiledFingerprint: "c".repeat(64),
			headerNames: [],
			queryKeys: ["status"],
			body: { mode: "none", sizeBytes: 0, fingerprint: null },
			auth: { mode: "none", source: "request", referenceKeys: [] },
			variableSources: [{ field: "query.value", key: "status_filter", scope: "environment" }],
		},
		source: { type: "scratch" },
		policy: { decision: "allowed", version: 7, local: false },
		target: { scheme: "http", hostname: "127.0.0.1", port: 8000, address: "127.0.0.1", family: 4 },
		redirects: [],
		transport: { httpVersion: "HTTP/1.1", durationMs: 8.2, firstByteMs: 6.1, receivedBodyBytes: 40, capturedBodyBytes: 40 },
		response: {
			bodyFingerprint: "d".repeat(64),
			truncated: false,
			binary: false,
			contract: { status: 200, headers: [{ name: "content-type", count: 1 }], bodyShape: [{ path: "$.id", type: "string" }] },
		},
		error: null,
		tests: { counts: { passed: 0, failed: 0, error: 0 }, failureFingerprint: null },
		warnings: [],
		...overrides,
	};
}

async function seedExecution(profileId, { executionId = randomUUID(), receiptOverrides = {}, recordOverrides = {} } = {}) {
	const request = requestDefinition();
	await ExecutionHistory.create({
		ownerProfileId: profileId,
		executionId,
		fingerprint: fingerprintOf({ request, context: {} }),
		fingerprintKeyId: fingerprintKeyId(),
		instanceId: "test-instance",
		status: "terminal",
		outcome: "response",
		effectCertainty: "may_have_reached_target",
		persistence: { state: "saved" },
		request,
		context: { tabId: "tab-1", draftVersion: 1 },
		snapshot: { displayUrl: request.urlTemplate, executedUrl: "http://127.0.0.1:8000/demo/orders?status=paid" },
		compileTrace: [{ field: "query.value", variable: "status_filter", scope: "environment" }],
		warnings: [],
		error: null,
		response: { status: 200 },
		receipt: storedReceipt(executionId, receiptOverrides),
		startedAt: new Date(),
		finishedAt: new Date(),
		...recordOverrides,
	});
	return executionId;
}

describe.skipIf(!ready)("Phase 49 — Why? Inspector over HTTP", () => {
	beforeAll(async () => {
		profileA = await Profile.create({ name: "Alex", email: "alex@why.test", avatarColor: "#2F6F5F", sortOrder: 0 });
		profileB = await Profile.create({ name: "Jordan", email: "jordan@why.test", avatarColor: "#4C6EF5", sortOrder: 1 });
		account = await WorkspaceAccount.create({
			name: "Workspace",
			email: "workspace@why.test",
			passwordHash: "not-used-in-this-test",
			allowedProfileIds: [profileA._id, profileB._id],
		});
		tokenA = signToken(profileA._id);
		tokenB = signToken(profileB._id);
		const app = createApp();
		server = app.listen(0);
		baseUrl = `http://127.0.0.1:${server.address().port}`;
	});

	afterAll(async () => {
		server?.close();
		if (ready) {
			const profiles = [profileA?._id, profileB?._id].filter(Boolean);
			await Promise.all([
				ExecutionHistory.deleteMany({ ownerProfileId: { $in: profiles } }),
				Investigation.deleteMany({ ownerProfileId: { $in: profiles } }),
				Collection.deleteMany({ ownerProfileId: { $in: profiles } }),
				Environment.deleteMany({ ownerProfileId: { $in: profiles } }),
				WorkspaceAccount.deleteMany({ _id: account?._id }),
				Profile.deleteMany({ _id: { $in: profiles } }),
			]);
		}
		await disconnectTestDatabase();
	});

	beforeEach(async () => {
		const profiles = [profileA._id, profileB._id];
		await Promise.all([
			ExecutionHistory.deleteMany({ ownerProfileId: { $in: profiles } }),
			Investigation.deleteMany({ ownerProfileId: { $in: profiles } }),
			Collection.deleteMany({ ownerProfileId: { $in: profiles } }),
			Environment.deleteMany({ ownerProfileId: { $in: profiles } }),
		]);
	});

	mtest("requires authentication", async () => {
		const executionId = await seedExecution(profileA._id);
		const response = await api(`/api/v1/why/executions/${executionId}`, { token: "" });
		expect(response.status).toBe(401);
	});

	mtest("rejects a malformed execution identifier", async () => {
		const response = await api("/api/v1/why/executions/not-a-uuid");
		expect(response.status).toBe(400);
		expect(response.payload.error.code).toBe("VALIDATION_ERROR");
	});

	mtest("returns 404 for an unknown execution and for another profile's execution", async () => {
		const unknown = await api(`/api/v1/why/executions/${randomUUID()}`);
		expect(unknown.status).toBe(404);
		expect(unknown.payload.error.code).toBe("EXECUTION_NOT_FOUND");

		const executionId = await seedExecution(profileA._id);
		const otherProfile = await api(`/api/v1/why/executions/${executionId}`, { token: tokenB });
		expect(otherProfile.status).toBe(404);
	});

	mtest("explains a recorded execution without resolving secrets", async () => {
		const secret = "phase49-literal-secret-token";
		const executionId = await seedExecution(profileA._id, {
			recordOverrides: { request: requestDefinition({ auth: { mode: "bearer", tokenTemplate: secret } }) },
		});
		const response = await api(`/api/v1/why/executions/${executionId}`);
		expect(response.status).toBe(200);
		const explanation = response.payload.data;
		expect(explanation.kind).toBe("tracer.why-explanation");
		expect(explanation.schemaVersion).toBe(2);
		expect(explanation.recorded).toBe(true);
		expect(explanation.configuration.state).toBe("partial");
		expect(explanation.configuration.entries.length).toBeGreaterThan(0);
		expect(explanation.configuration.gaps.map((gap) => gap.code)).toContain("NO_SOURCE_REFERENCE");
		expect(explanation.dependencies.variables.map((variable) => variable.scope)).toEqual(["environment"]);
		expect(explanation.verification.state).toBe("UNKNOWN");
		expect(explanation.change.recorded).toBe(false);
		expect(JSON.stringify(explanation)).not.toContain(secret);
	});

	mtest("resolves collection and environment names from the current documents", async () => {
		const collection = await Collection.create({
			ownerProfileId: profileA._id,
			name: "Demo orders",
			nameKey: "demo orders",
			auth: { mode: "none" },
			revision: 4,
		});
		const environment = await Environment.create({
			ownerProfileId: profileA._id,
			name: "Local",
			nameKey: "local",
			variables: [],
			revision: 2,
		});
		const executionId = await seedExecution(profileA._id, {
			receiptOverrides: {
				source: {
					type: "collection",
					collectionId: String(collection._id),
					collectionRevision: 4,
					environmentId: String(environment._id),
					environmentRevision: 1,
				},
			},
		});
		const response = await api(`/api/v1/why/executions/${executionId}`);
		const explanation = response.payload.data;
		const sourceEntries = explanation.configuration.entries.filter((entry) => entry.group === "source");
		expect(sourceEntries.find((entry) => entry.id === "source.collection").value).toBe("Demo orders");
		expect(sourceEntries.find((entry) => entry.id === "source.environment").value).toBe("Local");
		const references = explanation.dependencies.references;
		expect(references.find((reference) => reference.kind === "environment").currentRevision).toBe(2);
		expect(explanation.configuration.gaps.map((gap) => gap.code)).toContain("SOURCE_REVISION_CHANGED");
	});

	mtest("composes a persisted investigation as change evidence", async () => {
		const executionId = await seedExecution(profileA._id);
		await Investigation.create({
			ownerProfileId: profileA._id,
			investigationId: randomUUID(),
			schemaVersion: 1,
			kind: "tracer.investigation",
			failingExecutionId: executionId,
			status: "completed",
			stage: "completed",
			startedAt: new Date(),
			finishedAt: new Date(),
			expiresAt: new Date(Date.now() + 86_400_000),
			result: {
				summary: { text: "One verified cause.", counts: { verifiedCauses: 1 } },
				comparison: {
					available: true,
					baseExecutionId: "base-1",
					candidateExecutionId: executionId,
					firstDivergence: { category: "environment", path: "environment.status_filter", message: "paid -> pending" },
					changes: [{ category: "environment", path: "environment.status_filter", message: "paid -> pending" }],
				},
				verifiedCauses: [{ label: "verified", path: "environment.status_filter", executionIds: ["probe-1"] }],
				unverifiedChanges: [],
			},
		});
		const response = await api(`/api/v1/why/executions/${executionId}`);
		const explanation = response.payload.data;
		expect(explanation.change.recorded).toBe(true);
		expect(explanation.change.comparisons[0].firstDivergence.message).toBe("paid -> pending");
		expect(explanation.change.comparisons[0].verifiedCauses).toHaveLength(1);
		// Phase 49B chain vocabulary is fixed to WHY_CHAIN (configuration,
		// execution, impact, drift, rehearsal, contract, verification, proof);
		// the composed investigation lives in the change section, not the chain.
		expect(explanation.evidence.chain.map((node) => node.kind)).toContain("verification");
	});

	mtest("a recorded policy block is an observation, never a verification state", async () => {
		const executionId = await seedExecution(profileA._id, {
			receiptOverrides: { policy: { decision: "blocked", version: 7, local: false }, target: null, transport: null, response: null },
			recordOverrides: { outcome: "validation_error", response: null, error: { code: "TARGET_BLOCKED", message: "blocked" } },
		});
		const response = await api(`/api/v1/why/executions/${executionId}`);
		// Phase 49B: only a linked Phase 41 result is authoritative. With no
		// proof linked, the state stays UNKNOWN and the recorded policy
		// decision is reported as an observation-only reason.
		expect(response.payload.data.verification.state).toBe("UNKNOWN");
		expect(response.payload.data.verification.stateBasis).toBe("none");
		expect(JSON.stringify(response.payload.data.verification.reasons)).toContain("blocked");
	});

	mtest("recorded assertions are observations, never a verification state", async () => {
		const executionId = await seedExecution(profileA._id, {
			receiptOverrides: { tests: { counts: { passed: 2, failed: 0, error: 0 }, failureFingerprint: null } },
		});
		const response = await api(`/api/v1/why/executions/${executionId}`);
		expect(response.payload.data.verification.state).toBe("UNKNOWN");
		expect(response.payload.data.verification.stateBasis).toBe("none");
		expect(JSON.stringify(response.payload.data.verification.reasons)).toContain("2 request assertions");
	});

	mtest("a second profile's investigation is never composed into another profile's explanation", async () => {
		const executionId = await seedExecution(profileA._id);
		await Investigation.create({
			ownerProfileId: profileB._id,
			investigationId: randomUUID(),
			schemaVersion: 1,
			kind: "tracer.investigation",
			failingExecutionId: executionId,
			status: "completed",
			stage: "completed",
			startedAt: new Date(),
			finishedAt: new Date(),
			expiresAt: new Date(Date.now() + 86_400_000),
			result: { summary: { text: "should not appear" }, comparison: { available: true } },
		});
		const response = await api(`/api/v1/why/executions/${executionId}`);
		expect(response.payload.data.change.recorded).toBe(false);
		expect(JSON.stringify(response.payload.data)).not.toContain("should not appear");
	});
});
