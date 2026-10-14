// In-memory adapters for the headless CLI.
//
// The CLI runs real executions but must not require MongoDB: it is designed for
// clean CI checkouts and for running a project that lives on disk. Every adapter
// below implements exactly the interface its Mongo-backed counterpart exposes to
// the execution service and collection runner, so the CLI exercises the same
// service logic the workspace does — only the storage layer is swapped.
//
// Nothing here is ever written to disk, so a run cannot leak resolved secrets
// into a database, and a project on disk is never mutated.

import { randomUUID } from "node:crypto";

// MongoDB's finalize uses `$set` with dotted paths (for example
// "snapshot.scriptResults"). This reproduces just that behavior for our records.
function applyDottedSet(target, update) {
	for (const [dotted, value] of Object.entries(update)) {
		const parts = dotted.split(".");
		let cursor = target;
		for (let index = 0; index < parts.length - 1; index += 1) {
			const part = parts[index];
			if (cursor[part] === null || typeof cursor[part] !== "object") cursor[part] = {};
			cursor = cursor[part];
		}
		cursor[parts[parts.length - 1]] = value;
	}
	return target;
}

export function createMemoryCollectionStore(collections, profileId) {
	const byId = new Map(collections.map((collection) => [String(collection._id), collection]));
	return {
		async findById(id, ownerProfileId) {
			if (ownerProfileId !== profileId) return null;
			return byId.get(String(id)) ?? null;
		},
		async findOwnedIds(ids, ownerProfileId) {
			if (ownerProfileId !== profileId) return [];
			return ids.map((id) => String(id)).filter((id) => byId.has(id));
		},
	};
}

export function createMemoryEnvironmentStore(environments, profileId) {
	const byId = new Map(environments.map((environment) => [String(environment._id), environment]));
	return {
		async findById(id, ownerProfileId) {
			if (ownerProfileId !== profileId) return null;
			return byId.get(String(id)) ?? null;
		},
	};
}

export function createMemoryHistoryStore() {
	const records = new Map();
	const keyOf = (profileId, executionId) => `${profileId}:${executionId}`;

	return {
		records,
		async admit(entry) {
			const key = keyOf(entry.ownerProfileId, entry.executionId);
			if (records.has(key)) {
				// Mirrors the duplicate-key error the execution service handles.
				const error = new Error("A record for this execution already exists.");
				error.code = 11000;
				throw error;
			}
			const record = { ...entry, _id: entry.executionId };
			records.set(key, record);
			return record;
		},
		async finalize(ownerProfileId, executionId, update) {
			const record = records.get(keyOf(ownerProfileId, executionId));
			if (!record || record.status !== "running") return null;
			applyDottedSet(record, update);
			return record;
		},
		async get(ownerProfileId, executionId) {
			const record = records.get(keyOf(ownerProfileId, executionId));
			if (!record) return null;
			if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) return { ...record, expired: true };
			return record;
		},
		async reconcileStale() {
			return 0;
		},
	};
}

function cookieIsLive(entry, sessionId, now) {
	if (!entry.expiresAt) return entry.sessionId === sessionId;
	return entry.expiresAt.getTime() > new Date(now).getTime();
}

export function createMemoryCookieRepository() {
	const items = new Map();
	const keyOf = (ownerProfileId, name, domain, path) => `${ownerProfileId}|${domain}|${path}|${name}`;

	return {
		items,
		async list(ownerProfileId, sessionId, now = Date.now()) {
			return [...items.values()]
				.filter((entry) => entry.ownerProfileId === ownerProfileId && cookieIsLive(entry, sessionId, now))
				.sort((left, right) => {
					if (left.path !== right.path) return left.path < right.path ? 1 : -1;
					const leftAt = left.createdAt?.getTime?.() ?? 0;
					const rightAt = right.createdAt?.getTime?.() ?? 0;
					if (leftAt !== rightAt) return leftAt - rightAt;
					return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
				});
		},
		async count(ownerProfileId, sessionId, now = Date.now()) {
			return [...items.values()].filter((entry) => entry.ownerProfileId === ownerProfileId && cookieIsLive(entry, sessionId, now)).length;
		},
		async purgeDead(ownerProfileId, sessionId, now = Date.now()) {
			let removed = 0;
			for (const [key, entry] of items) {
				if (entry.ownerProfileId !== ownerProfileId) continue;
				if (cookieIsLive(entry, sessionId, now)) continue;
				items.delete(key);
				removed += 1;
			}
			return { deletedCount: removed };
		},
		async upsert(entry) {
			const key = keyOf(entry.ownerProfileId, entry.name, entry.domain, entry.path);
			const existing = items.get(key);
			const timestamp = new Date();
			const record = {
				_id: existing?._id ?? randomUUID(),
				createdAt: existing?.createdAt ?? timestamp,
				updatedAt: timestamp,
				...existing,
				...entry,
			};
			items.set(key, record);
			return record;
		},
		async deleteByKey(ownerProfileId, { name, domain, path }) {
			const key = keyOf(ownerProfileId, name, domain, path);
			const existed = items.delete(key);
			return { deletedCount: existed ? 1 : 0 };
		},
		async deleteById(ownerProfileId, id) {
			for (const [key, entry] of items) {
				if (entry.ownerProfileId === ownerProfileId && String(entry._id) === String(id)) {
					items.delete(key);
					return entry;
				}
			}
			return null;
		},
		async clear(ownerProfileId) {
			let removed = 0;
			for (const [key, entry] of items) {
				if (entry.ownerProfileId !== ownerProfileId) continue;
				items.delete(key);
				removed += 1;
			}
			return { deletedCount: removed };
		},
	};
}

export function createMemoryCollectionRunRepository() {
	const records = new Map();
	const keyOf = (profileId, runId) => `${profileId}:${runId}`;

	return {
		records,
		async create(entry) {
			const record = { ...entry, _id: entry.runId };
			records.set(keyOf(entry.ownerProfileId, entry.runId), record);
			return record;
		},
		async get(ownerProfileId, runId) {
			return records.get(keyOf(ownerProfileId, runId)) ?? null;
		},
		async update(ownerProfileId, runId, patch) {
			const key = keyOf(ownerProfileId, runId);
			const record = records.get(key);
			if (!record) return null;
			Object.assign(record, patch);
			return record;
		},
		// Compare-and-set mirror of the Mongo repository: the write applies only while the
		// stored status still matches the expected source state, and a terminal state has
		// no outgoing transition.
		async transition(ownerProfileId, runId, expectedStatus, patch) {
			if (expectedStatus === "completed" || expectedStatus === "cancelled" || expectedStatus === "failed") return null;
			const key = keyOf(ownerProfileId, runId);
			const record = records.get(key);
			if (!record || record.status !== expectedStatus) return null;
			Object.assign(record, patch);
			return record;
		},
		async list(ownerProfileId, { collectionId = null, limit = 20 } = {}) {
			return [...records.values()]
				.filter((record) => record.ownerProfileId === ownerProfileId && (!collectionId || record.collectionId === collectionId))
				.sort((left, right) => {
					const leftAt = left.startedAt?.getTime?.() ?? 0;
					const rightAt = right.startedAt?.getTime?.() ?? 0;
					return rightAt - leftAt;
				})
				.slice(0, limit);
		},
	};
}

// Explicit, exact-host Local Runtime opt-in. The normal SSRF boundary stays in
// force; only the hosts the caller named on the command line become reachable.
export function createMemoryLocalRuntime(hosts = []) {
	const approved = [...new Set(hosts)];
	return {
		async forExecution() {
			return approved.length > 0 ? { enabled: true, hosts: approved } : { enabled: false, hosts: [] };
		},
		async get() {
			return { enabled: approved.length > 0, targets: [], revision: approved.length > 0 ? 1 : 0 };
		},
	};
}
