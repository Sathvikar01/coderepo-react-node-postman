# Phase 41A — Cross-Environment Verification Core

**Branch:** `phase41/cross-env-verification-core`
**Base:** `origin/main` @ `ef2388f`
**Scope:** backend-only, no HTTP execution, no frontend.

## Question answered

> Is this workspace/version sufficiently verified to move from environment A to
> environment B, and what blocks verification?

## Non-goals honoured

No request is executed. No database, network, transport, runner, Flight Recorder,
snapshot, change-impact, or environment-drift module is modified. Nothing in
`frontend/`, `App.jsx`, stylesheets, `hackerrank.yml`, CI, or dependencies changed.

## Module layout

| File | Responsibility |
|---|---|
| `verification-schema.js` | Kind/version constants, state + reason-code enums, Zod input/output contracts, fail-closed parsers, self-assertion of results |
| `evidence-normalization.js` | Normalizes caller execution/assertion records, dedupes deterministically (failure-priority wins), classifies evidence binding |
| `rehearsal-set.js` | Derives the minimal rehearsal set from a change-impact result |
| `verification-rules.js` | Six explicit rules: identity, drift, impact completeness, dynamic references, per-request evidence verdict, rehearsal coverage |
| `verification-result.js` | State resolution and byte-stable envelope construction |
| `cross-env-verification.service.js` | `verifyCrossEnvironment` orchestrator; the only public entry point |
| `ordering.js` | Shared deterministic comparison/sorting primitives |
| `index.js` | Public barrel + injectable integration seam |

## State model

| State | Meaning |
|---|---|
| `VERIFIED` | Identity sufficient, no blockers, rehearsal set trustworthy and complete, every required request carries admissible success evidence |
| `BLOCKED` | Positive evidence of failure: high-severity drift, unresolved drift, failed assertion, failed/incomplete execution, contradictory evidence, unresolved dynamic reference, or unusable impact |
| `NEEDS_REHEARSAL` | No proven failure, but required requests lack admissible evidence |
| `UNKNOWN` | Input structurally insufficient (missing target identity, unavailable/incomplete rehearsal set) |

Absence of evidence produces `NEEDS_REHEARSAL`; only positive evidence of failure
produces `BLOCKED`. Missing drift or missing impact is a blocker, so a caller
cannot obtain `VERIFIED` by omitting the comparison.

## Reason codes

`SNAPSHOT_IDENTITY_MISSING`, `ENVIRONMENT_IDENTITY_MISSING`,
`SNAPSHOT_CHANGED`, `WORKSPACE_UNCHANGED`, `HIGH_SEVERITY_DRIFT`,
`UNKNOWN_DRIFT`, `ENVIRONMENT_DRIFT_MISSING`, `CHANGE_IMPACT_MISSING`,
`DYNAMIC_REFERENCE_UNRESOLVED`, `EVIDENCE_WRONG_SNAPSHOT`,
`EVIDENCE_WRONG_ENVIRONMENT`, `EVIDENCE_WRONG_WORKSPACE`, `EVIDENCE_STALE`,
`EVIDENCE_CONTRADICTORY`, `ASSERTION_FAILED`, `EXECUTION_FAILED`,
`EXECUTION_INCOMPLETE`, `AFFECTED_REQUEST_UNVERIFIED`, `NO_REHEARSAL_EVIDENCE`.

## Evidence binding

Every record is classified before it is allowed to influence a verdict:
accepted, wrong snapshot, wrong environment, wrong workspace, or stale. Rejected
records are reported by id and never verify anything. Identity comparison prefers
ids over names; a name-only match is only decisive when neither side has an id.
Evidence without a timestamp is never judged stale.

## Freshness

Freshness is applied **only** when the caller supplies a policy. A policy with no
age bound is treated as no policy. There is no hidden or default cutoff, so the
engine cannot silently age out evidence. Cutoffs accept `maxAgeMs` with an
explicit `now`, or an explicit `staleBefore` instant — no system clock read.

## Minimal rehearsal set

Direct impact rows are required. Indirect rows are required unless their
confidence is `exact`. A dynamic boundary request named by an unknown reference is
required. The set reports `available`/`complete`; unresolved, truncated, or
unnamable boundaries mark it incomplete, which forces `UNKNOWN` rather than a
false `VERIFIED`.

## Determinism

Ids and findings are sorted through `ordering.js`, duplicates collapse to a
single deterministic survivor, and findings dedupe on
`(code, requestId, evidenceId, collectionId)`. Two identical invocations serialize
byte-identically; shuffling the evidence array does not change the output.

## Isolation and security

Evidence owned by another profile is refused with
`AppError(403, CROSS_ENV_VERIFICATION_PROFILE_MISMATCH)`. Evidence from another
collection/workspace is rejected as `EVIDENCE_WRONG_WORKSPACE`. Malformed input —
non-objects, unknown fields, unknown outcomes, negative age bounds — fails closed
with `AppError(400, CROSS_ENV_VERIFICATION_INVALID_INPUT)`. The result envelope is
validated against its own contract before it is returned
(`CROSS_ENV_VERIFICATION_INVALID_RESULT`).

## Integration seam (for 41B)

Phases 39 (Change Impact) and 40 (Environment Drift) are not merged at the time of
writing, so this core consumes their **public result envelopes structurally** and
does not import them. `createCrossEnvVerifier({ changeImpactSource,
environmentDriftSource })` defines the exact hook a later integration phase uses
to feed real Phase 39/40 results into the same pure engine, with no engine change.

## Tests

`cross-env-verification.test.js` — 55 tests covering the 20 required cases
(unchanged-workspace verify, wrong snapshot, wrong environment, missing evidence,
direct/indirect confidence, high/unknown drift, assertion and execution failure,
incomplete execution, stale vs. unbounded freshness, dedupe, rehearsal
determinism, dynamic references, stable ordering, malformed input, profile
isolation, byte-stability) plus contradiction, missing-input, binding-precedence,
and seam coverage.

## Verification evidence

```
bun test src/features/cross-env-verification/...   55 pass / 0 fail
bun test (repo-wide)                               1084 pass / 36 skip / 0 fail
node --check (all 8 modules)                       ok
bun install --frozen-lockfile                      no changes
```

Protected paths confirmed untouched (no diff outside
`backend/src/features/cross-env-verification/`).

## Verdict

`PHASE 41A VERDICT: PASS`
