import { describe, expect, test } from "bun:test";
import {
	ABORT_DECISIONS,
	ADMISSION_STATES,
	BLAST_RADIUS_ERROR_CODES,
	BlastRadiusError,
	REASON_CODES,
	REQUEST_CLASSIFICATIONS,
	classifyMethod,
	evaluateAbort,
	evaluateBlastRadius,
	normalizeHost,
} from "./index.js";

const WORKSPACE = "ws-1";
const ENVIRONMENT = "env-staging";

function baseInput(overrides = {}) {
	return {
		workspaceId: WORKSPACE,
		snapshotId: "snap-1",
		environmentId: ENVIRONMENT,
		policy: {},
		requests: [
			{ requestId: "req-1", method: "GET", host: { host: "api.example.test" } },
		],
		...overrides,
	};
}

function request(requestId, method, host = "api.example.test", port = undefined) {
	return { requestId, method, host: host === null ? null : { host, ...(port === undefined ? {} : { port }) } };
}

// ---------------------------------------------------------------------------
// 1-7. Method classification
// ---------------------------------------------------------------------------

describe("Phase 45A — method classification", () => {
	test("1. GET is NON_MUTATING", () => {
		expect(classifyMethod("GET")).toBe(REQUEST_CLASSIFICATIONS.NON_MUTATING);
	});

	test("2. HEAD is NON_MUTATING", () => {
		expect(classifyMethod("HEAD")).toBe(REQUEST_CLASSIFICATIONS.NON_MUTATING);
	});

	test("2b. OPTIONS is NON_MUTATING", () => {
		expect(classifyMethod("OPTIONS")).toBe(REQUEST_CLASSIFICATIONS.NON_MUTATING);
	});

	test("3. POST is MUTATING", () => {
		expect(classifyMethod("POST")).toBe(REQUEST_CLASSIFICATIONS.MUTATING);
	});

	test("4. PUT is MUTATING", () => {
		expect(classifyMethod("PUT")).toBe(REQUEST_CLASSIFICATIONS.MUTATING);
	});

	test("5. PATCH is MUTATING", () => {
		expect(classifyMethod("PATCH")).toBe(REQUEST_CLASSIFICATIONS.MUTATING);
	});

	test("6. DELETE is MUTATING", () => {
		expect(classifyMethod("DELETE")).toBe(REQUEST_CLASSIFICATIONS.MUTATING);
	});

	test("7. unknown/custom method is UNKNOWN", () => {
		for (const method of ["PROPFIND", "PURGE", "MKCOL", "FOO", "TRACE"]) {
			expect(classifyMethod(method)).toBe(REQUEST_CLASSIFICATIONS.UNKNOWN);
		}
	});

	test("adversarial: malformed methods are UNKNOWN, never NON_MUTATING", () => {
		for (const method of ["", "  ", "G ET", "GET\t", "\tGET", " GET", "GET ", null, undefined, 42, {}, [], "get post"]) {
			expect(classifyMethod(method)).toBe(REQUEST_CLASSIFICATIONS.UNKNOWN);
		}
	});

	test("adversarial: a padded method token can never be admitted as non-mutating", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowedMethods: ["GET", "HEAD"] },
				requests: [request("r1", "GET\t"), request("r2", "\tGET")],
			}),
		);
		expect(envelope.requests.admitted).toBe(0);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.BLOCKED);
		expect(envelope.allowedRequests[0].reasonCodes).toEqual([REASON_CODES.METHOD_NOT_ALLOWED]);
		expect(envelope.allowedRequests[1].reasonCodes).toEqual([REASON_CODES.METHOD_NOT_ALLOWED]);
	});

	test("method casing is normalized for classification", () => {
		expect(classifyMethod("get")).toBe(REQUEST_CLASSIFICATIONS.NON_MUTATING);
		expect(classifyMethod("Get")).toBe(REQUEST_CLASSIFICATIONS.NON_MUTATING);
		expect(classifyMethod("Post")).toBe(REQUEST_CLASSIFICATIONS.MUTATING);
		// Padded tokens are malformed and stay malformed; they are never trimmed
		// into an admissible method.
		expect(classifyMethod("  Post  ")).toBe(REQUEST_CLASSIFICATIONS.UNKNOWN);
	});
});

// ---------------------------------------------------------------------------
// 8-13. Environment / host / method admission
// ---------------------------------------------------------------------------

describe("Phase 45A — environment, host and method allowlists", () => {
	test("8. allowed environment is admitted", () => {
		const envelope = evaluateBlastRadius(
			baseInput({ policy: { allowedEnvironmentIds: [ENVIRONMENT, "env-other"] } }),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.ADMITTED);
		expect(envelope.reasonCodes).toEqual([]);
	});

	test("9. blocked environment blocks every request", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowedEnvironmentIds: ["env-prod"] },
				requests: [request("req-1", "GET"), request("req-2", "POST")],
			}),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.BLOCKED);
		expect(envelope.reasonCodes).toEqual([REASON_CODES.ENVIRONMENT_NOT_ALLOWED]);
		expect(envelope.requests.blocked).toBe(2);
		expect(envelope.requests.admitted).toBe(0);
		expect(envelope.violations).toEqual([
			{
				reasonCode: REASON_CODES.ENVIRONMENT_NOT_ALLOWED,
				count: 2,
				requestIds: ["req-1", "req-2"],
			},
		]);
	});

	test("9b. blocked environment also blocks an otherwise-admissible mutating request", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowedEnvironmentIds: ["env-prod"], allowMutating: true },
				requests: [request("req-post", "POST")],
			}),
		);
		expect(envelope.allowedRequests[0].admission).toBe(ADMISSION_STATES.BLOCKED);
		expect(envelope.allowedRequests[0].reasonCodes).toEqual([REASON_CODES.ENVIRONMENT_NOT_ALLOWED]);
	});

	test("10. allowed host is admitted", () => {
		const envelope = evaluateBlastRadius(
			baseInput({ policy: { allowedHosts: ["api.example.test", "other.test"] } }),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.ADMITTED);
	});

	test("10b. host allowlist matching is case- and root-dot-insensitive", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowedHosts: ["API.Example.Test."] },
				requests: [request("req-1", "GET", "api.example.test")],
			}),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.ADMITTED);
	});

	test("11. blocked host is BLOCKED with HOST_NOT_ALLOWED", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowedHosts: ["api.example.test"] },
				requests: [request("req-1", "GET", "evil.example.test")],
			}),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.BLOCKED);
		expect(envelope.reasonCodes).toEqual([REASON_CODES.HOST_NOT_ALLOWED]);
	});

	test("12. unknown host with a configured allowlist is not admitted", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowedHosts: ["api.example.test"] },
				requests: [request("req-1", "GET", null)],
			}),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.UNKNOWN);
		expect(envelope.reasonCodes).toEqual([REASON_CODES.UNKNOWN_HOST]);
		expect(envelope.admittedCount ?? envelope.requests.admitted).toBe(0);
	});

	test("12b. unknown host without an allowlist is UNKNOWN, never ADMITTED", () => {
		const envelope = evaluateBlastRadius(baseInput({ requests: [request("req-1", "GET", null)] }));
		expect(envelope.admissionState).toBe(ADMISSION_STATES.UNKNOWN);
		expect(envelope.requests.admitted).toBe(0);
		expect(envelope.reasonCodes).toEqual([REASON_CODES.UNKNOWN_HOST]);
	});

	test("adversarial: malformed host values are UNKNOWN", () => {
		for (const bad of ["", " ", "exa mple.test", "http://api.example.test", "api..example.test", "-bad.test", "bad-.test", "a".repeat(64) + ".test", null, 7, {}, [], "api.example.test/path", "api.example.test:8080"]) {
			const envelope = evaluateBlastRadius(
				baseInput({ policy: { allowedHosts: ["api.example.test"] }, requests: [request("req-1", "GET", bad)] }),
			);
			expect(envelope.admissionState).toBe(ADMISSION_STATES.UNKNOWN);
			expect(envelope.reasonCodes).toEqual([REASON_CODES.UNKNOWN_HOST]);
		}
	});

	test("12c. normalizeHost strips root dot and lowercases", () => {
		expect(normalizeHost("API.Example.Test.")).toBe("api.example.test");
		expect(normalizeHost("localhost")).toBe("localhost");
		expect(normalizeHost("http://x")).toBe("");
	});

	test("13. method allowlist admits listed and blocks unlisted", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowedMethods: ["GET", "HEAD"] },
				requests: [request("req-get", "GET"), request("req-post", "POST")],
			}),
		);
		expect(envelope.allowedRequests[0].admission).toBe(ADMISSION_STATES.ADMITTED);
		expect(envelope.allowedRequests[1].admission).toBe(ADMISSION_STATES.BLOCKED);
		expect(envelope.allowedRequests[1].reasonCodes).toEqual([REASON_CODES.METHOD_NOT_ALLOWED]);
	});

	test("13b. method allowlist is case-insensitive and de-duplicated", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowedMethods: ["get", "GET", "Get"] },
				requests: [request("req-1", "get")],
			}),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.ADMITTED);
	});
});

// ---------------------------------------------------------------------------
// 14-15. Mutating policy
// ---------------------------------------------------------------------------

describe("Phase 45A — mutating policy", () => {
	test("14. mutating disabled blocks mutating requests but admits reads", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowMutating: false },
				requests: [request("req-get", "GET"), request("req-post", "POST")],
			}),
		);
		expect(envelope.allowedRequests[0].admission).toBe(ADMISSION_STATES.ADMITTED);
		expect(envelope.allowedRequests[1].admission).toBe(ADMISSION_STATES.BLOCKED);
		expect(envelope.allowedRequests[1].reasonCodes).toEqual([REASON_CODES.MUTATING_REQUEST_NOT_ALLOWED]);
	});

	test("14b. mutating permitted explicitly admits a mutating request", () => {
		const envelope = evaluateBlastRadius(
			baseInput({ policy: { allowMutating: true }, requests: [request("req-post", "POST")] }),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.ADMITTED);
	});

	test("14c. missing allowMutating must not imply disabled", () => {
		const envelope = evaluateBlastRadius(baseInput({ requests: [request("req-post", "POST")] }));
		expect(envelope.admissionState).toBe(ADMISSION_STATES.ADMITTED);
		expect(envelope.effectiveLimits.allowMutating).toEqual({ configured: false, value: null });
	});

	test("15. mutating confirmation required yields REQUIRES_CONFIRMATION", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowMutating: true, requireMutatingConfirmation: true },
				requests: [request("req-get", "GET"), request("req-post", "POST")],
			}),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.REQUIRES_CONFIRMATION);
		expect(envelope.allowedRequests[0].admission).toBe(ADMISSION_STATES.ADMITTED);
		expect(envelope.allowedRequests[1].admission).toBe(ADMISSION_STATES.REQUIRES_CONFIRMATION);
		expect(envelope.allowedRequests[1].reasonCodes).toEqual([REASON_CODES.MUTATING_CONFIRMATION_REQUIRED]);
		expect(envelope.confirmations).toEqual([
			{
				reasonCode: REASON_CODES.MUTATING_CONFIRMATION_REQUIRED,
				count: 1,
				requestIds: ["req-post"],
			},
		]);
	});

	test("15b. non-mutating requests never require confirmation", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { requireMutatingConfirmation: true },
				requests: [request("req-head", "HEAD")],
			}),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.ADMITTED);
	});
});

// ---------------------------------------------------------------------------
// 16-20. Limits and tri-state semantics
// ---------------------------------------------------------------------------

describe("Phase 45A — limit semantics", () => {
	test("16. total request limit truncates admission deterministically", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { maxTotalRequests: 2 },
				requests: [request("r1", "GET"), request("r2", "GET"), request("r3", "GET")],
			}),
		);
		expect(envelope.requests.admitted).toBe(2);
		expect(envelope.requests.blocked).toBe(1);
		expect(envelope.allowedRequests[2].reasonCodes).toEqual([REASON_CODES.REQUEST_LIMIT_EXCEEDED]);
	});

	test("17. mutating request limit counts only mutating requests", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowMutating: true, maxMutatingRequests: 1, maxTotalRequests: 10 },
				requests: [request("r1", "GET"), request("r2", "POST"), request("r3", "PUT")],
			}),
		);
		expect(envelope.allowedRequests[0].admission).toBe(ADMISSION_STATES.ADMITTED);
		expect(envelope.allowedRequests[1].admission).toBe(ADMISSION_STATES.ADMITTED);
		expect(envelope.allowedRequests[2].admission).toBe(ADMISSION_STATES.BLOCKED);
		expect(envelope.allowedRequests[2].reasonCodes).toEqual([REASON_CODES.MUTATING_LIMIT_EXCEEDED]);
	});

	test("18. per-host request limit applies per normalized host", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { maxRequestsPerHost: 1, maxTotalRequests: 10 },
				requests: [
					request("r1", "GET", "a.example.test"),
					request("r2", "GET", "a.example.test"),
					request("r3", "GET", "b.example.test"),
				],
			}),
		);
		expect(envelope.requests.admitted).toBe(2);
		expect(envelope.allowedRequests[1].reasonCodes).toEqual([REASON_CODES.HOST_REQUEST_LIMIT_EXCEEDED]);
		expect(envelope.hostSummary).toEqual([
			{ hostKey: "a.example.test", host: "a.example.test", port: null, proposed: 2, admitted: 1, blocked: 1, unknown: 0, requiresConfirmation: 0, mutating: 0, nonMutating: 2 },
			{ hostKey: "b.example.test", host: "b.example.test", port: null, proposed: 1, admitted: 1, blocked: 0, unknown: 0, requiresConfirmation: 0, mutating: 0, nonMutating: 1 },
		]);
	});

	test("18b. distinct ports on one host are distinct host identities", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { maxRequestsPerHost: 1, maxTotalRequests: 10 },
				requests: [
					request("r1", "GET", "a.example.test", 8443),
					request("r2", "GET", "a.example.test", 9443),
				],
			}),
		);
		expect(envelope.requests.admitted).toBe(2);
		expect(envelope.hostSummary.map((host) => host.hostKey)).toEqual([
			"a.example.test:8443",
			"a.example.test:9443",
		]);
	});

	test("19. zero-limit semantics: configured zero blocks everything", () => {
		const envelope = evaluateBlastRadius(
			baseInput({ policy: { maxTotalRequests: 0 }, requests: [request("r1", "GET")] }),
		);
		expect(envelope.requests.admitted).toBe(0);
		expect(envelope.requests.blocked).toBe(1);
		expect(envelope.effectiveLimits.maxTotalRequests).toEqual({ configured: true, value: 0 });
		expect(envelope.allowedRequests[0].reasonCodes).toEqual([REASON_CODES.REQUEST_LIMIT_EXCEEDED]);
	});

	test("19b. zero mutating limit blocks mutation even when reads pass", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowMutating: true, maxMutatingRequests: 0, maxTotalRequests: 10 },
				requests: [request("r1", "GET"), request("r2", "POST")],
			}),
		);
		expect(envelope.requests.admitted).toBe(1);
		expect(envelope.allowedRequests[1].reasonCodes).toEqual([REASON_CODES.MUTATING_LIMIT_EXCEEDED]);
	});

	test("20. missing-limit semantics: absent limits are not configured and not applied", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				requests: Array.from({ length: 25 }, (_, index) => request(`r${index}`, "GET", `h${index}.example.test`)),
			}),
		);
		expect(envelope.requests.admitted).toBe(25);
		expect(envelope.effectiveLimits.maxTotalRequests).toEqual({ configured: false, value: null });
		expect(envelope.effectiveLimits.maxMutatingRequests).toEqual({ configured: false, value: null });
		expect(envelope.effectiveLimits.maxRequestsPerHost).toEqual({ configured: false, value: null });
	});

	test("20b. not-configured is distinguishable from configured-zero", () => {
		const absent = evaluateBlastRadius(baseInput());
		const zero = evaluateBlastRadius(baseInput({ policy: { maxRequestsPerHost: 0 } }));
		expect(absent.effectiveLimits.maxRequestsPerHost).toEqual({ configured: false, value: null });
		expect(zero.effectiveLimits.maxRequestsPerHost).toEqual({ configured: true, value: 0 });
	});
});

// ---------------------------------------------------------------------------
// 21-24. Fail-closed behavior
// ---------------------------------------------------------------------------

describe("Phase 45A — fail closed", () => {
	test("21. duplicate request IDs are a typed error and never double-count", () => {
		expect(() =>
			evaluateBlastRadius(
				baseInput({
					policy: { maxTotalRequests: 5 },
					requests: [request("dup", "GET"), request("dup", "GET")],
				}),
			),
		).toThrow(BlastRadiusError);

		try {
			evaluateBlastRadius(baseInput({ requests: [request("dup", "GET"), request("dup", "GET")] }));
			throw new Error("expected throw");
		} catch (error) {
			expect(error.code).toBe(BLAST_RADIUS_ERROR_CODES.DUPLICATE_REQUEST_ID);
			expect(error.details.duplicateIndex).toBe(1);
		}
	});

	test("23. malformed policy is a typed error", () => {
		for (const policy of [
			{ maxTotalRequests: -1 },
			{ maxTotalRequests: 1.5 },
			{ maxTotalRequests: "3" },
			{ allowedMethods: "GET" },
			{ allowedHosts: 5 },
			{ allowMutating: "yes" },
			{ maxFailures: null },
		]) {
			expect(() => evaluateBlastRadius(baseInput({ policy }))).toThrow(BlastRadiusError);
		}
	});

	test("23b. malformed top-level input is a typed error", () => {
		for (const input of [null, undefined, {}, { requests: [] }, { workspaceId: "w", environmentId: "e" }, { workspaceId: "w", environmentId: "e", requests: "nope" }]) {
			expect(() => evaluateBlastRadius(input)).toThrow(BlastRadiusError);
		}
	});

	test("23c. missing required identity is a typed error", () => {
		expect(() => evaluateBlastRadius(baseInput({ requests: [{ method: "GET", host: { host: "a.test" } }] }))).toThrow(
			BlastRadiusError,
		);
	});

	test("24. contradictory limits are a typed error", () => {
		const cases = [
			{ maxMutatingRequests: 5, maxTotalRequests: 2 },
			{ maxRequestsPerHost: 5, maxTotalRequests: 2 },
			{ maxConsecutiveFailures: 5, maxFailures: 2 },
			{ maxFailures: 0, stopOnCriticalFailure: true },
		];
		for (const policy of cases) {
			try {
				evaluateBlastRadius(baseInput({ policy }));
				throw new Error("expected throw");
			} catch (error) {
				expect(error.code).toBe(BLAST_RADIUS_ERROR_CODES.CONTRADICTORY_LIMITS);
			}
		}
	});

	test("24b. non-contradictory equal limits are accepted", () => {
		const envelope = evaluateBlastRadius(
			baseInput({ policy: { allowMutating: true, maxMutatingRequests: 2, maxTotalRequests: 2 } }),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.ADMITTED);
	});
});

// ---------------------------------------------------------------------------
// 29, 30, 31, 32. Invariants, minimization, purity, determinism
// ---------------------------------------------------------------------------

describe("Phase 45A — invariants and determinism", () => {
	test("29. UNKNOWN never becomes ADMITTED", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowedHosts: ["api.example.test"], allowedMethods: ["GET"] },
				requests: [request("r1", "CUSTOMVERB")],
			}),
		);
		expect(envelope.admissionState).toBe(ADMISSION_STATES.BLOCKED);
		expect(envelope.allowedRequests[0].admission).not.toBe(ADMISSION_STATES.ADMITTED);
	});

	test("29b. unknown method with no allowlist is BLOCKED with UNKNOWN_METHOD", () => {
		const envelope = evaluateBlastRadius(baseInput({ requests: [request("r1", "PROPFIND")] }));
		expect(envelope.admissionState).toBe(ADMISSION_STATES.BLOCKED);
		expect(envelope.reasonCodes).toEqual([REASON_CODES.UNKNOWN_METHOD]);
		expect(envelope.allowedRequests[0].reasonCodes).toEqual([REASON_CODES.UNKNOWN_METHOD]);
	});

	test("29c. an UNKNOWN set-level state never presents as ADMITTED", () => {
		const envelope = evaluateBlastRadius(baseInput({ requests: [request("r1", "GET", null)] }));
		expect(envelope.admissionState).toBe(ADMISSION_STATES.UNKNOWN);
		expect(envelope.allowedRequests[0].admission).toBe(ADMISSION_STATES.UNKNOWN);
	});

	test("30. known seeded secret strings never appear in serialized output", () => {
		const SECRETS = [
			"phase45-secret-bearer-9f2a",
			"phase45-secret-cookie-4c1e",
			"phase45-secret-apikey-77bd",
			"phase45-secret-body-1de9",
		];
		const serializedInput = {
			workspaceId: WORKSPACE,
			snapshotId: "snap-1",
			environmentId: ENVIRONMENT,
			policy: { allowedHosts: ["api.example.test"] },
			// Adversarial: payload-shaped fields smuggled into the input must never
			// reach the output. The schema is passthrough, so this proves the
			// service projects only identity, never payload.
			requests: [
				{
					requestId: "r1",
					method: "POST",
					host: { host: "api.example.test", token: SECRETS[0] },
					headers: [{ name: "Authorization", value: `Bearer ${SECRETS[0]}` }],
					cookies: [{ name: "session", value: SECRETS[1] }],
					auth: { mode: "apiKey", value: SECRETS[2] },
					body: { mode: "json", text: JSON.stringify({ password: SECRETS[3] }) },
					url: `https://api.example.test/orders?api_key=${SECRETS[2]}`,
					secretRef: { alias: "prod_token", resolved: SECRETS[0] },
				},
			],
		};

		const envelope = evaluateBlastRadius(serializedInput);
		const serialized = JSON.stringify(envelope);
		for (const secret of SECRETS) {
			expect(serialized.includes(secret)).toBe(false);
		}
		// Payload-shaped keys must not survive projection either.
		for (const forbidden of ["headers", "cookies", "auth", "body", "url", "secretRef", "token"]) {
			expect(Object.prototype.hasOwnProperty.call(envelope.allowedRequests[0], forbidden)).toBe(false);
		}
	});

	test("30b. envelope exposes only the documented execution-entry fields", () => {
		const envelope = evaluateBlastRadius(baseInput({ requests: [request("r1", "POST", "api.example.test", 8443)] }));
		expect(Object.keys(envelope.allowedRequests[0]).sort()).toEqual(
			["admission", "classification", "host", "hostKey", "method", "mutating", "port", "reasonCodes", "requestId"].sort(),
		);
	});

	test("31. inputs are never mutated", () => {
		const input = baseInput({
			policy: { allowedHosts: ["API.Example.Test"], allowedMethods: ["get"], maxTotalRequests: 5 },
			requests: [request("r1", "get", "API.Example.Test"), request("r2", "POST")],
		});
		const snapshot = JSON.stringify(input);
		evaluateBlastRadius(input);
		expect(JSON.stringify(input)).toBe(snapshot);

		const policy = { allowedHosts: ["API.Example.Test"] };
		const policySnapshot = JSON.stringify(policy);
		evaluateBlastRadius(baseInput({ policy }));
		expect(JSON.stringify(policy)).toBe(policySnapshot);
	});

	test("32. repeated invocation is byte-identical", () => {
		const input = baseInput({
			policy: {
				allowedEnvironmentIds: [ENVIRONMENT],
				allowedHosts: ["b.example.test", "a.example.test"],
				allowedMethods: ["POST", "GET"],
				allowMutating: true,
				requireMutatingConfirmation: true,
				maxTotalRequests: 5,
				maxMutatingRequests: 3,
				maxRequestsPerHost: 2,
				maxFailures: 2,
				maxConsecutiveFailures: 1,
				stopOnCriticalFailure: true,
			},
			requests: [
				request("r1", "GET", "b.example.test"),
				request("r2", "POST", "a.example.test"),
				request("r3", "DELETE", "a.example.test"),
				request("r4", "GET", "c.example.test", null),
			],
		});
		const first = JSON.stringify(evaluateBlastRadius(input));
		const second = JSON.stringify(evaluateBlastRadius(input));
		const third = JSON.stringify(evaluateBlastRadius(structuredClone(input)));
		expect(first).toBe(second);
		expect(first).toBe(third);
	});

	test("22. deterministic ordering: irrelevant input ordering changes nothing stable", () => {
		const requestsInOrder = [
			request("r1", "GET", "a.example.test"),
			request("r2", "GET", "b.example.test"),
		];
		const forward = evaluateBlastRadius(baseInput({ policy: { allowedHosts: ["b.example.test", "a.example.test"] }, requests: requestsInOrder }));
		const reversedAllowlist = evaluateBlastRadius(
			baseInput({ policy: { allowedHosts: ["a.example.test", "b.example.test"] }, requests: requestsInOrder }),
		);
		expect(forward.policy.identity).toBe(reversedAllowlist.policy.identity);
		expect(JSON.stringify(forward)).toBe(JSON.stringify(reversedAllowlist));

		// Identical requests in a different declared order keep their declared
		// ordinal (execution order is semantically supplied) but the allowlist and
		// host summary are order-independent.
		const swapped = evaluateBlastRadius(
			baseInput({ policy: { allowedHosts: ["a.example.test", "b.example.test"] }, requests: [...requestsInOrder].reverse() }),
		);
		expect(swapped.policy.identity).toBe(forward.policy.identity);
		expect(swapped.hostSummary).toEqual(forward.hostSummary);
		expect(swapped.requests).toEqual(forward.requests);
	});

	test("22b. policy identity is stable across equivalent policies and differs for different ones", () => {
		const base = evaluateBlastRadius(baseInput({ policy: { allowedMethods: ["GET", "POST"], maxTotalRequests: 3 } }));
		const reordered = evaluateBlastRadius(
			baseInput({ policy: { allowedMethods: ["POST", "GET"], maxTotalRequests: 3 } }),
		);
		const different = evaluateBlastRadius(baseInput({ policy: { allowedMethods: ["GET", "POST"], maxTotalRequests: 4 } }));
		expect(base.policy.identity).toBe(reordered.policy.identity);
		expect(base.policy.identity).not.toBe(different.policy.identity);
	});

	test("execution ordering dependency hints are preserved only when supplied", () => {
		const withDeps = evaluateBlastRadius(
			baseInput({
				requests: [
					{ requestId: "r1", method: "GET", host: { host: "a.example.test" } },
					{ requestId: "r2", method: "GET", host: { host: "a.example.test" }, dependsOn: ["r1", "r1"] },
				],
			}),
		);
		expect(withDeps.allowedRequests.map((entry) => entry.requestId)).toEqual(["r1", "r2"]);
		// Depending on r1 does not change admission here (no invented ordering rule).
		expect(withDeps.requests.admitted).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 25-28. Abort evaluator
// ---------------------------------------------------------------------------

function envelopeWithLimits(limits) {
	return evaluateBlastRadius(
		baseInput({
			policy: {
				allowMutating: true,
				...limits,
			},
			requests: [request("r1", "GET")],
		}),
	);
}

describe("Phase 45A — abort evaluator", () => {
	test("25. failure count reaching configured max aborts", () => {
		const envelope = envelopeWithLimits({ maxFailures: 2 });
		const result = evaluateAbort({
			envelope,
			progress: { totalCompleted: 2, failureCount: 2, consecutiveFailureCount: 1, latestResultClassification: "failure" },
		});
		expect(result.decision).toBe(ABORT_DECISIONS.ABORT);
		expect(result.reasonCodes).toEqual([REASON_CODES.FAILURE_LIMIT_REACHED]);
	});

	test("26. consecutive failure count reaching configured max aborts", () => {
		const envelope = envelopeWithLimits({ maxFailures: 10, maxConsecutiveFailures: 2 });
		const result = evaluateAbort({
			envelope,
			progress: { totalCompleted: 3, failureCount: 2, consecutiveFailureCount: 2, latestResultClassification: "failure" },
		});
		expect(result.decision).toBe(ABORT_DECISIONS.ABORT);
		expect(result.reasonCodes).toEqual([REASON_CODES.CONSECUTIVE_FAILURE_LIMIT_REACHED]);
	});

	test("27. critical failure with stop-on-critical aborts", () => {
		const envelope = envelopeWithLimits({ maxFailures: 10, stopOnCriticalFailure: true });
		const result = evaluateAbort({
			envelope,
			progress: {
				totalCompleted: 1,
				failureCount: 1,
				consecutiveFailureCount: 1,
				latestResultClassification: "error",
				latestResultCritical: true,
			},
		});
		expect(result.decision).toBe(ABORT_DECISIONS.ABORT);
		expect(result.reasonCodes).toContain(REASON_CODES.CRITICAL_FAILURE);
	});

	test("27b. critical failure without stop-on-critical does not abort", () => {
		const envelope = envelopeWithLimits({ maxFailures: 10 });
		const result = evaluateAbort({
			envelope,
			progress: {
				totalCompleted: 1,
				failureCount: 1,
				consecutiveFailureCount: 1,
				latestResultClassification: "error",
				latestResultCritical: true,
			},
		});
		expect(result.decision).toBe(ABORT_DECISIONS.CONTINUE);
		expect(result.reasonCodes).toEqual([]);
	});

	test("28. thresholds not reached continues", () => {
		const envelope = envelopeWithLimits({ maxFailures: 5, maxConsecutiveFailures: 3, stopOnCriticalFailure: true });
		const result = evaluateAbort({
			envelope,
			progress: { totalCompleted: 4, failureCount: 1, consecutiveFailureCount: 0, latestResultClassification: "success" },
		});
		expect(result.decision).toBe(ABORT_DECISIONS.CONTINUE);
		expect(result.reasonCodes).toEqual([]);
	});

	test("28b. unconfigured limits never abort", () => {
		const envelope = evaluateBlastRadius(baseInput({ requests: [request("r1", "GET")] }));
		const result = evaluateAbort({
			envelope,
			progress: {
				totalCompleted: 99,
				failureCount: 99,
				consecutiveFailureCount: 99,
				latestResultClassification: "error",
				latestResultCritical: true,
			},
		});
		expect(result.decision).toBe(ABORT_DECISIONS.CONTINUE);
	});

	test("28c. multiple abort conditions are reported sorted and unique", () => {
		const envelope = envelopeWithLimits({ maxFailures: 1, maxConsecutiveFailures: 1, stopOnCriticalFailure: true });
		const result = evaluateAbort({
			envelope,
			progress: {
				totalCompleted: 1,
				failureCount: 1,
				consecutiveFailureCount: 1,
				latestResultClassification: "failure",
				latestResultCritical: true,
			},
		});
		expect(result.decision).toBe(ABORT_DECISIONS.ABORT);
		expect(result.reasonCodes).toEqual([
			REASON_CODES.CONSECUTIVE_FAILURE_LIMIT_REACHED,
			REASON_CODES.CRITICAL_FAILURE,
			REASON_CODES.FAILURE_LIMIT_REACHED,
		]);
	});

	test("28d. zero maxFailures aborts immediately on the first failure count", () => {
		const envelope = evaluateBlastRadius(
			baseInput({ policy: { maxFailures: 0, maxTotalRequests: 5 }, requests: [request("r1", "GET")] }),
		);
		const result = evaluateAbort({
			envelope,
			progress: { totalCompleted: 1, failureCount: 0, consecutiveFailureCount: 0, latestResultClassification: "success" },
		});
		// 0 >= 0, so the configured-zero failure budget immediately aborts.
		expect(result.decision).toBe(ABORT_DECISIONS.ABORT);
		expect(result.reasonCodes).toEqual([REASON_CODES.FAILURE_LIMIT_REACHED]);
	});

	test("abort evaluator is pure and byte-stable", () => {
		const envelope = envelopeWithLimits({ maxFailures: 2 });
		const progress = { totalCompleted: 2, failureCount: 2, consecutiveFailureCount: 2, latestResultClassification: "failure" };
		const envelopeSnapshot = JSON.stringify(envelope);
		const progressSnapshot = JSON.stringify(progress);
		const first = JSON.stringify(evaluateAbort({ envelope, progress }));
		const second = JSON.stringify(evaluateAbort({ envelope, progress }));
		expect(first).toBe(second);
		expect(JSON.stringify(envelope)).toBe(envelopeSnapshot);
		expect(JSON.stringify(progress)).toBe(progressSnapshot);
	});

	test("abort evaluator fails closed on malformed progress", () => {
		const envelope = envelopeWithLimits({ maxFailures: 2 });
		const bad = [
			null,
			undefined,
			{},
			{ totalCompleted: -1, failureCount: 0, consecutiveFailureCount: 0, latestResultClassification: "success" },
			{ totalCompleted: 1, failureCount: 2, consecutiveFailureCount: 0, latestResultClassification: "success" },
			{ totalCompleted: 1, failureCount: 1, consecutiveFailureCount: 2, latestResultClassification: "success" },
			{ totalCompleted: 1, failureCount: 0, consecutiveFailureCount: 0, latestResultClassification: "wat" },
		];
		for (const progress of bad) {
			expect(() => evaluateAbort({ envelope, progress })).toThrow(BlastRadiusError);
		}
		expect(() => evaluateAbort({ envelope: null, progress: {} })).toThrow(BlastRadiusError);
	});
});

// ---------------------------------------------------------------------------
// Envelope shape
// ---------------------------------------------------------------------------

describe("Phase 45A — envelope contract", () => {
	test("declares abort conditions derived from the policy", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { maxFailures: 3, maxConsecutiveFailures: 1, stopOnCriticalFailure: true },
			}),
		);
		expect(envelope.abortConditions).toEqual([
			{ reasonCode: REASON_CODES.CONSECUTIVE_FAILURE_LIMIT_REACHED, limit: "maxConsecutiveFailures", value: 1 },
			{ reasonCode: REASON_CODES.CRITICAL_FAILURE, limit: "stopOnCriticalFailure", value: true },
			{ reasonCode: REASON_CODES.FAILURE_LIMIT_REACHED, limit: "maxFailures", value: 3 },
		]);
	});

	test("exposes identity, classification counts and reason codes", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowMutating: true },
				requests: [request("r1", "GET"), request("r2", "POST"), request("r3", "CUSTOM")],
			}),
		);
		expect(envelope.kind).toBe("tracer.blast-radius-envelope");
		expect(envelope.version).toBe(1);
		expect(envelope.workspace).toEqual({ workspaceId: WORKSPACE, snapshotId: "snap-1" });
		expect(envelope.environment).toEqual({ environmentId: ENVIRONMENT, targetEnvironmentId: ENVIRONMENT });
		expect(envelope.policy.kind).toBe("tracer.blast-radius-policy");
		expect(typeof envelope.policy.identity).toBe("string");
		expect(envelope.classification).toEqual({ mutating: 1, nonMutating: 1, unknown: 1 });
		expect(envelope.mutatingRequestIds).toEqual(["r2"]);
		expect(envelope.nonMutatingRequestIds).toEqual(["r1"]);
		expect(envelope.unknownRequestIds).toEqual(["r3"]);
		expect(envelope.reasonCodes).toEqual([REASON_CODES.UNKNOWN_METHOD]);
		expect(envelope.allowedRequests.map((entry) => entry.admission)).toEqual([
			ADMISSION_STATES.ADMITTED,
			ADMISSION_STATES.ADMITTED,
			ADMISSION_STATES.BLOCKED,
		]);
	});

	test("target environment may differ from the workspace environment", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				targetEnvironmentId: "env-prod",
				policy: { allowedEnvironmentIds: ["env-prod"] },
			}),
		);
		expect(envelope.environment).toEqual({ environmentId: ENVIRONMENT, targetEnvironmentId: "env-prod" });
		expect(envelope.admissionState).toBe(ADMISSION_STATES.ADMITTED);
	});

	test("blocked requests consume no budget, so later requests still fit", () => {
		const envelope = evaluateBlastRadius(
			baseInput({
				policy: { allowMutating: false, maxTotalRequests: 2 },
				requests: [request("r1", "DELETE"), request("r2", "GET"), request("r3", "HEAD")],
			}),
		);
		// r1 is blocked by the mutation ban and must not consume the budget.
		expect(envelope.allowedRequests[0].admission).toBe(ADMISSION_STATES.BLOCKED);
		expect(envelope.allowedRequests[1].admission).toBe(ADMISSION_STATES.ADMITTED);
		expect(envelope.allowedRequests[2].admission).toBe(ADMISSION_STATES.ADMITTED);
	});
});
