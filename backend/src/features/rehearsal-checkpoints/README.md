# Rehearsal Checkpoint Core (Phase 46B)

Persistent, crash-safe state for a cross-environment rehearsal run.

This module answers one question:

> How do we checkpoint a rehearsal after each completed step, and resume safely
> without repeating completed work or letting a stale worker keep going?

It is **state and checkpoint semantics only**. It does not execute HTTP, does not
integrate with the Collection Runner, does not check contracts, and does not know
how a step is performed. A later phase supplies the executor; this core supplies the
durable state machine that makes an interrupted rehearsal resumable.

## Composition seam

```
Blast Radius Policy (Phase 45)  ->  Rehearsal Checkpoint Core (46B)  ->  Rehearsal Executor
```

`blast-radius-policy` names "Checkpointed Rehearsal" as a downstream consumer. This
core is that seam's state layer. The executor is deliberately out of scope.

## Guarantees

| Guarantee | How it is enforced |
|---|---|
| **Immutable run identity** | workspace / snapshot / target environment / plan / policy are written once, fingerprinted, and re-verified on every mutating call and every resume. A mismatch names the exact differing fields. |
| **Strict lifecycle** | `CREATED → RUNNING ⇄ PAUSED → COMPLETED / ABORTED / FAILED`. Terminal states have no outgoing transition, and terminal protection is checked *before* any other rule. |
| **Stale-worker protection** | Ownership is a `generation` epoch. Claim/resume/reclaim atomically `$inc` it under a CAS filter; a worker holding an old generation matches nothing. |
| **Exactly-once completion** | A repeated completion with the *same* completion identity is an idempotent no-op; a *contradictory* one is refused with a typed 409. The attempt counter is incremented only by a genuine advance. |
| **Crash-safe resume** | Resume recomputes pending work from persisted state only. Completed and skipped steps are never rescheduled. |
| **Self-consistent derived state** | `completedStepIds` and the `current`/`next` step pointers are derived *inside* the atomic write from the step array after the change — never from a caller's stale read — so two concurrent checkpoints of different steps cannot erase each other. |
| **Data minimization** | Only identities, fingerprints, statuses, and bounded evidence references are persisted. No request bodies, headers, cookies, tokens, or resolved secrets. Credential-shaped values are rejected at the boundary. |
| **Tenant isolation** | Every read and write is constrained by `ownerProfileId`. The unique index is `(ownerProfileId, runId)`, so the same run id is independent across profiles. |

## Files

| File | Responsibility |
|---|---|
| `reason-codes.js` | Closed vocabularies: run states, step states, reason codes, error codes. |
| `checkpoint-schema.js` | Zod validation, fail-closed, with credential-shape screening and size bounds. |
| `run-lifecycle.js` | Transition tables and pure predicates shared by service, repository, and tests. |
| `run-identity.js` | Identity binding, canonicalization, fingerprinting, and field-by-field diffing. |
| `checkpoint-canonical.js` | Deterministic checkpoint serialization, step-completion identity, derived pointers. |
| `checkpoint.model.js` | Mongoose model: one document per run, unique `(ownerProfileId, runId)` index. |
| `checkpoint.repository.js` | Every mutation is a single atomic `findOneAndUpdate` whose *filter* encodes the concurrency contract. |
| `rehearsal-checkpoint.service.js` | The semantics: lifecycle, ownership, exactly-once accounting, crash-safe resume. |
| `index.js` | Public surface. |

## Persistence design

There is **no separate per-step collection**. A step's state is only meaningful as
part of one run's ordered accounting, and splitting it would turn "exactly-once"
into a cross-document problem with no single-document CAS to enforce it. One run is
one document, one atomic write per state change.

The step checkpoint write is an **aggregation-pipeline update**, not a plain `$set`.
The derived `completedStepIds` mirror and the next/current pointers are computed from
the step array *after* the positional change, within the same atomic operation. A
plain `$set` would require precomputing them from a read taken before the write, so
two concurrent checkpoints of different steps would each write a "completed" list
that predates the other and one would silently erase the other's progress. Deriving
them in the write makes the flat mirror provably agree with the step array in every
interleaving.

## Tests

- `rehearsal-checkpoints.test.js` — semantics against an in-memory repository that
  models the same CAS contract. Runs without a database.
- `rehearsal-checkpoints.persistence.test.js` — the same guarantees against real
  MongoDB: real unique indexes, real atomic filters, real concurrent writers,
  restart/resume cycles. Skips cleanly when no database is reachable.

Run:

```sh
cd backend
bun test src/features/rehearsal-checkpoints
```

## Seam for the executor (not implemented here)

A rehearsal executor will, for each pending step:

1. `resumeRun(...)` to obtain the authoritative pending-step list and its generation,
2. do the work with its own execution/transport path,
3. `checkpointStep(...)` with the generation it was granted and the evidence
   reference of what it did.

Anything the executor does that is not a `checkpointStep` at the current generation
is invisible to the checkpoint, which is what makes a crash between steps safe: the
durable state only ever advances at recorded step boundaries.

### Adapter from a Phase 46A plan

The planner (Phase 46A) produces a deterministic plan whose `steps[]` carry
`stepId`, `requestId`, `collectionId`, and `ordinal`. The checkpoint core is
deliberately narrower — it needs only *what must run and in what order*, never the
request payload — so the adapter is mechanical and lossless for identity purposes:

```js
const identity = {
  workspaceId: plan.workspace.workspaceId,
  snapshotId: plan.snapshot.snapshotId,
  snapshotFingerprint: plan.snapshot.snapshotFingerprint,
  targetEnvironment: {
    environmentId: plan.target.environmentId,
    environmentFingerprint: plan.target.snapshotFingerprint,
  },
  planId: persistedPlanId,
  planFingerprint: plan.identity.planFingerprint,
  policyId: plan.blastRadius.policyIdentity,
};
const planForCheckpoint = {
  steps: plan.steps.map((step) => ({ stepId: step.stepId, refId: step.requestId })),
};
```

Both phases fingerprint through the same `fingerprintOf` / `fingerprintKeyId`
primitive from `history/fingerprint.js`, so a plan fingerprint computed by the
planner is directly comparable to the one bound into a run's identity here. A plan
that changes in any identity-bearing way produces a different fingerprint, and
therefore a run whose identity no longer matches — which the identity-binding
check refuses by name.

One deliberate asymmetry: the planner accepts a snapshot or target identified by
*either* an id or a fingerprint, because it may be planning from partial metadata.
A checkpointed run requires **both** the id and the fingerprint, because "resume
under the same premises" is not checkable with an id alone — an environment can be
edited without changing its id. A plan that never had a frozen snapshot fingerprint
cannot bind a run. That is fail-closed on purpose: an unidentifiable rehearsal is
refused rather than resumed against premises nobody can prove.
