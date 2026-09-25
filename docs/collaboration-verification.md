# Phase 24 — Collaboration + Versioning Verification

Two independent authenticated contexts against the real running API and a seeded
MongoDB. Nothing is stubbed, mocked, or simulated in this document: every line
below is the server's actual response.

How to reproduce:

```bash
# 1. Mongo must be running, then seed both baseline and collaboration data.
cd backend && bun src/features/workspaces/seed.js

# 2. Start the API.
cd backend && bun start

# 3. Drive the two-user proof (exits non-zero on any failure).
cd backend && bun src/features/workspaces/two-user-demo.mjs
```

Recorded transcript — **35/35 checks passed**:

```
PASS  1.  Two independent login contexts — alex=… jordan=…
PASS  2.  Each account authorizes only its own profile — Alex Morgan / Jordan Lee
PASS  3.  Jordan cannot authorize Alex's profile — status=403 code=PROFILE_FORBIDDEN
PASS  4.  The same shared workspace appears for both users — workspace=64b0…f001
PASS  5.  Roles differ per member: Alex OWNER, Jordan EDITOR
PASS  6.  Server-issued capabilities match the role
PASS  7.  The member list resolves real accounts and emails
PASS  8.  Both users see the same shared collections — count=2
PASS  9.  Both users see the same shared environments — count=2
PASS  10. Another workspace's resources never mix in — personal count=2
PASS  8b. Opening a shared collection returns its full request tree — requests=5 folders=2
PASS  11. Jordan's edit is immediately visible to Alex — revision=2
PASS  12. The edit records its actual actor, not the workspace owner — createdBy=Alex updatedBy=Jordan
PASS  13. A stale write fails with a typed, attributed 409
           status=409 code=COLLECTION_REVISION_CONFLICT expected=2 current=3 lastUpdatedBy=Jordan Lee
PASS  14. No last-write-wins: the stale write changed nothing
PASS  15. OWNER changes Jordan's role to VIEWER
PASS  16. VIEWER can still read shared definitions
PASS  17. VIEWER mutation is refused immediately (403, fail-closed) capability=writeCollections
PASS  18. VIEWER cannot create a collection
PASS  19. VIEWER cannot execute a side-effecting request — capability=execute
PASS  20. Restoring EDITOR returns write access immediately
PASS  21. OWNER removes Jordan from the workspace
PASS  22. A removed member loses access immediately — list=403 read=403
PASS  23. Removing a non-member fails closed — status=400
PASS  24. OWNER re-adds Jordan by email
PASS  25. The re-added member regains access
PASS  26. The last OWNER cannot be demoted — status=409 code=LAST_OWNER
PASS  27. The activity feed records the workspace lifecycle
           member.added, member.removed, collection.updated, member.role_changed,
           environment.created, collection.created, workspace.created
PASS  28. Activity entries are attributed and revision-stamped
PASS  29. The activity feed leaks no authorization, cookie, or secret material
PASS  30. Sharing an environment shares alias names, never values
           secrets=local_token, alex_private_token
PASS  31. The stored environment never contains a resolved value
PASS  32. Alex can execute inside the shared workspace and it is recorded — outcome=response
PASS  32b. Execution history stays profile-scoped inside a shared workspace — alex=1 jordan=0
PASS  33. Workspace endpoints require authentication — status=401
```

## What each check proves

| # | Requirement |
|---|---|
| 1–3 | Login separation; one account authorizes exactly its own profile; cross-account authorization fails closed |
| 4–7 | One persisted shared workspace, per-member roles, server-issued capabilities, real member identity |
| 8–10 | Combined definitions (collections/environments) are shared across members but never leak between workspaces |
| 11–12 | A collaborator's write is visible to the other user, attributed to the real actor |
| 13–14 | Optimistic concurrency: stale write → typed `409` with the losing revision and the winning author; nothing is overwritten |
| 15–20 | Role lifecycle: OWNER → VIEWER takes effect immediately; VIEWER reads but cannot write or execute; restoring EDITOR restores access immediately |
| 21–25 | Membership lifecycle: removal revokes access immediately, non-member operations fail closed, re-adding by email restores access |
| 26 | The workspace can never lose its last OWNER |
| 27–29 | Bounded append-only activity feed, attributed, and free of sensitive material |
| 30–31 | Secret boundary: sharing an environment shares only alias names, never resolved values |
| 32–32b | Execution history stays profile-scoped even inside a shared workspace |
| 33 | Workspace endpoints require authentication |

## Phase 24B — live collaboration + version history

Run after a fresh seed, with the backend on :8000 and the frontend on :3000:

```bash
cd backend && bun run seed
bun frontend/scripts/phase24b-live-e2e.mjs
```

Expected: `PHASE24B_LIVE_E2E_PASS 29/29` — two independent Chrome contexts (Alex OWNER, Jordan EDITOR) proving: live update toasts without reload, immutable v1/v2 history with structured compare, dirty-draft preservation with a remote-change banner, stale-save 409 through the real Save button, restore-as-new-revision (v4, not a rewrite), immediate VIEWER read-only, direct-API 403s, removal stream-close with fallback, history isolation, no credential material in versions/diffs/events/activity, reconnect without duplicate writes, and 375/1440 responsive + light/dark checks on the new surfaces.

Backend domain and security suites live alongside the Phase 24 suites:

```bash
cd backend && bun test src/features/versions/
```

They cover version recording/retention/retry-safety, deterministic bounded compare with typed truncation, CAS restore, outsider/VIEWER/cross-workspace refusal, revocation stream-close, and snapshot/event secret exclusion.
