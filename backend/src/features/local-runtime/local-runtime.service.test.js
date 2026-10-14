import { describe, expect, test } from "bun:test";
import { createLocalRuntimeService, DISABLED_LOCAL_RUNTIME } from "./local-runtime.service.js";

function fakeRepository() {
	const documents = new Map();
	return {
		documents,
		async findByProfile(ownerProfileId) {
			const document = documents.get(String(ownerProfileId));
			return document ? structuredClone(document) : null;
		},
		async create(input) {
			documents.set(String(input.ownerProfileId), structuredClone(input));
			return structuredClone(input);
		},
		async replace(ownerProfileId, expectedRevision, update) {
			const key = String(ownerProfileId);
			const document = documents.get(key);
			if (!document || document.revision !== expectedRevision) return null;
			const next = { ...document, ...structuredClone(update), revision: expectedRevision + 1 };
			documents.set(key, next);
			return structuredClone(next);
		},
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

// Repository double that models the unique `ownerProfileId` index. The read
// barrier makes both racers finish `findByProfile` (observing an empty profile)
// before either `create` runs, so the race is deterministic rather than timing
// dependent.
function racingRepository() {
	const documents = new Map();
	const bothReads = deferred();
	let reads = 0;
	return {
		documents,
		async findByProfile(ownerProfileId) {
			const key = String(ownerProfileId);
			reads += 1;
			if (reads >= 2) bothReads.resolve();
			await bothReads.promise;
			const document = documents.get(key);
			return document ? structuredClone(document) : null;
		},
		async create(input) {
			const key = String(input.ownerProfileId);
			if (documents.has(key)) {
				const error = new Error("E11000 duplicate key error collection: localruntimesettings index: ownerProfileId_1");
				error.code = 11000;
				error.keyPattern = { ownerProfileId: 1 };
				error.keyValue = { ownerProfileId: input.ownerProfileId };
				throw error;
			}
			documents.set(key, structuredClone(input));
			return structuredClone(input);
		},
		async replace(ownerProfileId, expectedRevision, update) {
			const key = String(ownerProfileId);
			const document = documents.get(key);
			if (!document || document.revision !== expectedRevision) return null;
			const next = { ...document, ...structuredClone(update), revision: expectedRevision + 1 };
			documents.set(key, next);
			return structuredClone(next);
		},
	};
}

const update = (overrides = {}) => ({ expectedRevision: 0, enabled: true, targets: [], ...overrides });

describe("local runtime settings", () => {
	test("profiles start disabled with no approved hosts", async () => {
		const service = createLocalRuntimeService({ repository: fakeRepository() });
		expect(await service.get("profile-a")).toEqual(DISABLED_LOCAL_RUNTIME);
		expect(await service.forExecution("profile-a")).toEqual({ enabled: false, hosts: [] });
	});

	test("approved hosts are normalized and keep stable ids", async () => {
		const repository = fakeRepository();
		const service = createLocalRuntimeService({ repository });
		const first = await service.update("profile-a", update({ targets: [{ host: "Dev.LAN" }, { host: "127.0.0.1" }] }));
		expect(first.revision).toBe(1);
		expect(first.enabled).toBe(true);
		expect(first.targets.map((target) => target.host)).toEqual(["dev.lan", "127.0.0.1"]);
		const ids = first.targets.map((target) => target.id);
		const second = await service.update(
			"profile-a",
			update({ expectedRevision: 1, targets: [{ host: "127.0.0.1" }, { host: "::1" }] }),
		);
		expect(second.revision).toBe(2);
		expect(second.targets.map((target) => target.id)[0]).toBe(ids[1]);
		expect(second.targets.map((target) => target.host)).toEqual(["127.0.0.1", "::1"]);
	});

	test("rejects duplicate, invalid, and metadata hosts", async () => {
		const service = createLocalRuntimeService({ repository: fakeRepository() });
		await expect(service.update("profile-a", update({ targets: [{ host: "dev.lan" }, { host: "DEV.LAN" }] }))).rejects.toMatchObject({
			code: "LOCAL_HOST_DUPLICATE",
		});
		await expect(service.update("profile-a", update({ targets: [{ host: "*.lan" }] }))).rejects.toMatchObject({
			code: "LOCAL_HOST_INVALID",
		});
		await expect(service.update("profile-a", update({ targets: [{ host: "metadata.google.internal" }] }))).rejects.toMatchObject({
			code: "LOCAL_HOST_METADATA",
		});
		await expect(service.update("profile-a", update({ targets: [{ host: "169.254.169.254" }] }))).rejects.toMatchObject({
			code: "LOCAL_HOST_METADATA",
		});
	});

	test("enforces the approved host limit", async () => {
		const service = createLocalRuntimeService({ repository: fakeRepository() });
		const targets = Array.from({ length: 21 }, (item, index) => ({ host: `host-${index}.lan` }));
		await expect(service.update("profile-a", update({ targets }))).rejects.toMatchObject({ code: "PROFILE_LIMIT" });
	});

	test("rejects stale revisions", async () => {
		const service = createLocalRuntimeService({ repository: fakeRepository() });
		await service.update("profile-a", update({ targets: [{ host: "dev.lan" }] }));
		await expect(service.update("profile-a", update({ expectedRevision: 0 }))).rejects.toMatchObject({
			code: "LOCAL_RUNTIME_CHANGED",
		});
	});

	test("disabling keeps the approved list but stops execution access", async () => {
		const repository = fakeRepository();
		const service = createLocalRuntimeService({ repository });
		await service.update("profile-a", update({ targets: [{ host: "dev.lan" }] }));
		expect(await service.forExecution("profile-a")).toEqual({ enabled: true, hosts: ["dev.lan"] });
		const disabled = await service.update("profile-a", update({ expectedRevision: 1, enabled: false, targets: [{ host: "dev.lan" }] }));
		expect(disabled.enabled).toBe(false);
		expect(disabled.targets).toHaveLength(1);
		expect(await service.forExecution("profile-a")).toEqual({ enabled: false, hosts: [] });
	});

	test("settings are profile-scoped and survive a new service instance", async () => {
		const repository = fakeRepository();
		const first = createLocalRuntimeService({ repository });
		await first.update("profile-a", update({ targets: [{ host: "dev.lan" }] }));
		const restarted = createLocalRuntimeService({ repository });
		expect((await restarted.get("profile-a")).targets.map((target) => target.host)).toEqual(["dev.lan"]);
		expect(await restarted.get("profile-b")).toEqual(DISABLED_LOCAL_RUNTIME);
		expect(await restarted.forExecution("profile-b")).toEqual({ enabled: false, hosts: [] });
	});
});

describe("local runtime concurrent first creation", () => {
	test("two equivalent first updates race to one canonical document", async () => {
		const repository = racingRepository();
		const service = createLocalRuntimeService({ repository });
		const input = update({ targets: [{ host: "dev.lan" }] });
		const [first, second] = await Promise.all([service.update("profile-a", { ...input }), service.update("profile-a", { ...input })]);

		expect(repository.documents.size).toBe(1);
		expect(first).toEqual(second);
		expect(first.revision).toBe(1);
		expect(first.enabled).toBe(true);
		expect(first.targets.map((target) => target.host)).toEqual(["dev.lan"]);
		expect(repository.documents.get("profile-a").revision).toBe(1);
	});

	test("conflicting first updates leave the winner and reject the loser with LOCAL_RUNTIME_CHANGED", async () => {
		const repository = racingRepository();
		const service = createLocalRuntimeService({ repository });
		const results = await Promise.allSettled([
			service.update("profile-a", update({ targets: [{ host: "dev.lan" }] })),
			service.update("profile-a", update({ targets: [{ host: "stage.lan" }] })),
		]);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason).toMatchObject({ statusCode: 409, code: "LOCAL_RUNTIME_CHANGED" });
		// Raw duplicate-key details must never surface through the API error.
		expect(rejected[0].reason.message).not.toMatch(/11000|duplicate key/i);

		expect(repository.documents.size).toBe(1);
		const stored = repository.documents.get("profile-a");
		expect(stored.revision).toBe(1);
		expect(stored.enabled).toBe(fulfilled[0].value.enabled);
		expect(stored.targets.map((target) => target.host)).toEqual(fulfilled[0].value.targets.map((target) => target.host));
		expect(["dev.lan", "stage.lan"]).toContain(stored.targets[0].host);
	});

	test("revision stays valid and monotonic after a first-update race", async () => {
		const repository = racingRepository();
		const service = createLocalRuntimeService({ repository });
		const input = update({ targets: [{ host: "dev.lan" }] });
		await Promise.all([service.update("profile-a", { ...input }), service.update("profile-a", { ...input })]);
		const next = await service.update("profile-a", update({ expectedRevision: 1, enabled: false, targets: [{ host: "dev.lan" }] }));
		expect(next.revision).toBe(2);
		expect(next.enabled).toBe(false);
	});

	test("a non-duplicate create failure is not converted to LOCAL_RUNTIME_CHANGED", async () => {
		const failure = new Error("connection reset by peer");
		failure.code = 112;
		const repository = {
			async findByProfile() {
				return null;
			},
			async create() {
				throw failure;
			},
			async replace() {
				return null;
			},
		};
		const service = createLocalRuntimeService({ repository });
		await expect(service.update("profile-a", update())).rejects.toBe(failure);
	});

	test("a duplicate key on an unrelated index is not converted to LOCAL_RUNTIME_CHANGED", async () => {
		const failure = new Error("E11000 duplicate key error");
		failure.code = 11000;
		failure.keyPattern = { nameKey: 1 };
		failure.keyValue = { nameKey: "dev" };
		const repository = {
			async findByProfile() {
				return null;
			},
			async create() {
				throw failure;
			},
			async replace() {
				return null;
			},
		};
		const service = createLocalRuntimeService({ repository });
		await expect(service.update("profile-a", update())).rejects.toBe(failure);
	});
});
