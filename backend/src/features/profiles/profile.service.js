import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { collectionRepository } from "../collections/collection.repository.js";
import { environmentRepository } from "../environments/environment.repository.js";
import { preferenceRepository, profileRepository } from "./profile.repository.js";

export function filterAuthorizedProfiles(profiles, allowedProfileIds) {
	if (!allowedProfileIds) return profiles;
	const allowed = new Set(allowedProfileIds.map(String));
	return profiles.filter((profile) => allowed.has(String(profile._id)));
}

export const profileService = {
	async list(account) {
		const profiles = await profileRepository.list();
		return filterAuthorizedProfiles(profiles, account?.allowedProfileIds);
	},
	findProfileById: (id) => profileRepository.findById(id),
};

const DEFAULT_PREFERENCES = {
	activeEnvironmentId: null,
	lastSavedRequest: { collectionId: null, requestId: null },
	collectionOrder: [],
	theme: "dark",
	sidebarCollapsed: false,
	responseView: "pretty",
};

async function loadAuthorizedPreferences(ownerProfileId) {
	const stored = await preferenceRepository.findByProfile(ownerProfileId);
	if (!stored) return { ...DEFAULT_PREFERENCES, ownerProfileId };
	const [environment, collection] = await Promise.all([
		stored.activeEnvironmentId ? environmentRepository.findById(stored.activeEnvironmentId, ownerProfileId) : null,
		stored.lastSavedRequest?.collectionId ? collectionRepository.findById(stored.lastSavedRequest.collectionId, ownerProfileId) : null,
	]);
	const ownedCollections = await collectionRepository.findOwnedIds(stored.collectionOrder || [], ownerProfileId);
	const ownedIds = new Set(ownedCollections.map((item) => String(item._id)));
	return {
		...DEFAULT_PREFERENCES,
		...stored,
		activeEnvironmentId: environment ? String(environment._id) : null,
		lastSavedRequest: collection
			? { collectionId: String(collection._id), requestId: stored.lastSavedRequest.requestId || null }
			: DEFAULT_PREFERENCES.lastSavedRequest,
		collectionOrder: (stored.collectionOrder || []).map(String).filter((id) => ownedIds.has(id)),
	};
}

export const preferenceService = {
	async get(ownerProfileId) {
		return loadAuthorizedPreferences(ownerProfileId);
	},
	async update(ownerProfileId, input) {
		if (input.activeEnvironmentId) {
			if (!mongoose.isValidObjectId(input.activeEnvironmentId))
				throw new AppError(400, "VALIDATION_ERROR", "Select a valid environment.");
			const environment = await environmentRepository.findById(input.activeEnvironmentId, ownerProfileId);
			if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
		}
		if (input.lastSavedRequest?.collectionId) {
			const collection = await collectionRepository.findById(input.lastSavedRequest.collectionId, ownerProfileId);
			if (!collection) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
		}
		if (Array.isArray(input.collectionOrder)) {
			const owned = await collectionRepository.findOwnedIds(input.collectionOrder, ownerProfileId);
			if (owned.length !== new Set(input.collectionOrder.map(String)).size) {
				throw new AppError(403, "COLLECTION_FORBIDDEN", "The collection order contains a collection this profile does not own.");
			}
		}
		const update = {
			...(input.activeEnvironmentId !== undefined ? { activeEnvironmentId: input.activeEnvironmentId } : {}),
			...(input.lastSavedRequest !== undefined ? { lastSavedRequest: input.lastSavedRequest } : {}),
			...(input.collectionOrder !== undefined ? { collectionOrder: input.collectionOrder } : {}),
			...(input.theme !== undefined ? { theme: input.theme } : {}),
			...(input.sidebarCollapsed !== undefined ? { sidebarCollapsed: input.sidebarCollapsed } : {}),
			...(input.responseView !== undefined ? { responseView: input.responseView } : {}),
		};
		await preferenceRepository.upsert(ownerProfileId, update);
		return loadAuthorizedPreferences(ownerProfileId);
	},
};
