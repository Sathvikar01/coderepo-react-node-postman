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

export function createLocalRuntimeService({ repository = localRuntimeRepository } = {}) {
	return {
		async get(ownerProfileId) {
			return publicSetting(await repository.findByProfile(ownerProfileId));
		},
		async update(ownerProfileId, { expectedRevision, enabled, targets }) {
			const current = await repository.findByProfile(ownerProfileId);
			const currentRevision = current?.revision ?? 0;
			if (expectedRevision !== currentRevision)
				throw new AppError(409, "LOCAL_RUNTIME_CHANGED", "Local Runtime settings changed in another session. Reload and try again.");
			const nextTargets = planTargets(current?.targets ?? [], targets);
			const document = current
				? await repository.replace(ownerProfileId, currentRevision, { enabled, targets: nextTargets })
				: await repository.create({ ownerProfileId, enabled, targets: nextTargets, revision: 1 });
			if (!document)
				throw new AppError(409, "LOCAL_RUNTIME_CHANGED", "Local Runtime settings changed in another session. Reload and try again.");
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
