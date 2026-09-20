import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { getConfig } from "../../shared/config/index.js";
import { LIMITS } from "../../shared/utils/limits.js";
import { nameKey } from "../../shared/utils/names.js";
import { environmentRepository } from "./environment.repository.js";

function assertId(id) {
	if (!mongoose.isValidObjectId(id)) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
}

async function ensureUniqueName(name, ownerProfileId, excludedId) {
	const conflict = await environmentRepository.findByNameKey(nameKey(name), ownerProfileId, excludedId);
	if (conflict) throw new AppError(409, "ENVIRONMENT_NAME_CONFLICT", "An environment with this name already exists in this profile.");
}

async function withNameConflictBoundary(operation) {
	try {
		return await operation();
	} catch (error) {
		if (error?.code === 11000)
			throw new AppError(409, "ENVIRONMENT_NAME_CONFLICT", "An environment with this name already exists in this profile.");
		throw error;
	}
}

export const environmentService = {
	list: (ownerProfileId) => environmentRepository.list(ownerProfileId),
	async get(id, ownerProfileId) {
		assertId(id);
		const environment = await environmentRepository.findById(id, ownerProfileId);
		if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
		return environment;
	},
	async create(input, ownerProfileId) {
		const count = await environmentRepository.count(ownerProfileId);
		if (count >= LIMITS.environmentsPerProfile)
			throw new AppError(413, "PROFILE_LIMIT", "This profile has reached the 20 environment limit.", {
				limit: LIMITS.environmentsPerProfile,
				actual: count,
				unit: "environments",
				scope: "profile",
			});
		await ensureUniqueName(input.name, ownerProfileId, null);
		return withNameConflictBoundary(() =>
			environmentRepository.create({ ...input, nameKey: nameKey(input.name), ownerProfileId, revision: 1 }),
		);
	},
	async replace(id, ownerProfileId, expectedRevision, input) {
		assertId(id);
		const current = await environmentRepository.findById(id, ownerProfileId);
		if (!current) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
		await ensureUniqueName(input.name, ownerProfileId, id);
		const updated = await withNameConflictBoundary(() =>
			environmentRepository.replaceWithRevision(id, ownerProfileId, expectedRevision, {
				...input,
				nameKey: nameKey(input.name),
			}),
		);
		if (!updated)
			throw new AppError(409, "ENVIRONMENT_REVISION_CONFLICT", "This environment changed since it was loaded. Reload before saving.");
		return updated;
	},
	async remove(id, ownerProfileId, expectedRevision) {
		assertId(id);
		const removed = await environmentRepository.removeWithRevision(id, ownerProfileId, expectedRevision);
		if (!removed) {
			const exists = await environmentRepository.findById(id, ownerProfileId);
			if (!exists) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
			throw new AppError(
				409,
				"ENVIRONMENT_REVISION_CONFLICT",
				"This environment changed since it was loaded. Reload before deleting.",
			);
		}
		return removed;
	},
	secretAliases(ownerProfileId) {
		return getConfig()
			.secretAliases.filter((entry) => entry.profileIds.length === 0 || entry.profileIds.includes(ownerProfileId))
			.map((entry) => ({ alias: entry.alias, configured: Boolean(entry.value) }));
	},
	resolveSecretAlias(ownerProfileId, alias) {
		const entry = getConfig().secretAliases.find((candidate) => candidate.alias === alias);
		if (!entry) return null;
		if (entry.profileIds.length > 0 && !entry.profileIds.includes(ownerProfileId)) return null;
		return entry.value;
	},
};
