// Phase 24 — the frontend mirror of the backend workspace capability matrix.
//
// The backend is always the authority: it re-checks every capability on the
// server. This module exists so the UI can disable, hide, or explain an action
// before a round trip, and it is deliberately fail-closed — an unknown, missing,
// or unexpected role grants nothing rather than everything.
//
// The shapes here mirror `backend/src/features/workspaces/workspace-roles.js`.
// If the matrix changes there, it must change here in the same commit; the
// `workspace-permissions.test.js` suite pins both directions.

export const WORKSPACE_ROLES = Object.freeze(["OWNER", "EDITOR", "VIEWER"]);

export const WORKSPACE_CAPABILITY_KEYS = Object.freeze([
	"read",
	"execute",
	"writeCollections",
	"writeEnvironments",
	"manageMembers",
	"renameWorkspace",
	"viewActivity",
]);

export const ROLE_LABELS = Object.freeze({
	OWNER: "Owner",
	EDITOR: "Editor",
	VIEWER: "Viewer",
});

export const ROLE_HINTS = Object.freeze({
	OWNER: "Full control, including sharing and member roles.",
	EDITOR: "Can read, run, and edit the workspace's collections and environments.",
	VIEWER: "Read-only: can inspect the workspace but cannot change or run it.",
});

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
	EDITOR: Object.freeze({
		read: true,
		execute: true,
		writeCollections: true,
		writeEnvironments: true,
		manageMembers: false,
		renameWorkspace: false,
		viewActivity: true,
	}),
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

// The all-denied capability set. Used whenever the role is unknown or absent so
// the UI never accidentally enables a destructive control.
export const NO_CAPABILITIES = Object.freeze(
	Object.fromEntries(WORKSPACE_CAPABILITY_KEYS.map((capability) => [capability, false])),
);

export function isWorkspaceRole(role) {
	return WORKSPACE_ROLES.includes(role);
}

// Returns a fresh capability object for a known role, or null for anything else.
export function capabilitiesFor(role) {
	const entry = MATRIX[role];
	if (!entry) return null;
	return { ...entry };
}

export function hasCapability(role, capability) {
	const entry = MATRIX[role];
	return Boolean(entry && entry[capability] === true);
}

// Resolve the effective capabilities for a workspace summary. The server-provided
// capability object wins when present (it is the authority); otherwise we derive
// them from the role. Anything unrecognized collapses to the all-denied set.
export function resolveCapabilities(workspace) {
	const provided = workspace?.capabilities;
	if (provided && typeof provided === "object") {
		const resolved = {};
		for (const capability of WORKSPACE_CAPABILITY_KEYS) resolved[capability] = provided[capability] === true;
		if (Object.values(resolved).some(Boolean) || isWorkspaceRole(workspace?.role)) return resolved;
	}
	return capabilitiesFor(workspace?.role) ?? { ...NO_CAPABILITIES };
}

export function roleLabel(role) {
	return ROLE_LABELS[role] ?? "No access";
}
