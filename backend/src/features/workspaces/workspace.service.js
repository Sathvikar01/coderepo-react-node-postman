import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import { LIMITS } from "../../shared/utils/limits.js";
import { nameKey } from "../../shared/utils/names.js";
import { WorkspaceAccount } from "../auth/workspace-account.model.js";
import { collectionRepository } from "../collections/collection.repository.js";
import { environmentRepository } from "../environments/environment.repository.js";
import { Profile } from "../profiles/profile.model.js";
import { preferenceRepository, profileRepository } from "../profiles/profile.repository.js";
import { recordWorkspaceActivity } from "./workspace-activity.js";
import { workspaceActivityRepository } from "./workspace-activity.repository.js";
import { Workspace } from "./workspace.model.js";
import { workspaceRepository } from "./workspace.repository.js";
import { assertRole, capabilitiesFor, hasCapability } from "./workspace-roles.js";

function assertWorkspaceId(id) {
	if (!mongoose.isValidObjectId(id)) throw new AppError(404, "WORKSPACE_NOT_FOUND", "The requested workspace does not exist.");
}

function normalizeName(value) {
	const name = String(value ?? "").trim();
	if (!name) throw new AppError(400, "VALIDATION_ERROR", "Enter a workspace name.");
	if (name.length > LIMITS.workspaceName)
		throw new AppError(400, "VALIDATION_ERROR", `Workspace names are limited to ${LIMITS.workspaceName} characters.`);
	return name;
}

function revisionConflict() {
	return new AppError(409, "WORKSPACE_REVISION_CONFLICT", "This workspace changed since it was loaded. Reload before retrying.");
}

function nameConflict() {
	return new AppError(409, "WORKSPACE_NAME_CONFLICT", "You already have a workspace with this name.");
}

async function withNameConflictBoundary(operation) {
	try {
		return await operation();
	} catch (error) {
		if (error?.code === 11000) throw nameConflict();
		throw error;
	}
}

function membershipOf(workspace, profileId) {
	return workspace.members.find((member) => String(member.profileId) === String(profileId)) ?? null;
}

function summarize(workspace, profileId, activeWorkspaceId) {
	const membership = membershipOf(workspace, profileId);
	const role = membership?.role ?? null;
	return {
		_id: String(workspace._id),
		name: workspace.name,
		ownerProfileId: String(workspace.ownerProfileId),
		isPersonal: Boolean(workspace.personalForProfileId) && String(workspace.personalForProfileId) === String(profileId),
		memberCount: workspace.members.length,
		revision: workspace.revision,
		role,
		capabilities: capabilitiesFor(role),
		isActive: activeWorkspaceId ? String(workspace._id) === String(activeWorkspaceId) : false,
		createdAt: workspace.createdAt,
		updatedAt: workspace.updatedAt,
	};
}

export async function requireMembership(workspaceId, profileId) {
	assertWorkspaceId(workspaceId);
	const workspace = await workspaceRepository.findById(workspaceId);
	if (!workspace) throw new AppError(404, "WORKSPACE_NOT_FOUND", "The requested workspace does not exist.");
	const membership = membershipOf(workspace, profileId);
	if (!membership) throw new AppError(403, "WORKSPACE_FORBIDDEN", "You do not have access to this workspace.");
	return { workspace, role: membership.role, capabilities: capabilitiesFor(membership.role) };
}

function requireCapability(role, capability) {
	if (!hasCapability(role, capability)) {
		throw new AppError(403, "WORKSPACE_FORBIDDEN", "Your workspace role does not allow this action.", {
			requiredCapability: capability,
			role,
		});
	}
}

function assertOwnerRemains(members) {
	if (!members.some((member) => member.role === "OWNER")) {
		throw new AppError(409, "LAST_OWNER", "A workspace must always keep at least one owner.");
	}
}

async function resolveProfileForAccount(account) {
	const profiles = await Profile.find({ _id: { $in: account.allowedProfileIds } })
		.sort({ sortOrder: 1, name: 1 })
		.lean();
	if (profiles.length === 0) return null;
	return profiles.find((profile) => profile.email === account.email) ?? profiles[0];
}

async function profilesByIds(ids) {
	if (ids.length === 0) return new Map();
	const profiles = await Profile.find({ _id: { $in: ids } }).lean();
	return new Map(profiles.map((profile) => [String(profile._id), profile]));
}

// Auto-provision a personal workspace for a profile and adopt any resources that
// predate workspace scoping. Idempotent and safe to call on every legacy-scope request.
// `Workspace.init()` guarantees the one-personal-workspace-per-profile unique index
// exists before the find-or-create, so two concurrent legacy calls cannot each mint
// their own personal workspace.
async function ensurePersonalWorkspace(profileId) {
	await Workspace.init();
	let workspace = await workspaceRepository.findPersonal(profileId);
	if (!workspace) {
		const profile = await profileRepository.findById(profileId);
		const label = profile?.name ? `${profile.name}'s workspace` : "Personal workspace";
		try {
			const created = await workspaceRepository.create({
				ownerProfileId: profileId,
				name: label,
				nameKey: nameKey(label),
				personalForProfileId: profileId,
				members: [{ profileId, role: "OWNER", addedByProfileId: profileId, addedAt: new Date() }],
				revision: 1,
			});
			workspace = created.toObject ? created.toObject() : created;
		} catch (error) {
			if (error?.code !== 11000) throw error;
			workspace = await workspaceRepository.findPersonal(profileId);
			if (!workspace) throw error;
		}
		await Promise.all([
			collectionRepository.backfillWorkspace(profileId, workspace._id),
			environmentRepository.backfillWorkspace(profileId, workspace._id),
		]);
	}
	return workspace;
}

export const workspaceService = {
	ensurePersonalWorkspace,

	async listForProfile(profileId) {
		const [list, preferences] = await Promise.all([
			workspaceRepository.listForProfile(profileId),
			preferenceRepository.findByProfile(profileId),
		]);
		const activeWorkspaceId = preferences?.activeWorkspaceId ? String(preferences.activeWorkspaceId) : null;
		const entries = list.map((workspace) => summarize(workspace, profileId, activeWorkspaceId));
		if (entries.length === 0) {
			const personal = await ensurePersonalWorkspace(profileId);
			entries.push(summarize(personal, profileId, activeWorkspaceId ?? String(personal._id)));
		}
		// Exactly one workspace is presented as active; the client mirrors this id into
		// the `x-workspace-id` header.
		if (!entries.some((entry) => entry.isActive)) entries[0].isActive = true;
		return entries;
	},

	// Resolve which workspace a request is operating in, and the caller's role there.
	// Falls back from an explicit header to the profile's stored preference to the
	// first workspace they belong to, then to a freshly provisioned personal workspace.
	async resolveContext({ profileId, requestedWorkspaceId = null }) {
		if (requestedWorkspaceId) {
			assertWorkspaceId(requestedWorkspaceId);
			const workspace = await workspaceRepository.findById(requestedWorkspaceId);
			if (!workspace) throw new AppError(404, "WORKSPACE_NOT_FOUND", "The requested workspace does not exist.");
			const membership = membershipOf(workspace, profileId);
			if (!membership) throw new AppError(403, "WORKSPACE_FORBIDDEN", "You do not have access to this workspace.");
			return { workspace, role: membership.role, capabilities: capabilitiesFor(membership.role) };
		}
		const preferences = await preferenceRepository.findByProfile(profileId);
		const activeWorkspaceId = preferences?.activeWorkspaceId ? String(preferences.activeWorkspaceId) : null;
		if (activeWorkspaceId && mongoose.isValidObjectId(activeWorkspaceId)) {
			const workspace = await workspaceRepository.findByIdForMember(activeWorkspaceId, profileId);
			if (workspace) {
				const membership = membershipOf(workspace, profileId);
				return { workspace, role: membership.role, capabilities: capabilitiesFor(membership.role) };
			}
		}
		const list = await workspaceRepository.listForProfile(profileId);
		if (list.length > 0) {
			const membership = membershipOf(list[0], profileId);
			return { workspace: list[0], role: membership.role, capabilities: capabilitiesFor(membership.role) };
		}
		const personal = await ensurePersonalWorkspace(profileId);
		return { workspace: personal, role: "OWNER", capabilities: capabilitiesFor("OWNER") };
	},

	async get(workspaceId, profileId) {
		const { workspace, role } = await requireMembership(workspaceId, profileId);
		const summaries = summarize(workspace, profileId, String(workspace._id));
		const profiles = await profilesByIds(workspace.members.map((member) => member.profileId));
		return {
			...summaries,
			members: workspace.members.map((member) => {
				const profile = profiles.get(String(member.profileId));
				return {
					profileId: String(member.profileId),
					role: member.role,
					addedAt: member.addedAt,
					name: profile?.name ?? "Former member",
					email: profile?.email ?? null,
					isSelf: String(member.profileId) === String(profileId),
				};
			}),
			role,
		};
	},

	async create({ name }, actorProfileId) {
		const count = await workspaceRepository.countForProfile(actorProfileId);
		if (count >= LIMITS.workspacesPerProfile)
			throw new AppError(413, "WORKSPACE_LIMIT", `You have reached the ${LIMITS.workspacesPerProfile} workspace limit.`, {
				limit: LIMITS.workspacesPerProfile,
				actual: count,
				unit: "workspaces",
			});
		const cleanName = normalizeName(name);
		const conflict = await workspaceRepository.findOwnedByNameKey(actorProfileId, nameKey(cleanName), null);
		if (conflict) throw nameConflict();
		const created = await withNameConflictBoundary(() =>
			workspaceRepository.create({
				ownerProfileId: actorProfileId,
				name: cleanName,
				nameKey: nameKey(cleanName),
				members: [{ profileId: actorProfileId, role: "OWNER", addedByProfileId: actorProfileId, addedAt: new Date() }],
				revision: 1,
			}),
		);
		const workspace = created.toObject ? created.toObject() : created;
		await recordWorkspaceActivity({
			workspaceId: workspace._id,
			actorProfileId,
			action: "workspace.created",
			targetType: "workspace",
			targetId: String(workspace._id),
			targetLabel: workspace.name,
			newRevision: workspace.revision,
			summary: `Workspace "${workspace.name}" created`,
		});
		return workspaceService.get(String(workspace._id), actorProfileId);
	},

	async rename(workspaceId, actorProfileId, { name, expectedRevision }) {
		const { workspace, role } = await requireMembership(workspaceId, actorProfileId);
		requireCapability(role, "renameWorkspace");
		const cleanName = normalizeName(name);
		const conflict = await workspaceRepository.findOwnedByNameKey(workspace.ownerProfileId, nameKey(cleanName), workspace._id);
		if (conflict) throw nameConflict();
		const updated = await withNameConflictBoundary(() =>
			workspaceRepository.replaceWithRevision(workspace._id, expectedRevision, {
				name: cleanName,
				nameKey: nameKey(cleanName),
				members: workspace.members,
			}),
		);
		if (!updated) throw revisionConflict();
		await recordWorkspaceActivity({
			workspaceId: workspace._id,
			actorProfileId,
			action: "workspace.renamed",
			targetType: "workspace",
			targetId: String(workspace._id),
			targetLabel: cleanName,
			previousRevision: expectedRevision,
			newRevision: updated.revision,
			summary: `Workspace renamed from "${workspace.name}" to "${cleanName}"`,
			metadata: { previousName: workspace.name },
		});
		return workspaceService.get(String(workspace._id), actorProfileId);
	},

	async addMember(workspaceId, actorProfileId, { email, role, expectedRevision }) {
		const { workspace, role: actorRole } = await requireMembership(workspaceId, actorProfileId);
		requireCapability(actorRole, "manageMembers");
		assertRole(role);
		const normalizedEmail = String(email ?? "").trim().toLowerCase();
		if (!normalizedEmail) throw new AppError(400, "VALIDATION_ERROR", "Enter the email address of an existing Tracer user.");
		const account = await WorkspaceAccount.findOne({ email: normalizedEmail, active: true }).lean();
		if (!account) throw new AppError(404, "USER_NOT_FOUND", "No active Tracer account uses that email address.");
		const targetProfile = await resolveProfileForAccount(account);
		if (!targetProfile) throw new AppError(404, "USER_NOT_FOUND", "That account has no profile to share a workspace with.");
		if (membershipOf(workspace, targetProfile._id))
			throw new AppError(409, "MEMBER_EXISTS", "That user is already a member of this workspace.");
		if (workspace.members.length >= LIMITS.workspaceMembers)
			throw new AppError(413, "WORKSPACE_MEMBER_LIMIT", `A workspace can have at most ${LIMITS.workspaceMembers} members.`, {
				limit: LIMITS.workspaceMembers,
				actual: workspace.members.length,
				unit: "members",
			});
		const members = [
			...workspace.members,
			{ profileId: targetProfile._id, role, addedByProfileId: actorProfileId, addedAt: new Date() },
		];
		const updated = await workspaceRepository.replaceWithRevision(workspace._id, expectedRevision, {
			name: workspace.name,
			nameKey: workspace.nameKey,
			members,
		});
		if (!updated) throw revisionConflict();
		await recordWorkspaceActivity({
			workspaceId: workspace._id,
			actorProfileId,
			action: "member.added",
			targetType: "member",
			targetId: String(targetProfile._id),
			targetLabel: targetProfile.name,
			previousRevision: expectedRevision,
			newRevision: updated.revision,
			summary: `${targetProfile.name} added as ${role}`,
			metadata: { role },
		});
		return workspaceService.get(String(workspace._id), actorProfileId);
	},

	async changeRole(workspaceId, actorProfileId, { profileId, role, expectedRevision }) {
		const { workspace, role: actorRole } = await requireMembership(workspaceId, actorProfileId);
		requireCapability(actorRole, "manageMembers");
		assertRole(role);
		const target = membershipOf(workspace, profileId);
		if (!target) throw new AppError(404, "MEMBER_NOT_FOUND", "That profile is not a member of this workspace.");
		if (target.role === role) return workspaceService.get(String(workspace._id), actorProfileId);
		const members = workspace.members.map((member) =>
			String(member.profileId) === String(profileId) ? { ...member, role } : member,
		);
		assertOwnerRemains(members);
		const updated = await workspaceRepository.replaceWithRevision(workspace._id, expectedRevision, {
			name: workspace.name,
			nameKey: workspace.nameKey,
			members,
		});
		if (!updated) throw revisionConflict();
		await recordWorkspaceActivity({
			workspaceId: workspace._id,
			actorProfileId,
			action: "member.role_changed",
			targetType: "member",
			targetId: String(profileId),
			previousRevision: expectedRevision,
			newRevision: updated.revision,
			summary: `Role changed from ${target.role} to ${role}`,
			metadata: { previousRole: target.role, role },
		});
		return workspaceService.get(String(workspace._id), actorProfileId);
	},

	async removeMember(workspaceId, actorProfileId, { profileId, expectedRevision }) {
		const { workspace, role: actorRole } = await requireMembership(workspaceId, actorProfileId);
		requireCapability(actorRole, "manageMembers");
		const target = membershipOf(workspace, profileId);
		if (!target) throw new AppError(404, "MEMBER_NOT_FOUND", "That profile is not a member of this workspace.");
		const members = workspace.members.filter((member) => String(member.profileId) !== String(profileId));
		assertOwnerRemains(members);
		const updated = await workspaceRepository.replaceWithRevision(workspace._id, expectedRevision, {
			name: workspace.name,
			nameKey: workspace.nameKey,
			members,
		});
		if (!updated) throw revisionConflict();
		await recordWorkspaceActivity({
			workspaceId: workspace._id,
			actorProfileId,
			action: "member.removed",
			targetType: "member",
			targetId: String(profileId),
			previousRevision: expectedRevision,
			newRevision: updated.revision,
			summary: `A ${target.role} was removed from the workspace`,
			metadata: { removedRole: target.role },
		});
		return workspaceService.get(String(workspace._id), actorProfileId);
	},

	async listActivity(workspaceId, profileId, { limit, before } = {}) {
		const { workspace, role } = await requireMembership(workspaceId, profileId);
		requireCapability(role, "viewActivity");
		const parsedLimit = Math.min(Math.max(Number.parseInt(limit ?? "", 10) || LIMITS.workspaceActivityPageMax, 1), LIMITS.workspaceActivityPageMax);
		let beforeDate = null;
		if (before) {
			const parsed = new Date(before);
			if (Number.isNaN(parsed.getTime())) throw new AppError(400, "VALIDATION_ERROR", "Provide a valid activity cursor.");
			beforeDate = parsed;
		}
		const entries = await workspaceActivityRepository.list(workspace._id, { limit: parsedLimit, before: beforeDate });
		const actorIds = entries.map((entry) => entry.actorProfileId).filter(Boolean);
		const [profiles, total] = await Promise.all([profilesByIds(actorIds), workspaceActivityRepository.count(workspace._id)]);
		return {
			workspaceId: String(workspace._id),
			total,
			limit: parsedLimit,
			entryCount: entries.length,
			entries: entries.map((entry) => ({
				id: String(entry._id),
				actorProfileId: entry.actorProfileId ? String(entry.actorProfileId) : null,
				actorName: entry.actorProfileId ? (profiles.get(String(entry.actorProfileId))?.name ?? "Former member") : "System",
				action: entry.action,
				targetType: entry.targetType,
				targetId: entry.targetId ? String(entry.targetId) : null,
				targetLabel: entry.targetLabel ?? null,
				previousRevision: entry.previousRevision ?? null,
				newRevision: entry.newRevision ?? null,
				summary: entry.summary,
				metadata: entry.metadata ?? {},
				createdAt: entry.createdAt,
			})),
		};
	},
};

export { hasCapability };
