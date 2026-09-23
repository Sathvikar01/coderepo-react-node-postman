import { describe, expect, test } from "bun:test";
import { AppError } from "../../../shared/errors/app-error.js";
import { verifyCounterfactual } from "./counterfactual.js";

const IDS = {
	mode: "11111111-1111-4111-8111-111111111111",
	trace: "22222222-2222-4222-8222-222222222222",
	tag1: "33333333-3333-4333-8333-333333333333",
	tag2: "44444444-4444-4444-8444-444444444444",
	key: "55555555-5555-4555-8555-555555555555",
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

function headerValue(source, key) {
	return source.headers?.find((item) => item.enabled !== false && item.key.toLowerCase() === key.toLowerCase())?.value;
}

function probeFrom(fails) {
	let call = 0;
	const requests = [];
	return {
		requests,
		async probe(source) {
			call += 1;
			requests.push(structuredClone(source));
			const failed = fails(source);
			return { executionId: `exec-${call}`, outcome: "response", response: { status: failed ? 500 : 200 }, scriptResults: null };
		},
	};
}

async function errorOf(promise) {
	try {
		await promise;
		return null;
	} catch (error) {
		return error;
	}
}

describe("counterfactual verification engine", () => {
	test("classifies a single genuinely causal header as causal with probe evidence", async () => {
		const base = request({ headers: [row(IDS.mode, "X-Mode", "ok")] });
		const candidate = request({ headers: [row(IDS.mode, "X-Mode", "fail")] });
		const { probe } = probeFrom((source) => headerValue(source, "X-Mode") === "fail");

		const result = await verifyCounterfactual({
			baseRequest: base,
			candidateRequest: candidate,
			predicate: { type: "status", equals: 500 },
			probe,
			baseExecutionId: "base-1",
			candidateExecutionId: "cand-1",
		});

		expect(result).toMatchObject({
			schemaVersion: 1,
			kind: "tracer.counterfactual-result",
			status: "completed",
			baseExecutionId: "base-1",
			candidateExecutionId: "cand-1",
			budgetExhausted: false,
		});
		expect(result.summary).toMatchObject({ total: 1, causal: 1, not_causal: 0, inconclusive: 0, not_replayable: 0 });
		expect(result.causalDeltaIds).toEqual([`header:${IDS.mode}`]);
		expect(result.baseline).toMatchObject({ stable: true, goodMatched: false, failingMatched: true });
		expect(result.probesUsed).toBe(4);

		const intervention = result.interventions[0];
		expect(intervention.classification).toBe("causal");
		expect(intervention.delta).toMatchObject({ id: `header:${IDS.mode}`, kind: "header", replayable: true });
		expect(intervention.evidence.applied).toMatchObject({ predicateMatched: true, status: 500 });
		expect(intervention.evidence.reverted).toMatchObject({ predicateMatched: false, status: 200 });
		expect(intervention.evidence.applied.probeExecutionId).toBe("exec-2");
		expect(intervention.evidence.reverted.probeExecutionId).toBe("exec-1");
	});

	test("classifies an unrelated header as not_causal while keeping the causal one", async () => {
		const base = request({ headers: [row(IDS.mode, "X-Mode", "ok"), row(IDS.trace, "X-Trace", "1")] });
		const candidate = request({ headers: [row(IDS.mode, "X-Mode", "fail"), row(IDS.trace, "X-Trace", "2")] });
		const { probe } = probeFrom((source) => headerValue(source, "X-Mode") === "fail");

		const result = await verifyCounterfactual({
			baseRequest: base,
			candidateRequest: candidate,
			predicate: { type: "status", equals: 500 },
			probe,
		});

		expect(result.summary).toMatchObject({ total: 2, causal: 1, not_causal: 1, inconclusive: 0, not_replayable: 0 });
		expect(result.interventions.map((entry) => [entry.delta.id, entry.classification])).toEqual([
			[`header:${IDS.mode}`, "causal"],
			[`header:${IDS.trace}`, "not_causal"],
		]);
	});

	test("selects exactly one causal delta among several material changes", async () => {
		const base = request({ headers: [row(IDS.mode, "X-Mode", "ok"), row(IDS.trace, "X-A", "1"), row(IDS.tag1, "X-B", "2")] });
		const candidate = request({ headers: [row(IDS.mode, "X-Mode", "fail"), row(IDS.trace, "X-A", "9"), row(IDS.tag1, "X-B", "8")] });
		const { probe } = probeFrom((source) => headerValue(source, "X-Mode") === "fail");

		const result = await verifyCounterfactual({ baseRequest: base, candidateRequest: candidate, predicate: { type: "status", equals: 500 }, probe });

		expect(result.summary).toMatchObject({ total: 3, causal: 1, not_causal: 2 });
		expect(result.causalDeltaIds).toEqual([`header:${IDS.mode}`]);
	});

	test("verifies a nested JSON body field as causal", async () => {
		const base = request({ body: { mode: "json", text: JSON.stringify({ profile: { tier: "gold" }, note: "a" }) } });
		const candidate = request({ body: { mode: "json", text: JSON.stringify({ profile: { tier: "blocked" }, note: "b" }) } });
		const { probe } = probeFrom((source) => {
			try {
				return JSON.parse(source.body.text).profile?.tier === "blocked";
			} catch {
				return false;
			}
		});

		const result = await verifyCounterfactual({ baseRequest: base, candidateRequest: candidate, predicate: { type: "status", equals: 500 }, probe });

		expect(result.summary).toMatchObject({ causal: 1, not_causal: 1 });
		expect(result.causalDeltaIds).toEqual(['body.json:["profile","tier"]']);
	});

	test("keeps duplicate query rows independently identifiable by id", async () => {
		const base = request({ query: [row(IDS.tag1, "tag", "a"), row(IDS.tag2, "tag", "b")] });
		const candidate = request({ query: [row(IDS.tag1, "tag", "c"), row(IDS.tag2, "tag", "b")] });
		const { probe } = probeFrom((source) => source.query.some((item) => item.key === "tag" && item.value === "c"));

		const result = await verifyCounterfactual({ baseRequest: base, candidateRequest: candidate, predicate: { type: "status", equals: 500 }, probe });

		expect(result.summary.total).toBe(1);
		expect(result.causalDeltaIds).toEqual([`query:${IDS.tag1}`]);
	});

	test("never replays auth or sensitive headers and never leaks their values", async () => {
		const secret = "Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789";
		const base = request({ headers: [row(IDS.mode, "X-Mode", "ok"), row(IDS.key, "X-Api-Key", "public")] });
		const candidate = request({
			headers: [row(IDS.mode, "X-Mode", "fail"), row(IDS.key, "X-Api-Key", secret)],
			auth: { mode: "bearer", tokenTemplate: secret },
		});
		const { probe } = probeFrom((source) => headerValue(source, "X-Mode") === "fail");

		const result = await verifyCounterfactual({ baseRequest: base, candidateRequest: candidate, predicate: { type: "status", equals: 500 }, probe });

		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("public");
		const notReplayable = result.interventions.filter((entry) => entry.classification === "not_replayable").map((entry) => entry.delta.id);
		expect(notReplayable).toEqual([`header:${IDS.key}`, "auth"]);
		expect(result.causalDeltaIds).toEqual([`header:${IDS.mode}`]);
	});

	test("fails closed as inconclusive when the failure is flaky across baseline probes", async () => {
		const base = request({ headers: [row(IDS.mode, "X-Mode", "ok")] });
		const candidate = request({ headers: [row(IDS.mode, "X-Mode", "fail")] });
		let call = 0;
		let candidateCalls = 0;
		const probe = async (source) => {
			call += 1;
			const isCandidate = headerValue(source, "X-Mode") === "fail";
			if (isCandidate) candidateCalls += 1;
			const failed = isCandidate && candidateCalls === 1;
			return { executionId: `exec-${call}`, outcome: "response", response: { status: failed ? 500 : 200 }, scriptResults: null };
		};

		const result = await verifyCounterfactual({ baseRequest: base, candidateRequest: candidate, predicate: { type: "status", equals: 500 }, probe });

		expect(result).toMatchObject({ status: "inconclusive", reason: "baseline_unstable" });
		expect(result.baseline.stable).toBe(false);
		expect(result.interventions.every((entry) => entry.classification === "inconclusive" && entry.reason === "baseline_unstable")).toBe(true);
	});

	test("refuses to attribute causality when the known-good execution also fails", async () => {
		const base = request({ headers: [row(IDS.mode, "X-Mode", "ok")] });
		const candidate = request({ headers: [row(IDS.mode, "X-Mode", "fail")] });
		const { probe } = probeFrom(() => true);

		const result = await verifyCounterfactual({ baseRequest: base, candidateRequest: candidate, predicate: { type: "status", equals: 500 }, probe });

		expect(result).toMatchObject({ status: "inconclusive", reason: "base_predicate_met" });
	});

	test("reports failure_not_reproduced when the candidate no longer fails", async () => {
		const base = request({ headers: [row(IDS.mode, "X-Mode", "ok")] });
		const candidate = request({ headers: [row(IDS.mode, "X-Mode", "fail")] });
		const { probe } = probeFrom(() => false);

		const result = await verifyCounterfactual({ baseRequest: base, candidateRequest: candidate, predicate: { type: "status", equals: 500 }, probe });

		expect(result).toMatchObject({ status: "inconclusive", reason: "failure_not_reproduced" });
	});

	test("stops at the hard probe budget and marks the remainder inconclusive", async () => {
		const base = request({ headers: [row(IDS.mode, "X-Mode", "ok"), row(IDS.trace, "X-Trace", "1")] });
		const candidate = request({ headers: [row(IDS.mode, "X-Mode", "fail"), row(IDS.trace, "X-Trace", "2")] });
		const { probe } = probeFrom((source) => headerValue(source, "X-Mode") === "fail");

		const result = await verifyCounterfactual({
			baseRequest: base,
			candidateRequest: candidate,
			predicate: { type: "status", equals: 500 },
			probe,
			maxProbes: 5,
		});

		expect(result).toMatchObject({ status: "budget_exhausted", budgetExhausted: true, probesUsed: 5 });
		expect(result.interventions.every((entry) => entry.classification === "inconclusive" && entry.reason === "probe_budget_exhausted")).toBe(true);
	});

	test("honours cancellation before the next probe", async () => {
		const base = request({ headers: [row(IDS.mode, "X-Mode", "ok")] });
		const candidate = request({ headers: [row(IDS.mode, "X-Mode", "fail")] });
		const controller = new AbortController();
		let call = 0;
		const probe = async () => {
			call += 1;
			if (call === 1) controller.abort();
			return { executionId: `exec-${call}`, outcome: "response", response: { status: 200 }, scriptResults: null };
		};

		const error = await errorOf(
			verifyCounterfactual({ baseRequest: base, candidateRequest: candidate, predicate: { type: "status", equals: 500 }, probe, signal: controller.signal }),
		);
		expect(error?.code).toBe("COUNTERFACTUAL_CANCELLED");
	});

	test("refuses to replay a method change when mutating probes are not approved", async () => {
		const base = request({ method: "GET" });
		const candidate = request({ method: "POST" });
		const { probe } = probeFrom((source) => source.method === "POST");

		const result = await verifyCounterfactual({
			baseRequest: base,
			candidateRequest: candidate,
			predicate: { type: "status", equals: 500 },
			probe,
			safety: { mutatingAllowed: false },
		});

		expect(result.summary).toMatchObject({ not_replayable: 1 });
		expect(result.interventions[0]).toMatchObject({ classification: "not_replayable", reason: "mutating_method_not_approved" });
	});

	test("propagates target-policy rejection instead of swallowing it", async () => {
		const base = request({ urlTemplate: "https://api.test/checkout" });
		const candidate = request({ urlTemplate: "https://blocked.test/checkout" });
		const probe = async (source) => {
			if (String(source.urlTemplate).includes("blocked.test")) throw new AppError(400, "TARGET_BLOCKED", "The target is not permitted.");
			return { executionId: "exec", outcome: "response", response: { status: 200 }, scriptResults: null };
		};

		const error = await errorOf(verifyCounterfactual({ baseRequest: base, candidateRequest: candidate, predicate: { type: "status", equals: 500 }, probe }));
		expect(error?.code).toBe("TARGET_BLOCKED");
	});

	test("produces byte-identical results for identical inputs and probe sequences", async () => {
		const base = request({ headers: [row(IDS.mode, "X-Mode", "ok"), row(IDS.trace, "X-Trace", "1")] });
		const candidate = request({ headers: [row(IDS.mode, "X-Mode", "fail"), row(IDS.trace, "X-Trace", "2")] });
		const fails = (source) => headerValue(source, "X-Mode") === "fail";

		const first = await verifyCounterfactual({ baseRequest: base, candidateRequest: candidate, predicate: { type: "status", equals: 500 }, probe: probeFrom(fails).probe });
		const second = await verifyCounterfactual({ baseRequest: base, candidateRequest: candidate, predicate: { type: "status", equals: 500 }, probe: probeFrom(fails).probe });

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first.interventions.map((entry) => entry.delta.id)).toEqual([`header:${IDS.mode}`, `header:${IDS.trace}`]);
	});
});
