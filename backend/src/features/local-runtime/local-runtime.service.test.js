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
