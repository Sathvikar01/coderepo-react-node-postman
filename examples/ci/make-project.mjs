// Regenerates examples/ci/tracer-project.json from the real TracerProjectV1
// serializer, so the committed fixture is canonical, minimal, and provably valid.
//
//   bun examples/ci/make-project.mjs
//
// Identifiers are fixed on purpose: the CI fixture must be byte-for-byte stable
// across regenerations, otherwise the workflow artifacts would churn.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializeProject } from "../../backend/src/features/projects/project-serialize.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(here, "tracer-project.json");
const baseUrl = "http://127.0.0.1:4571";

const plain = (id, key, value) => ({ id, key, kind: "plain", value, enabled: true });
const statusAssertion = (id, name, expected) => ({
	id,
	name,
	enabled: true,
	target: "status",
	operator: "equals",
	path: "",
	expected: String(expected),
	valueType: "number",
});
const jsonAssertion = (id, name, jsonPath, expected) => ({
	id,
	name,
	enabled: true,
	target: "json",
	operator: "equals",
	path: jsonPath,
	expected,
	valueType: "string",
});

const passingFolderId = "22222222-2222-4222-8222-222222222222";

const project = {
	schemaVersion: 1,
	kind: "tracer.project",
	name: "Tracer CI Demo",
	description: "Deterministic pass/fail fixtures for the Tracer CLI CI workflow.",
	collections: [
		{
			name: "CI Demo",
			description: "Requests that pass, and one that fails, against the local demo target.",
			variables: [plain("11111111-1111-4111-8111-111111111111", "base_url", baseUrl)],
			auth: { mode: "none" },
			folders: [{ id: passingFolderId, name: "Passing" }],
			requests: [
				{
					schemaVersion: 1,
					id: "33333333-3333-4333-8333-333333333331",
					folderId: passingFolderId,
					name: "Health check",
					method: "GET",
					urlTemplate: "{{base_url}}/health",
					query: [],
					headers: [],
					body: { mode: "none" },
					auth: { mode: "inherit" },
					scripts: { preRequest: "", test: "" },
					settings: { timeoutMs: 5000 },
					assertions: {
						contract: "tracer.assertions/1",
						items: [statusAssertion("44444444-4444-4444-8444-444444444441", "Health returns 200", 200)],
					},
				},
				{
					schemaVersion: 1,
					id: "33333333-3333-4333-8333-333333333332",
					folderId: passingFolderId,
					name: "Read order",
					method: "GET",
					urlTemplate: "{{base_url}}/api/orders/1",
					query: [],
					headers: [],
					body: { mode: "none" },
					auth: { mode: "inherit" },
					scripts: { preRequest: "", test: "" },
					settings: { timeoutMs: 5000 },
					assertions: {
						contract: "tracer.assertions/1",
						items: [
							statusAssertion("44444444-4444-4444-8444-444444444442", "Order returns 200", 200),
							jsonAssertion("44444444-4444-4444-8444-444444444443", "Order is open", "status", "open"),
						],
					},
				},
				{
					schemaVersion: 1,
					id: "33333333-3333-4333-8333-333333333333",
					folderId: null,
					name: "Missing order",
					method: "GET",
					urlTemplate: "{{base_url}}/api/orders/missing",
					query: [],
					headers: [],
					body: { mode: "none" },
					auth: { mode: "inherit" },
					scripts: { preRequest: "", test: "" },
					settings: { timeoutMs: 5000 },
					assertions: {
						contract: "tracer.assertions/1",
						items: [statusAssertion("44444444-4444-4444-8444-444444444444", "Missing order returns 200", 200)],
					},
				},
			],
		},
	],
	environments: [
		{
			name: "Local",
			variables: [plain("11111111-1111-4111-8111-111111111112", "base_url", baseUrl)],
		},
	],
	examples: [],
};

writeFileSync(outputPath, `${serializeProject(project)}\n`, "utf8");
console.log(`wrote ${path.relative(process.cwd(), outputPath)}`);
