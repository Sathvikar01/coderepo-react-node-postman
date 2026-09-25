import { request } from "../../shared/api/client.js";

// Phase 24 — the workspace and membership API surface.
//
// Every call is scoped by the active profile token plus the `x-workspace-id`
// header that the shared client attaches. Membership endpoints are CAS-guarded:
// the caller passes the revision it last read, and a stale write returns a typed
// 409 rather than silently overwriting a collaborator's change.
export const workspaceApi = {
	list: () => request("/workspaces"),
	get: (workspaceId) => request(`/workspaces/${workspaceId}`),
	create: (name) => request("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
	rename: (workspaceId, expectedRevision, name) =>
		request(`/workspaces/${workspaceId}`, { method: "PUT", body: JSON.stringify({ expectedRevision, name }) }),
	addMember: (workspaceId, expectedRevision, email, role) =>
		request(`/workspaces/${workspaceId}/members`, {
			method: "POST",
			body: JSON.stringify({ expectedRevision, email: String(email ?? "").trim(), role }),
		}),
	changeRole: (workspaceId, expectedRevision, profileId, role) =>
		request(`/workspaces/${workspaceId}/members/${profileId}`, {
			method: "PUT",
			body: JSON.stringify({ expectedRevision, role }),
		}),
	removeMember: (workspaceId, expectedRevision, profileId) =>
		request(`/workspaces/${workspaceId}/members/${profileId}?revision=${expectedRevision}`, { method: "DELETE" }),
	activity: (workspaceId, { limit, before } = {}) => {
		const query = new URLSearchParams();
		if (limit) query.set("limit", String(limit));
		if (before) query.set("before", before);
		const suffix = query.toString();
		return request(`/workspaces/${workspaceId}/activity${suffix ? `?${suffix}` : ""}`);
	},
};
