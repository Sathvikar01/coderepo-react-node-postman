# Phase 49 — Effective Configuration / "Why?" Inspector

- **Phase:** 49 — Effective Configuration / "Why?" Inspector
- **Branch:** `phase49/why-inspector`
- **Base commit:** `b573a54f9b0d1b2fb690bb4d2d87f8e77837285f` (`docs(transcript): add Phase 48B result` on `main`)
- **Worktree:** isolated at `postman-phase49`
- **Nature of phase:** additive read-model + presentation. **No new execution, verification, impact, drift, contract, or proof semantics were introduced.** The inspector composes evidence that already exists.
- **Test runner:** `bun test` (repo-wide), the backend feature suites, the frontend model suite, and one real-browser CDP suite.

---

## 1. The question this phase answers

> Why did this request execute this way, and why did Tracer reach this verification result?

The chain is `configuration → dependency → execution → change → verification → evidence`. Every link is a **projection of something already recorded**. The phase adds no truth of its own: it explains truth that is already in the execution receipt, the request-compiler trace, the persisted investigation records, and the current collection/environment revisions.

---

## 2. What was built

### 2.1 Backend — `backend/src/features/why-inspector/`

| File | Lines | Responsibility |
| --- | --- | --- |
| `why-schema.js` | 118 | Frozen vocabulary: envelope kind, section ids, section states, limits, scope order/labels, execution stages, reason codes, caveat. |
| `why-projection.js` | 673 | Pure, deterministic, side-effect-free projection. `buildWhyExplanation()` and `deriveVerificationState()`. |
| `why-inspector.repository.js` | 45 | Read-only, profile-scoped loads (execution, collection, environment, completed investigations). |
| `why-inspector.service.js` | 41 | Orchestrates the loads, returns `null` for missing/expired/hidden records. |
| `why-inspector.controller.js` | 23 | UUID validation, typed `404 EXECUTION_NOT_FOUND`. |
| `why-inspector.routes.js` | 16 | `GET /executions/:executionId`, read-only. |
| `index.js` | 16 | Barrel. |

Mounted in `backend/src/app.js`:

```js
app.use(
  "/api/v1/why",
  express.json({ limit: LIMITS.jsonBodyDefault }),
  requireWorkspaceAuth,
  resolveProfileContext,
  whyInspectorRouter,
);
```

### 2.2 Frontend — `frontend/src/features/why-inspector/`

| File | Lines | Responsibility |
| --- | --- | --- |
| `why-inspector.api.js` | 11 | Thin transport wrapper. |
| `why-inspector-model.js` | 148 | Pure presentation helpers. **No inference** — labels, tones, ordering, and the precedence ladder are all read from backend-supplied fields. |
| `WhyInspectorDialog.jsx` | 568 | The dialog: roving tabs, availability chips, precedence ladder, pipeline timeline, evidence chain, dense key/value and table layouts. |
| `why-inspector.css` | 568 | Feature-local presentation over the existing design tokens. |

`Why?` entry points: history rows (`HistoryPanel`), the Flight Recorder passport (`FlightRecorderDialog`), and the Investigation dialog (`InvestigationDialog`). Wired through `App.jsx` via `openWhyInspector(executionId)`; each caller closes its own dialog before opening the target, so no two modals stack.

---

## 3. Design decisions

| Decision | Rationale |
| --- | --- |
| **Projection, not a new engine** | The repo already records everything the answer needs. A second source of truth would drift. |
| **Backend owns precedence and derivation** | The frontend must never infer variable precedence, impact, drift, contract compatibility, verification status, or proof validity. The projection exposes the canonical `VARIABLE_SCOPE_ORDER`, its labels, and `appliedScopes`; the UI renders them verbatim. |
| **Fail closed with named states** | Every section is `recorded`, `partial`, or `not_recorded`, and every fail-closed branch carries a stable reason code. A missing section renders "Not recorded", never a silent blank. |
| **Stable empty-section contract** | `emptySection()` returns a superset of every section key, so a consumer reading `configuration.entries` or `dependencies.variables` always gets `[]` rather than `undefined`. |
| **Secrets are never resolved** | The projection reads only the receipt's *evidence* about auth (`mode`, `source`, `referenceKeys`). It never touches `record.request.auth` literals, never calls the secret-alias resolver, and never emits a resolved value. |
| **Bounded output** | `WHY_LIMITS` caps entries (40), variables (100), references (20), stages (12), evidence (40), change comparisons (10), change items (40), verified causes (20), reasons (12), and text (1024 bytes). Overflow is reported as `truncated: true`. |
| **Verification vocabulary is reused** | `VERIFIED` / `BLOCKED` / `NEEDS_REHEARSAL` / `UNKNOWN` come from the Phase 41 cross-environment verification vocabulary; this phase does not coin new states. |

### 3.1 Verification-state derivation (read-model of recorded facts)

The projection derives a state, never invents one, and always reports **why**:

| Precedence | Basis | State |
| --- | --- | --- |
| 1 | `linked_verification` — a linked persisted verification artifact | its own recorded state |
| 2 | `target_policy` — `receipt.policy.decision === "blocked"` | `BLOCKED` |
| 3 | `recorded_assertions` — failed/error > 0 | `NEEDS_REHEARSAL` |
| 3 | `recorded_assertions` — passed > 0, failed+error = 0, outcome `response` | `VERIFIED` |
| 4 | `none` | `UNKNOWN` |

`linked_verification` is a documented extension point: no persisted verification artifact is linked today, so the ladder falls through to recorded policy and recorded assertions. Every response carries `stateBasis` plus `WHY_CAVEAT` so the reader knows which rung answered.

---

## 4. Fail-closed behaviour when provenance is absent

This phase was scoped against a real architectural constraint: impact, drift, cross-environment verification, and proofs are **generated on demand and not persisted**, and there is no workspace-snapshot engine. The honest answer is therefore often "not recorded".

| Situation | Behaviour |
| --- | --- |
| No execution record for the id | `404 EXECUTION_NOT_FOUND` (typed, actionable). |
| Record is expired or hidden | Same typed 404 — no partial leak. |
| No `compileTrace` and no `variableSources` | `dependencies.state = "not_recorded"` + `NO_VARIABLE_REFERENCES`. |
| Request authored without a saved source | `configuration` gap `NO_SOURCE_REFERENCE`. |
| Saved collection/environment revision moved on | `configuration` gap `SOURCE_REVISION_CHANGED`. |
| No completed investigation for the execution | `change.recorded = false` + `NO_CHANGE_EVIDENCE`. |
| Response body not captured | `RESPONSE_NOT_RECORDED` + evidence node marked unavailable. |
| Nothing to derive a verification from | `UNKNOWN` with `stateBasis: "none"`. |

---

## 5. Verification evidence

### 5.1 Automated tests

| Suite | Result |
| --- | --- |
| `backend/src/features/why-inspector/why-projection.test.js` | 23 pass / 0 fail |
| `backend/src/features/why-inspector/why-inspector.routes.test.js` | 9 pass / 0 fail (real MongoDB, real JWT) |
| `frontend/src/features/why-inspector/why-inspector-model.test.js` | 11 pass / 0 fail |
| **Feature total** | **43 pass / 0 fail** |

Coverage highlights: envelope shape; fail-closed missing record; determinism (byte-stable with `generatedAt` nulled); secret exclusion (asserts the serialized explanation never contains the literal credential from `record.request.auth.tokenTemplate`); source-revision drift gap; variable precedence ordering and `appliedScopes`; bounds (150 variables → 100 + `truncated: true`); all seven execution stages recorded; blocked pre-dispatch execution (`policy` recorded, `dns` not recorded); change fail-closed **and** composed investigation; all four verification states plus the precedence ladder; evidence-chain node kinds and ordering; cross-profile isolation (another profile's investigation is never composed).

### 5.2 Repository gates

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | PASS — no manifest or lockfile change |
| `bun test` (repo-wide, the command CI runs) | **1865 pass, 2 skip, 0 fail**, 6606 `expect()` calls, 119 files |
| Backend syntax (`node --check`) on every changed backend file | PASS |
| `cd frontend && bun run build` | PASS — 113 modules |
| `bash setup.sh --seed` | PASS — 1 account, 2 profiles, 4 collections, 4 environments, 2 preferences, 10 demo orders |
| `bun run demo:flight-recorder` | PASS — 47/47 |
| `bun run demo:investigation` | PASS — 14/14 |

### 5.3 Real-browser acceptance — `frontend/scripts/phase49-why-inspector-e2e.mjs`

Driven over CDP against the live seeded instance (app `:3000`, API `:8000`). The script authenticates through the page's own origin and session storage, so it never handles a credential itself.

**`PHASE49_E2E_PASS 20/20`**

| # | Check |
| --- | --- |
| 1 | Login → profile → workspace |
| 2 | A real execution completed through the workspace (seeded "List orders", 200) |
| 3 | Every history row exposes an exactly-labelled `Why?` action |
| 4 | `Why?` opens the Why Inspector dialog |
| 5 | Dialog exposes Configuration / Execution / Change / Evidence |
| 6 | Dialog states the question it answers |
| 7 | Configuration renders real recorded groups, entries, and a verification state |
| 8 | Dependencies record the variable references and the backend precedence ladder |
| 9 | Execution pipeline reports all seven stages as recorded |
| 10 | Change evidence fails closed when nothing recorded it |
| 11 | Evidence chain and projection metadata are rendered |
| 12 | Projection records the credential reference but never a credential value |
| 13 | Unknown and malformed identifiers fail closed with explicit codes (`VALIDATION_ERROR`, `EXECUTION_NOT_FOUND`) |
| 14 | Dialog is read-only: no send, save, or mutate affordance |
| 15 | Passport and `Why?` cross-link in both directions |
| 16 | Tab list is keyboard navigable (ArrowRight / Home / End) |
| 17 | Escape closes the Why Inspector |
| 18 | Renders at 375 / 768 / 1024 / 1440 in both themes with no overflow or clipping |
| 19 | Opening the Why Inspector produces no new execution |
| 20 | No unhandled browser exceptions |

The secret-exclusion check is evidence-based rather than pattern-guessing: it reads the generated demo tokens from `backend/.env` and asserts neither value, no secret alias (`local_token` / `staging_token`), and no `Bearer`/`Basic` credential string appears anywhere in the raw projection JSON — while asserting the recorded **reference key** `orders_token` is present.

---

## 6. Defects found and fixed during acceptance

Both were found by the real browser, not by inspection, and both were fixed with the smallest possible change.

| # | Defect | Root cause | Fix | Regression coverage |
| --- | --- | --- | --- | --- |
| 1 | The dialog could render before its projection fetch resolved, so the section tablist was momentarily absent. | The suite waited for the dialog shell, not its content. | The suite now waits for the section tablist (with a bounded timeout). | E2E checks 4–7. |
| 2 | **The dialog footer was clipped below the viewport at 375px.** | The dialog shell set a `min-height` floor but no viewport cap, so header + wrapped tabs + body exceeded the viewport and the footer was pushed off-screen. | `why-inspector.css`: capped the dialog with `max-height: calc(100dvh - 24px)` and made the section body a proper flex scroll region (`flex: 1 1 auto; min-height: 0; max-height: none`). | E2E check 18, which asserts the footer's bottom edge is inside the viewport at every width × theme. |

**Shared-test-singleton leak (pre-existing hazard, fixed).** `backend/test/verification-proof-api.setup.js` replaced the shared `authService.authenticate` and `profileService.findProfileById` singletons unconditionally. Because `bun test` evaluates every file against one module registry and `verification-proof-api` sorts before `why-inspector`, the stub leaked into the new route suite and turned its expected `400`/`404`/`200` into `401`. The setup now installs **delegating wrappers**: it intercepts only its own `TEST_TOKEN` and synthetic profile id and otherwise calls the captured real implementations. This repairs the hazard for any future suite rather than working around it locally.

---

## 7. Security and privacy

| Check | Result | Evidence |
| --- | --- | --- |
| No resolved secret in any projection | PASS | Projection unit tests + E2E check 12 (compares against the real generated demo tokens). |
| Secret values never resolved by the read-model | PASS | The projection reads only receipt auth *evidence*; it does not call `resolveSecretAlias`. |
| Profile isolation | PASS | Repository queries are `ownerProfileId`-scoped; a cross-profile execution returns typed 404 and a cross-profile investigation is never composed. |
| Read-only surface | PASS | The router exposes only `GET`; the dialog has no send/save/mutate affordance (E2E check 14). |
| No new execution triggered by inspection | PASS | E2E check 19 compares the newest history entry before and after. |
| No LLM generation | PASS | The projection is deterministic pure code. |
| Bounded response | PASS | `WHY_LIMITS` caps every list and every text field. |

---

## 8. What this phase deliberately does not do

- It does not persist impact, drift, verification, or proof results, and therefore cannot show them where nothing recorded them — it says "not recorded" instead.
- It does not add a workspace-snapshot engine (Phase 38 remained a docs-only record).
- It does not resume Phase 10 or Phase 23, and it adds no Postman-parity capability.
- It does not change execution, verification, impact, drift, contract, or proof semantics.

---

## 9. Gates

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | PASS (no changes) |
| `bun test` (repo-wide) | **1865 pass, 2 skip, 0 fail** — 6606 `expect()` calls, 119 files |
| Backend syntax on changed files | PASS |
| `cd frontend && bun run build` | PASS (113 modules) |
| Isolated seed/reset | PASS |
| Demos | PASS (47/47, 14/14) |
| Real-browser Phase 49 suite | **PASS — `PHASE49_E2E_PASS 20/20`** |
| Responsive / theme matrix | PASS at 375 / 768 / 1024 / 1440, dark and light |

---

## 10. Verdict

**PHASE 49 VERDICT: PASS — WHY INSPECTOR READY**
