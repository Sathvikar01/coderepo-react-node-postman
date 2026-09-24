# Blast-Radius Safety Policy Core (Phase 45A)

Backend-only, deterministic admission engine for API rehearsals.

> **Is this proposed API rehearsal safe to start, what is it allowed to
> execute, and exactly when must it abort?**

This feature defines the **safety envelope only**. It never executes HTTP
requests, never resolves DNS, and never touches persistence. It is pure and
fully deterministic: equivalent inputs produce byte-stable output.

## Public API

```js
import {
  evaluateBlastRadius,
  evaluateAbort,
  ADMISSION_STATES,
  REASON_CODES,
} from "./backend/src/features/blast-radius-policy/index.js";

const envelope = evaluateBlastRadius(input);
const { decision, reasonCodes } = evaluateAbort({ envelope, progress });
```

## Composition seam (not implemented here)

```
Change Impact  ->  Blast Radius Policy  ->  Checkpointed Rehearsal
```

A later rehearsal engine consumes `envelope.allowedRequests` for identity and
the envelope's `effectiveLimits` / `abortConditions` for its runtime guard.

## Modules

| Module | Responsibility |
|---|---|
| `blast-radius-schema.js` | Zod input schema, typed errors, contradiction detection |
| `reason-codes.js` | Closed vocabularies (states, classifications, reason codes) |
| `request-classification.js` | Deterministic HTTP method classification |
| `policy-normalization.js` | Casing/order/dedup normalization, tri-state limits |
| `admission-rules.js` | Ordered, deterministic admission precedence |
| `execution-envelope.js` | Payload-free envelope + host summary |
| `abort-evaluator.js` | Pure runtime CONTINUE/ABORT guard |
| `blast-radius.service.js` | Orchestration + stable policy identity |

## Request classification

| Methods | Classification |
|---|---|
| `GET`, `HEAD`, `OPTIONS` | `NON_MUTATING` |
| `POST`, `PUT`, `PATCH`, `DELETE` | `MUTATING` |
| anything else | `UNKNOWN` |

Classification is purely syntactic. It says nothing about semantic
idempotency, and `UNKNOWN` is **never** treated as safe. Padded or otherwise
malformed method tokens stay malformed — they are never trimmed into a valid
method (see the `"GET\t"` regression test).

## Admission states

`ADMITTED` · `BLOCKED` · `REQUIRES_CONFIRMATION` · `UNKNOWN`

Set-level precedence: `BLOCKED` > `UNKNOWN` > `REQUIRES_CONFIRMATION` >
`ADMITTED`. `UNKNOWN` never becomes `ADMITTED`.

Per-request precedence (first match wins):

1. `BLOCKED` — environment not in a configured allowlist
2. `BLOCKED` — mutating request while `allowMutating: false`
3. `BLOCKED` — method not in a configured method allowlist
4. `BLOCKED` — method classification is `UNKNOWN`
5. `UNKNOWN` — host unresolved → `UNKNOWN_HOST`
6. `BLOCKED` — host not in a configured host allowlist
7. `BLOCKED` — total / mutating / per-host budget exhausted
8. `REQUIRES_CONFIRMATION` — mutating with confirmation demanded
9. `ADMITTED`

A blocked or unknown request **consumes no budget**, so the envelope reflects
what a rehearsal could actually start rather than what was proposed.

## Limit semantics

Every limit is tri-state and the difference is preserved exactly:

| Input | Meaning | Reported as |
|---|---|---|
| absent / `undefined` | not configured — no limit applied | `{ configured: false, value: null }` |
| `0` | configured with zero — nothing fits | `{ configured: true, value: 0 }` |
| `n > 0` | configured numeric limit | `{ configured: true, value: n }` |

The engine never invents a default and never interprets a missing field as
unlimited. Contradictory limits (`maxMutatingRequests > maxTotalRequests`,
`maxConsecutiveFailures > maxFailures`, …) are typed errors, not clampings.

## Reason codes

`ENVIRONMENT_NOT_ALLOWED` · `HOST_NOT_ALLOWED` · `METHOD_NOT_ALLOWED` ·
`MUTATING_REQUEST_NOT_ALLOWED` · `MUTATING_CONFIRMATION_REQUIRED` ·
`REQUEST_LIMIT_EXCEEDED` · `MUTATING_LIMIT_EXCEEDED` ·
`HOST_REQUEST_LIMIT_EXCEEDED` · `UNKNOWN_METHOD` · `UNKNOWN_HOST` ·
`FAILURE_LIMIT_REACHED` · `CONSECUTIVE_FAILURE_LIMIT_REACHED` ·
`CRITICAL_FAILURE`

## Security / data minimization

The envelope and every execution entry carry **identity and decisions only**.
Never present anywhere in the output:

- request bodies, URLs, or query strings
- `Authorization` / `Cookie` header values
- bearer tokens or API keys
- credential templates or resolved credential values
- secret values, or the resolved values behind `secretRef` aliases

`allowedRequests[i]` exposes exactly these keys: `requestId`, `host`,
`hostKey`, `port`, `method`, `classification`, `mutating`, `admission`,
`reasonCodes`. Leakage tests assert that known seeded secret strings smuggled
into payload-shaped input fields never survive projection.

## Determinism

Normalized: host casing + trailing root dot, method casing, duplicate request
references, and irrelevant allowlist ordering. Execution ordering supplied via
`dependsOn` is preserved because it is semantically required, but it never
invents an admission rule. Duplicate `requestId`s are a typed error so limits
can never be double-counted.

## Verification

```sh
cd backend && bun test src/features/blast-radius-policy/
cd .. && bun test
```

No routes, no controllers, no persistence, no frontend.
