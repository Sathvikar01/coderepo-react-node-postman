# Phase 35 — Investigation Engine

Branch `phase35/investigation-engine` → `main`. Composes the merged Phase 31–34
workspace modules into one deterministic InvestigationV1 workflow (Workflow 5).
No second execution engine, no AI inference, no confidence percentages.

## Contract

`POST /api/v1/execution-intelligence/investigations` → 202 `{investigationId}`,
background run; `GET .../investigations/:id` → status/result;
`POST .../investigations/:id/cancel`; `GET .../investigations/:id/capsule`.

`InvestigationV1` (`tracer.investigation`, schemaVersion 1) sections:
`summary`, `regressionBoundary`, `comparison`, `interventions`, `verifiedCauses`,
`unverifiedChanges`, `minimization`, `reproducibility`, `reproductionCapsule`,
plus `stages.completed` / `stages.interruptedAt` and an `evidence` block whose
every conclusion references concrete execution/probe ids.

## Orchestration

1. **Regression boundary** — Phase 33 `buildTimeline` over collection lineage
   (`source: "phase33"`), or an explicitly provided `goodExecutionId`
   (`source: "provided"`). Unresolvable boundaries are recorded truthfully
   (`NO_HISTORY`, `NO_KNOWN_GOOD`, `BOUNDARY_NOT_ADJACENT`, `AMBIGUOUS_LINEAGE`)
   and later stages degrade instead of inventing.
2. **Comparison** — Phase 32 `compareReceipts`; without a good base the section
   is `available: false` with `no_good_execution`.
3. **Counterfactual verification** — Phase 31 `counterfactualService.analyze`.
   Safety refusals degrade truthfully: unsafe mutating requests produce
   `not_replayable` rows with `unsafe_mutating_request_not_replayed` and zero
   probes; budget/input refusals are recorded `inconclusive` with the real reason.
4. **Failure minimization** — Phase 27 `minimizeFailure` over the same probe
   seam, with `probeBudget` and a record-level `probePermission` gate.
5. **Reproducibility** — reproduction series over the minimized (else failing)
   request: `reproducible` / `flaky` / `not_reproduced` / `inconclusive`.
6. **Capsule** — redacted ReproCapsuleV1 from the minimized request; round-trips
   through the Phase 7 import boundary as an unsent dirty draft
   (`autoSend: false`, `autoSave: false`).

## Truthfulness labels

`verified_cause` (strict evidence rule below), `leading_divergence`,
`correlated_change`, `unverified`, `not_replayable`, `inconclusive`.

`verifiedCauses` may contain **only** deltas whose Phase 31 item is classified
`causal` and carries both probe ids with `applied.predicateMatched === true` and
`reverted.predicateMatched === false`. `buildInvestigationV1` throws
`AppError(422, "INVESTIGATION_EVIDENCE_INVALID")` and never publishes anything
otherwise. Provenance of each cause: `source: "phase31_counterfactual"`.
Comparison-only changes are never promoted to causes.

Cancellation degrades truthfully: cancelled stages keep partial evidence,
stages that never ran report `skipped` with `not_reached_after_cancellation`
(after cancellation) or `not_reached`, and hard crashes leave a usable record
(`INVESTIGATION_INTERRUPTED`).

## Verification matrix

`investigation.test.js` (10 tests) + `investigation.service.test.js` (22 tests):
causal + unverified deltas; no known-good; AMBIGUOUS_LINEAGE; leading/correlated
labelling; nested JSON cause; determinism (byte-identical normalized results);
minimization budget_limited; flaky (`MINIMIZATION_FLAKY`); not_reproduced;
zero secret leakage (result + capsule); unsafe mutating zero-probe degradation;
unsafe local + explicit confirmations runs fully; policy-blocked (SSRF-style)
dispatches zero network calls; profile isolation; cancellation at every stage
entry plus mid-minimization; restart interruption (`INVESTIGATION_INTERRUPTED`);
capsule round-trip as dirty unsent draft; and the proof that `verifiedCauses`
cannot contain an unproven delta (builder rejects).

Evidence: `bun test` 765 pass / 2 skip / 0 fail (71 files); `node --check` clean
across `backend/src`; frontend build clean; `bash setup.sh --seed` clean
(`Investigation` included in the deterministic reset); runtime smoke
(backend :8000 health `ok`, database `connected`; frontend :3000 HTTP 200);
`bun run demo:investigation` **14/14**, ending with exactly the requested
reproduction (failing request → proven cause → smallest reproducer →
3/3 reliable reproduction → safe capsule importing as a dirty unsent draft);
`bun run demo:flight-recorder` **47/47**; Tracer CLI `bun test src/features/cli`
**99/99**.

## Decisions

- Investigation results persist as a new `Investigation` model, profile-scoped,
  cleaned by the seed reset — never mixed into the history domain.
- One AbortController per run (per-instance registry, so a restart cannot cancel
  a stale run id); `signal` is forwarded to every real execution probe.
- Stage-not-reached vs cancelled is distinguished (`not_reached` vs
  `not_reached_after_cancellation`) and `stages.interruptedAt` is cleared when
  the run finishes, so completed results cannot carry a false interruption.
- Minimized request becomes the capsule only when minimization completed;
  otherwise the capsule holds the sanitized failing request and says so
  (`requestSource: "failing"`).
