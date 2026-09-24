import { describe, expect, test } from "bun:test";
import { AppError } from "../../shared/errors/app-error.js";
import { analyzeChange, analyzeChanges, analyzeWorkspaceDiff, buildGraph } from "./change-impact.service.js";
import { assertProfileScope, createChangeImpactAdapter } from "./change-impact-adapter.js";
import { diffWorkspaces } from "./workspace-diff.js";
import { extractPlaceholders, scanScript } from "./reference-extractor.js";

const ENV_ID = "env-1";
const ALT_ENV_ID = "env-2";
const COL_ID = "col-1";
const FOLDER_ID = "folder-1";
const PROFILE_ID = "profile-1";

function variable(id, key, value) {
	return { id, key, kind: "plain", value, enabled: true };
}

function secret(id, key, alias) {
	return { id, key, kind: "secretRef", alias, enabled: true };
}

function makeWorkspace() {
	return {
		ownerProfileId: PROFILE_ID,
		environmentId: ENV_ID,
		collections: [
			{
				id: COL_ID,
				ownerProfileId: PROFILE_ID,
				name: "Users",
				auth: { mode: "bearer", tokenTemplate: "{{API_TOKEN}}" },
				variables: [
					variable("cv-1", "USER_ID", "42"),
					variable("cv-2", "BODY_TAG", "beta"),
					variable("cv-3", "QUERY_KEY", "abc"),
					variable("cv-4", "UNUSED_VAR", "unused"),
					secret("cv-5", "API_TOKEN", "col-token"),
				],
				folders: [{ id: FOLDER_ID, name: "Users" }],
				requests: [
					{
						id: "r-1",
						folderId: FOLDER_ID,
						name: "List users",
						method: "GET",
						urlTemplate: "{{BASE_URL}}/users/{{USER_ID}}",
						headers: [
							{ id: "h-1", key: "X-Trace", value: "{{API_TOKEN}}", enabled: true },
							{ id: "h-2", key: "X-Client", value: "tracer", enabled: true },
						],
						auth: { mode: "inherit" },
						scripts: { preRequest: 'pm.variables.set("REQUEST_TOKEN", "abc");', test: "" },
						assertions: [{ id: "a-1", name: "ok", enabled: true, target: "status", path: "" }],
					},
					{
						id: "r-2",
						folderId: FOLDER_ID,
						name: "Create user",
						method: "POST",
						urlTemplate: "{{BASE_URL}}/users",
						headers: [{ id: "h-3", key: "X-Client", value: "tracer", enabled: true }],
						body: { mode: "json", text: '{"token":"{{REQUEST_TOKEN}}","tag":"{{BODY_TAG}}"}' },
						auth: { mode: "inherit" },
						assertions: [{ id: "a-2", name: "created", enabled: true, target: "status", path: "" }],
					},
					{
						id: "r-3",
						name: "Health",
						method: "GET",
						urlTemplate: "{{BASE_URL}}/health/{{MISSING_VAR}}/{{ }}",
						query: [{ id: "q-1", key: "key", value: "{{QUERY_KEY}}", enabled: true }],
						headers: [{ id: "h-4", key: "X-Client", value: "tracer", enabled: true }],
						auth: { mode: "none" },
						scripts: { test: 'const scopeName = "X"; pm.variables.get(scopeName);' },
					},
				],
			},
		],
		environments: [
			{
				id: ENV_ID,
				ownerProfileId: PROFILE_ID,
				name: "Local",
				variables: [variable("ev-1", "BASE_URL", "https://api.example.com"), secret("ev-2", "API_TOKEN", "env-token")],
			},
			{
				id: ALT_ENV_ID,
				ownerProfileId: PROFILE_ID,
				name: "Staging",
				variables: [variable("ev-3", "BASE_URL", "https://staging.example.com")],
			},
		],
	};
}

const baseWorkspace = () => structuredClone(makeWorkspace());

function requestIds(result) {
	return result.requests.direct.map((item) => item.requestId).sort();
}

describe("reference extraction", () => {
	test("extracts distinct placeholders and flags malformed opens", () => {
		const found = extractPlaceholders("{{A}}/{{ A }}/{{B}}/{{ }}");
		expect(found.keys).toEqual(["A", "B"]);
		expect(found.malformed).toBe(true);
	});

	test("reads literal script references and reports computed names as dynamic", () => {
		const script = scanScript('pm.variables.set("TOKEN", "1"); pm.environment.get("BASE_URL"); pm.variables.get(name);');
		expect(script.writes).toEqual([{ key: "TOKEN", op: "set" }]);
		expect(script.reads.map((read) => read.key)).toEqual(["BASE_URL"]);
		expect(script.dynamicReads.length).toBe(1);
	});
});

describe("change impact core", () => {
	test("direct variable reference affects every referencing request", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "changed", target: { kind: "environmentVariable", environmentId: ENV_ID, key: "BASE_URL" } },
		});
		expect(result.resolved).toBe(true);
		expect(requestIds(result)).toEqual(["r-1", "r-2", "r-3"]);
		expect(result.change.target.key).toBe("BASE_URL");
		expect(result.summary.severity).toBe("medium");
	});

	test("environment scope shadows collection scope for the same key", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "changed", target: { kind: "collectionVariable", collectionId: COL_ID, key: "API_TOKEN" } },
		});
		expect(result.resolved).toBe(true);
		expect(result.summary.totalRequests).toBe(0);
		expect(result.summary.severity).toBe("none");
	});

	test("transitive impact walks from a variable through a request feed", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "changed", target: { kind: "environmentVariable", environmentId: ENV_ID, key: "API_TOKEN" } },
		});
		expect(result.requests.direct.map((item) => item.requestId).sort()).toEqual(["r-1", "r-2"]);
		// The feed node (produced by r-1, consumed by r-2) is indirect.
		const feed = result.impact.indirect.find((item) => item.nodeKind === "requestVariable");
		expect(feed).toBeTruthy();
		expect(feed.hop).toBe(2);
		expect(feed.severity).toBe("low");
	});

	test("removing a produced request variable flags its readers as high severity", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "removed", target: { kind: "requestVariable", collectionId: COL_ID, requestId: "r-1", key: "REQUEST_TOKEN" } },
		});
		expect(result.resolved).toBe(true);
		expect(requestIds(result)).toEqual(["r-2"]);
		expect(result.requests.direct[0].severity).toBe("high");
		expect(result.requests.direct[0].hop).toBe(1);
	});

	test("collection auth change reaches requests that inherit", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "changed", target: { kind: "auth", scope: "collection", collectionId: COL_ID } },
		});
		expect(result.requests.direct.map((item) => item.requestId).sort()).toEqual(["r-1", "r-2"]);
		expect(result.summary.severity).toBe("high");
	});

	test("request-scoped header change affects only that request", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "removed", target: { kind: "header", scope: "request", collectionId: COL_ID, requestId: "r-1", name: "X-Client" } },
		});
		expect(requestIds(result)).toEqual(["r-1"]);
		expect(result.summary.severity).toBe("medium");
	});

	test("shared header change affects every request that uses it", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "changed", target: { kind: "header", scope: "shared", name: "X-Client" } },
		});
		expect(requestIds(result)).toEqual(["r-1", "r-2", "r-3"]);
		expect(result.summary.severity).toBe("low");
	});

	test("body and query references resolve to their requests", () => {
		const body = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "changed", target: { kind: "collectionVariable", collectionId: COL_ID, key: "BODY_TAG" } },
		});
		expect(requestIds(body)).toEqual(["r-2"]);
		const query = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "changed", target: { kind: "collectionVariable", collectionId: COL_ID, key: "QUERY_KEY" } },
		});
		expect(requestIds(query)).toEqual(["r-3"]);
	});

	test("path variable reference resolves through the URL template", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "changed", target: { kind: "collectionVariable", collectionId: COL_ID, key: "USER_ID" } },
		});
		expect(requestIds(result)).toEqual(["r-1"]);
	});

	test("collection-level change reaches every request in the collection", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "changed", target: { kind: "collection", collectionId: COL_ID } },
		});
		expect(result.requests.direct.map((item) => item.requestId).sort()).toEqual(["r-1", "r-2", "r-3"]);
		expect(result.collections).toHaveLength(1);
		expect(result.collections[0].requestIds).toEqual(["r-1", "r-2", "r-3"]);
	});

	test("folder change resolves the requests it contains", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "removed", target: { kind: "folder", collectionId: COL_ID, folderId: FOLDER_ID } },
		});
		expect(requestIds(result)).toEqual(["r-1", "r-2"]);
		expect(result.folders).toHaveLength(1);
	});

	test("unreferenced change has zero impact", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "changed", target: { kind: "collectionVariable", collectionId: COL_ID, key: "UNUSED_VAR" } },
		});
		expect(result.resolved).toBe(true);
		expect(result.summary.totalRequests).toBe(0);
		expect(result.summary.severity).toBe("none");
		expect(result.impact.direct).toEqual([]);
	});

	test("missing target fails closed without inventing impact", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "removed", target: { kind: "collectionVariable", collectionId: COL_ID, key: "GHOST" } },
		});
		expect(result.resolved).toBe(false);
		expect(result.unknown.some((unknown) => unknown.code === "target-not-found")).toBe(true);
		expect(result.summary.totalRequests).toBe(0);
	});

	test("cycles terminate and stay bounded", () => {
		const workspace = baseWorkspace();
		workspace.collections[0].requests.push({
			id: "r-cycle",
			name: "Cycle",
			method: "GET",
			urlTemplate: "{{BASE_URL}}/cycle",
			scripts: { preRequest: 'const next = pm.variables.get("LOOP") ?? "1"; pm.variables.set("LOOP", next);', test: "" },
		});
		const result = analyzeChange({
			workspace,
			change: { operation: "changed", target: { kind: "request", collectionId: COL_ID, requestId: "r-cycle" } },
		});
		expect(result.impact.direct.some((item) => item.nodeKind === "requestVariable")).toBe(true);
		expect(result.truncated).toBe(false);
		const unique = new Set(result.impact.direct.map((item) => item.node));
		expect(unique.size).toBe(result.impact.direct.length);
	});

	test("duplicate references dedupe to a single request row", () => {
		const workspace = baseWorkspace();
		workspace.collections[0].requests[0].headers.push({ id: "h-dup", key: "X-User", value: "{{USER_ID}}", enabled: true });
		const result = analyzeChange({
			workspace,
			change: { operation: "changed", target: { kind: "collectionVariable", collectionId: COL_ID, key: "USER_ID" } },
		});
		const rows = result.requests.direct.filter((item) => item.requestId === "r-1");
		expect(rows).toHaveLength(1);
	});

	test("malformed stored data is rejected as a structured error", () => {
		let error;
		try {
			analyzeChange({
				workspace: {
					ownerProfileId: PROFILE_ID,
					collections: [{ id: COL_ID, ownerProfileId: PROFILE_ID, auth: { mode: "none" }, requests: "not-an-array" }],
					environments: [],
				},
				change: { operation: "changed", target: { kind: "collection", collectionId: COL_ID } },
			});
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(AppError);
		expect(error.statusCode).toBe(422);
		expect(error.code).toBe("CHANGE_IMPACT_SOURCE_INVALID");
	});

	test("a workspace spanning two profiles is rejected", () => {
		const workspace = baseWorkspace();
		workspace.environments[0].ownerProfileId = "profile-2";
		let error;
		try {
			buildGraph(workspace);
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(AppError);
		expect(error.code).toBe("CHANGE_IMPACT_SOURCE_INVALID");
	});

	test("output ordering and shape are deterministic", () => {
		const change = { operation: "changed", target: { kind: "environmentVariable", environmentId: ENV_ID, key: "API_TOKEN" } };
		const first = analyzeChange({ workspace: baseWorkspace(), change });
		const second = analyzeChange({ workspace: baseWorkspace(), change });
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});

	test("dynamic and unresolved references are reported as unknown", () => {
		const result = analyzeChange({
			workspace: baseWorkspace(),
			change: { operation: "changed", target: { kind: "environmentVariable", environmentId: ENV_ID, key: "BASE_URL" } },
		});
		const codes = new Set(result.unknown.map((unknown) => unknown.code));
		expect(codes.has("unresolved-variable")).toBe(true);
		expect(codes.has("malformed-placeholder")).toBe(true);
		expect(codes.has("dynamic-variable-read")).toBe(true);
	});

	test("ambiguous environment scope is marked unknown rather than guessed", () => {
		const workspace = baseWorkspace();
		workspace.environmentId = null;
		const result = analyzeChange({
			workspace,
			change: { operation: "changed", target: { kind: "environmentVariable", environmentId: ENV_ID, key: "BASE_URL" } },
		});
		expect(result.unknown.some((unknown) => unknown.code === "ambiguous-variable-scope")).toBe(true);
		expect(result.requests.direct.length).toBeGreaterThan(0);
		expect(result.requests.direct.every((item) => item.confidence === "unknown")).toBe(true);
	});

	test("order-dependent write becomes an unknown feed", () => {
		const workspace = baseWorkspace();
		workspace.collections[0].requests = [
			{
				id: "reader",
				name: "Reader",
				method: "GET",
				urlTemplate: "{{BASE_URL}}/reader/{{LATE}}",
				auth: { mode: "none" },
			},
			{
				id: "writer",
				name: "Writer",
				method: "GET",
				urlTemplate: "{{BASE_URL}}/writer",
				auth: { mode: "none" },
				scripts: { preRequest: 'pm.variables.set("LATE", "1");', test: "" },
			},
		];
		const result = analyzeChange({
			workspace,
			change: { operation: "changed", target: { kind: "requestVariable", collectionId: COL_ID, requestId: "writer", key: "LATE" } },
		});
		expect(result.unknown.some((unknown) => unknown.code === "order-dependent-variable-feed")).toBe(true);
		const feed = result.impact.direct.find((item) => item.nodeKind === "request");
		expect(feed.confidence).toBe("unknown");
	});
});

describe("workspace diff boundary", () => {
	test("diff detects a removed collection variable and analyzes its impact", () => {
		const before = baseWorkspace();
		const after = baseWorkspace();
		after.collections[0].variables = after.collections[0].variables.filter((entry) => entry.key !== "USER_ID");
		const diff = analyzeWorkspaceDiff({ before, after });
		const removal = diff.changes.find(
			(result) => result.change.operation === "removed" && result.change.target.kind === "collectionVariable" && result.change.target.key === "USER_ID",
		);
		expect(removal).toBeTruthy();
		expect(removal.requests.direct.map((item) => item.requestId)).toEqual(["r-1"]);
	});

	test("diff detects header value edits", () => {
		const before = baseWorkspace();
		const after = baseWorkspace();
		after.collections[0].requests[0].headers[1].value = "changed";
		const changes = diffWorkspaces(before, after);
		expect(changes).toContainEqual({ operation: "changed", target: { kind: "header", scope: "request", collectionId: COL_ID, requestId: "r-1", name: "x-client" } });
	});

	test("analyzeChanges analyzes a batch deterministically", () => {
		const results = analyzeChanges({
			workspace: baseWorkspace(),
			changes: [
				{ operation: "changed", target: { kind: "collectionVariable", collectionId: COL_ID, key: "USER_ID" } },
				{ operation: "changed", target: { kind: "collectionVariable", collectionId: COL_ID, key: "UNUSED_VAR" } },
			],
		});
		expect(results).toHaveLength(2);
		expect(requestIds(results[0])).toEqual(["r-1"]);
		expect(results[1].summary.totalRequests).toBe(0);
	});
});

describe("repository adapter", () => {
	test("loads a profile workspace and analyzes the current state", async () => {
		const workspace = makeWorkspace();
		const adapter = createChangeImpactAdapter({
			collectionSource: async () => workspace.collections,
			environmentSource: async () => workspace.environments,
		});
		const result = await adapter.analyzeCurrent({
			ownerProfileId: PROFILE_ID,
			environmentId: ENV_ID,
			change: { operation: "changed", target: { kind: "collectionVariable", collectionId: COL_ID, key: "USER_ID" } },
		});
		expect(result.requests.direct.map((item) => item.requestId)).toEqual(["r-1"]);
	});

	test("rejects data from another profile", () => {
		expect(() => assertProfileScope({ collections: [{ id: "c", ownerProfileId: "other" }], environments: [] }, PROFILE_ID)).toThrow(AppError);
	});
});
