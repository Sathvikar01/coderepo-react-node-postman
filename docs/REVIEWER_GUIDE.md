# Tracer Reviewer Guide

This document is the fastest way to understand and demo the shipped product.

## 30-second pitch

**Tracer is an API execution, investigation, and change-verification workspace.**

A conventional HTTP client answers: *what did this request return?*

Tracer continues:

1. **How exactly did it execute?**
2. **What changed when it stopped working?**
3. **What does this change affect?**
4. **Can the affected workflow be rehearsed safely?**
5. **What evidence makes this state VERIFIED, BLOCKED, NEEDS_REHEARSAL, or UNKNOWN?**
6. **Why did Tracer reach that result?**
7. **What happens when another developer changes the same shared API workspace?**

The request builder is the substrate. The differentiator is the evidence system around each execution, plus conflict-safe shared workspace collaboration: live saved-state updates, immutable resource versions, attributed CAS conflicts, and restore-as-new-revision.

```text
Execute → Understand → Compare → Verify
   \____________ Why? ____________/
```

## What to show first

If a reviewer only gives you two minutes, do this:

1. Send **Orders API → Read → List orders**.
2. Open **History → Why?**.
3. Show:
   - effective configuration,
   - where variables/auth came from,
   - ordered execution stages,
   - explicit missing/unknown evidence instead of guessed conclusions.
4. Cross-link to **Passport**.
5. Explain: **“React never decides that this execution is verified. Phase 41 is the authority; Why? only explains recorded evidence.”**

That single path demonstrates the central product idea better than walking through every Postman-like feature.

## Five-minute differentiator demo

### 1. Execute

Send a seeded Orders request.

Point out that every send passes through one backend-owned pipeline:

```text
compile → policy → DNS → transport → capture → normalize → history
```

The browser never sends arbitrary target HTTP directly.

### 2. Understand

Open the **Execution Passport**.

Show:

- compiled request evidence,
- variable/auth sources,
- target-policy decision,
- timings,
- response contract,
- secret-redacted identity.

The Passport is evidence from the actual execution, not a reconstruction from today's editable request.

### 3. Investigate

Compare a passing and failing execution.

Explain the distinction:

- **first divergence / correlated change** = evidence worth inspecting;
- **verified cause** = an intervention actually reproduced the failure and reversing it removed the failure.

Tracer deliberately does not turn chronology into causation.

Use **Minimize** to reduce a failing request under a bounded probe budget, then export a redacted reproduction capsule. Import opens an **unsent, unsaved draft**.

### 4. Verify

The verification story is:

```text
edit
 ↓
snapshot identity
 ↓
impact
 ↓
drift
 ↓
rehearsal
 ↓
contract compatibility
 ↓
Phase 41 verification
 ↓
Verification Proof
```

Important: the shipped verification artifacts bind to an explicit snapshot identity/fingerprint. Do not describe a separate persisted snapshot product surface where one was not recorded.

### 5. Explain the result

Open **Why? → Evidence**.

Without a linked Phase 41 result, verification stays **UNKNOWN**.

Attach an exported Verification Proof for this read only. The artifact goes to the backend; React does not validate or persist it.

Then show:

```text
Configuration
 ↓
Execution
 ↓
Impact
 ↓
Drift
 ↓
Rehearsal
 ↓
Contract
 ↓
Phase 41 Verification
 ↓
Phase 47 Proof
```

Point out explicit link states:

- `not_recorded`
- `identity_mismatch`
- `STALE`
- `INVALID`

A stale proof is never painted as a current green pass.

### 6. Collaborate live

> Tracer provides live workspace synchronization and conflict awareness, not character-level collaborative editing.

Strongest demo path, with two signed-in browsers (Alex OWNER, Jordan EDITOR) in **API Platform Team**:

```text
Jordan edits → Alex receives the live change → compare versions → concurrent conflict → restore old version as new revision
```

1. Jordan saves the shared collection → Alex's UI follows the tip with a toast, no reload.
2. Alex opens **Versions** from the collection menu, selects v1, and compares structured paths (`requests[id=…].method`) against current.
3. Alex dirties a request draft; Jordan saves again → Alex keeps the draft and gets a remote-change banner (Compare / Reload remote / Keep editing).
4. Alex saves the stale draft → the attributed 409, then Reload.
5. Alex restores v1 → a new revision (v4), never a history rewrite; Jordan sees v4 live.
6. Demote Jordan to VIEWER → controls go read-only immediately; remove Jordan → the stream closes and the client falls back to an authorized workspace.

Version snapshots hold the saved canonical definition only: `secretRef` aliases without values, reference-only auth templates, and redacted header/query credentials.

## Architecture in one diagram

```mermaid
flowchart LR
    UI["React UI<br/>Workspace · History · Passport<br/>Investigation · Proof · Why?"]
    API["Express API<br/>auth · profile/workspace scope · validation"]

    subgraph COLLAB["Shared workspace collaboration"]
      WS["membership + roles"]
      SAVED["collections/environments<br/>revision CAS"]
      VER["20 immutable versions<br/>compare · restore"]
      SSE["authenticated SSE<br/>freshness only"]
      WS --> SAVED --> VER
      SAVED --> SSE
    end

    subgraph EXEC["Single execution boundary"]
      C["compile"]
      P["target policy"]
      D["DNS + pin"]
      T["native transport"]
      N["capture + normalize"]
      H["history + Passport"]
      C --> P --> D --> T --> N --> H
    end

    subgraph VERIFY["Evidence / verification"]
      I["Impact"]
      R["Drift"]
      RH["Rehearsal"]
      CC["Contract"]
      V["Phase 41<br/>authoritative state"]
      PF["Phase 47 Proof"]
      W["Why?<br/>projection only"]
      I --> V
      R --> V
      RH --> V
      CC --> V
      V --> PF
      I --> W
      R --> W
      RH --> W
      CC --> W
      V --> W
      PF --> W
    end

    DB[("MongoDB")]
    TARGET["Approved targets"]

    UI --> API
    API --> WS
    API --> C
    SSE --> UI
    SAVED --> DB
    VER --> DB
    H --> DB
    H --> W
    API --> DB
    T --> TARGET
```

## Truth ownership

| Output | Who owns it? | What the UI may do |
| --- | --- | --- |
| Effective request/configuration | compiler + execution receipt | display provenance |
| Execution facts | execution pipeline/history | display |
| Investigation conclusion | investigation engine | display evidence/reason |
| Impact | Phase 39 | display |
| Drift | Phase 40 | display |
| Contract compatibility | Phase 43 | display |
| Rehearsal/run state | Phase 46 | display |
| VERIFIED / BLOCKED / NEEDS_REHEARSAL / UNKNOWN | **Phase 41** | display only |
| Proof integrity/currentness | Phase 47 | display only |
| Why explanation | Why read-model | compose existing evidence only |
| Shared workspace membership / role | workspace service + persisted membership | display backend capabilities |
| Saved collection/environment revision | resource CAS in backend services | keep local draft, never silently merge |
| Version history / restore | immutable version rows + CAS restore | inspect/compare/request restore |
| Live update event | SSE broker (advisory only) | reload canonical state |
| Human review decision (APPROVED / CHANGES_REQUESTED / WAIVED) | **review participants** (OWNER/EDITOR) | record beside evidence; never rewrite it |
| Review freshness (CURRENT / STALE) | frozen-evidence comparison | display; re-review from current evidence |

The rule to remember:

> **Missing evidence never becomes a pass.**

> **Machines determine technical truth; humans determine what the team chooses to do about that truth.** `technicalState != reviewDecision`: a `WAIVED` review on `BLOCKED` evidence still displays BLOCKED.

## Why this is not just a Postman clone

Tracer still has the substrate expected from an HTTP client: requests, collections, environments, history, response inspection, runner, import/export, cookies, examples, mocks, CLI, and related workflows.

But the product thesis is different:

> **A request should be explainable after it executes, diagnosable after it fails, and verifiable after it changes.**

The differentiators are the linked evidence workflows:

- Execution Passport / Flight Recorder
- evidence-driven Investigation
- bounded minimization + reproduction capsule
- impact and drift evidence
- checkpointed rehearsal with fail-closed uncertainty
- contract compatibility
- authoritative cross-environment verification
- tamper-evident Verification Proof
- WHY Inspector across the full chain
- live multi-user workspace synchronization with conflict-safe drafts
- immutable collection/environment version history with compare + restore-as-new-revision
- human review & decision workflow bound to frozen evidence (Reviews tab)

### Review queue in one minute

Open the sidebar **Reviews** tab: the Needs Attention summary counts breaking findings, blocked states, and items assigned to you. Open a review to see four sections — **Finding | Evidence | Discussion | Decision**. Approve or waive a `BLOCKED` item and watch the technical state stay `BLOCKED`: the decision is recorded beside the evidence, never over it. Change the underlying resource and recheck freshness: the review goes `STALE` with the changed fields named, old comments and decisions intact, and **Create re-review** links a fresh review forward.

## Likely reviewer questions

### “Why not let the frontend compute verification?”

Because verification is a trust boundary. If React can recompute or upgrade the state, two clients could disagree about whether the same evidence is safe. Phase 41 owns the state; the UI only renders it.

### “What happens when evidence is missing?”

Tracer fails closed. Missing Phase 41 evidence means `UNKNOWN`, not VERIFIED. Missing links appear as `not_recorded`; mismatched identities remain visible instead of being joined heuristically.

### “Why does Why? need a proof attachment?”

Proof artifacts are intentionally not persisted server-side by the proof import flow. The Why dialog can attach one for a single read. The backend's existing Phase 47 importer verifies it; the browser stores it only in component state.

### “What does STEP_IN_DOUBT mean?”

It protects mutating rehearsal steps from blind replay. If a remote side effect may have occurred but the durable checkpoint is ambiguous, Tracer stops rather than claiming exactly-once remote behavior it cannot prove.

### “Is the live collaboration Google-Docs-style realtime editing?”

No. Tracer synchronizes **saved resource state**, roles, membership and activity live. It intentionally does not synchronize keystrokes or cursors. If Alex and Jordan edit the same saved request concurrently, each keeps their own local draft; the first valid CAS save wins and the stale save receives an attributed `409`. That is safer for an API-development tool than silently merging request definitions.

### “What if an SSE event is missed?”

Nothing authoritative is lost. SSE is a freshness signal only. On reconnect the client reloads canonical workspace state from the API; persisted MongoDB resources, version rows and activity are the source of truth. The in-process broker is appropriate to this single-process assessment runtime and is not presented as multi-instance pub/sub.

### “Can one collaborator see another collaborator's execution history or secrets?”

No. Saved collection/environment definitions are workspace-shared, but execution History/Passport/Investigation remains profile-scoped. Environment `secretRef` aliases may be shared as definitions; resolved credential values remain profile-authorized and are never copied into versions, activity or live event payloads.

### “Are you claiming enterprise compliance?”

No. Security & Safety, Data Handling, and Responsible Use document implemented behavior. The project does not claim SOC 2, GDPR certification, penetration-test certification, or production legal review.

### “Is every architecture document current?”

`ASTRA_ARCHITECTURE.md` is intentionally the frozen **pre-implementation design record** from September 17. The current shipped architecture is described in the README and this guide.

## Honest limitations

- Proof import/attachment is inspection-only and read-scoped; Tracer does not persist an imported proof merely to make Why? easier.
- If evidence from Impact/Drift/Verification/Proof is not available or cannot be identity-linked, Why? reports that gap.
- The final submission-readiness report documents host-specific rerun limitations separately; do not replace those historical results with stronger claims.
- Live collaboration uses an in-process authenticated SSE broker with bounded replay. It is deliberately suitable for the single backend process used by this assessment; multi-instance deployment would require an external pub/sub layer.
- Collaboration is saved-state synchronization, not CRDT/OT character-level co-editing.
- The project is designed for local evaluation and HackerRank assessment constraints, not as a claim of a hosted multi-tenant commercial SaaS.

## Demo account

After `bun start`:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8000`
- Email: `alex.morgan@example.test` (team workspace `OWNER`)
- Password: `password123`
- Second account: `jordan.lee@example.test` / `password123` (team workspace `EDITOR`)

Both accounts are members of the seeded **API Platform Team** workspace. Use a
private/incognito window for the second account to see the same shared
collections and environments from an independently authenticated session, and
the workspace **Manage** dialog as Alex to change Jordan's role, remove, or
re-add them.

## Useful commands

```bash
bun install --frozen-lockfile
bash setup.sh --seed
bun start

bun test
bun run demo:flight-recorder
bun run demo:investigation
bun frontend/scripts/phase24b-live-e2e.mjs  # two-browser live collaboration proof (app running)
```

For exact final acceptance evidence and caveats, read:

- `docs/final-submission-readiness.md`
- `docs/phase49/why-inspector.md`
- `docs/collaboration-verification.md`
