import { AppError } from "../../shared/errors/app-error.js";

// The three collaboration roles a profile can hold inside a shared workspace.
// Capability checks are fail-closed: an unknown or missing role grants nothing.
export const WORKSPACE_ROLES = ["OWNER", "EDITOR", "VIEWER"];

export const WORKSPACE_CAPABILITIES = [
	"read",
	"execute",
	"writeCollections",
	"writeEnvironments",
	"manageMembers",
	"renameWorkspace",
	"viewActivity",
];

const MATRIX = Object.freeze({
	OWNER: Object.freeze({
		read: true,
		execute: true,
		writeCollections: true,
		writeEnvironments: true,
		manageMembers: true,
		renameWorkspace: true,
		viewActivity: true,
	}),
	// An editor can shape the shared definitions and run them, but cannot change who
	// has access or rename the workspace.
	EDITOR: Object.freeze({
		read: true,
		execute: true,
		writeCollections: true,
		writeEnvironments: true,
		manageMembers: false,
		renameWorkspace: false,
		viewActivity: true,
	}),
	// A viewer is an explicit read-only participant. `execute: false` is deliberate:
	// a viewer must not be able to dispatch a side-effecting request through the
	// workspace, even though they can read and inspect the shared definitions.
	VIEWER: Object.freeze({
		read: true,
		execute: false,
		writeCollections: false,
		writeEnvironments: false,
		manageMembers: false,
		renameWorkspace: false,
		viewActivity: true,
	}),
});

export function isWorkspaceRole(role) {
	return WORKSPACE_ROLES.includes(role);
}

export function capabilitiesFor(role) {
	const entry = MATRIX[role];
	if (!entry) return null;
	return { ...entry };
}

export function hasCapability(role, capability) {
	const entry = MATRIX[role];
	return Boolean(entry && entry[capability] === true);
}

export function assertRole(role) {
	if (!isWorkspaceRole(role)) {
		throw new AppError(400, "VALIDATION_ERROR", "Select a valid workspace role: OWNER, EDITOR, or VIEWER.", {
			allowed: WORKSPACE_ROLES,
		});
	}
	return role;
}
