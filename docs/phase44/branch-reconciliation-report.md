# Phase 44 — Branch Reconciliation + Core Integration Gate

**Status:** PASS
**Branch:** `phase44/branch-reconciliation` → merged to `main`
**Merge commit:** `45b8335` (PR #41)
**Date:** 2026-09-24

---

## 1. Objective

Bring the frozen and completed backend lanes onto one clean `main` without
regressing the accepted Investigation workflow, and add the single thin seam the
merged cores need to work together. No new product features.

Lanes integrated:

| Phase | Branch | Result |
|---|---|---|
| 37 | `phase37/investigation-acceptance` | merged first (authoritative Investigation source of truth) |
| 39A | `phase39/change-impact-core` | merged |
| 40A | `phase40/environment-drift-core` | merged |
| 41A | `phase41/cross-env-verification-core` | merged |
| 42A | `phase42/contract-registry-core` | merged |

---

## 2. PR #33 decision — closed without merging

`#33` (`hotfix/restore-ui-after-phase36`) removes the Phase 36/37 Investigation
frontend:

- `frontend/src/features/execution-intelligence/InvestigationDialog.jsx`
- `frontend/src/features/execution-intelligence/investigation-model.js`
- `frontend/src/features/execution-intelligence/investigation-model.test.js`
- `frontend/src/features/execution-intelligence/investigation.api.js`
- `frontend/scripts/phase36-investigation-e2e.mjs`

1941 deletions, 0 additions of Investigation code.

`main` carries **no** Investigation UI. Phase 37 re-adds and freezes it, so this
branch is a regression of accepted functionality regardless of merge order.
**Decision: close without merging.** The reason and evidence were recorded on the
PR before closing.

---

## 3. Merge order and conflicts

All five branches shared merge-base `ef2388f`. Integrated in dependency order
37 → 39A → 40A → 41A → 42A.

**Conflicts: zero.** Each post-37 lane owns a disjoint `backend/src/features/<name>/**`
path. Only Phase 42 touches a shared file (`seed.js`, +3 additive lines: one model
import and one reset registration). No dependency or lockfile changes in any lane.

After integration the branch was rebased onto the then-current `origin/main`
(which had advanced by one transcript-only commit, no code). The rebase applied
cleanly with no conflicts, and the resulting tree contains every file from all
five lanes.

---

## 4. The integration seam

### The problem

Phase 41 was authored before 39/40 merged. It consumes their result envelopes
structurally through `createCrossEnvVerifier`, but its own input contract is a
`.strict()` Zod schema. The extra envelope fields Phase 39/40 emit (`kind`,
`schemaVersion`, `change`, `impact`, `collections`, `folders`, `assertions`,
`source`, `target`) cause rejection:

```
CROSS_ENV_VERIFICATION_INVALID_INPUT
```

Two concrete mismatches were confirmed:

1. **Phase 39** — its `summary` carries 8 fields; Phase 41 accepts exactly 3
   (`directRequests`, `indirectRequests`, `unknownReferences`). Raw pass-through
   fails on `summary` unrecognised keys.
2. **Phase 40** — passes through cleanly once the envelope wrapper is removed.

### The solution

`backend/src/features/core-integration` is a **projection adapter, not a
re-implementation**:

- It moves no logic out of Phase 39/40 or Phase 41.
- It computes no impact or drift itself.
- It relaxes no Phase 41 validation.
- It maps a missing/malformed core result to the exact "absent" value Phase 41
  already treats as a blocker, so `missing / unknown evidence ≠ VERIFIED`.

Exports:

| Export | Role |
|---|---|
| `hasImpactEnvelope` / `hasDiffEnvelope` / `hasDriftEnvelope` | shape guards ("did a real core produce this?") |
| `projectChangeImpact` / `projectEnvironmentDrift` | project an envelope onto Phase 41's exact input subset; `null` when invalid |
| `changeImpactFromWorkspaceDiff` / `environmentDriftFromEnvironments` | composition sources in the shape `createCrossEnvVerifier` expects |
| `verifyMove` | entry point: workspace diff + environment states + evidence → impact + drift → verification |

One deliberate choice: `verifyMove` calls the pure `verifyCrossEnvironment`
engine rather than the `createCrossEnvVerifier` seam. The seam throws when both
results are absent because it exists to wire sources; here an absent core result
must reach the engine as "missing", which the engine already turns into a
blocker. This is what preserves the fail-closed invariant at the integration
boundary.

Supplied-but-unusable values (`changeImpact: { kind: "not-a-core" }`) **throw**
rather than silently falling back to re-running the cores, so a caller error
cannot be hidden behind fresh analysis.

---

## 5. Invariants proven

23 deterministic tests in `core-integration.test.js`, using the **real** Phase
39/40 services feeding the **real** Phase 41 engine. No mocks, no network, no
database, no rehearsal execution.

| # | Required invariant | Test | Result |
|---|---|---|---|
| 1 | Phase 39 impact is consumable by Phase 41 | projection passes Phase 41's strict schema; raw does not | PASS |
| 2 | Phase 40 drift is consumable by Phase 41 | projection preserved severity/status | PASS |
| 3 | High-severity drift ≠ VERIFIED | `BASE_URL` change → `BLOCKED` + `HIGH_SEVERITY_DRIFT` | PASS |
| 4 | Unverified affected request → NEEDS_REHEARSAL | no evidence → `NEEDS_REHEARSAL`, `req-affected` required | PASS |
| 5 | Matching evidence → VERIFIED | bound evidence → `VERIFIED`, `verifiedRequestIds=[req-affected]` | PASS |
| 6 | Malformed/missing fails closed | missing impact/drift → blockers; malformed → `TypeError` | PASS |
| 7 | Deterministic | byte-identical across repeats; order-independent | PASS |

Additional coverage: unresolved impact stays out of VERIFIED; the required
rehearsal set is derived from the real impact rows (the unaffected request is not
forced into rehearsal); a workspace-diff envelope is accepted through the same
entry point.

---

## 6. Seed / reset reconciliation

Requirement: the reset must include **every** persistent model exactly once.

Verified: 16 model imports, 16 `deleteMany` calls, 16 registered models — one
each, no duplicates, no omissions.

Determinism: two consecutive `bun run seed` runs produce identical output
(1 account, 2 profiles, 4 collections, 4 environments, 2 preferences, 10 demo
orders, 0 histories).

Phase 42's contract models proven actually cleared: inserted a probe document
into `contractversions` and `contractcounters` (count 1 each), re-ran the reset,
count 0 after.

---

## 7. Verification evidence

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | OK — 150 installs, no changes |
| `bun test` (full, on branch and on merged `main`) | **1309 pass, 0 fail, 2 skip** / 103 files |
| Cross-core integration suite | **23/23 pass** |
| Backend syntax (`node --check`, all JS) | 0 failures |
| Frontend build | OK (~800ms) |
| Seed/reset determinism + Phase 42 clearing | PASS |
| Investigation demo | **14/14 checks passed** |
| Flight Recorder demo | **47/47 checks passed** |
| Phase 37 acceptance e2e (real browser, on merged `main`) | **18/18 PASS** |
| Phase 36 state matrix e2e (real browser) | **30/30 PASS** |
| Phase 30 e2e | **14/14 PASS** |
| CI parity demo (CLI validate/pass/fail) | exit 0 / 0 / 1, JSON + JUnit reports written |
| Runtime smoke | `/api/v1/health` ok, frontend HTTP 200 |

### Browser acceptance detail

The Phase 37 and Phase 36 suites each include the full **375 / 768 / 1024 / 1440
× dark / light** overflow matrix with **zero console errors**:

- Phase 37: 18/18, including capsule export → normalized-boundary import → unsent
  dirty draft → manually reproduces the failure.
- Phase 36: 30/30, including keyboard focus containment, Escape close, focus
  return, honest empty states, and cancelled-execution handling.

PR #41 CI: all four checks green — `contract`, `Headless collection runner`,
`browser-e2e`, `locust-load`.

---

## 8. Git hygiene and repository state

- Working tree clean on `main`.
- `origin/main` advanced to the PR #41 merge commit `45b8335`.
- Every file from all five phase branches is present in `main` (verified
  file-by-file against each branch tip; the "not contained" SHA results were an
  artifact of the rebase rewriting commit identities, not lost content).
- Branch naming follows `phase<N>/<short-name>`; merge went through PR + green
  CI, not a direct push.
- Repository `coderepo-react-node-postman` remains **private** from creation
  onward; never published.
- No secrets added; `.env` remains gitignored.

---

## 9. Scope discipline

- No new product features.
- No dependencies, no lockfile changes.
- No opportunistic refactor.
- No changes to execution, persistence, or security semantics.
- Frozen Investigation boundaries untouched.

---

## 10. Files added

```
backend/src/features/core-integration/index.js               (212 lines)
backend/src/features/core-integration/core-integration.test.js (380 lines)
```

---

PHASE 44 VERDICT: PASS — CORES INTEGRATED, INVESTIGATION FREEZE PRESERVED
