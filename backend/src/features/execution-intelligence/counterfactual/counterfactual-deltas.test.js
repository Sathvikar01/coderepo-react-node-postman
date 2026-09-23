import { describe, expect, test } from "bun:test";
import { applyCounterfactualDelta, computeCounterfactualDeltas } from "./counterfactual-deltas.js";

const IDS = {
	row1: "11111111-1111-4111-8111-111111111111",
	row2: "22222222-2222-4222-8222-222222222222",
	row3: "33333333-3333-4333-8333-333333333333",
	request: "99999999-9999-4999-8999-999999999999",
};

function row(id, key, value, enabled = true) {
	return { id, key, value, enabled };
}

function request(overrides = {}) {
	return {
		schemaVersion: 1,
		id: IDS.request,
		folderId: null,
		name: "Checkout",
		method: "GET",
		urlTemplate: "https://api.test/checkout",
		query: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		scripts: { preRequest: "", test: "" },
		assertions: [],
		settings: { timeoutMs: 15000 },
		...overrides,
	};
}

function byId(deltas) {
	return Object.fromEntries(deltas.map((delta) => [delta.id, delta]));
}

describe("counterfactual delta compiler", () => {
	test("emits deltas in a fixed order with stable ids", () => {
		const base = request({
			method: "GET",
			urlTemplate: "https://api.test/a",
			query: [row(IDS.row1, "q", "1")],
			headers: [row(IDS.row2, "X-Trace", "a")],
			body: { mode: "json", text: '{"a":1}' },
			settings: { timeoutMs: 1000 },
			auth: { mode: "none" },
		});
		const candidate = request({
			method: "POST",
			urlTemplate: "https://api.test/b",
			query: [row(IDS.row1, "q", "2")],
			headers: [row(IDS.row2, "X-Trace", "b")],
			body: { mode: "json", text: '{"a":2}' },
			settings: { timeoutMs: 2000 },
			auth: { mode: "bearer", tokenTemplate: "{{token}}" },
		});

		const deltas = computeCounterfactualDeltas({ baseRequest: base, candidateRequest: candidate });
		expect(deltas.map((delta) => delta.kind)).toEqual(["method", "url", "query", "header", "body.json", "settings", "auth"]);
		expect(deltas.map((delta) => delta.id)).toEqual([
			"method",
			"url",
			`query:${IDS.row1}`,
			`header:${IDS.row2}`,
			'body.json:["a"]',
			"settings.timeoutMs",
			"auth",
		]);
	});

	test("marks non-secret header changes replayable and round-trips through apply/revert", () => {
		const base = request({ headers: [row(IDS.row1, "X-Mode", "ok")] });
		const candidate = request({ headers: [row(IDS.row1, "X-Mode", "fail")] });
		const [delta] = computeCounterfactualDeltas({ baseRequest: base, candidateRequest: candidate });

		expect(delta).toMatchObject({ id: `header:${IDS.row1}`, kind: "header", replayable: true, op: { type: "row" } });
		expect(applyCounterfactualDelta(base, delta, "after")).toEqual(candidate);
		expect(applyCounterfactualDelta(candidate, delta, "before")).toEqual(base);
	});

	test("refuses to replay sensitive header values and redacts their evidence", () => {
		const secret = "Bearer super-secret-token-value";
		const base = request({ headers: [row(IDS.row1, "Authorization", "Bearer public")] });
		const candidate = request({ headers: [row(IDS.row1, "Authorization", secret)] });
		const [delta] = computeCounterfactualDeltas({ baseRequest: base, candidateRequest: candidate });

		expect(delta.replayable).toBe(false);
		expect(delta.reason).toBe("sensitive_value_not_reconstructable");
		expect(delta.op).toBeNull();
		expect(JSON.stringify(delta)).not.toContain(secret);
		expect(JSON.stringify(delta)).not.toContain("public");
		expect(delta.displayAfter).toMatchObject({ value: "[REDACTED]" });
	});

	test("replays nested JSON fields and refuses sensitive JSON keys", () => {
		const base = request({ body: { mode: "json", text: JSON.stringify({ profile: { tier: "gold" }, password: "old" }) } });
		const candidate = request({ body: { mode: "json", text: JSON.stringify({ profile: { tier: "blocked" }, password: "new" }) } });
		const deltas = computeCounterfactualDeltas({ baseRequest: base, candidateRequest: candidate });
		const map = byId(deltas);

		const tier = map['body.json:["profile","tier"]'];
		expect(tier).toMatchObject({ kind: "body.json", replayable: true, path: "request.body.$.profile.tier" });
		expect(tier.op.path).toEqual(["profile", "tier"]);
		expect(applyCounterfactualDelta(base, tier, "after").body.text).toBe(
			JSON.stringify({ profile: { tier: "blocked" }, password: "old" }),
		);

		const password = map['body.json:["password"]'];
		expect(password.replayable).toBe(false);
		expect(password.reason).toBe("sensitive_value_not_reconstructable");
		expect(JSON.stringify(password)).not.toContain("old");
		expect(JSON.stringify(password)).not.toContain("new");
	});

	test("uses row ids as stable identity for duplicate query keys", () => {
		const base = request({
			query: [row(IDS.row1, "tag", "a"), row(IDS.row2, "tag", "b")],
		});
		const candidate = request({
			query: [row(IDS.row1, "tag", "c"), row(IDS.row2, "tag", "b")],
		});
		const deltas = computeCounterfactualDeltas({ baseRequest: base, candidateRequest: candidate });

		expect(deltas).toHaveLength(1);
		expect(deltas[0].id).toBe(`query:${IDS.row1}`);
		expect(deltas[0].before).toMatchObject({ id: IDS.row1, value: "a" });
		expect(deltas[0].after).toMatchObject({ id: IDS.row1, value: "c" });
	});

	test("treats a body mode change as a single non-replayable delta", () => {
		const base = request({ body: { mode: "none" } });
		const candidate = request({ body: { mode: "json", text: '{"a":1}' } });
		const deltas = computeCounterfactualDeltas({ baseRequest: base, candidateRequest: candidate });

		expect(deltas).toHaveLength(1);
		expect(deltas[0]).toMatchObject({ id: "body.mode", kind: "body.mode", replayable: false, reason: "body_mode_not_reconstructable" });
	});

	test("refuses URLs carrying sensitive query parameters", () => {
		const base = request({ urlTemplate: "https://api.test/a" });
		const candidate = request({ urlTemplate: "https://api.test/b?access_token=abc123" });
		const [delta] = computeCounterfactualDeltas({ baseRequest: base, candidateRequest: candidate });

		expect(delta).toMatchObject({ id: "url", kind: "url", replayable: false, reason: "sensitive_value_not_reconstructable" });
		expect(JSON.stringify(delta)).not.toContain("abc123");
	});

	test("does not replay auth, script, or assertion changes", () => {
		const base = request();
		const candidate = request({
			auth: { mode: "basic", usernameTemplate: "u", passwordTemplate: "{{pw}}" },
			scripts: { preRequest: "pm.x=1", test: "pm.test('a')" },
			assertions: [{ id: IDS.row3, name: "status", enabled: true, target: "status", operator: "equals", expected: "200" }],
		});
		const map = byId(computeCounterfactualDeltas({ baseRequest: base, candidateRequest: candidate }));

		expect(map.auth).toMatchObject({ replayable: false, reason: "authentication_not_reconstructable" });
		expect(map.scripts).toMatchObject({ replayable: false, reason: "scripts_not_reconstructable" });
		expect(map.assertions).toMatchObject({ replayable: false, reason: "assertions_not_reconstructable" });
	});

	test("surfaces environment, collection, and unexplained compiled differences from receipts", () => {
		const base = request();
		const candidate = request();
		const baseReceipt = {
			source: { environmentId: "env-a", environmentRevision: 1, collectionId: "col", collectionRevision: 1 },
			request: { compiledFingerprint: "fp-a" },
		};
		const candidateReceipt = {
			source: { environmentId: "env-b", environmentRevision: 2, collectionId: "col", collectionRevision: 1 },
			request: { compiledFingerprint: "fp-b" },
		};
		const map = byId(computeCounterfactualDeltas({ baseRequest: base, candidateRequest: candidate, baseReceipt, candidateReceipt }));

		expect(map.environment).toMatchObject({ replayable: false, reason: "environment_not_reconstructable" });
		expect(map.compiled).toMatchObject({ replayable: false, reason: "compiled_request_not_reconstructable" });
		expect(map.collection).toBeUndefined();
	});

	test("suppresses the compiled delta when a request delta already explains it", () => {
		const base = request({ headers: [row(IDS.row1, "X-Mode", "ok")] });
		const candidate = request({ headers: [row(IDS.row1, "X-Mode", "fail")] });
		const baseReceipt = { source: {}, request: { compiledFingerprint: "fp-a" } };
		const candidateReceipt = { source: {}, request: { compiledFingerprint: "fp-b" } };
		const map = byId(computeCounterfactualDeltas({ baseRequest: base, candidateRequest: candidate, baseReceipt, candidateReceipt }));

		expect(map.compiled).toBeUndefined();
		expect(map[`header:${IDS.row1}`].replayable).toBe(true);
	});
});
