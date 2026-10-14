import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.js";
import { LIMITS } from "../../shared/utils/limits.js";
import { normalizeLocalHost } from "./local-address-policy.js";
import { localRuntimeRepository } from "./local-runtime.repository.js";

export const DISABLED_LOCAL_RUNTIME = { enabled: false, targets: [], revision: 0 };

function publicSetting(document) {
	if (!document) return { ...DISABLED_LOCAL_RUNTIME };
	return {
		enabled: document.enabled === true,
		targets: (document.targets ?? []).map((target) => ({
			id: target.id,
			host: target.host,
			addedAt: target.addedAt ?? null,
		})),
		revision: document.revision,
	};
}

function planTargets(existing, requested) {
	if (requested.length > LIMITS.localRuntimeTargets)
		throw new AppError(413, "PROFILE_LIMIT", `This profile has reached the ${LIMITS.localRuntimeTargets} approved local host limit.`, {
			limit: LIMITS.localRuntimeTargets,
			actual: requested.length,
			unit: "local hosts",
			scope: "profile",
		});
	const seen = new Set();
	return requested.map((entry) => {
		const host = normalizeLocalHost(entry.host);
		if (seen.has(host)) throw new AppError(409, "LOCAL_HOST_DUPLICATE", `${host} is already on the approved list.`);
		seen.add(host);
		const prior = existing.find((target) => target.host === host);
		return { id: prior?.id ?? randomUUID(), host, addedAt: prior?.addedAt ?? new Date() };
	});
}

function runtimeChanged() {
	return new AppError(409, "LOCAL_RUNTIME_CHANGED", "Local Runtime settings changed in another session. Reload and try again.");
}

// `ownerProfileId` is the only unique index on LocalRuntimeSetting, so a
// duplicate-key failure during create can only mean another request won the
// first-write race. When the driver reports the colliding key, confirm it is
// that index so a duplicate on any future unique key stays an unrelated error.
function isConcurrentCreateConflict(error) {
	if (error?.code !== 11000 && error?.code !== 11001) return false;
	const pattern = error.keyPattern ?? error.keyValue;
	if (!pattern) return true;
	return Boolean(pattern.ownerProfileId);
}

// The winner's document is canonical. A losing racer may adopt it only when it
// asked for exactly the same logical setting (same enabled flag and normalized
// hosts in order); anything else is a genuine revision conflict, because the
// racer's `expectedRevision` was computed against the now-stale empty state.
function matchesRequestedSetting(document, { enabled, targets }) {
	if (!document) return false;
	if ((document.enabled === true) !== (enabled === true)) return false;
	const storedHosts = (document.targets ?? []).map((target) => target.host);
	if (storedHosts.length !== targets.length) return false;
	return storedHosts.every((host, index) => host === targets[index].host);
}

export function createLocalRuntimeService({ repository = localRuntimeRepository } = {}) {
	return {
		async get(ownerProfileId) {
			return publicSetting(await repository.findByProfile(ownerProfileId));
		},
		async update(ownerProfileId, { expectedRevision, enabled, targets }) {
			const current = await repository.findByProfile(ownerProfileId);
			const currentRevision = current?.revision ?? 0;
			if (expectedRevision !== currentRevision) throw runtimeChanged();
			const nextTargets = planTargets(current?.targets ?? [], targets);
			if (current) {
				const document = await repository.replace(ownerProfileId, currentRevision, { enabled, targets: nextTargets });
				if (!document) throw runtimeChanged();
				return publicSetting(document);
			}
			let document;
			try {
				document = await repository.create({ ownerProfileId, enabled, targets: nextTargets, revision: 1 });
			} catch (error) {
				// A concurrent first update won the unique ownerProfileId insert.
				// Reconcile against the canonical row; every other database error
				// propagates unchanged and is never reported as a revision conflict.
				if (!isConcurrentCreateConflict(error)) throw error;
				const canonical = await repository.findByProfile(ownerProfileId);
				if (matchesRequestedSetting(canonical, { enabled, targets: nextTargets })) return publicSetting(canonical);
				throw runtimeChanged();
			}
			return publicSetting(document);
		},
		// Read-only projection consumed by the execution service before target
		// validation. Disabled or missing settings never broaden the default policy.
		async forExecution(ownerProfileId) {
			const document = await repository.findByProfile(ownerProfileId);
			if (!document?.enabled) return { enabled: false, hosts: [] };
			return { enabled: true, hosts: (document.targets ?? []).map((target) => target.host) };
		},
	};
}

export const localRuntimeService = createLocalRuntimeService();
