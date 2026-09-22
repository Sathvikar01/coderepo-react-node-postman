// Phase 14 — the CLI's storage adapters must behave like the Mongo repositories
// they stand in for, because the execution service and collection runner are the
// real ones. These tests pin the behaviors those services actually depend on.

import { describe, expect, test } from "bun:test";
import {
	createMemoryCollectionRunRepository,
	createMemoryCollectionStore,
	createMemoryCookieRepository,
	createMemoryEnvironmentStore,
	createMemoryHistoryStore,
	createMemoryLocalRuntime,
} from "./memory-stores.js";

describe("memory history store", () => {
	test("admits, finalizes dotted paths, and refuses duplicates like Mongo", async () => {
		const history = createMemoryHistoryStore();
		await history.admit({ ownerProfileId: "p", executionId: "e1", status: "running", snapshot: { path: "/a" }, expiresAt: new Date(Date.now() + 1000) });
		// $set with a dotted path must expand, not replace the parent object.
		await history.finalize("p", "e1", { status: "terminal", outcome: "response", "snapshot.scriptResults": [{ name: "t" }] });
		const record = await history.get("p", "e1");
		expect(record.status).toBe("terminal");
		expect(record.outcome).toBe("response");
		expect(record.snapshot).toEqual({ path: "/a", scriptResults: [{ name: "t" }] });

		// A terminal record is immutable: a second finalize is a no-op.
		expect(await history.finalize("p", "e1", { status: "terminal", outcome: "other" })).toBeNull();

		let duplicate = null;
		try {
			await history.admit({ ownerProfileId: "p", executionId: "e1", status: "running" });
		} catch (error) {
			duplicate = error;
		}
		expect(duplicate?.code).toBe(11000);
	});

	test("expired records are flagged and profiles are isolated", async () => {
		const history = createMemoryHistoryStore();
		await history.admit({ ownerProfileId: "p", executionId: "old", status: "running", expiresAt: new Date(Date.now() - 1000) });
		expect(await history.get("p", "old")).toMatchObject({ expired: true });
		expect(await history.get("other", "old")).toBeNull();
	});
});

describe("memory cookie repository", () => {
	const entry = (overrides = {}) => ({
		ownerProfileId: "p",
		sessionId: "s",
		name: "sid",
		domain: "127.0.0.1",
		path: "/",
		value: "v1",
		expiresAt: null,
		...overrides,
	});

	test("upsert replaces in place and keeps identity", async () => {
		const cookies = createMemoryCookieRepository();
		const first = await cookies.upsert(entry());
		const second = await cookies.upsert(entry({ value: "v2" }));
		expect(second._id).toBe(first._id);
		expect(second.createdAt).toBe(first.createdAt);
		expect(second.value).toBe("v2");
		expect(cookies.items.size).toBe(1);
	});

	test("listing is session-scoped, expiry-aware, and path-descending", async () => {
		const cookies = createMemoryCookieRepository();
		await cookies.upsert(entry({ name: "root", path: "/", createdAt: new Date(1) }));
		await cookies.upsert(entry({ name: "deep", path: "/api", createdAt: new Date(2) }));
		await cookies.upsert(entry({ name: "dead", expiresAt: new Date(Date.now() - 1) }));
		await cookies.upsert(entry({ name: "other-session", sessionId: "z" }));

		const listed = await cookies.list("p", "s");
		expect(listed.map((cookie) => cookie.name)).toEqual(["deep", "root"]);
		// A non-persistent cookie belongs only to its owning session.
		expect((await cookies.list("p", "z")).map((cookie) => cookie.name)).toContain("other-session");

		expect(await cookies.count("p", "s")).toBe(2);
		// purgeDead drops expired cookies and non-persistent cookies from other sessions.
		expect((await cookies.purgeDead("p", "s")).deletedCount).toBe(2);
	});

	test("delete by key, delete by id, and clear stay inside one profile", async () => {
		const cookies = createMemoryCookieRepository();
		await cookies.upsert(entry());
		await cookies.upsert(entry({ ownerProfileId: "other", name: "theirs" }));
		expect((await cookies.deleteByKey("p", { name: "sid", domain: "127.0.0.1", path: "/" })).deletedCount).toBe(1);
		expect(cookies.items.size).toBe(1);
		const restored = await cookies.upsert(entry());
		await cookies.deleteById("p", "missing");
		expect((await cookies.deleteById("p", restored._id)).name).toBe("sid");
		await cookies.upsert(entry());
		expect(await cookies.clear("other")).toMatchObject({ deletedCount: 1 });
		expect(await cookies.clear("p")).toMatchObject({ deletedCount: 1 });
	});
});

describe("memory collection run repository", () => {
	test("lifecycle and listing match the Mongo contract", async () => {
		const runs = createMemoryCollectionRunRepository();
		await runs.create({ ownerProfileId: "p", runId: "r1", collectionId: "c1", startedAt: new Date(1000), status: "running" });
		await runs.create({ ownerProfileId: "p", runId: "r2", collectionId: "c2", startedAt: new Date(2000), status: "running" });
		expect(await runs.create({ ownerProfileId: "p", runId: "r1", collectionId: "c1", startedAt: new Date(3000) })).toMatchObject({
			_id: "r1",
		});
		await runs.update("p", "r1", { status: "completed" });
		expect((await runs.get("p", "r1")).status).toBe("completed");
		expect(await runs.get("other", "r1")).toBeNull();
		expect(await runs.update("p", "missing", { status: "completed" })).toBeNull();
		expect((await runs.list("p")).map((run) => run.runId)).toEqual(["r1", "r2"]);
		expect((await runs.list("p", { collectionId: "c2" })).map((run) => run.runId)).toEqual(["r2"]);
		expect((await runs.list("p", { limit: 1 })).map((run) => run.runId)).toEqual(["r1"]);
	});
});

describe("memory project stores and local runtime opt-in", () => {
	test("collections and environments are profile-scoped", async () => {
		const collections = createMemoryCollectionStore([{ _id: "c1", name: "Alpha" }], "p");
		expect(await collections.findById("c1", "p")).toMatchObject({ name: "Alpha" });
		expect(await collections.findById("c1", "other")).toBeNull();
		expect(await collections.findOwnedIds(["c1", "nope"], "p")).toEqual(["c1"]);
		expect(await collections.findOwnedIds(["c1"], "other")).toEqual([]);

		const environments = createMemoryEnvironmentStore([{ _id: "e1", name: "Local" }], "p");
		expect(await environments.findById("e1", "p")).toMatchObject({ name: "Local" });
		expect(await environments.findById("e1", "other")).toBeNull();
	});

	test("local runtime stays disabled until exact hosts are approved", async () => {
		expect(await createMemoryLocalRuntime().forExecution("p")).toEqual({ enabled: false, hosts: [] });
		const approved = createMemoryLocalRuntime(["127.0.0.1", "127.0.0.1", "dev.lan"]);
		expect(await approved.forExecution("p")).toEqual({ enabled: true, hosts: ["127.0.0.1", "dev.lan"] });
		expect(await approved.get("p")).toMatchObject({ enabled: true });
	});
});
