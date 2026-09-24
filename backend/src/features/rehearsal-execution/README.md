# Phase 46C — Checkpointed Cross-Environment Rehearsal Integration

The rehearsal **executor**: a thin orchestrator that binds the completed rehearsal
cores together and drives them through Tracer's **existing** execution path.

```
Impact + Drift
   -> 46A Rehearsal Plan
   -> 45A Blast-Radius Safety (admission + runtime abort)
   -> 46B Checkpoint Run (durable, resumable)
   -> existing execution path (executionService.send)
   -> 43 Contract Compatibility
   -> 41 Cross-Environment Verification evidence
```

## What this module is

- A **conductor**, not a second runner. It owns no transport, no request
  resolution, no variable scope, and no persistence of its own.
- Backend-only. No routes, no HTTP server, no frontend, no CLI.

## What this module is not

- It is not a replacement for the Phase 13 Collection Runner. Collection-run
  variable/run-scope semantics stay in Phase 13. The executor performs **one
  ordinary execution per eligible step** and nothing more.
- It does not send anything through a new HTTP client. Every step goes through
  `executionService.send`, the same path the app and the Collection Runner use.
- It does not auto-confirm, auto-retry, or invent a result.

## Public surface (`index.js`)

```js
import {
  createRehearsalExecutor,
  runRehearsal,
  deriveRunBinding,
  EXECUTOR_ERROR_CODES,
  EXECUTOR_STOP_REASONS,
  EXECUTOR_LIMITS,
  CONTRACT_STATUS,
} from "./rehearsal-execution/index.js";
```

### `createRehearsalExecutor(deps?) -> { run }`

Every dependency is injectable so the executor is deterministic under test:

| Dependency | Default | Purpose |
| --- | --- | --- |
| `checkpoints` | `createRehearsalCheckpointService()` | Phase 46B run lifecycle + CAS persistence |
| `executions` | `{ send: executionService.send }` | the existing single-request execution path |
| `contractCompatibility` | `{ compare: compareContractToResponse }` | Phase 43 |
| `verify` | `verifyCrossEnvironment` | Phase 41 |
| `abortEvaluator` | `evaluateAbort` | Phase 45A runtime guard |
| `now` | `() => new Date()` | clock |
| `newExecutionId` | `randomUUID` | execution identity |
| `newOwner` | `exec-<uuid>` | worker identity for the checkpoint CAS |

### `run(profileId, input) -> report`

Input (wrapper validated by `parseExecutorInput`; `plan`/`blastRadius` validated by
their owning cores):

```js
{
  plan,                 // required: the exact Phase 46A plan
  blastRadius,          // required: the Phase 45A envelope the plan was built against
  environment: {        // required: the plan's target environment
    environmentId,
    environmentFingerprint,
    environmentName?,   // omitted when null, never null
  },
  snapshot?,            // may complete a half-specified plan snapshot; never contradicts it
  runId?,               // defaults to a deterministic id derived from the plan fingerprint
  owner?,               // defaults to a unique worker id
  contracts?,           // Map | Array | object keyed by requestId
  resolveContract?,     // (step) => contract | null
  resolveRequest?,      // (step) => request   — required for scratch (collection-less) steps
  verification?,        // Phase 41 input extras (source/snapshotDiff/drift/impact)
  freshness?,           // Phase 41 freshness policy
  signal?,              // AbortSignal
  deadlineAt?,          // Date | ISO-8601 | epoch millis
  maxSteps?,            // per-invocation step budget
}
```

Report:

```js
{
  kind: "tracer.rehearsal-execution",
  schemaVersion: 1,
  runId, runState, generation, owner,
  planFingerprint, identityFingerprint,
  terminated, stopReason,        // EXECUTOR_STOP_REASONS.*
  executedStepIds[], skippedStepIds[], completedStepIds[],
  abort,                         // { decision, reasonCodes, reasonCode } | null
  evidence: { executions[], assertions[] },   // Phase 41-shaped, bounded, redacted
  verification,                  // Phase 41 result | null
  stepOutcomes[], reasonCodes[],
  run: presentRun(run),          // Phase 46B presentation
}
```

## Guarantees

1. **Exact-plan acceptance.** A plan that is `UNRESOLVED`, empty, larger than the
   step limit, internally inconsistent (steps vs `executableRequestIds`), or that
   contains a non-`EXECUTABLE` step is refused with
   `REHEARSAL_EXECUTOR_PLAN_NOT_EXECUTABLE`.
2. **Identity fails closed.** Environment, snapshot, and blast-radius policy
   identities must agree with the plan. A mismatch is
   `IDENTITY_MISMATCH` / `BLAST_RADIUS_MISMATCH`; a missing required token is
   `MISSING_IDENTITY`. Nothing is invented to fill a gap.
3. **Admission is re-checked.** Every executable step must still be `ADMITTED` in
   the supplied envelope, even if the plan claims otherwise
   (`STEP_NOT_ADMITTED`).
4. **One run per plan.** The run id is deterministic from the plan fingerprint, so
   a retried invocation resumes the same run.
5. **Generation is claimed.** The executor resumes (never "starts") the run, so a
   stale worker cannot checkpoint. `beginStep`/`checkpointStep`/`releaseStep` do not
   advance the generation, so the claimed generation is reused for every write in
   one pass.
6. **Completed steps never re-execute.** Phase 46B returns only pending work, and
   a terminal run is returned as-is (`stopReason: TERMINAL`) without dispatch.
7. **In-flight steps are never blindly replayed.** Before dispatching a step the
   executor calls `beginStep`, which durably marks it `IN_PROGRESS`. A crash
   between the remote request and the checkpoint leaves that marker behind, so a
   later resume fails closed with `STEP_IN_DOUBT` rather than replaying a request
   whose side effect is unknowable. A dispatch that is cancelled or times out is
   `releaseStep`d back to `PENDING`, because an aborted request has no side effect
   to protect against.
8. **Abort stops immediately.** Phase 45A is evaluated after every result; on
   `ABORT` the run is aborted and no further step is dispatched.
9. **Bounded, redacted evidence.** Checkpoints carry only flat scalar metadata;
   evidence carries no bodies, credentials, cookies, or tokens. Overflow is
   reported (`EVIDENCE_LIMIT`) rather than silently truncated.
10. **Missing evidence is never VERIFIED.** A contract that is absent, or that
    cannot be compared (draft, identity mismatch, malformed), produces **no**
    assertion record — absence, not a fabricated pass.

## Step semantics

| Execution result | Checkpoint | Run |
| --- | --- | --- |
| any known terminal outcome | step `COMPLETED` (HTTP outcome in metadata/evidence) | continues unless abort |
| `cancelled`, or signal aborted | step `releaseStep`d back to `PENDING` | `PAUSED` (`CANCELLED`) |
| deadline reached | step stays `PENDING` (not yet claimed) | `PAUSED` (`DEADLINE_EXCEEDED`) |
| step budget reached | step stays `PENDING` (not yet claimed) | `PAUSED` (`STEP_BUDGET`) |
| previous worker left a step `IN_PROGRESS` | no dispatch; step stays `IN_PROGRESS` | `FAILED` (`STEP_IN_DOUBT`) |
| unknown outcome | — | `FAILED` (`STEP_OUTCOME_MISSING`) |
| execution throws / step unresolved | — | `FAILED` (`PLAN_INCOMPLETE` / `INTERNAL_ERROR`) |
| 45A abort | — | `ABORTED` (mapped 46B reason code) |
| all steps terminal | all `COMPLETED` | `COMPLETED` |

## Resume progress

Abort limits are computed from the run's **persisted** step metadata, so a resumed
run does not reset failure/consecutive-failure counters to zero. Completed steps
always form a prefix because checkpoints are written in plan order.

## Tests

`rehearsal-execution.test.js` drives the real 46A planner, the real 45A policy,
the real 46B checkpoint service (in-memory CAS repository), and the real 43 and 41
cores, with only the execution path and clock injected.
