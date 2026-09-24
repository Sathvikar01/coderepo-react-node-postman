import { describe, expect, test } from "bun:test";
import { analyzeEnvironmentDrift, adaptEnvironment, DRIFT_CATEGORIES } from "./index.js";

// Known seeded secret values. No drift payload may ever contain these.
const SEEDED_SECRET_VALUES = ["local-secret-token-value", "staging-secret-token-value"];

const row = (key, value, id = `${key}-row`) => ({ id, key, value, enabled: true });
const plain = (key, value, id = `${key}-var`) => ({ id, key, kind: "plain", value, enabled: true });
const secret = (key, alias, id = `${key}-var`) => ({ id, key, kind: "secretRef", alias, enabled: true });

function ordersCollection(overrides = {}) {
	return {
		id: "collection-1",
		ownerProfileId: "profile-1",
		name: "Orders API",
		variables: [plain("api_version", "v1")],
		auth: { mode: "bearer", tokenTemplate: "{{orders_token}}" },
		folders: [],
		requests: [
			{ id: "request-list", method: "GET", urlTemplate: "{{base_url}}/orders", query: [], headers: [], body: { mode: "none" }, auth: { mode: "inherit" } },
			{ id: "request-get", method: "GET", urlTemplate: "{{base_url}}/orders/{{order_id}}", query: [], headers: [], body: { mode: "none" }, auth: { mode: "inherit" } },
			{
				id: "request-create",
				method: "POST",
				urlTemplate: "{{base_url}}/orders",
				query: [],
				headers: [row("X-Tenant", "{{tenant_id}}")],
				body: { mode: "none" },
				auth: { mode: "inherit" },
			},
		],
		...overrides,
	};
}

function environment(id, name, variables, ownerProfileId = "profile-1") {
	return { id, ownerProfileId, name, revision: 1, variables };
}

function localVariables() {
	return [
		plain("base_url", "http://127.0.0.1:8000/demo/v1/local"),
		secret("orders_token", "local_token"),
		plain("order_id", "ord_0002"),
		plain("tenant_id", "tenant-local"),
	];
}

function stagingVariables() {
	return [
		plain("base_url", "http://127.0.0.1:8000/demo/v1/staging"),
		secret("orders_token", "staging_token"),
		plain("order_id", "ord_0004"),
		plain("tenant_id", "tenant-staging"),
	];
}

const local = () => environment("env-local", "Local", localVariables());
const staging = () => environment("env-staging", "Staging", stagingVariables());

function categoryEntries(report, category) {
	return report.drift.filter((entry) => entry.category === category);
}

describe("environment drift — identical and canonicalization", () => {
	test("identical effective configuration produces zero drift", () => {
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: local() });
		expect(report.identical).toBe(true);
		expect(report.drift).toEqual([]);
		expect(report.summary.total).toBe(0);
		expect(report.summary.byCategory).toEqual({});
	});

	test("variable array order and ids are ordering noise, not drift", () => {
		const reordered = environment("env-local", "Local", [
			{ ...plain("tenant_id", "tenant-local"), id: "different-id" },
			{ ...plain("order_id", "ord_0002"), id: "another-id" },
			{ ...secret("orders_token", "local_token"), id: "third-id" },
			{ ...plain("base_url", "http://127.0.0.1:8000/demo/v1/local"), id: "fourth-id" },
		]);
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: reordered });
		expect(report.identical).toBe(true);
	});

	test("an environment override that yields the same effective value is not drift", () => {
		const collection = ordersCollection({ variables: [plain("base_url", "http://shared.example")] });
		const withoutOverride = environment("env-local", "Local", [secret("orders_token", "local_token"), plain("order_id", "ord_0002"), plain("tenant_id", "tenant-local")]);
		const withOverride = environment("env-local", "Local", [
			plain("base_url", "http://shared.example"),
			secret("orders_token", "local_token"),
			plain("order_id", "ord_0002"),
			plain("tenant_id", "tenant-local"),
		]);
		const report = analyzeEnvironmentDrift({ collection, sourceEnvironment: withoutOverride, targetEnvironment: withOverride });
		expect(report.identical).toBe(true);
	});

	test("output is deterministic across runs and input order", () => {
		const first = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: staging() });
		const second = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: staging() });
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first.drift.map((entry) => `${entry.category}:${entry.path}`)).toEqual([
			"ENVIRONMENT_SELECTION_CHANGED:environment.selection",
			"BASE_URL_CHANGED:variables.base_url",
			"VARIABLE_CHANGED:variables.order_id",
			"SECRET_REFERENCE_CHANGED:variables.orders_token",
			"HEADER_CONFIG_CHANGED:variables.tenant_id",
		]);
	});
});

describe("environment drift — variable categories", () => {
	test("changed plain variable is reported with its affected reference", () => {
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: staging() });
		const entry = categoryEntries(report, "VARIABLE_CHANGED").find((candidate) => candidate.path === "variables.order_id");
		expect(entry).toBeDefined();
		expect(entry.severity).toBe("medium");
		expect(entry.status).toBe("confirmed");
		expect(entry.sourceState).toEqual({ kind: "plain", value: "ord_0002" });
		expect(entry.targetState).toEqual({ kind: "plain", value: "ord_0004" });
		expect(entry.affectedReferenceIds).toEqual(["request-get"]);
	});

	test("added referenced variable is reported", () => {
		const source = environment("env-local", "Local", [plain("base_url", "http://dev"), secret("orders_token", "local_token"), plain("tenant_id", "t")]);
		const target = environment("env-local", "Local", [
			plain("base_url", "http://dev"),
			secret("orders_token", "local_token"),
			plain("tenant_id", "t"),
			plain("order_id", "ord_0002"),
		]);
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: source, targetEnvironment: target });
		const entry = categoryEntries(report, "VARIABLE_ADDED").find((candidate) => candidate.path === "variables.order_id");
		expect(entry).toBeDefined();
		expect(entry.severity).toBe("medium");
		expect(entry.sourceState).toBeNull();
		expect(entry.targetState).toEqual({ kind: "plain", value: "ord_0002" });
		expect(entry.affectedReferenceIds).toEqual(["request-get"]);
	});

	test("added unused variable is low severity", () => {
		const target = environment("env-local", "Local", [...localVariables(), plain("unused_flag", "on")]);
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: target });
		const entry = categoryEntries(report, "VARIABLE_ADDED").find((candidate) => candidate.path === "variables.unused_flag");
		expect(entry).toBeDefined();
		expect(entry.severity).toBe("low");
		expect(entry.affectedReferenceIds).toEqual([]);
	});

	test("referenced variable missing in the target is high severity", () => {
		const target = environment("env-local", "Local", localVariables().filter((variable) => variable.key !== "base_url"));
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: target });
		const entry = categoryEntries(report, "VARIABLE_MISSING").find((candidate) => candidate.path === "variables.base_url");
		expect(entry).toBeDefined();
		expect(entry.severity).toBe("high");
		expect(entry.status).toBe("confirmed");
		expect(entry.targetState).toBeNull();
		expect(entry.affectedReferenceIds).toEqual(["request-create", "request-get", "request-list"]);
	});

	test("removed unused variable is low severity", () => {
		const source = environment("env-local", "Local", [...localVariables(), plain("unused_flag", "on")]);
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: source, targetEnvironment: local() });
		const entry = categoryEntries(report, "VARIABLE_MISSING").find((candidate) => candidate.path === "variables.unused_flag");
		expect(entry).toBeDefined();
		expect(entry.severity).toBe("low");
	});

	test("unresolved reference is unknown and not claimed as breakage", () => {
		const disabled = environment(
			"env-local",
			"Local",
			localVariables().map((variable) => (variable.key === "base_url" ? { ...variable, enabled: false } : variable)),
		);
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: disabled });
		const entry = categoryEntries(report, "UNRESOLVED_REFERENCE").find((candidate) => candidate.path === "references.base_url");
		expect(entry).toBeDefined();
		expect(entry.severity).toBe("unknown");
		expect(entry.status).toBe("unknown");
		expect(entry.sourceState).toEqual({ resolved: true });
		expect(entry.targetState).toEqual({ resolved: false });
	});
});

describe("environment drift — specialized categories", () => {
	test("base URL change is high severity and lists every affected request", () => {
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: staging() });
		const entries = categoryEntries(report, "BASE_URL_CHANGED");
		expect(entries).toHaveLength(1);
		expect(entries[0].severity).toBe("high");
		expect(entries[0].affectedReferenceIds).toEqual(["request-create", "request-get", "request-list"]);
	});

	test("API version change is high severity", () => {
		const source = environment("env-local", "Local", [...localVariables(), plain("api_version", "v1")]);
		const target = environment("env-local", "Local", [...localVariables(), plain("api_version", "v2")]);
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: source, targetEnvironment: target });
		const entry = categoryEntries(report, "VERSION_CHANGED")[0];
		expect(entry).toBeDefined();
		expect(entry.path).toBe("variables.api_version");
		expect(entry.severity).toBe("high");
	});

	test("auth reference change is high severity and includes inheriting requests", () => {
		const collection = ordersCollection({ auth: { mode: "bearer", tokenTemplate: "{{api_token}}" } });
		const source = environment("env-local", "Local", [...localVariables(), plain("api_token", "token-a")]);
		const target = environment("env-local", "Local", [...localVariables(), plain("api_token", "token-b")]);
		const report = analyzeEnvironmentDrift({ collection, sourceEnvironment: source, targetEnvironment: target });
		const entry = categoryEntries(report, "AUTH_CONFIG_CHANGED")[0];
		expect(entry).toBeDefined();
		expect(entry.path).toBe("variables.api_token");
		expect(entry.severity).toBe("high");
		expect(entry.affectedReferenceIds).toEqual(["collection.auth", "request-create", "request-get", "request-list"]);
	});

	test("shared header difference is medium severity", () => {
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: staging() });
		const entry = categoryEntries(report, "HEADER_CONFIG_CHANGED")[0];
		expect(entry).toBeDefined();
		expect(entry.path).toBe("variables.tenant_id");
		expect(entry.severity).toBe("medium");
		expect(entry.affectedReferenceIds).toEqual(["request-create"]);
	});

	test("environment selection change is low severity", () => {
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: staging() });
		const entry = categoryEntries(report, "ENVIRONMENT_SELECTION_CHANGED")[0];
		expect(entry).toBeDefined();
		expect(entry.severity).toBe("low");
		expect(entry.sourceState).toEqual({ id: "env-local", name: "Local" });
		expect(entry.targetState).toEqual({ id: "env-staging", name: "Staging" });
	});

	test("all categories are within the declared closed set", () => {
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: staging() });
		for (const entry of report.drift) expect(DRIFT_CATEGORIES).toContain(entry.category);
	});
});

describe("environment drift — secret safety", () => {
	test("secret reference change reports only the alias and never a value", () => {
		const source = local();
		// A stray value on a secret reference must be dropped, never surfaced.
		const target = environment("env-staging", "Staging", [
			...stagingVariables().map((variable) => (variable.key === "orders_token" ? { ...variable, value: SEEDED_SECRET_VALUES[1] } : variable)),
		]);
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: source, targetEnvironment: target });
		const entry = categoryEntries(report, "SECRET_REFERENCE_CHANGED")[0];
		expect(entry).toBeDefined();
		expect(entry.severity).toBe("high");
		expect(entry.sourceState).toEqual({ kind: "secretRef", alias: "local_token" });
		expect(entry.targetState).toEqual({ kind: "secretRef", alias: "staging_token" });
		const serialized = JSON.stringify(report);
		for (const secretValue of SEEDED_SECRET_VALUES) expect(serialized).not.toContain(secretValue);
	});

	test("no drift payload ever contains a known seeded secret value", () => {
		const source = environment("env-local", "Local", [
			// Stray secret values attached to references and plain slots must not leak.
			...localVariables().map((variable) => (variable.key === "orders_token" ? { ...variable, value: SEEDED_SECRET_VALUES[0] } : variable)),
			plain("plain_echo", "harmless"),
		]);
		const target = environment("env-staging", "Staging", [
			...stagingVariables().map((variable) => (variable.key === "orders_token" ? { ...variable, value: SEEDED_SECRET_VALUES[1] } : variable)),
		]);
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: source, targetEnvironment: target });
		const serialized = JSON.stringify(report);
		for (const secretValue of SEEDED_SECRET_VALUES) expect(serialized).not.toContain(secretValue);
	});
});

describe("environment drift — deduplication", () => {
	test("a variable referenced in several places yields one entry with sorted unique ids", () => {
		const report = analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: staging() });
		const baseUrlEntries = categoryEntries(report, "BASE_URL_CHANGED");
		expect(baseUrlEntries).toHaveLength(1);
		expect(baseUrlEntries[0].affectedReferenceIds).toEqual(["request-create", "request-get", "request-list"]);
	});

	test("the same reference used twice in one request is deduplicated", () => {
		const collection = ordersCollection({
			requests: [
				{
					id: "request-list",
					method: "GET",
					urlTemplate: "{{base_url}}/orders?region={{base_url}}",
					query: [row("host", "{{base_url}}")],
					headers: [],
					body: { mode: "none" },
					auth: { mode: "none" },
				},
			],
		});
		const report = analyzeEnvironmentDrift({ collection, sourceEnvironment: local(), targetEnvironment: staging() });
		const entry = categoryEntries(report, "BASE_URL_CHANGED")[0];
		expect(entry.affectedReferenceIds).toEqual(["request-list"]);
	});
});

describe("environment drift — malformed and isolation", () => {
	test("malformed environment variables fail closed", () => {
		expect(() => adaptEnvironment({ variables: "not-an-array" }, "source")).toThrow(
			expect.objectContaining({ code: "ENVIRONMENT_DRIFT_MALFORMED" }),
		);
	});

	test("a secret reference without an alias fails closed", () => {
		expect(() => adaptEnvironment({ variables: [{ id: "v", key: "token", kind: "secretRef", enabled: true }] }, "source")).toThrow(
			expect.objectContaining({ code: "ENVIRONMENT_DRIFT_MALFORMED" }),
		);
	});

	test("duplicate variable names fail closed", () => {
		expect(() =>
			adaptEnvironment({ variables: [plain("base_url", "a"), plain("BASE_URL", "b")] }, "target"),
		).toThrow(expect.objectContaining({ code: "ENVIRONMENT_DRIFT_MALFORMED" }));
	});

	test("an unknown variable kind fails closed", () => {
		expect(() => adaptEnvironment({ variables: [{ id: "v", key: "x", kind: "computed", enabled: true }] }, "source")).toThrow(
			expect.objectContaining({ code: "ENVIRONMENT_DRIFT_MALFORMED" }),
		);
	});

	test("environments from different profiles cannot be compared", () => {
		const foreign = environment("env-staging", "Staging", stagingVariables(), "profile-2");
		expect(() =>
			analyzeEnvironmentDrift({ collection: ordersCollection(), sourceEnvironment: local(), targetEnvironment: foreign }),
		).toThrow(expect.objectContaining({ code: "ENVIRONMENT_DRIFT_PROFILE_MISMATCH" }));
	});

	test("a collection from a different profile cannot be compared", () => {
		const foreignCollection = ordersCollection({ ownerProfileId: "profile-9" });
		expect(() =>
			analyzeEnvironmentDrift({ collection: foreignCollection, sourceEnvironment: local(), targetEnvironment: staging() }),
		).toThrow(expect.objectContaining({ code: "ENVIRONMENT_DRIFT_PROFILE_MISMATCH" }));
	});

	test("null environments compare as an empty state without throwing", () => {
		const report = analyzeEnvironmentDrift({ collection: null, sourceEnvironment: null, targetEnvironment: null });
		expect(report.identical).toBe(true);
		expect(report.drift).toEqual([]);
	});
});
