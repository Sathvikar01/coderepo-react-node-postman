// Phase 45A — Blast-Radius Safety Policy Core (schema layer).
//
// This module defines the closed input vocabulary for the blast-radius policy
// engine. It answers exactly one question:
//
//   "Is this proposed API rehearsal safe to start, what is it allowed to
//    execute, and exactly when must it abort?"
//
// It never resolves DNS, never performs network calls, and never executes an
// HTTP request. It is a pure, deterministic admission engine.
//
// Missing-limit semantics. Every limit is tri-state on purpose:
//
//   * `undefined` / absent  -> not configured. The engine applies no limit and
//                              reports `configured: false`, `value: null`.
//   * `0`                   -> configured with zero. This is a real limit and
//                              means "no request may satisfy this budget".
//   * `n > 0`               -> configured numeric limit.
//
// The engine never invents a default limit and never silently widens a policy.

import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { BLAST_RADIUS_ERROR_CODES } from "./reason-codes.js";

export const BLAST_RADIUS_POLICY_KIND = "tracer.blast-radius-policy";
export const BLAST_RADIUS_POLICY_VERSION = 1;
export const BLAST_RADIUS_ENVELOPE_KIND = "tracer.blast-radius-envelope";
export const BLAST_RADIUS_ENVELOPE_VERSION = 1;
export const BLAST_RADIUS_ABORT_KIND = "tracer.blast-radius-abort";
export const BLAST_RADIUS_ABORT_VERSION = 1;

const MAX_REQUESTS = 10_000;
const MAX_HOSTS = 500;
const MAX_METHODS = 64;
const MAX_ID_LENGTH = 256;
const MAX_ORDER_ENTRIES = 10_000;

const boundedText = (max) => z.string().min(1).max(max);

const requestIdSchema = boundedText(MAX_ID_LENGTH);

// Host identity is intentionally lenient. A malformed host value is a *runtime*
// resolution failure (UNKNOWN_HOST), not a schema error, because the phase
// requires "unknown host + configured allowlist -> not admitted" rather than a
// hard input rejection. `normalizeHostIdentity` decides whether the value is a
// usable identity.
const hostIdentitySchema = z
	.object({
		// Normalized host identity supplied by the caller. The engine never
		// resolves DNS; it only compares normalized identities.
		host: z.unknown().optional(),
		port: z.number().int().min(1).max(65535).nullable().optional(),
	})
	.passthrough();

const proposedRequestSchema = z
	.object({
		requestId: requestIdSchema,
		method: boundedText(MAX_METHODS),
		// Optional normalized host identity. When absent the request's host is
		// UNKNOWN and it can never be admitted under a configured host allowlist.
		host: hostIdentitySchema.nullable().optional(),
		// Optional execution ordering/dependency hint supplied by the caller.
		// Only preserved when semantically supplied; never invented.
		dependsOn: z.array(requestIdSchema).max(MAX_ORDER_ENTRIES).optional(),
	})
	.passthrough();

// A limit is either absent (not configured) or a non-negative integer.
const limitSchema = z.number().int().min(0).max(MAX_REQUESTS);

// Tri-state limit wrapper. `undefined` means "not configured". A configured
// limit carries both the numeric value and whether it was explicitly set.
const policySchema = z
	.object({
		allowedEnvironmentIds: z.array(boundedText(MAX_ID_LENGTH)).max(MAX_HOSTS).optional(),
		allowedHosts: z.array(boundedText(MAX_HOSTS)).max(MAX_HOSTS).optional(),
		allowedMethods: z.array(boundedText(MAX_METHODS)).max(MAX_METHODS).optional(),
		allowMutating: z.boolean().optional(),
		requireMutatingConfirmation: z.boolean().optional(),
		maxTotalRequests: limitSchema.optional(),
		maxMutatingRequests: limitSchema.optional(),
		maxRequestsPerHost: limitSchema.optional(),
		maxFailures: limitSchema.optional(),
		maxConsecutiveFailures: limitSchema.optional(),
		stopOnCriticalFailure: z.boolean().optional(),
	})
	.passthrough();

const inputSchema = z
	.object({
		workspaceId: requestIdSchema,
		snapshotId: requestIdSchema.nullable().optional(),
		environmentId: requestIdSchema,
		// The environment the rehearsal is proposed to target. May be absent
		// when the caller has not resolved one yet; the engine then cannot
		// admit against a configured environment allowlist.
		targetEnvironmentId: requestIdSchema.nullable().optional(),
		policy: policySchema,
		requests: z.array(proposedRequestSchema).min(1).max(MAX_REQUESTS),
	})
	.passthrough();

export class BlastRadiusError extends AppError {
	constructor(code, message, details) {
		super(400, code, message, details);
	}
}

function fail(code, message, details) {
	throw new BlastRadiusError(code, message, details);
}

/**
 * Parse and validate the structured input for a blast-radius admission pass.
 *
 * Fails closed with a typed `BlastRadiusError` when the input is malformed.
 * Never repairs, never widens, never applies a hidden default.
 */
export function parseBlastRadiusInput(raw) {
	const parsed = inputSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({
			path: issue.path.join("."),
			message: issue.message,
		}));
		fail(
			BLAST_RADIUS_ERROR_CODES.MALFORMED_INPUT,
			"The blast-radius policy input is malformed.",
			{ issues },
		);
	}
	return parsed.data;
}

/**
 * Detect contradictory limits that make a policy unsatisfiable.
 *
 * A policy is contradictory when a narrower budget can never be exercised
 * because a wider budget that should contain it is smaller. These are typed
 * errors, not clampings: the engine refuses to guess the caller's intent.
 */
export function assertPolicyConsistent(policy) {
	const checks = [
		["maxMutatingRequests", "maxTotalRequests"],
		["maxRequestsPerHost", "maxTotalRequests"],
	];
	for (const [innerKey, outerKey] of checks) {
		const inner = policy[innerKey];
		const outer = policy[outerKey];
		if (inner === undefined || outer === undefined) continue;
		if (inner > outer) {
			fail(
				BLAST_RADIUS_ERROR_CODES.CONTRADICTORY_LIMITS,
				`Policy limit "${innerKey}" (${inner}) cannot exceed "${outerKey}" (${outer}).`,
				{ limit: innerKey, value: inner, conflictingLimit: outerKey, conflictingValue: outer },
			);
		}
	}

	if (policy.maxConsecutiveFailures !== undefined && policy.maxFailures !== undefined) {
		if (policy.maxConsecutiveFailures > policy.maxFailures) {
			fail(
				BLAST_RADIUS_ERROR_CODES.CONTRADICTORY_LIMITS,
				`Policy limit "maxConsecutiveFailures" (${policy.maxConsecutiveFailures}) cannot exceed "maxFailures" (${policy.maxFailures}).`,
				{
					limit: "maxConsecutiveFailures",
					value: policy.maxConsecutiveFailures,
					conflictingLimit: "maxFailures",
					conflictingValue: policy.maxFailures,
				},
			);
		}
	}

	if (policy.stopOnCriticalFailure === true && policy.maxFailures === 0) {
		fail(
			BLAST_RADIUS_ERROR_CODES.CONTRADICTORY_LIMITS,
			'A policy with "maxFailures": 0 cannot also request "stopOnCriticalFailure", which can never be reached.',
			{ limit: "stopOnCriticalFailure", conflictingLimit: "maxFailures", conflictingValue: 0 },
		);
	}

	return policy;
}

export const blastRadiusInputSchema = inputSchema;
export const blastRadiusPolicySchema = policySchema;
export const blastRadiusRequestSchema = proposedRequestSchema;
