# Phase 42A — API Contract Registry Core

**Branch:** `phase42/contract-registry-core`
**Base:** `origin/main` @ `ef2388f`
**Scope:** backend-only. No HTTP execution, no network, no UI.
**Verdict:** PASS

---

## 1. What this phase is

Tracer can record what *did* happen (execution receipts, history, Flight
Recorder) and what *changed* (change impact, environment drift, cross-environment
verification). It had no way to record what is *expected*.

Phase 42A adds the missing half: a deterministic, versioned registry of **expected
API response contracts**. A contract is one statement:

> For this request / workspace version, this is the response behavior we expect.

It is deliberately a *registry*, not a comparator. It stores and validates
contracts and owns their lifecycle. Comparing a contract to a live execution is a
later phase and is explicitly out of scope here.

---

## 2. Module layout

All new code lives in `backend/src/features/contract-registry/`. Each module has one
responsibility, matching the repository's established feature shape.

| Module | Responsibility |
|---|---|
| `contract-schema.js` | Bounded vocabulary and fail-closed validation (zod). |
| `contract-canonical.js` | Canonical serialization + content fingerprint. |
| `contract-lifecycle.js` | State machine predicates; immutability rules. |
| `contract.model.js` | Mongoose models, unique indexes, atomic counter. |
| `contract.repository.js` | Profile-scoped persistence; no business rules. |
| `contract-inference.js` | Pure, deterministic inference from a supplied response. |
| `contract.service.js` | Lifecycle orchestration; injectable repository seam. |
| `index.js` | Public barrel. |

### One narrow integration hook

`backend/src/scripts/seed.js` gained two imports and two `deleteMany({})` entries
(3 lines). This is required, not opportunistic: the repository's own
`seed-reset.test.js` enforces that *every* registered Mongoose model is cleared by
the seed reset block, so leaving contract rows behind would break the documented
"reset leaves no extra data behind" contract. The change is additive only — no
existing reset behaviour was altered.

---

## 3. State model

```
DRAFT  --publish-->  PUBLISHED  --newer version published-->  SUPERSEDED
  ^                      |
  +----edit / discard----+     (drafts are the only mutable state)
```

- **DRAFT** — editable, discardable, never compared against anything.
- **PUBLISHED** — the live expectation for a request. Immutable.
- **SUPERSEDED** — historical. Readable forever, never re-publishable.

Immutability is enforced in three independent places so a bug in any one cannot
leak a mutation:

1. `assertMutable` in the lifecycle module (service-level guard).
2. `state: "DRAFT"` filters on every write in the repository.
3. A partial unique index allowing at most one `PUBLISHED` row per
   `(ownerProfileId, contractId)`.

---

## 4. Requirements coverage

| # | Requirement | Where it is proven |
|---|---|---|
| 1 | Create draft | `contract-registry.test.js` §1; `contract.persistence.test.js` |
| 2 | Publish contract | §2; persistence test asserts actor/timestamp on disk |
| 3 | Immutable published contract | §3; plus a direct repository tamper attempt that returns `null` |
| 4 | Second version supersedes first | §4; persistence test checks `supersededBySequence` |
| 5 | Version history preserved | §5; restart test re-reads history after a reconnect |
| 6 | Deterministic canonicalization | §6–8 |
| 7 | Stable content fingerprint | §6–8 |
| 8 | Meaningful change alters fingerprint | §6–8 |
| 9 | Concurrent version creation | §9; 12-way parallel allocation against MongoDB |
| 10 | Duplicate / idempotent publication | §10; persistence test counts rows |
| 11 | Request / profile isolation | §11; cross-profile reads and writes refused |
| 12 | Malformed contract rejected | §12 |
| 13 | Excessive nesting rejected | §13, at the exact boundary |
| 14 | Excessive properties rejected | §14 |
| 15 | Sensitive headers rejected/redacted | §15, including inference dropping them |
| 16 | Nested object/array contracts | §16 |
| 17 | Allowed status sets | §17 |
| 18 | Selected response headers | §18 |
| 19 | Deterministic inference | §19 |
| 20 | Inference does not guess | §20 |

Plus coverage for reserved-key hardening, edit semantics, the inference-to-draft
path, and lifecycle predicates. **106 focused tests, all passing.**

---

## 5. Bugs found and fixed during this phase

Each of these was a real defect surfaced by a failing test, not a test adjustment.

### 5.1 Depth-cap off-by-one in inference (real, user-visible)

`inferNode` truncated containers at `depth >= maxDepth`, but the schema refuses to
let a container live at `maxDepth` (that level is leaves-only). Inference therefore
emitted contracts that **the schema itself rejected** — an inferred contract at the
depth cap could not be saved. Fixed by truncating one level earlier:

```js
const containerLimit = maxDepth - 1;
```

Regression coverage: "an inferred contract at the depth cap is still a valid
contract".

### 5.2 Publish order violated the one-PUBLISHED invariant (real, data-integrity)

`publish` promoted the new version to `PUBLISHED` *before* superseding the old one,
which collided with the partial unique index
(`E11000 ... ownerProfileId_1_contractId_1_state_1`). Publishing a second version
of any contract failed against the real database. Fixed by superseding first, then
promoting, with a compensating `restorePublished` action so a failed promotion
cannot silently unpublish a live contract.

Regression coverage: "publishing persists state, actor, and timestamp and
supersedes the previous version".

### 5.3 Atomic counter returned 0 for the first version (real, blocking)

The original `findOneAndUpdate` upsert combined `$inc` and a `$setOnInsert` on the
same field. MongoDB rejects that, and the pre-fix variant returned `nextSequence - 1`,
so the very first contract allocation was sequence **0**, which the model rejects
(`min: 1`). Fixed with an explicit fast path (`$inc`) plus a create-with-retry path
that is correct under concurrent first-allocation races.

Regression coverage: "sequences increment atomically under concurrent allocation".

### 5.4 Reserved property names were silently dropped (real, fail-open)

A contract declaring `__proto__` as a property name parsed "successfully" with the
property **silently discarded**, because zod's `record` parser assigns entries and
`obj["__proto__"] = x` rewires the prototype instead of creating a key. The stored
contract and its fingerprint would then disagree with what the caller submitted —
a fail-open violation of "never silently lose input".

Fixed with a `z.preprocess` guard that walks the raw node before zod sees it and
fails closed with `AppError(400, CONTRACT_INVALID)` for `__proto__`, `constructor`,
and `prototype` at any nesting depth. A property-name refinement alone was
insufficient (it ran too late); the pre-parse guard is what actually closes it.

Regression coverage: five tests including "parsing never mutates Object.prototype".

### 5.5 Test-harness fixes (not product bugs)

- Fake repository flagged a row as its own uniqueness duplicate on update.
- Date assertions compared `Date` objects to ISO strings, making the fake harmless.

---

## 6. Determinism and safety properties

**Deterministic output.** `canonicalContractJson` sorts object keys, drops
`undefined` members, lowercases and sorts header names, and sorts allowed status
codes. Array order is preserved where order is meaningful (required-property
lists). Two structurally equal contracts produce byte-identical canonical JSON and
identical fingerprints, regardless of key insertion order. Fingerprints are
HMAC-SHA-256 over the canonical content with the app fingerprint key, reused from
`features/history/fingerprint.js` so the key and key id stay consistent across the
codebase.

**Fail closed.** Every parse path throws `AppError(400, ...)` on malformed input.
There is no "best effort" branch: unknown fields, missing status, both status
forms, out-of-range codes, duplicate statuses, body/bodyType disagreement,
undeclared required properties, scalar nodes with children, and over-limit
documents all fail closed.

**Nothing sensitive is stored.** Header names are checked against the same
credential header set the mock matcher already uses (`authorization`,
`proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`). Credential-shaped
header values, property names, and enum values are refused. Inference *discards*
sensitive headers rather than storing them and reports what it dropped.

**Profile isolation.** Every repository read and write is constrained by
`ownerProfileId`. Two profiles can own the same `contractId` and request id without
interfering; a cross-profile read returns `null` and a cross-profile publish throws
`404 CONTRACT_NOT_FOUND`.

**No I/O at the core.** The schema, canonicalization, lifecycle, and inference
modules are pure. They read no clock, open no socket, and touch no database, which
is what makes the fingerprint reproducible.

---

## 7. Verification evidence

| Check | Result |
|---|---|
| Focused Phase 42 tests | **106 pass / 0 fail** |
| Full repository suite | **1168 pass / 2 skip / 0 fail** (1170 total) |
| `node --check` on all new modules + `seed.js` | pass |
| `bun install --frozen-lockfile` | no changes (150 installs, 175 packages) |
| `cd frontend && bun run build` | pass (`built in 577ms`) |
| Seed-reset coverage contract test | pass |
| Protected paths touched | **none** |

`git status` on the branch shows exactly:

```
 M backend/src/scripts/seed.js
?? backend/src/features/contract-registry/
```

No frontend file, `App.jsx`, stylesheet, execution/transport/runner code,
snapshot, change-impact, environment-drift, or cross-env-verification module,
CI workflow, dependency manifest, lockfile, or `hackerrank.yml` was modified. The
two skipped tests are pre-existing environment-dependent skips (TLS/SNI and the
no-database regression marker) and are unrelated to this phase.

---

## 8. Out of scope (deliberately not built)

- Comparison of a contract against a live execution.
- Breaking-change detection and classification.
- Runner, CLI, or CI integration.
- Any UI. The registry has no routes and no frontend surface in this phase.
- Persisting resolved secrets — credentials never enter a contract at all.

---

## 9. Known limits

- **Inference describes only one observed sample.** It intentionally never infers
  requiredness or enums, because a single response cannot prove either. Values that
  *should* be required must be authored explicitly.
- **Arrays are described by their first element.** A mixed-type array is reported
  as a warning rather than modelled as a union.
- **The inference depth cap truncates and warns** rather than failing, so a deeply
  nested real-world payload produces a valid but shallower contract. The warning
  names the path that was cut.
- **Contract content is stored as a validated `Mixed` document.** The recursive
  type node would require a self-referencing Mongoose schema; the zod schema
  remains the single source of truth for the stored shape, and the service runs
  `parseStoredContract` on every write so a persisted row can never disagree with
  the read path.

---

## 10. Files

**Added** — `backend/src/features/contract-registry/`
`contract-schema.js`, `contract-canonical.js`, `contract-lifecycle.js`,
`contract.model.js`, `contract.repository.js`, `contract-inference.js`,
`contract.service.js`, `index.js`, `contract-registry.test.js` (92 tests),
`contract.persistence.test.js` (14 tests).

**Modified** — `backend/src/scripts/seed.js` (+3 lines, seed-reset coverage).

---

PHASE 42A VERDICT: PASS
