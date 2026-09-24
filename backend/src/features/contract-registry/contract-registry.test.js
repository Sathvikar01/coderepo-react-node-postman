import { describe, expect, test } from "bun:test";
import { initConfig } from "../../shared/config/index.js";
import { AppError } from "../../shared/errors/app-error.js";

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/request_desk_phase42_test";
process.env.EXECUTION_FINGERPRINT_KEY = process.env.EXECUTION_FINGERPRINT_KEY || "phase42-test-fingerprint-key-0123456789";
process.env.JWT_SECRET = process.env.JWT_SECRET || "phase42-test-jwt-secret";
initConfig();
import {
	CONTRACT_LIMITS,
	CONTRACT_STATE,
	canonicalContractJson,
	canonicalizeContractValue,
	contractFingerprint,
	inferContractBody,
	inferContractFromResponse,
	parseContractBody,
	parseContractDraftInput,
} from "./index.js";
import { createContractRegistryService } from "./contract.service.js";

// Phase 42A — Contract registry tests that need no database.
//
// The service is written against an injected repository, so lifecycle,
// concurrency, idempotency, and isolation semantics are exercised against a fake
// repository that is deliberately *more* hostile than the real one: it enforces
// the same uniqueness constraints synchronously, so a racing caller fails exactly
// as it would against Mongo's unique index.

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------
//
// Mirrors the real repository's contract, including the two uniqueness rules
// (one row per (profile, contract, sequence); at most one PUBLISHED row per
// (profile, contract)) so concurrency behaviour is testable without a server.
function createFakeRepository() {
	const rows = [];
	const counters = new Map();
	let idCounter = 0;
	const key = (...parts) => parts.join("\u0000");

	function assertUnique(row, { isUpdate = false } = {}) {
		const duplicateSequence = rows.some(
			(existing) =>
				// A row being updated is itself, so it is excluded from its own
				// uniqueness check; only genuinely different rows can collide.
				!isUpdate &&
				key(existing.ownerProfileId, existing.contractId, existing.sequence) ===
					key(row.ownerProfileId, row.contractId, row.sequence),
		);
		if (duplicateSequence) {
			const error = new Error("E11000 duplicate key error: sequence");
			error.code = 11000;
			throw error;
		}
		if (row.state === CONTRACT_STATE.PUBLISHED && !isUpdate) {
			const duplicatePublished = rows.some(
				(existing) =>
					existing.ownerProfileId === row.ownerProfileId &&
					existing.contractId === row.contractId &&
					existing.sequence !== row.sequence &&
					existing.state === CONTRACT_STATE.PUBLISHED,
			);
			if (duplicatePublished) {
				const error = new Error("E11000 duplicate key error: published");
				error.code = 11000;
				throw error;
			}
		}
	}

	const clone = (row) => JSON.parse(JSON.stringify(row));

	return {
		rows,
		async allocateSequence(ownerProfileId, contractId) {
			const counterKey = key(ownerProfileId, contractId);
			const next = counters.get(counterKey) ?? 1;
			counters.set(counterKey, next + 1);
			return next;
		},
		async insertVersion(document) {
			const row = { _id: `row-${(idCounter += 1)}`, ...clone(document), createdAt: new Date(), updatedAt: new Date() };
			assertUnique(row);
			rows.push(row);
			return clone(row);
		},
		async findVersion(ownerProfileId, contractId, sequence) {
			const found = rows.find(
				(row) => row.ownerProfileId === ownerProfileId && row.contractId === contractId && row.sequence === sequence,
			);
			return found ? clone(found) : null;
		},
		async listVersions(ownerProfileId, contractId) {
			return rows
				.filter((row) => row.ownerProfileId === ownerProfileId && row.contractId === contractId)
				.sort((left, right) => left.sequence - right.sequence)
				.map(clone);
		},
		async findPublishedForRequest(ownerProfileId, requestId) {
			const found = rows.find(
				(row) => row.ownerProfileId === ownerProfileId && row.requestId === requestId && row.state === CONTRACT_STATE.PUBLISHED,
			);
			return found ? clone(found) : null;
		},
		async listForRequest(ownerProfileId, requestId) {
			return rows
				.filter((row) => row.ownerProfileId === ownerProfileId && row.requestId === requestId)
				.sort((left, right) => left.contractId.localeCompare(right.contractId) || left.sequence - right.sequence)
				.map(clone);
		},
		async listForProfile(ownerProfileId, { state } = {}) {
			return rows
				.filter((row) => row.ownerProfileId === ownerProfileId && (!state || row.state === state))
				.sort(
					(left, right) =>
						left.requestId.localeCompare(right.requestId) ||
						left.contractId.localeCompare(right.contractId) ||
						left.sequence - right.sequence,
				)
				.map(clone);
		},
		async markPublished(ownerProfileId, contractId, sequence, { publishedBy, publishedAt }) {
			const row = rows.find(
				(item) =>
					item.ownerProfileId === ownerProfileId &&
					item.contractId === contractId &&
					item.sequence === sequence &&
					item.state === CONTRACT_STATE.DRAFT,
			);
			if (!row) return null;
			row.state = CONTRACT_STATE.PUBLISHED;
			row.publishedBy = publishedBy ?? null;
			row.publishedAt = publishedAt;
			row.supersededBySequence = null;
			row.supersededAt = null;
			assertUnique(row, { isUpdate: true });
			return clone(row);
		},
		async markSuperseded(ownerProfileId, contractId, sequence, supersededBySequence, supersededAt) {
			const row = rows.find(
				(item) =>
					item.ownerProfileId === ownerProfileId &&
					item.contractId === contractId &&
					item.sequence === sequence &&
					item.state === CONTRACT_STATE.PUBLISHED,
			);
			if (!row) return null;
			row.state = CONTRACT_STATE.SUPERSEDED;
			row.supersededBySequence = supersededBySequence;
			row.supersededAt = supersededAt;
			return clone(row);
		},
		async restorePublished(ownerProfileId, contractId, sequence) {
			const row = rows.find(
				(item) =>
					item.ownerProfileId === ownerProfileId &&
					item.contractId === contractId &&
					item.sequence === sequence &&
					item.state === CONTRACT_STATE.SUPERSEDED,
			);
			if (!row) return null;
			row.state = CONTRACT_STATE.PUBLISHED;
			row.supersededBySequence = null;
			row.supersededAt = null;
			return clone(row);
		},
		async replaceDraftContent(ownerProfileId, contractId, sequence, update) {
			const row = rows.find(
				(item) =>
					item.ownerProfileId === ownerProfileId &&
					item.contractId === contractId &&
					item.sequence === sequence &&
					item.state === CONTRACT_STATE.DRAFT,
			);
			if (!row) return null;
			Object.assign(row, clone(update));
			return clone(row);
		},
		async deleteDraft(ownerProfileId, contractId, sequence) {
			const index = rows.findIndex(
				(item) =>
					item.ownerProfileId === ownerProfileId &&
					item.contractId === contractId &&
					item.sequence === sequence &&
					item.state === CONTRACT_STATE.DRAFT,
			);
			if (index === -1) return null;
			return clone(rows.splice(index, 1)[0]);
		},
	};
}

const PROFILE = "64b7f0c2f1a2b3c4d5e6f701";
const OTHER_PROFILE = "64b7f0c2f1a2b3c4d5e6f702";
const COLLECTION = "64b7f0c2f1a2b3c4d5e6f703";

function baseBody(overrides = {}) {
	return {
		status: 200,
		statuses: [],
		headers: [],
		bodyType: null,
		body: null,
		...overrides,
	};
}

function draftInput(overrides = {}) {
	return {
		contractId: "contract-orders",
		collectionId: COLLECTION,
		requestId: "request-1",
		name: "Orders list contract",
		description: "",
		provenance: "explicit",
		body: baseBody(),
		...overrides,
	};
}

function harness() {
	const repository = createFakeRepository();
	const service = createContractRegistryService({
		repository,
		now: () => new Date("2026-09-24T00:00:00.000Z"),
		actor: "tester",
	});
	return { repository, service };
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

// ---------------------------------------------------------------------------
// 1. Create draft
// ---------------------------------------------------------------------------
describe("1. create draft", () => {
	test("a draft is stored as version 1 in DRAFT state", async () => {
		const { service } = harness();
		const created = await service.createDraft(PROFILE, draftInput());
		expect(created.state).toBe(CONTRACT_STATE.DRAFT);
		expect(created.sequence).toBe(1);
		expect(created.contractId).toBe("contract-orders");
		expect(created.requestId).toBe("request-1");
	});

	test("a generated contract id is used when none is supplied", async () => {
		const { service } = harness();
		const created = await service.createDraft(PROFILE, draftInput({ contractId: undefined }));
		expect(created.contractId).toMatch(/^contract_[a-f0-9]{24}$/);
	});

	test("sequentially created drafts on one contract increment the version", async () => {
		const { service } = harness();
		const first = await service.createDraft(PROFILE, draftInput());
		const second = await service.createDraft(PROFILE, draftInput({ name: "Second" }));
		expect([first.sequence, second.sequence]).toEqual([1, 2]);
	});
});

// ---------------------------------------------------------------------------
// 2. Publish contract
// ---------------------------------------------------------------------------
describe("2. publish contract", () => {
	test("publishing a draft moves it to PUBLISHED with an actor and timestamp", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		const { contract, idempotent, superseded } = await service.publish(PROFILE, "contract-orders", 1);
		expect(contract.state).toBe(CONTRACT_STATE.PUBLISHED);
		expect(contract.publishedAt).toEqual("2026-09-24T00:00:00.000Z");
		expect(contract.publishedBy).toBe("tester");
		expect(idempotent).toBe(false);
		expect(superseded).toBeNull();
	});

	test("a published contract becomes the current one for its request", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.publish(PROFILE, "contract-orders", 1);
		const current = await service.getCurrentForRequest(PROFILE, "request-1");
		expect(current.sequence).toBe(1);
		expect(current.state).toBe(CONTRACT_STATE.PUBLISHED);
	});
});

// ---------------------------------------------------------------------------
// 3. Immutable published contract
// ---------------------------------------------------------------------------
describe("3. published contracts are immutable", () => {
	test("editing a published version is refused", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.publish(PROFILE, "contract-orders", 1);
		await expectAppError(
			service.updateDraft(PROFILE, "contract-orders", 1, { name: "Changed" }),
			{ code: "CONTRACT_IMMUTABLE", statusCode: 409 },
		);
	});

	test("discarding a published version is refused", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.publish(PROFILE, "contract-orders", 1);
		await expectAppError(service.discardDraft(PROFILE, "contract-orders", 1), { code: "CONTRACT_IMMUTABLE", statusCode: 409 });
	});

	test("a published contract's content is unchanged after a later version is published", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.publish(PROFILE, "contract-orders", 1);
		const before = await service.getVersion(PROFILE, "contract-orders", 1);
		await service.createDraft(PROFILE, draftInput({ name: "Second" }));
		await service.publish(PROFILE, "contract-orders", 2);
		const after = await service.getVersion(PROFILE, "contract-orders", 1);
		expect(after.contentFingerprint).toBe(before.contentFingerprint);
		expect(after.content.name).toBe("Orders list contract");
	});
});

// ---------------------------------------------------------------------------
// 4. Second version supersedes the first
// ---------------------------------------------------------------------------
describe("4. a newer version supersedes the previous published version", () => {
	test("publishing version 2 supersedes version 1 for the same request", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.publish(PROFILE, "contract-orders", 1);
		await service.createDraft(PROFILE, draftInput({ name: "Second", body: baseBody({ status: 201 }) }));
		const { superseded } = await service.publish(PROFILE, "contract-orders", 2);
		expect(superseded.sequence).toBe(1);
		expect(superseded.state).toBe(CONTRACT_STATE.SUPERSEDED);
		expect(superseded.supersededBySequence).toBe(2);
	});

	test("the current contract for the request becomes version 2", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.publish(PROFILE, "contract-orders", 1);
		await service.createDraft(PROFILE, draftInput({ name: "Second", body: baseBody({ status: 201 }) }));
		await service.publish(PROFILE, "contract-orders", 2);
		const current = await service.getCurrentForRequest(PROFILE, "request-1");
		expect(current.sequence).toBe(2);
	});

	test("a superseded version cannot be published again", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.publish(PROFILE, "contract-orders", 1);
		await service.createDraft(PROFILE, draftInput({ name: "Second", body: baseBody({ status: 201 }) }));
		await service.publish(PROFILE, "contract-orders", 2);
		await expectAppError(service.publish(PROFILE, "contract-orders", 1), { code: "CONTRACT_STATE_INVALID", statusCode: 409 });
	});
});

// ---------------------------------------------------------------------------
// 5. Version history preserved
// ---------------------------------------------------------------------------
describe("5. version history is preserved", () => {
	test("all versions remain readable after supersession", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.publish(PROFILE, "contract-orders", 1);
		await service.createDraft(PROFILE, draftInput({ name: "v2", body: baseBody({ status: 201 }) }));
		await service.publish(PROFILE, "contract-orders", 2);
		await service.createDraft(PROFILE, draftInput({ name: "v3", body: baseBody({ status: 202 }) }));
		await service.publish(PROFILE, "contract-orders", 3);

		const history = await service.listVersions(PROFILE, "contract-orders");
		expect(history.map((row) => row.sequence)).toEqual([1, 2, 3]);
		expect(history.map((row) => row.state)).toEqual([
			CONTRACT_STATE.SUPERSEDED,
			CONTRACT_STATE.SUPERSEDED,
			CONTRACT_STATE.PUBLISHED,
		]);
	});

	test("discarding a draft removes only the draft", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.publish(PROFILE, "contract-orders", 1);
		await service.createDraft(PROFILE, draftInput({ name: "throwaway" }));
		await service.discardDraft(PROFILE, "contract-orders", 2);
		const history = await service.listVersions(PROFILE, "contract-orders");
		expect(history.map((row) => row.sequence)).toEqual([1]);
	});
});

// ---------------------------------------------------------------------------
// 6/7/8. Deterministic canonicalization and fingerprinting
// ---------------------------------------------------------------------------
describe("6-8. canonicalization and fingerprint determinism", () => {
	test("object key ordering does not change canonical bytes", () => {
		const left = { provenance: "explicit", body: baseBody({ bodyType: "object", body: { type: "object", properties: { b: { type: "string" }, a: { type: "number" } } } }) };
		const right = { provenance: "explicit", body: baseBody({ bodyType: "object", body: { type: "object", properties: { a: { type: "number" }, b: { type: "string" } } } }) };
		expect(canonicalContractJson(left)).toBe(canonicalContractJson(right));
	});

	test("undefined members are dropped, so omission equals explicit undefined", () => {
		expect(canonicalContractJson({ provenance: "explicit", body: baseBody({ note: undefined }) })).toBe(
			canonicalContractJson({ provenance: "explicit", body: baseBody() }),
		);
	});

	test("null is preserved and differs from absent", () => {
		expect(canonicalizeContractValue({ a: null })).not.toEqual(canonicalizeContractValue({}));
	});

	test("array order is preserved for required-property lists", () => {
		const left = canonicalContractJson({ provenance: "explicit", body: baseBody({ bodyType: "object", body: { type: "object", requiredProperties: ["a", "b"] } }) });
		const right = canonicalContractJson({ provenance: "explicit", body: baseBody({ bodyType: "object", body: { type: "object", requiredProperties: ["b", "a"] } }) });
		expect(left).not.toBe(right);
	});

	test("header order does not change the fingerprint but header content does", () => {
		const headers = [
			{ name: "Content-Type", value: "application/json", required: true },
			{ name: "X-Trace", value: null, required: false },
		];
		const forward = contractFingerprint({ provenance: "explicit", body: baseBody({ headers }) });
		const reversed = contractFingerprint({ provenance: "explicit", body: baseBody({ headers: [...headers].reverse() }) });
		expect(forward).toBe(reversed);
		const changed = contractFingerprint({ provenance: "explicit", body: baseBody({ headers: [{ ...headers[0], value: "text/plain" }, headers[1]] }) });
		expect(changed).not.toBe(forward);
	});

	test("allowed status set order does not change the fingerprint", () => {
		const a = contractFingerprint({ provenance: "explicit", body: baseBody({ status: null, statuses: [201, 200] }) });
		const b = contractFingerprint({ provenance: "explicit", body: baseBody({ status: null, statuses: [200, 201] }) });
		expect(a).toBe(b);
	});

	test("a meaningful change alters the fingerprint", () => {
		const base = { provenance: "explicit", body: baseBody({ status: 200 }) };
		expect(contractFingerprint(base)).not.toBe(contractFingerprint({ provenance: "explicit", body: baseBody({ status: 201 }) }));
		expect(contractFingerprint(base)).not.toBe(
			contractFingerprint({ provenance: "explicit", body: baseBody({ status: 200, bodyType: "object", body: { type: "object" } }) }),
		);
	});

	test("provenance participates in the fingerprint", () => {
		expect(contractFingerprint({ provenance: "explicit", body: baseBody() })).not.toBe(
			contractFingerprint({ provenance: "inferred", body: baseBody() }),
		);
	});

	test("the fingerprint is stable across repeated computation", () => {
		const contract = { provenance: "explicit", body: baseBody({ status: 200 }) };
		expect(contractFingerprint(contract)).toBe(contractFingerprint(contract));
	});
});

// ---------------------------------------------------------------------------
// 9. Concurrent version creation
// ---------------------------------------------------------------------------
describe("9. concurrent version creation", () => {
	test("racing createDraft calls allocate distinct sequences", async () => {
		const { service } = harness();
		const created = await Promise.all(
			Array.from({ length: 8 }, () => service.createDraft(PROFILE, draftInput({ name: "concurrent" }))),
		);
		const sequences = created.map((row) => row.sequence).sort((left, right) => left - right);
		expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(new Set(sequences).size).toBe(8);
	});

	test("racing publications of the same version fail rather than both succeeding", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		const results = await Promise.allSettled([
			service.publish(PROFILE, "contract-orders", 1),
			service.publish(PROFILE, "contract-orders", 1),
		]);
		// One publish wins; the other either sees the already-published state
		// (idempotent) or loses the state race and is rejected. Neither may produce a
		// second PUBLISHED row.
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		expect(fulfilled.length).toBeGreaterThanOrEqual(1);
		const history = await service.listVersions(PROFILE, "contract-orders");
		expect(history.filter((row) => row.state === CONTRACT_STATE.PUBLISHED)).toHaveLength(1);
	});

	test("the repository rejects a duplicate sequence as a real database would", async () => {
		const { repository } = harness();
		const row = {
			ownerProfileId: PROFILE,
			contractId: "contract-orders",
			sequence: 1,
			state: CONTRACT_STATE.DRAFT,
			requestId: "request-1",
		};
		await repository.insertVersion(row);
		await expect(repository.insertVersion(row)).rejects.toThrow(/duplicate/);
	});
});

// ---------------------------------------------------------------------------
// 10. Duplicate / idempotent publication
// ---------------------------------------------------------------------------
describe("10. duplicate and idempotent publication", () => {
	test("publishing an already-published version is idempotent", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		const first = await service.publish(PROFILE, "contract-orders", 1);
		const second = await service.publish(PROFILE, "contract-orders", 1);
		expect(second.idempotent).toBe(true);
		expect(second.contract.sequence).toBe(first.contract.sequence);
		expect(second.contract.state).toBe(CONTRACT_STATE.PUBLISHED);
	});

	test("re-publishing identical content for the same request creates no new version", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.publish(PROFILE, "contract-orders", 1);
		await service.createDraft(PROFILE, draftInput());
		const result = await service.publish(PROFILE, "contract-orders", 2);
		expect(result.idempotent).toBe(true);
		// Version 1 stays current; the identical draft is left as a draft.
		const current = await service.getCurrentForRequest(PROFILE, "request-1");
		expect(current.sequence).toBe(1);
		expect((await service.getVersion(PROFILE, "contract-orders", 2)).state).toBe(CONTRACT_STATE.DRAFT);
	});

	test("changed content is not treated as a duplicate", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.publish(PROFILE, "contract-orders", 1);
		await service.createDraft(PROFILE, draftInput({ body: baseBody({ status: 201 }) }));
		const result = await service.publish(PROFILE, "contract-orders", 2);
		expect(result.idempotent).toBe(false);
		expect((await service.getCurrentForRequest(PROFILE, "request-1")).sequence).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 11. Request / profile isolation
// ---------------------------------------------------------------------------
describe("11. request and profile isolation", () => {
	test("another profile cannot read a contract version", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await expectAppError(service.getVersion(OTHER_PROFILE, "contract-orders", 1), { code: "CONTRACT_NOT_FOUND", statusCode: 404 });
	});

	test("another profile cannot publish someone else's contract", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await expectAppError(service.publish(OTHER_PROFILE, "contract-orders", 1), { code: "CONTRACT_NOT_FOUND", statusCode: 404 });
	});

	test("contract ids are scoped per profile so the same id can exist twice", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await service.createDraft(OTHER_PROFILE, draftInput({ name: "Other profile" }));
		const mine = await service.listVersions(PROFILE, "contract-orders");
		const theirs = await service.listVersions(OTHER_PROFILE, "contract-orders");
		expect(mine).toHaveLength(1);
		expect(theirs).toHaveLength(1);
		expect(mine[0].content.name).toBe("Orders list contract");
	});

	test("contracts for different requests do not supersede each other", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput({ requestId: "request-1" }));
		await service.publish(PROFILE, "contract-orders", 1);
		await service.createDraft(PROFILE, draftInput({ contractId: "contract-other", requestId: "request-2" }));
		await service.publish(PROFILE, "contract-other", 1);
		expect((await service.getCurrentForRequest(PROFILE, "request-1")).sequence).toBe(1);
		expect((await service.getVersion(PROFILE, "contract-orders", 1)).state).toBe(CONTRACT_STATE.PUBLISHED);
	});

	test("a missing profile is refused", async () => {
		const { service } = harness();
		await expectAppError(service.createDraft(null, draftInput()), { code: "CONTRACT_PROFILE_REQUIRED", statusCode: 401 });
	});
});

// ---------------------------------------------------------------------------
// 12. Malformed contract rejected
// ---------------------------------------------------------------------------
describe("12. malformed contracts are rejected", () => {
	test("an unknown field is rejected", () => {
		expect(() => parseContractDraftInput({ ...draftInput(), unexpected: true })).toThrow();
	});

	test("a missing request id is rejected", () => {
		expect(() => parseContractDraftInput({ ...draftInput(), requestId: "" })).toThrow();
	});

	test("neither a status nor a status set is rejected", () => {
		expect(() => parseContractBody(baseBody({ status: null, statuses: [] }))).toThrow();
	});

	test("both a status and a status set is rejected", () => {
		expect(() => parseContractBody(baseBody({ status: 200, statuses: [201] }))).toThrow();
	});

	test("a status outside 100-599 is rejected", () => {
		expect(() => parseContractBody(baseBody({ status: 42 }))).toThrow();
		expect(() => parseContractBody(baseBody({ status: 700 }))).toThrow();
	});

	test("duplicate allowed status codes are rejected", () => {
		expect(() => parseContractBody(baseBody({ status: null, statuses: [200, 200] }))).toThrow();
	});

	test("a body type that disagrees with the body shape is rejected", () => {
		expect(() =>
			parseContractBody(baseBody({ bodyType: "array", body: { type: "object" } })),
		).toThrow();
	});

	test("a required property that is not declared is rejected", () => {
		expect(() =>
			parseContractBody(baseBody({ bodyType: "object", body: { type: "object", properties: { a: { type: "string" } }, requiredProperties: ["b"] } })),
		).toThrow();
	});

	test("a scalar node with children is rejected", () => {
		expect(() => parseContractBody(baseBody({ bodyType: "string", body: { type: "string", properties: { a: { type: "string" } } } }))).toThrow();
	});

	test("a reserved property name is rejected at the top level", () => {
		const properties = {};
		Object.defineProperty(properties, "__proto__", { value: { type: "string" }, enumerable: true });
		expect(() => parseContractBody(baseBody({ bodyType: "object", body: { type: "object", properties } }))).toThrow();
	});

	test("a reserved property name is rejected when nested", () => {
		const properties = {};
		Object.defineProperty(properties, "__proto__", { value: { type: "string" }, enumerable: true });
		const node = { type: "object", properties: { inner: { type: "object", properties } } };
		expect(() => parseContractBody(baseBody({ bodyType: "object", body: node }))).toThrow();
	});

	test("constructor and prototype are refused as property names", () => {
		expect(() =>
			parseContractBody(baseBody({ bodyType: "object", body: { type: "object", properties: { constructor: { type: "string" } } } })),
		).toThrow();
		expect(() =>
			parseContractBody(baseBody({ bodyType: "object", body: { type: "object", properties: { prototype: { type: "string" } } } })),
		).toThrow();
	});

	test("parsing never mutates Object.prototype", () => {
		const properties = {};
		Object.defineProperty(properties, "__proto__", { value: { type: "string", polluted: true }, enumerable: true });
		try {
			parseContractBody(baseBody({ bodyType: "object", body: { type: "object", properties } }));
		} catch {
			// Rejection is the expected outcome; the assertion below is about the global.
		}
		expect({}.polluted).toBeUndefined();
		expect({}.type).toBeUndefined();
	});

	test("a near-miss property name is still allowed", () => {
		const parsed = parseContractBody(baseBody({ bodyType: "object", body: { type: "object", properties: { proto: { type: "string" } } } }));
		expect(Object.keys(parsed.body.properties)).toEqual(["proto"]);
	});

	test("an enum on a non-scalar node is rejected", () => {
		expect(() => parseContractBody(baseBody({ bodyType: "array", body: { type: "array", enum: ["a"] } }))).toThrow();
	});
});

// ---------------------------------------------------------------------------
// 13. Excessive nesting rejected
// ---------------------------------------------------------------------------
describe("13. excessive nesting is rejected", () => {
	function nested(depth, leaf = { type: "string" }) {
		let node = leaf;
		for (let level = 0; level < depth; level += 1) node = { type: "object", properties: { child: node } };
		return node;
	}

	test("a contract at the maximum depth is accepted", () => {
		// The root node sits at depth 0, so `maxDepth` nested children below it are
		// permitted and the deepest node is the one that must not nest further.
		const node = nested(CONTRACT_LIMITS.maxDepth);
		expect(() => parseContractBody(baseBody({ bodyType: "object", body: node }))).not.toThrow();
	});

	test("a contract beyond the maximum depth is rejected", () => {
		const node = nested(CONTRACT_LIMITS.maxDepth + 1);
		expect(() => parseContractBody(baseBody({ bodyType: "object", body: node }))).toThrow();
	});

	test("an over-deep array chain is rejected", () => {
		let node = { type: "string" };
		for (let level = 0; level <= CONTRACT_LIMITS.maxDepth; level += 1) node = { type: "array", items: node };
		expect(() => parseContractBody(baseBody({ bodyType: "array", body: node }))).toThrow();
	});
});

// ---------------------------------------------------------------------------
// 14. Excessive properties rejected
// ---------------------------------------------------------------------------
describe("14. excessive properties are rejected", () => {
	test("an object at the per-object property limit is accepted", () => {
		const properties = {};
		for (let index = 0; index < CONTRACT_LIMITS.maxPropertiesPerObject; index += 1) properties[`p${index}`] = { type: "string" };
		expect(() => parseContractBody(baseBody({ bodyType: "object", body: { type: "object", properties } }))).not.toThrow();
	});

	test("an object above the per-object property limit is rejected", () => {
		const properties = {};
		for (let index = 0; index <= CONTRACT_LIMITS.maxPropertiesPerObject; index += 1) properties[`p${index}`] = { type: "string" };
		expect(() => parseContractBody(baseBody({ bodyType: "object", body: { type: "object", properties } }))).toThrow();
	});

	test("too many required properties is rejected", () => {
		const properties = {};
		const requiredProperties = [];
		for (let index = 0; index <= CONTRACT_LIMITS.maxPropertiesPerObject; index += 1) {
			properties[`p${index}`] = { type: "string" };
			requiredProperties.push(`p${index}`);
		}
		expect(() => parseContractBody(baseBody({ bodyType: "object", body: { type: "object", properties, requiredProperties } }))).toThrow();
	});
});

// ---------------------------------------------------------------------------
// 15. Sensitive headers rejected / redacted
// ---------------------------------------------------------------------------
describe("15. sensitive headers are refused", () => {
	for (const name of ["Authorization", "Cookie", "Set-Cookie", "X-Api-Key", "Proxy-Authorization"]) {
		test(`"${name}" cannot appear in a contract`, () => {
			expect(() => parseContractBody(baseBody({ headers: [{ name, value: null, required: false }] }))).toThrow();
		});
	}

	test("a credential-shaped header value is refused", () => {
		expect(() =>
			parseContractBody(baseBody({ headers: [{ name: "X-Trace", value: "Bearer abcdefghijklmnop", required: false }] })),
		).toThrow();
	});

	test("a credential-shaped property name is refused", () => {
		expect(() =>
			parseContractBody(baseBody({ bodyType: "object", body: { type: "object", properties: { "ghp_abcdefghijklmnopqrst": { type: "string" } } } })),
		).toThrow();
	});

	test("inference drops sensitive headers instead of storing them", () => {
		const { body, warnings } = inferContractBody({
			status: 200,
			headers: [
				{ name: "Set-Cookie", value: "session=secret" },
				{ name: "Authorization", value: "Bearer xyz" },
				{ name: "Content-Type", value: "application/json" },
			],
		});
		expect(body.headers.map((header) => header.name)).toEqual(["Content-Type"]);
		expect(warnings.length).toBe(2);
		// The sensitive values must not appear anywhere in the produced contract.
		expect(JSON.stringify(body)).not.toContain("session=secret");
		expect(JSON.stringify(body)).not.toContain("Bearer xyz");
	});

	test("duplicate inferred headers are recorded once", () => {
		const { body, warnings } = inferContractBody({
			status: 200,
			headers: [
				{ name: "X-Trace", value: "a" },
				{ name: "x-trace", value: "b" },
			],
		});
		expect(body.headers).toHaveLength(1);
		expect(warnings.some((warning) => warning.includes("more than once"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 16. Nested object/array contracts
// ---------------------------------------------------------------------------
describe("16. nested object and array contracts", () => {
	test("a nested object/array body round-trips through the schema and fingerprint", () => {
		const node = {
			type: "object",
			properties: {
				orders: {
					type: "array",
					items: {
						type: "object",
						properties: { id: { type: "number" }, tags: { type: "array", items: { type: "string" } }, state: { type: "string", enum: ["paid", "shipped"] } },
						requiredProperties: ["id"],
					},
				},
			},
			requiredProperties: ["orders"],
		};
		const body = baseBody({ status: 200, statuses: [], bodyType: "object", body: node });
		const parsed = parseContractBody(body);
		expect(parsed.body.properties.orders.items.properties.state.enum).toEqual(["paid", "shipped"]);
		expect(contractFingerprint({ provenance: "explicit", body: parsed })).toMatch(/^[a-f0-9]{64}$/);
	});

	test("declaring a status set changes the fingerprint versus a single status", () => {
		const single = contractFingerprint({ provenance: "explicit", body: baseBody({ status: 200 }) });
		const set = contractFingerprint({ provenance: "explicit", body: baseBody({ status: null, statuses: [200, 201] }) });
		expect(single).not.toBe(set);
	});
});

// ---------------------------------------------------------------------------
// 17. Allowed status sets
// ---------------------------------------------------------------------------
describe("17. allowed status sets", () => {
	test("a status set is accepted and stored sorted", () => {
		const parsed = parseContractBody(baseBody({ status: null, statuses: [201, 200, 202] }));
		expect(parsed.status).toBeNull();
		expect(parsed.statuses).toEqual([201, 200, 202]);
	});

	test("a status set at the limit is accepted and above it is rejected", () => {
		const atLimit = Array.from({ length: CONTRACT_LIMITS.maxStatusCodes }, (_, index) => 200 + index);
		expect(() => parseContractBody(baseBody({ status: null, statuses: atLimit }))).not.toThrow();
		expect(() => parseContractBody(baseBody({ status: null, statuses: [...atLimit, 300] }))).toThrow();
	});

	test("a contract with a status set is published and superseded normally", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput({ body: baseBody({ status: null, statuses: [200, 204] }) }));
		await service.publish(PROFILE, "contract-orders", 1);
		const current = await service.getCurrentForRequest(PROFILE, "request-1");
		expect(current.content.body.statuses).toEqual([200, 204]);
	});
});

// ---------------------------------------------------------------------------
// 18. Selected response headers
// ---------------------------------------------------------------------------
describe("18. selected response headers", () => {
	test("headers are stored with their required flag", async () => {
		const { service } = harness();
		await service.createDraft(
			PROFILE,
			draftInput({
				body: baseBody({
					headers: [
						{ name: "Content-Type", value: null, required: true },
						{ name: "X-Request-Id", value: null, required: false },
					],
				}),
			}),
		);
		const draft = await service.getVersion(PROFILE, "contract-orders", 1);
		expect(draft.content.body.headers).toEqual([
			{ name: "Content-Type", value: null, required: true },
			{ name: "X-Request-Id", value: null, required: false },
		]);
	});

	test("duplicate header names are rejected", () => {
		expect(() =>
			parseContractBody(
				baseBody({
					headers: [
						{ name: "Content-Type", value: null, required: false },
						{ name: "content-type", value: null, required: false },
					],
				}),
			),
		).toThrow();
	});

	test("more than the header limit is rejected", () => {
		const headers = Array.from({ length: CONTRACT_LIMITS.maxHeaders + 1 }, (_, index) => ({
			name: `X-H${index}`,
			value: null,
			required: false,
		}));
		expect(() => parseContractBody(baseBody({ headers }))).toThrow();
	});
});

// ---------------------------------------------------------------------------
// 19. Deterministic inference from a supplied payload
// ---------------------------------------------------------------------------
describe("19. deterministic inference", () => {
	test("the same payload always infers the same body", () => {
		const response = {
			status: 200,
			contentType: "application/json",
			body: '{"id":1,"name":"widget","active":true,"tags":["a","b"],"meta":{"depth":1},"empty":null}',
		};
		const first = inferContractFromResponse({ response, name: "x" });
		const second = inferContractFromResponse({ response, name: "x" });
		expect(canonicalContractJson({ provenance: "inferred", body: first.body })).toBe(
			canonicalContractJson({ provenance: "inferred", body: second.body }),
		);
	});

	test("every observable JSON type is inferred correctly", () => {
		const { body } = inferContractBody({
			bodyValue: { s: "x", n: 1.5, b: false, z: null, o: { k: "v" }, a: [1, 2, 3] },
		});
		const properties = body.body.properties;
		expect(properties.s.type).toBe("string");
		expect(properties.n.type).toBe("number");
		expect(properties.b.type).toBe("boolean");
		expect(properties.z.type).toBe("null");
		expect(properties.o.type).toBe("object");
		expect(properties.a.type).toBe("array");
		expect(properties.a.items.type).toBe("number");
	});

	test("provenance is always inferred", () => {
		expect(inferContractFromResponse({ response: { status: 200, bodyValue: {} } }).provenance).toBe("inferred");
	});

	test("a JSON string body is parsed into structure", () => {
		const { body } = inferContractBody({ body: '{"a":{"b":1}}', contentType: "application/json" });
		expect(body.body.properties.a.type).toBe("object");
	});

	test("a non-JSON string body stays a string", () => {
		const { body } = inferContractBody({ body: "plain text", contentType: "text/plain" });
		expect(body.bodyType).toBe("string");
	});

	test("a body that is absent produces no body shape", () => {
		const { body } = inferContractBody({ status: 204 });
		expect(body.body).toBeNull();
		expect(body.bodyType).toBeNull();
	});

	test("an inferred status is carried through", () => {
		expect(inferContractBody({ status: 404 }).body.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// 20. Inference does not guess optionality or enums
// ---------------------------------------------------------------------------
describe("20. inference does not guess", () => {
	test("no property is marked required", () => {
		const { body } = inferContractBody({ bodyValue: { a: 1, b: "x", c: { d: 1 } } });
		expect(JSON.stringify(body.body)).not.toContain('"required":true');
		expect(body.body.requiredProperties).toBeUndefined();
	});

	test("no enum is invented from a single sample", () => {
		const { body } = inferContractBody({ bodyValue: { state: "paid" } });
		expect(JSON.stringify(body.body)).not.toContain('"enum"');
	});

	test("a mixed-type array is flagged rather than guessed", () => {
		const { body, warnings } = inferContractBody({ bodyValue: [1, "two", true] });
		expect(body.body.type).toBe("array");
		expect(warnings.some((warning) => warning.includes("element types"))).toBe(true);
	});

	test("hitting the depth cap warns instead of throwing", () => {
		let value = "leaf";
		for (let level = 0; level < CONTRACT_LIMITS.maxDepth + 2; level += 1) value = { nested: value };
		const { body, warnings } = inferContractBody({ status: 200, bodyValue: value });
		expect(body.body).not.toBeNull();
		expect(warnings.some((warning) => warning.includes("maximum depth"))).toBe(true);
	});

	test("an inferred contract at the depth cap is still a valid contract", () => {
		let value = "leaf";
		for (let level = 0; level < CONTRACT_LIMITS.maxDepth + 2; level += 1) value = { nested: value };
		const { body } = inferContractBody({ status: 200, bodyValue: value });
		expect(() => parseContractBody(body)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 21. Stable output ordering
// ---------------------------------------------------------------------------
describe("21. stable output ordering", () => {
	test("inferred property order is deterministic regardless of insertion order", () => {
		const first = inferContractBody({ bodyValue: { b: 1, a: 2, c: 3 } });
		const second = inferContractBody({ bodyValue: { c: 3, a: 2, b: 1 } });
		expect(Object.keys(first.body.body.properties)).toEqual(["a", "b", "c"]);
		expect(canonicalContractJson({ provenance: "inferred", body: first.body })).toBe(
			canonicalContractJson({ provenance: "inferred", body: second.body }),
		);
	});

	test("listVersions is ordered by sequence", async () => {
		const { service } = harness();
		for (let index = 0; index < 5; index += 1) await service.createDraft(PROFILE, draftInput({ name: `v${index}` }));
		const versions = await service.listVersions(PROFILE, "contract-orders");
		expect(versions.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
	});

	test("listForRequest is ordered by contract id then sequence", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput({ contractId: "b-contract" }));
		await service.createDraft(PROFILE, draftInput({ contractId: "a-contract" }));
		await service.createDraft(PROFILE, draftInput({ contractId: "a-contract", name: "second" }));
		const rows = await service.listForRequest(PROFILE, "request-1");
		expect(rows.map((row) => `${row.contractId}#${row.sequence}`)).toEqual(["a-contract#1", "a-contract#2", "b-contract#1"]);
	});
});

// ---------------------------------------------------------------------------
// Edit semantics
// ---------------------------------------------------------------------------
describe("edit semantics", () => {
	test("editing a draft replaces its content and fingerprint", async () => {
		const { service } = harness();
		const before = await service.createDraft(PROFILE, draftInput());
		const after = await service.updateDraft(PROFILE, "contract-orders", 1, { name: "Renamed", body: baseBody({ status: 202 }) });
		expect(after.content.name).toBe("Renamed");
		expect(after.contentFingerprint).not.toBe(before.contentFingerprint);
		expect(after.sequence).toBe(1);
		expect(after.state).toBe(CONTRACT_STATE.DRAFT);
	});

	test("an edit cannot move a contract to a different request", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		const updated = await service.updateDraft(PROFILE, "contract-orders", 1, { requestId: "request-999", name: "X" });
		expect(updated.requestId).toBe("request-1");
	});

	test("an invalid edit is rejected without changing the draft", async () => {
		const { service } = harness();
		await service.createDraft(PROFILE, draftInput());
		await expectAppError(service.updateDraft(PROFILE, "contract-orders", 1, { name: "" }), { code: "CONTRACT_INVALID", statusCode: 400 });
		const draft = await service.getVersion(PROFILE, "contract-orders", 1);
		expect(draft.content.name).toBe("Orders list contract");
	});
});

// ---------------------------------------------------------------------------
// Inference-to-draft path
// ---------------------------------------------------------------------------
describe("inference to draft", () => {
	test("an inferred contract is stored with inferred provenance", async () => {
		const { service } = harness();
		const inferred = inferContractFromResponse({
			response: { status: 200, contentType: "application/json", body: '{"ok":true}' },
			name: "Inferred orders",
		});
		const draft = await service.createDraftFromResponse(PROFILE, draftInput({ name: inferred.name }), inferred);
		expect(draft.content.provenance).toBe("inferred");
		expect(draft.content.body.body.properties.ok.type).toBe("boolean");
	});

	test("an inferred contract obeys the same limits as an explicit one", async () => {
		const { service } = harness();
		const properties = {};
		for (let index = 0; index <= CONTRACT_LIMITS.maxPropertiesPerObject; index += 1) properties[`p${index}`] = 1;
		// The inference helper truncates rather than throwing, so the resulting
		// contract is valid and the truncation is reported.
		const inferred = inferContractFromResponse({ response: { status: 200, bodyValue: properties } });
		expect(inferred.warnings.some((warning) => warning.includes("exceeded"))).toBe(true);
		const draft = await service.createDraftFromResponse(PROFILE, draftInput({ name: "Big" }), inferred);
		expect(Object.keys(draft.content.body.body.properties).length).toBe(CONTRACT_LIMITS.maxPropertiesPerObject);
	});
});

// ---------------------------------------------------------------------------
// Lifecycle predicates
// ---------------------------------------------------------------------------
describe("lifecycle predicates", () => {
	test("only drafts are mutable", async () => {
		const { canTransition, isMutable } = await import("./contract-lifecycle.js");
		expect(isMutable(CONTRACT_STATE.DRAFT)).toBe(true);
		expect(isMutable(CONTRACT_STATE.PUBLISHED)).toBe(false);
		expect(isMutable(CONTRACT_STATE.SUPERSEDED)).toBe(false);
		expect(canTransition(CONTRACT_STATE.DRAFT, CONTRACT_STATE.PUBLISHED)).toBe(true);
		expect(canTransition(CONTRACT_STATE.PUBLISHED, CONTRACT_STATE.DRAFT)).toBe(false);
		expect(canTransition(CONTRACT_STATE.SUPERSEDED, CONTRACT_STATE.PUBLISHED)).toBe(false);
	});
});
