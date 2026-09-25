import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	capabilitiesFor,
	hasCapability,
	isWorkspaceRole,
	NO_CAPABILITIES,
	resolveCapabilities,
	roleLabel,
	ROLE_LABELS,
	WORKSPACE_CAPABILITY_KEYS,
	WORKSPACE_ROLES,
} from "./workspace-permissions.js";

// The backend is the authority. This suite pins the frontend mirror against the
// real backend matrix so the two cannot drift silently in separate commits.
const backendRoles = readFileSync(
	fileURLToPath(
		new URL("../../../../backend/src/features/workspaces/workspace-roles.js", import.meta.url),
	),
	"utf8",
);

const backendCapabilitiesFor = (role) => {
	// Read the literal matrix block for the role out of the backend source. This is
	// a plain text comparison on purpose: a behavioral import would hide drift in
	// the shape of the object the server actually returns over HTTP.
	const start = backendRoles.indexOf(`\n\t${role}: Object.freeze({`);
	expect(start).toBeGreaterThan(-1);
	const end = backendRoles.indexOf("\n\t}),", start);
	expect(end).toBeGreaterThan(start);
	const block = backendRoles.slice(start, end);
	const resolved = {};
	for (const capability of WORKSPACE_CAPABILITY_KEYS) {
		resolved[capability] = new RegExp(`\\b${capability}:\\s*true`).test(block);
	}
	return resolved;
};

describe("workspace role vocabulary", () => {
	test("exposes exactly the three roles the backend defines", () => {
		expect(WORKSPACE_ROLES).toEqual(["OWNER", "EDITOR", "VIEWER"]);
		for (const role of WORKSPACE_ROLES) expect(backendRoles).toContain(`"${role}"`);
	});

	test("labels every role and never invents a label for an unknown one", () => {
		for (const role of WORKSPACE_ROLES) expect(ROLE_LABELS[role]).toBeTruthy();
		expect(roleLabel("SUPERADMIN")).toBe("No access");
		expect(roleLabel(undefined)).toBe("No access");
	});

	test("recognizes only the canonical role strings", () => {
		for (const role of WORKSPACE_ROLES) expect(isWorkspaceRole(role)).toBe(true);
		expect(isWorkspaceRole("owner")).toBe(false);
		expect(isWorkspaceRole("")).toBe(false);
		expect(isWorkspaceRole(null)).toBe(false);
	});
});

describe("capability matrix mirrors the backend", () => {
	test("every role's capabilities match the backend matrix exactly", () => {
		for (const role of WORKSPACE_ROLES) {
			expect(capabilitiesFor(role)).toEqual(backendCapabilitiesFor(role));
		}
	});

	test("a viewer can read and inspect activity but cannot mutate or execute", () => {
		const viewer = capabilitiesFor("VIEWER");
		expect(viewer.read).toBe(true);
		expect(viewer.viewActivity).toBe(true);
		expect(viewer.execute).toBe(false);
		expect(viewer.writeCollections).toBe(false);
		expect(viewer.writeEnvironments).toBe(false);
		expect(viewer.manageMembers).toBe(false);
		expect(viewer.renameWorkspace).toBe(false);
	});

	test("an editor can run and write but cannot manage members or rename", () => {
		const editor = capabilitiesFor("EDITOR");
		expect(editor.execute).toBe(true);
		expect(editor.writeCollections).toBe(true);
		expect(editor.writeEnvironments).toBe(true);
		expect(editor.manageMembers).toBe(false);
		expect(editor.renameWorkspace).toBe(false);
	});

	test("an owner holds every capability", () => {
		for (const capability of WORKSPACE_CAPABILITY_KEYS) expect(hasCapability("OWNER", capability)).toBe(true);
	});

	test("fail-closed: unknown roles and unknown capabilities grant nothing", () => {
		expect(capabilitiesFor("OWNER ")).toBeNull();
		expect(capabilitiesFor("")).toBeNull();
		expect(capabilitiesFor(null)).toBeNull();
		expect(hasCapability("VIEWER", "execute")).toBe(false);
		expect(hasCapability(undefined, "read")).toBe(false);
		expect(hasCapability("OWNER", "deleteEverything")).toBe(false);
	});

	test("NO_CAPABILITIES denies every known capability", () => {
		expect(Object.keys(NO_CAPABILITIES).sort()).toEqual([...WORKSPACE_CAPABILITY_KEYS].sort());
		for (const capability of WORKSPACE_CAPABILITY_KEYS) expect(NO_CAPABILITIES[capability]).toBe(false);
	});
});

describe("resolveCapabilities", () => {
	test("prefers the server-provided capability object", () => {
		const resolved = resolveCapabilities({
			role: "VIEWER",
			capabilities: { read: true, viewActivity: true, execute: true },
		});
		// The server said execute is true even though the role would deny it; the
		// server wins because it re-checks every request anyway.
		expect(resolved.execute).toBe(true);
		expect(resolved.writeCollections).toBe(false);
	});

	test("derives capabilities from the role when the server omits them", () => {
		expect(resolveCapabilities({ role: "EDITOR" })).toEqual(capabilitiesFor("EDITOR"));
	});

	test("collapses an unrecognized workspace to the all-denied set", () => {
		expect(resolveCapabilities(null)).toEqual({ ...NO_CAPABILITIES });
		expect(resolveCapabilities({})).toEqual({ ...NO_CAPABILITIES });
		expect(resolveCapabilities({ role: "GOD" })).toEqual({ ...NO_CAPABILITIES });
	});

	test("coerces every server capability to a strict boolean", () => {
		const resolved = resolveCapabilities({
			role: "VIEWER",
			capabilities: { execute: "yes", writeCollections: 1, read: true, viewActivity: null },
		});
		expect(resolved.execute).toBe(false);
		expect(resolved.writeCollections).toBe(false);
		expect(resolved.read).toBe(true);
		expect(resolved.viewActivity).toBe(false);
	});
});
