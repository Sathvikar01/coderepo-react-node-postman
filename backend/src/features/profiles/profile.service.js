import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { collectionRepository } from "../collections/collection.repository.js";
import { environmentRepository } from "../environments/environment.repository.js";
import { workspaceRepository } from "../workspaces/workspace.repository.js";
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
	activeWorkspaceId: null,
	lastSavedRequest: { collectionId: null, requestId: null },
	collectionOrder: [],
	theme: "dark",
	sidebarCollapsed: false,
	responseView: "pretty",
};

// Preferences are stored per profile, but the resources they point at (active
// environment, saved request, collection order) live inside a workspace. Every id is
// re-validated against the *active workspace* so a switch can never surface a resource
// from a workspace the profile is not viewing, and a stale id resolves to null.
async function loadAuthorizedPreferences(ownerProfileId, workspaceId = null) {
	const stored = await preferenceRepository.findByProfile(ownerProfileId);
	const scoped = workspaceId !== null && workspaceId !== undefined;
	const activeWorkspaceId =
		stored?.activeWorkspaceId && (await workspaceRepository.findByIdForMember(stored.activeWorkspaceId, ownerProfileId))
			? String(stored.activeWorkspaceId)
			: null;
	if (!stored) {
		return {
			...DEFAULT_PREFERENCES,
			ownerProfileId,
			activeWorkspaceId,
			workspaceId: scoped ? String(workspaceId) : null,
		};
	}
	const [environment, collection] = await Promise.all([
		stored.activeEnvironmentId
			? scoped
				? environmentRepository.findByIdInWorkspace(stored.activeEnvironmentId, workspaceId)
				: environmentRepository.findById(stored.activeEnvironmentId, ownerProfileId)
			: null,
		stored.lastSavedRequest?.collectionId
			? scoped
				? collectionRepository.findByIdInWorkspace(stored.lastSavedRequest.collectionId, workspaceId)
				: collectionRepository.findById(stored.lastSavedRequest.collectionId, ownerProfileId)
			: null,
	]);
	const visibleCollections = scoped
		? await collectionRepository.findIdsInWorkspace(stored.collectionOrder || [], workspaceId)
		: await collectionRepository.findOwnedIds(stored.collectionOrder || [], ownerProfileId);
	const visibleIds = new Set(visibleCollections.map((item) => String(item._id)));
	return {
		...stored,
		activeEnvironmentId: environment ? String(environment._id) : null,
		activeWorkspaceId,
		workspaceId: scoped ? String(workspaceId) : null,
		lastSavedRequest: collection
			? { collectionId: String(collection._id), requestId: stored.lastSavedRequest.requestId || null }
			: DEFAULT_PREFERENCES.lastSavedRequest,
		collectionOrder: (stored.collectionOrder || []).map(String).filter((id) => visibleIds.has(id)),
	};
}

export const preferenceService = {
	async get(ownerProfileId, workspaceId = null) {
		return loadAuthorizedPreferences(ownerProfileId, workspaceId);
	},
	async update(ownerProfileId, input, workspaceId = null) {
		const scoped = workspaceId !== null && workspaceId !== undefined;
		if (input.activeWorkspaceId) {
			if (!mongoose.isValidObjectId(input.activeWorkspaceId))
				throw new AppError(400, "VALIDATION_ERROR", "Select a valid workspace.");
			const workspace = await workspaceRepository.findByIdForMember(input.activeWorkspaceId, ownerProfileId);
			if (!workspace) throw new AppError(403, "WORKSPACE_FORBIDDEN", "You are not a member of that workspace.");
		}
		if (input.activeEnvironmentId) {
			if (!mongoose.isValidObjectId(input.activeEnvironmentId))
				throw new AppError(400, "VALIDATION_ERROR", "Select a valid environment.");
			const environment = scoped
				? await environmentRepository.findByIdInWorkspace(input.activeEnvironmentId, workspaceId)
				: await environmentRepository.findById(input.activeEnvironmentId, ownerProfileId);
			if (!environment) throw new AppError(404, "ENVIRONMENT_NOT_FOUND", "The requested environment does not exist.");
		}
		if (input.lastSavedRequest?.collectionId) {
			const collection = scoped
				? await collectionRepository.findByIdInWorkspace(input.lastSavedRequest.collectionId, workspaceId)
				: await collectionRepository.findById(input.lastSavedRequest.collectionId, ownerProfileId);
			if (!collection) throw new AppError(404, "COLLECTION_NOT_FOUND", "The requested collection does not exist.");
		}
		if (Array.isArray(input.collectionOrder)) {
			const visible = scoped
				? await collectionRepository.findIdsInWorkspace(input.collectionOrder, workspaceId)
				: await collectionRepository.findOwnedIds(input.collectionOrder, ownerProfileId);
			if (visible.length !== new Set(input.collectionOrder.map(String)).size) {
				throw new AppError(
					403,
					"COLLECTION_FORBIDDEN",
					scoped
						? "The collection order contains a collection outside the active workspace."
						: "The collection order contains a collection this profile does not own.",
				);
			}
		}
		const update = {
			...(input.activeEnvironmentId !== undefined ? { activeEnvironmentId: input.activeEnvironmentId } : {}),
			...(input.activeWorkspaceId !== undefined ? { activeWorkspaceId: input.activeWorkspaceId } : {}),
			...(input.lastSavedRequest !== undefined ? { lastSavedRequest: input.lastSavedRequest } : {}),
			...(input.collectionOrder !== undefined ? { collectionOrder: input.collectionOrder } : {}),
			...(input.theme !== undefined ? { theme: input.theme } : {}),
			...(input.sidebarCollapsed !== undefined ? { sidebarCollapsed: input.sidebarCollapsed } : {}),
			...(input.responseView !== undefined ? { responseView: input.responseView } : {}),
		};
		await preferenceRepository.upsert(ownerProfileId, update);
		return loadAuthorizedPreferences(ownerProfileId, workspaceId);
	},
};
