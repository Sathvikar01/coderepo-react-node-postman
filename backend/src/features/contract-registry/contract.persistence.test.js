import mongoose from "mongoose";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { AppError } from "../../shared/errors/app-error.js";
import { connectTestDatabase, disconnectTestDatabase } from "../../shared/utils/test-db.js";
import { ContractCounter, ContractVersion } from "./contract.model.js";
import { contractRepository } from "./contract.repository.js";
import { createContractRegistryService } from "./contract.service.js";
import { CONTRACT_STATE } from "./contract-schema.js";

// Phase 42A — persistence tests for the contract registry.
//
// These exercise the real Mongoose model, indexes, and repository against MongoDB:
// the atomic sequence allocator, the one-PUBLISHED-per-contract unique index, the
// idempotent-republication path, profile scoping, and restart persistence. They skip
// cleanly when no database is reachable, matching the rest of the suite.

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase42_persistence_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase42-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase42-test-jwt-secret";
initConfig();

const ready = await connectTestDatabase();
if (ready) await ContractVersion.init();

const profileA = new mongoose.Types.ObjectId().toHexString();
const profileB = new mongoose.Types.ObjectId().toHexString();
const collectionId = new mongoose.Types.ObjectId().toHexString();

const TEST_TIMEOUT_MS = 20000;
const mtest = (name, fn) => test(name, fn, TEST_TIMEOUT_MS);

function baseBody(overrides = {}) {
	return { status: 200, statuses: [], headers: [], bodyType: null, body: null, ...overrides };
}

function draftInput(overrides = {}) {
	return {
		contractId: "contract-orders",
		collectionId,
		requestId: "request-1",
		name: "Orders list contract",
		description: "",
		provenance: "explicit",
		body: baseBody(),
		...overrides,
	};
}

async function expectAppError(promise, expected) {
	let caught = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(AppError);
	expect(caught).toMatchObject(expected);
	return caught;
}

describe.skipIf(!ready)("contract registry persistence", () => {
	const service = createContractRegistryService({ now: () => new Date("2026-09-24T00:00:00.000Z"), actor: "tester" });

	beforeEach(async () => {
		await ContractVersion.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } });
		await ContractCounter.deleteMany({ ownerProfileId: { $in: [profileA, profileB] } });
	});

	mtest("a draft persists with its content fingerprint and profile scope", async () => {
		const created = await service.createDraft(profileA, draftInput());
		const stored = await ContractVersion.findById(created._id).lean();
		expect(String(stored.ownerProfileId)).toBe(profileA);
		expect(stored.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(stored.fingerprintKeyId).toBeTruthy();
		expect(stored.content.body.status).toBe(200);
	});

	mtest("sequences increment atomically under concurrent allocation", async () => {
		const created = await Promise.all(
			Array.from({ length: 12 }, (_, index) => service.createDraft(profileA, draftInput({ name: `c${index}` }))),
		);
		const sequences = created.map((row) => row.sequence).sort((left, right) => left - right);
		expect(sequences).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
	});

	mtest("two profiles can own the same contract id and request independently", async () => {
		await service.createDraft(profileA, draftInput({ name: "A" }));
		await service.createDraft(profileB, draftInput({ name: "B" }));
		const mine = await contractRepository.listVersions(profileA, "contract-orders");
		const theirs = await contractRepository.listVersions(profileB, "contract-orders");
		expect(mine).toHaveLength(1);
		expect(theirs).toHaveLength(1);
		expect(mine[0].content.name).toBe("A");
		expect(theirs[0].content.name).toBe("B");
	});

	mtest("a profile cannot read another profile's version", async () => {
		await service.createDraft(profileA, draftInput());
		expect(await contractRepository.findVersion(profileB, "contract-orders", 1)).toBeNull();
	});

	mtest("publishing persists state, actor, and timestamp and supersedes the previous version", async () => {
		await service.createDraft(profileA, draftInput());
		const first = await service.publish(profileA, "contract-orders", 1);
		expect(first.contract.state).toBe(CONTRACT_STATE.PUBLISHED);

		await service.createDraft(profileA, draftInput({ name: "v2", body: baseBody({ status: 201 }) }));
		const second = await service.publish(profileA, "contract-orders", 2);
		expect(second.superseded.sequence).toBe(1);

		const superseded = await service.getVersion(profileA, "contract-orders", 1);
		expect(superseded.state).toBe(CONTRACT_STATE.SUPERSEDED);
		expect(superseded.supersededBySequence).toBe(2);
		expect(superseded.content.name).toBe("Orders list contract");

		const current = await service.getCurrentForRequest(profileA, "request-1");
		expect(current.sequence).toBe(2);
	});

	mtest("the one-published-per-contract index is enforced by the database", async () => {
		await service.createDraft(profileA, draftInput());
		await service.publish(profileA, "contract-orders", 1);
		// Forcing a second published row for the same profile+contract must be refused
		// by the partial unique index, not just by service logic.
		await service.createDraft(profileA, draftInput({ name: "v2", body: baseBody({ status: 201 }) }));
		let caught = null;
		try {
			await ContractVersion.findOneAndUpdate(
				{ ownerProfileId: profileA, contractId: "contract-orders", sequence: 2 },
				{ $set: { state: CONTRACT_STATE.PUBLISHED } },
				{ new: true },
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).not.toBeNull();
		expect(caught.code).toBe(11000);
	});

	mtest("re-publishing identical content is idempotent and writes no new version", async () => {
		await service.createDraft(profileA, draftInput());
		await service.publish(profileA, "contract-orders", 1);
		await service.createDraft(profileA, draftInput());
		const result = await service.publish(profileA, "contract-orders", 2);
		expect(result.idempotent).toBe(true);
		const totalRows = await ContractVersion.countDocuments({ ownerProfileId: profileA, contractId: "contract-orders" });
		expect(totalRows).toBe(2);
		const published = await ContractVersion.countDocuments({
			ownerProfileId: profileA,
			contractId: "contract-orders",
			state: CONTRACT_STATE.PUBLISHED,
		});
		expect(published).toBe(1);
	});
	mtest("publishing an already-published version is idempotent against the database", async () => {
		await service.createDraft(profileA, draftInput());
		await service.publish(profileA, "contract-orders", 1);
		const again = await service.publish(profileA, "contract-orders", 1);
		expect(again.idempotent).toBe(true);
		expect(again.contract.sequence).toBe(1);
	});

	mtest("published content cannot be edited through the repository", async () => {
		await service.createDraft(profileA, draftInput());
		await service.publish(profileA, "contract-orders", 1);
		const attempt = await contractRepository.replaceDraftContent(profileA, "contract-orders", 1, {
			content: { name: "tampered" },
			contentFingerprint: "0".repeat(64),
		});
		expect(attempt).toBeNull();
		const stored = await service.getVersion(profileA, "contract-orders", 1);
		expect(stored.content.name).toBe("Orders list contract");
	});

	mtest("published content cannot be discarded through the repository", async () => {
		await service.createDraft(profileA, draftInput());
		await service.publish(profileA, "contract-orders", 1);
		const attempt = await contractRepository.deleteDraft(profileA, "contract-orders", 1);
		expect(attempt).toBeNull();
		expect(await service.getVersion(profileA, "contract-orders", 1)).toBeTruthy();
	});

	mtest("a service-level edit of a published version is refused", async () => {
		await service.createDraft(profileA, draftInput());
		await service.publish(profileA, "contract-orders", 1);
		await expectAppError(service.updateDraft(profileA, "contract-orders", 1, { name: "x" }), {
			code: "CONTRACT_IMMUTABLE",
			statusCode: 409,
		});
	});

	mtest("version history survives a reconnect and stays ordered", async () => {
		await service.createDraft(profileA, draftInput());
		await service.publish(profileA, "contract-orders", 1);
		await service.createDraft(profileA, draftInput({ name: "v2", body: baseBody({ status: 201 }) }));
		await service.publish(profileA, "contract-orders", 2);

		await disconnectTestDatabase();
		await connectTestDatabase();
		const fresh = createContractRegistryService({ now: () => new Date("2026-09-25T00:00:00.000Z"), actor: "tester" });
		const history = await fresh.listVersions(profileA, "contract-orders");
		expect(history.map((row) => row.sequence)).toEqual([1, 2]);
		expect(history[0].state).toBe(CONTRACT_STATE.SUPERSEDED);
		expect(history[1].state).toBe(CONTRACT_STATE.PUBLISHED);
	});

	mtest("listing the profile's contracts is deterministic", async () => {
		await service.createDraft(profileA, draftInput({ contractId: "b-contract" }));
		await service.createDraft(profileA, draftInput({ contractId: "a-contract" }));
		await service.createDraft(profileA, draftInput({ contractId: "a-contract", name: "second" }));
		const rows = await service.listForProfile(profileA);
		expect(rows.map((row) => row.contractId)).toEqual(["a-contract", "a-contract", "b-contract"]);
		expect(rows.map((row) => row.sequence)).toEqual([1, 2, 1]);
	});

	mtest("a persisted inferred contract keeps its provenance and body shape", async () => {
		const { inferContractFromResponse } = await import("./contract-inference.js");
		const inferred = inferContractFromResponse({
			response: { status: 200, contentType: "application/json", body: '{"ok":true,"items":[{"id":1}]}' },
			name: "Inferred",
		});
		const draft = await service.createDraftFromResponse(profileA, draftInput({ name: "Inferred" }), inferred);
		const stored = await service.getVersion(profileA, "contract-orders", draft.sequence);
		expect(stored.content.provenance).toBe("inferred");
		expect(stored.content.body.body.properties.items.items.properties.id.type).toBe("number");
	});
});

afterAll(async () => {
	await disconnectTestDatabase();
});
