# API Flight Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Phase 27 API Flight Recorder suite in the mandated order without adding unrelated product features.

**Architecture:** A dedicated `execution-intelligence` backend domain reads immutable history records and owns receipt construction, comparison, capsule handling, and minimization jobs. Narrow hooks attach receipts to execution finalization and expose a focused history-driven frontend dialog; probes call the existing execution service rather than transport directly.

**Tech Stack:** JavaScript/JSX, Bun tests, Express, Zod, Mongoose, React, native fetch.

**Spec:** `docs/superpowers/specs/2026-09-22-api-flight-recorder-design.md`

## Global Constraints

- Keep the root Bun workspace, React, Express, MongoDB/Mongoose, Vite, native fetch, ports, and dependency freeze unchanged.
- No resolved secret may enter a receipt, comparison, capsule, minimization record, log, error, or response.
- No alternate compiler, policy, DNS, transport, capture, normalization, assertion, mock, or portable-project implementation.
- Capsule import yields preview metadata plus an unsent dirty draft; it never persists or dispatches.
- Minimization uses at most 12 probes, verifies predicate stability, supports cancellation, and blocks non-safe methods unless the recorded execution used approved local access.

## Review Focus

- Low-entropy secret values must not leak through unkeyed body or request hashes; use the existing keyed fingerprint boundary.
- Old history records without receipts must fail with a clear compatibility response, not crash comparison or export.
- Duplicate response headers and array/object JSON shape changes must produce deterministic contract results.
- A process restart must not leave a persisted minimization job permanently “running”; status reconciliation marks it interrupted.
- Hidden minimization probes must remain persisted for audit but absent from normal history lists.

---

### Task 1: Execution Passport / `ExecutionReceiptV1`

**Files:**
- Create: `backend/src/features/execution-intelligence/execution-receipt.js`
- Create: `backend/src/features/execution-intelligence/execution-receipt.test.js`
- Modify: `backend/src/features/history/history.model.js`
- Modify: `backend/src/features/executions/execution.service.js`

**Interfaces:**
- Produces: `buildExecutionReceipt(input) -> ExecutionReceiptV1` and history field `receipt`.
- Consumed by: Tasks 2–4.

- [ ] Write failing tests proving versioned receipt shape, keyed fingerprints, JSON shape extraction, source revisions, target/policy metadata, response metadata, and complete secret omission.
- [ ] Run `cd backend && bun test src/features/execution-intelligence/execution-receipt.test.js`; expect failures because the module does not exist.
- [ ] Implement `buildExecutionReceipt` as a pure bounded builder and attach its output on every terminal execution path.
- [ ] Add `receipt` to terminal results and history persistence without changing transport semantics.
- [ ] Run the focused tests and `bun test`; expect all passing.
- [ ] Commit with `Add execution passports`.

### Task 2: Causal Run Comparison / `RunComparisonV1`

**Files:**
- Create: `backend/src/features/execution-intelligence/run-comparison.js`
- Create: `backend/src/features/execution-intelligence/run-comparison.test.js`
- Create: `backend/src/features/execution-intelligence/execution-intelligence.service.js`
- Create: `backend/src/features/execution-intelligence/execution-intelligence.controller.js`
- Create: `backend/src/features/execution-intelligence/execution-intelligence.routes.js`
- Modify: `backend/src/app.js`

**Interfaces:**
- Consumes: two persisted `ExecutionReceiptV1` records.
- Produces: `compareReceipts(base, candidate) -> RunComparisonV1`, `GET /receipts/:executionId`, and `POST /comparisons`.

- [ ] Write failing tests for source, auth, compiled request, DNS target, policy, transport, status, header-count, JSON removed-path/type-change, binary, and truncated-body comparisons.
- [ ] Run the focused test and verify the missing-module failure.
- [ ] Implement deterministic ordered change categories and select the first divergence from evidence order.
- [ ] Implement lightweight contract checks without parsing bodies beyond the stored bounded shape.
- [ ] Add strict Zod route inputs and profile-scoped history lookup; old records without receipts return `RECEIPT_UNAVAILABLE`.
- [ ] Run focused route/service tests and `bun test`; expect all passing.
- [ ] Commit with `Add causal execution comparison`.

### Task 3: Reproduction Capsule / `ReproCapsuleV1`

**Files:**
- Create: `backend/src/features/execution-intelligence/repro-capsule.js`
- Create: `backend/src/features/execution-intelligence/repro-capsule.test.js`
- Modify: `backend/src/features/execution-intelligence/execution-intelligence.service.js`
- Modify: `backend/src/features/execution-intelligence/execution-intelligence.controller.js`
- Modify: `backend/src/features/execution-intelligence/execution-intelligence.routes.js`

**Interfaces:**
- Consumes: history request snapshot, receipt, and deterministic failure predicate.
- Produces: `buildReproCapsule(record)`, `parseReproCapsule(text)`, `POST /capsules/export`, and `POST /capsules/import`.

- [ ] Write failing round-trip and adversarial secret tests for auth, headers, query strings, JSON/text bodies, response bodies, errors, cookies, malformed JSON, unsupported versions, and oversized capsules.
- [ ] Run the focused test and verify the missing-module failure.
- [ ] Implement canonical versioned serialization using portable request semantics and a placeholder manifest; unsafe literals become `[REQUIRED_INPUT]` or are omitted.
- [ ] Import to `{ draft, warnings, receiptSummary }` only; do not call collection, history, mock, or execution persistence.
- [ ] Run focused route/service tests and `bun test`; expect all passing.
- [ ] Commit with `Add redacted reproduction capsules`.

### Task 4: Failure Minimizer / `MinimizationJobV1`

**Files:**
- Create: `backend/src/features/execution-intelligence/minimization.model.js`
- Create: `backend/src/features/execution-intelligence/minimization.repository.js`
- Create: `backend/src/features/execution-intelligence/failure-minimizer.js`
- Create: `backend/src/features/execution-intelligence/failure-minimizer.test.js`
- Modify: `backend/src/features/executions/execution.service.js`
- Modify: `backend/src/features/execution-intelligence/execution-intelligence.service.js`
- Modify: `backend/src/features/execution-intelligence/execution-intelligence.controller.js`
- Modify: `backend/src/features/execution-intelligence/execution-intelligence.routes.js`

**Interfaces:**
- Consumes: a source history record, a deterministic status/outcome/assertion predicate, and internal `executionService.send(profileId, input, { rateLimit, visible })`.
- Produces: persisted `MinimizationJobV1` plus start/status/cancel endpoints.

- [ ] Write failing pure-algorithm tests for query/header/JSON-field reduction, 12-probe budget, stable baseline, flaky predicate, cancellation, and no-input cases.
- [ ] Write failing service tests proving GET/HEAD/OPTIONS allowance, unsafe-method rejection, approved-local exception, hidden probe persistence, SSRF path reuse, and interrupted-job reconciliation.
- [ ] Run focused tests and verify failures before production code.
- [ ] Implement bounded delta reduction with injected probe function; never call transport directly.
- [ ] Persist profile-scoped jobs and keep active AbortControllers in memory; status reconciles orphaned running jobs.
- [ ] Add the narrow internal send options while leaving public execution input unchanged.
- [ ] Run focused tests and `bun test`; expect all passing.
- [ ] Commit with `Add bounded failure minimization`.

### Task 5: History-Driven Flight Recorder UI

**Files:**
- Create: `frontend/src/features/execution-intelligence/execution-intelligence.api.js`
- Create: `frontend/src/features/execution-intelligence/flight-recorder-model.js`
- Create: `frontend/src/features/execution-intelligence/flight-recorder-model.test.js`
- Create: `frontend/src/features/execution-intelligence/FlightRecorderDialog.jsx`
- Modify: `frontend/src/features/history/HistoryPanel.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: Phase 27 API endpoints.
- Produces: keyboard-accessible Passport, Compare, Capsule, and Minimize workflows from history.

- [ ] Write failing frontend model tests for ordered evidence groups, contract severity labels, capsule-to-dirty-draft conversion, minimization state, and compatibility errors.
- [ ] Run focused tests and verify failures.
- [ ] Implement the API module and pure view-model helpers.
- [ ] Add an Analyze action per history item, two-run comparison selection, capsule download/import preview, and minimization start/status/cancel controls.
- [ ] Keep imported drafts unsent and unsaved; open them through the existing draft-tab boundary.
- [ ] Run frontend tests and production build; expect all passing.
- [ ] Commit with `Add Flight Recorder workspace UI`.

### Task 6: Phase 27 Gate and Baseline Gate

**Files:**
- Modify only if verification exposes a real Phase 27 regression.

**Interfaces:**
- Consumes: all Phase 27 deliverables.
- Produces: auditable phase verdict.

- [ ] Run focused backend and frontend Phase 27 tests.
- [ ] Run backend syntax checks for every changed backend source file.
- [ ] Run root `bun test` and `cd frontend && bun run build`.
- [ ] Run browser smoke at 375, 768, 1024, and 1440 widths for Passport, Compare, Capsule import/export, and Minimize/cancel.
- [ ] Run the repository Baseline Gate and designated validation skill checks applicable before submission.
- [ ] Review the complete branch for secret leakage, authorization, alternate execution paths, and scope creep.
- [ ] Commit verified fixes, leave the worktree clean, and report `PHASE 27 VERDICT: PASS` only when every required command has evidence.

