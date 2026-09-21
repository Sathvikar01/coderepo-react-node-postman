import { describe, expect, test } from "bun:test";
import { ASSERTIONS_CONTRACT } from "./project-schema.js";
import { projectFromDomain } from "./project-export.js";
import { projectToDomain } from "./project-import.js";
import { parseProject, projectFingerprint, serializeProject } from "./project-serialize.js";

const REQUEST_1 = "11111111-1111-4111-8111-111111111111";
const REQUEST_2 = "22222222-2222-4222-8222-222222222222";
const FOLDER_1 = "33333333-3333-4333-8333-333333333333";
const Q_1 = "44444444-4444-4444-8444-444444444441";
const Q_2 = "44444444-4444-4444-8444-444444444442";
const Q_3 = "44444444-4444-4444-8444-444444444443";
const H_1 = "44444444-4444-4444-8444-444444444451";
const H_2 = "44444444-4444-4444-8444-444444444452";
const H_3 = "44444444-4444-4444-8444-444444444453";
const H_4 = "44444444-4444-4444-8444-444444444454";
const VAR_PLAIN = "55555555-5555-4555-8555-555555555551";
const VAR_SECRET = "55555555-5555-4555-8555-555555555552";
const ENV_VAR = "66666666-6666-4666-8666-666666666661";
const NEW_HEADER = "77777777-7777-4777-8777-777777777771";
const MONGO_COLLECTION_ID = "68c0ffee00000000000000a1";

const PRE_REQUEST = "tracer.variables.set('tenant', 'acme');";
const TEST_SCRIPT = "tracer.test('status is 200', () => tracer.expect(tracer.response.status).toBe(200));";

function collectionDoc(overrides = {}) {
	return {
		_id: MONGO_COLLECTION_ID,
		ownerProfileId: "68c0ffee00000000000000b2",
		name: "Orders API",
		nameKey: "orders api",
		description: "Order management",
		revision: 7,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-02T00:00:00.000Z",
		variables: [
			{ id: VAR_PLAIN, key: "baseUrl", kind: "plain", value: "https://api.test", enabled: true },
			{ id: VAR_SECRET, key: "orders_token", kind: "secretRef", alias: "local_token", enabled: true },
		],
		auth: { mode: "none" },
		folders: [{ id: FOLDER_1, name: "Read" }],
		requests: [
			{
				schemaVersion: 1,
				id: REQUEST_1,
				folderId: FOLDER_1,
				name: "List orders",
				method: "GET",
				urlTemplate: "{{baseUrl}}/orders",
				query: [
					{ id: Q_1, key: "status", value: "{{status}}", enabled: true },
					{ id: Q_2, key: "status", value: "{{fallback}}", enabled: true },
					{ id: Q_3, key: "page", value: "1", enabled: false },
				],
				headers: [
					{ id: H_1, key: "Accept", value: "application/json", enabled: true },
					{ id: H_2, key: "Accept", value: "text/plain", enabled: false },
					{ id: H_3, key: "X-Tenant", value: "{{tenant}}", enabled: true },
				],
				body: { mode: "none" },
				auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
				scripts: { preRequest: PRE_REQUEST, test: TEST_SCRIPT },
				settings: { timeoutMs: 15000 },
			},
			{
				schemaVersion: 1,
				id: REQUEST_2,
				folderId: null,
				name: "Create order",
				method: "POST",
				urlTemplate: "{{baseUrl}}/orders",
				query: [],
				headers: [{ id: H_4, key: "Content-Type", value: "application/json", enabled: true }],
				body: { mode: "json", text: '{"sku":"{{sku}}","note":"日本語 🚀"}' },
				auth: { mode: "inherit" },
				scripts: { preRequest: "", test: "" },
				settings: { timeoutMs: 30000 },
			},
		],
		...overrides,
	};
}

function environmentDoc(overrides = {}) {
	return {
		_id: "68c0ffee00000000000000e1",
		ownerProfileId: "68c0ffee00000000000000b2",
		name: "Local",
		nameKey: "local",
		revision: 3,
		variables: [{ id: ENV_VAR, key: "host", kind: "plain", value: "127.0.0.1:8000", enabled: true }],
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		...overrides,
	};
}

function exampleDoc(overrides = {}) {
	return {
		_id: "68c0ffee00000000000000f1",
		ownerProfileId: "68c0ffee00000000000000b2",
		name: "List orders example",
		nameKey: "list orders example",
		source: {
			type: "response",
			executionId: "99999999-9999-4999-8999-999999999999",
			requestId: REQUEST_1,
			collectionId: MONGO_COLLECTION_ID,
			requestName: "List orders",
		},
		match: {
			method: "GET",
			path: "/orders",
			query: [{ key: "status", value: "paid" }],
			headers: [{ key: "accept", value: "application/json" }],
		},
		response: {
			status: 200,
			statusText: "OK",
			contentType: "application/json",
			headers: [{ name: "Content-Type", value: "application/json" }],
			body: { encoding: "utf8", value: '{"orders":[{"id":"o1"}]}', mediaType: "application/json", truncated: false, omittedReason: null },
		},
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		...overrides,
	};
}

const domainInput = (overrides = {}) => ({
	collections: [collectionDoc()],
	environments: [environmentDoc()],
	examples: [exampleDoc()],
	...overrides,
});

const expectedAggregate = () => {
	const collection = collectionDoc();
	return {
		name: collection.name,
		description: collection.description,
		variables: collection.variables,
		auth: collection.auth,
		folders: collection.folders,
		requests: collection.requests,
	};
};

function caught(operation) {
	try {
		operation();
	} catch (error) {
		return error;
	}
	throw new Error("expected the operation to throw");
}

describe("domain -> portable export", () => {
	test("drops persistence bookkeeping and execution state", () => {
		const text = serializeProject(projectFromDomain({ ...domainInput(), name: "Orders workspace" }));
		for (const forbidden of [
			"ownerProfileId",
			"nameKey",
			'"revision"',
			"createdAt",
			"executionId",
			"collectionId",
			"_id",
			MONGO_COLLECTION_ID,
			"authOverride",
			"cookieJar",
		]) {
			expect(text).not.toContain(forbidden);
		}
	});

	test("is deterministic across repeated exports of the same domain model", () => {
		const first = serializeProject(projectFromDomain(domainInput()));
		const second = serializeProject(projectFromDomain(domainInput()));
		expect(first).toBe(second);
		expect(projectFingerprint(projectFromDomain(domainInput()))).toBe(projectFingerprint(projectFromDomain(domainInput())));
	});

	test("rejects an empty collection list", () => {
		expect(caught(() => projectFromDomain({ collections: [] })).code).toBe("PROJECT_INVALID");
	});
});

describe("portable -> domain round trip", () => {
	test("preserves the collection aggregate without semantic drift", () => {
		const project = projectFromDomain(domainInput());
		const applied = projectToDomain(parseProject(serializeProject(project)));
		expect(applied.collections).toEqual([expectedAggregate()]);
	});

	test("preserves request, folder, variable, and row identifiers", () => {
		const applied = projectToDomain(serializeProject(projectFromDomain(domainInput())));
		const collection = applied.collections[0];
		expect(collection.folders.map((folder) => folder.id)).toEqual([FOLDER_1]);
		expect(collection.requests.map((request) => request.id)).toEqual([REQUEST_1, REQUEST_2]);
		expect(collection.variables.map((variable) => variable.id)).toEqual([VAR_PLAIN, VAR_SECRET]);
		expect(collection.requests[0].headers.map((row) => row.id)).toEqual([H_1, H_2, H_3]);
		expect(collection.requests[0].query.map((row) => row.id)).toEqual([Q_1, Q_2, Q_3]);
	});

	test("preserves duplicate query keys, disabled rows, and row order", () => {
		const applied = projectToDomain(serializeProject(projectFromDomain(domainInput())));
		const request = applied.collections[0].requests[0];
		expect(request.query.map((row) => row.key)).toEqual(["status", "status", "page"]);
		expect(request.query.map((row) => row.enabled)).toEqual([true, true, false]);
		expect(request.query[1].value).toBe("{{fallback}}");
		expect(request.headers.map((row) => row.key)).toEqual(["Accept", "Accept", "X-Tenant"]);
		expect(request.headers.map((row) => row.enabled)).toEqual([true, false, true]);
	});

	test("preserves variable references, auth references, scripts, and bodies", () => {
		const applied = projectToDomain(serializeProject(projectFromDomain(domainInput())));
		const [list, create] = applied.collections[0].requests;
		expect(applied.collections[0].variables[1]).toEqual({
			id: VAR_SECRET,
			key: "orders_token",
			kind: "secretRef",
			alias: "local_token",
			enabled: true,
		});
		expect(list.auth).toEqual({ mode: "bearer", tokenTemplate: "{{orders_token}}" });
		expect(list.scripts).toEqual({ preRequest: PRE_REQUEST, test: TEST_SCRIPT });
		expect(create.auth).toEqual({ mode: "inherit" });
		expect(create.body).toEqual({ mode: "json", text: '{"sku":"{{sku}}","note":"日本語 🚀"}' });
		expect(create.folderId).toBeNull();
	});

	test("preserves environments and examples", () => {
		const applied = projectToDomain(serializeProject(projectFromDomain(domainInput())));
		expect(applied.environments).toEqual([{ name: "Local", variables: environmentDoc().variables }]);
		expect(applied.examples).toEqual([
			{
				name: "List orders example",
				source: { type: "response", requestId: REQUEST_1, requestName: "List orders" },
				match: exampleDoc().match,
				response: exampleDoc().response,
			},
		]);
	});

	test("fails closed on enabled duplicate headers instead of deduplicating", () => {
		const portable = parseProject(serializeProject(projectFromDomain(domainInput())));
		const headers = portable.collections[0].requests[0].headers;
		headers.push({ id: NEW_HEADER, key: "accept", value: "text/plain", enabled: true });
		const error = caught(() => projectToDomain(portable));
		expect(error.code).toBe("PROJECT_DOMAIN_INVALID");
		expect(error.details.issues.some((issue) => /duplicate/i.test(issue.message))).toBe(true);
		expect(portable.collections[0].requests[0].headers).toHaveLength(4);
	});

	test("never applies unknown fields silently", () => {
		const portable = parseProject(serializeProject(projectFromDomain(domainInput())));
		portable.collections[0].futureCollectionKey = "keep me";
		expect(caught(() => projectToDomain(portable)).code).toBe("PROJECT_DOMAIN_INVALID");
		delete portable.collections[0].futureCollectionKey;
		portable.collections[0].requests[0].futureRequestKey = true;
		expect(caught(() => projectToDomain(portable)).code).toBe("PROJECT_DOMAIN_INVALID");
		delete portable.collections[0].requests[0].futureRequestKey;
		portable.futureProjectKey = "container metadata";
		expect(projectToDomain(portable).collections[0].name).toBe("Orders API");
	});
});

describe("assertions envelope", () => {
	const items = [
		{ id: "assert-1", kind: "status", expected: 200 },
		{ id: "assert-2", kind: "header", name: "content-type", matches: "json" },
	];

	test("carries assertions through the portable format and defers them", () => {
		const exported = projectFromDomain({ ...domainInput(), assertionsByRequestId: { [REQUEST_1]: { contract: ASSERTIONS_CONTRACT, items } } });
		const applied = projectToDomain(parseProject(serializeProject(exported)));
		expect(applied.deferred.assertions).toEqual([{ requestId: REQUEST_1, contract: ASSERTIONS_CONTRACT, items }]);
		expect(applied.collections[0].requests[0].assertions).toBeUndefined();
		expect(applied.collections[0].requests[1].assertions).toBeUndefined();
	});

	test("re-exports identically after a round trip", () => {
		const exported = projectFromDomain({ ...domainInput(), assertionsByRequestId: { [REQUEST_1]: { contract: ASSERTIONS_CONTRACT, items } } });
		const applied = projectToDomain(serializeProject(exported));
		const reexported = projectFromDomain({
			collections: applied.collections,
			environments: applied.environments,
			examples: applied.examples,
			assertionsByRequestId: { [REQUEST_1]: { contract: ASSERTIONS_CONTRACT, items } },
		});
		expect(serializeProject(reexported)).toBe(serializeProject(exported));
	});

	test("fails closed on an assertions contract this version does not own", () => {
		const error = caught(() =>
			projectFromDomain({ ...domainInput(), assertionsByRequestId: { [REQUEST_1]: { contract: "tracer.assertions/99", items: [] } } }),
		);
		expect(error.code).toBe("PROJECT_ASSERTIONS_UNSUPPORTED");
	});
});
