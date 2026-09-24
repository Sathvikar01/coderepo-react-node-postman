# Phase 39A — Change Impact Analysis Core

Branch: `phase39/change-impact-core` (worktree `../postman-p39`, based on `origin/main` @ `ef2388f`)
Scope: new isolated backend feature at `backend/src/features/change-impact/`.
Verdict: **PHASE 39A VERDICT: PASS**

---

## 1. Files changed

All work is a single new directory. No existing file was modified.

| File | Lines | Role |
|---|---:|---|
| `node-ids.js` | 58 | Canonical node-id constructors/parsers for the graph |
| `reference-extractor.js` | 170 | Deterministic placeholder + script reference extraction |
| `change-impact-schema.js` | 292 | Zod validation, change/workspace parsing, canonical change, root node id |
| `dependency-graph.js` | 342 | Graph construction (nodes, edges, inverted dependents index) |
| `impact-traversal.js` | 88 | Cycle-safe, confidence-tiered BFS traversal with path preservation |
| `severity.js` | 54 | Explicit deterministic severity rules |
| `impact-result.js` | 161 | Deterministic structured result envelope |
| `workspace-diff.js` | 206 | Pure snapshot A → snapshot B differ |
| `change-impact.service.js` | 63 | Pure entry points (`analyzeChange`, `analyzeChanges`, `analyzeWorkspaceDiff`) |
| `change-impact-adapter.js` | 106 | Repository/snapshot adapter + profile-scope guard |
| `index.js` | 15 | Public barrel boundary |
| `change-impact.test.js` | 425 | 28 focused tests |

`git status` on the worktree reports exactly one untracked path: `backend/src/features/change-impact/`. No frontend file, `App.jsx`, global CSS/theme, Flight Recorder/investigation code, execution service/runner, workspace-snapshot code, workflow, dependency manifest, lockfile, or `hackerrank.yml` was touched. A repo-wide grep confirms nothing outside this directory imports it.

## 2. Graph / domain model

**Node ids** are colon-delimited and stable across runs. The delimiters are safe because the embedded values are schema-constrained (UUID ids, `[A-Za-z_][A-Za-z0-9_]*` variable keys, colon-free HTTP header tokens):

```
environment:<envId>                        environment-variable:<envId>:<key>
collection:<c>                             collection-variable:<c>:<key>
folder:<c>:<folderId>                      request:<c>:<requestId>
request-variable:<c>:<r>:<key>             auth:collection:<c>
auth:request:<c>:<r>                       header:request:<c>:<r>:<lowerName>
header:shared:<lowerName>                  assertion:<c>:<r>:<assertionId>
```

**Edges** always point *dependent → dependency*: `{ from, to, type, confidence, detail }`, where `confidence ∈ {exact, conditional, unknown}` and `type` is one of `container`, `reference`, `auth`, `auth-inherit`, `header`, `shared-header`, `produces`, `request-feed`, `self-feed`, `assertion`. Construction additionally returns an inverted `dependents: Map<to, Edge[]>` index so traversal from a changed node is a forward walk.

Construction order is deterministic: collections and environments sort by id, variables by key, folders by id; requests follow the **same run order contract as the collection runner** (folders in array order with their requests, then root-level requests), reimplemented locally to keep this feature free of runner imports. Two equal workspaces therefore always produce byte-identical graphs and results.

## 3. Supported dependency types

| Dependency | Modeled as | Notes |
|---|---|---|
| Environment variable | `environment-variable` node | Referenced via `{{ }}` in interpolated fields |
| Collection variable | `collection-variable` node | |
| Request variable (script-written) | `request-variable` node + `produces` edge | Created by literal `pm.variables.set/unset("KEY")` |
| Auth references | `auth:collection` / `auth:request` nodes | Interpolated `tokenTemplate`, `usernameTemplate`, `passwordTemplate`, `valueTemplate` |
| Auth inheritance | `auth-inherit` edge | `request.auth.mode === "inherit"` → collection auth |
| Collection / request headers | `header:request` nodes, `shared-header` edge | Header refs attach to the owning header node; keys are lowercased |
| URL / path / query refs | `reference` edges from the request | `urlTemplate`, query row values |
| Request body refs | `reference` edges | `json`/`text` bodies and `urlencoded` row values |
| Scripts | `reference` edges + `request-variable` nodes | Literal only; `pm.variables/environment/collection.get/set/unset` |
| Assertions | `assertion` nodes | Attached to the owning request (assertions have no interpolation) |
| Request chains | `request-feed` / `self-feed` edges | Writer must precede reader in run order |
| Containment | `container` edges | request → folder → collection |

Only fields the real request compiler interpolates are treated as references, so the engine never invents an edge the runtime would not honor.

## 4. Impact result schema

```
{
  schemaVersion: 1,
  kind: "tracer.change-impact",
  change: { operation: "changed"|"removed", target: {…canonical, header names lowercased} },
  resolved: boolean,                       // false when the change target is not in the workspace
  summary: {
    directRequests, indirectRequests, totalRequests,
    affectedCollections, affectedFolders, affectedAssertions,
    unknownReferences, severity
  },
  impact:    { direct: ImpactItem[], indirect: ImpactItem[] },
  requests:  { direct: ImpactItem[], indirect: ImpactItem[] },   // request-kind subset
  collections: [{ collectionId, name, requestIds[], folderIds[] }],
  folders:     [{ collectionId, folderId, name, requestIds[] }],
  assertions:  ImpactItem[],
  unknown:   [{ code, key?, collectionId?, requestId?, field?, scope?, fromRequestId?, op?, rowId?, environmentIds? }],
  truncated: boolean
}
```

Every `ImpactItem` is `{ node, nodeKind, impact, hop, category, severity, confidence, path[], reason, …entityFields }`. `path` is the preserved dependency chain — an ordered list of `{ node, kind, edge }` steps from the changed node to the affected node, so the result explains *why* without prose. `reason` mirrors the final edge. `category` is one of `variable`, `auth`, `header`, `collection-config`, `folder`, `request`, `environment`. All arrays are sorted by a fixed key, so `JSON.stringify` of two runs is identical.

The service returns data only — no sentences, no recommendations, no severity adjectives.

## 5. Transitive and cycle handling

Traversal is a breadth-first walk over the inverted index with two confidence tiers:

1. **Exact pass** — follows `confidence === "exact"` edges, marking `hop === 1` rows `direct` and deeper rows `indirect`.
2. **Relaxed pass** — continues from the exact frontier across all remaining edges; anything newly reached is tagged `confidence: "unknown"`.

A `visited` set is seeded before each pass, so cycles (e.g. two requests that mutually write and read the same variable) terminate and each node appears at most once. `maxDepth` (default 32, parameterizable) is a hard bound; hitting it sets `truncated: true` and appends a `traversal-depth-limit` unknown.

Hops are counted over **structural** nodes: `requestHeader`, `requestAuth`, `collectionAuth`, and `sharedHeader` are transparent, so "this variable is used by this request's header" is still reported as a *direct* impact on that request rather than being buried one hop deeper. Real transitive impact is only produced by an actual dependency boundary — a request feeding another request.

Deduping is by node id (the visited set), and each node keeps the first path found, which is the shortest path because traversal is breadth-first and edge expansion is sorted deterministically.

## 6. Unknown / dynamic behavior

The engine never guesses. The following are emitted as explicit `unknown` records instead of edges:

| Code | Meaning |
|---|---|
| `unresolved-variable` | A referenced key is declared nowhere |
| `ambiguous-variable-scope` | The key exists in more than one environment and no environment is selected — all candidates get `unknown`-confidence edges |
| `order-dependent-variable-feed` | A writer exists but runs *later* than the reader; the edge is real only across iterations |
| `malformed-placeholder` | `{{` with no valid identifier (e.g. `{{ }}`), which the compiler cannot interpolate |
| `dynamic-variable-read` / `dynamic-variable-write` | Computed names: `pm.variables.get(name)`, template literals with `${}`, `toObject()` |
| `target-not-found` | The proposed change targets a node absent from the workspace; also forces `resolved: false` |
| `traversal-depth-limit` | The depth bound stopped the walk |

When scope is ambiguous, or a feed is order-dependent, the affected requests are reported with `confidence: "unknown"` and severity is downgraded, so callers can distinguish evidence from possibility.

## 7. Tests added

`backend/src/features/change-impact/change-impact.test.js` — 28 tests, all passing:

- **Extraction (2):** distinct placeholders + malformed detection; literal script reads/writes vs computed names reported dynamic.
- **Core (21):** direct variable reference; environment scope shadowing a collection key; transitive impact through a request feed; removal of a produced request variable; collection auth change reaching inheriting requests; request-scoped header change; shared header change across requests; body reference; query reference; path (URL) reference; collection-level change; folder change; zero-impact unreferenced change; missing target fails closed; cycle termination and uniqueness; duplicate-reference dedupe; malformed stored data → `AppError(422 CHANGE_IMPACT_SOURCE_INVALID)`; cross-profile workspace rejected; byte-identical repeated output; unknown/malformed/dynamic reporting; ambiguous environment scope; order-dependent feed.
- **Diff boundary (3):** removed collection variable detected and analyzed; header value edit detected; batch `analyzeChanges` deterministic.
- **Adapter (2):** profile-scoped load + analyze; `assertProfileScope` rejection.

## 8. Gate results

| Gate | Command | Result |
|---|---|---|
| Focused Phase 39 tests | `bun test backend/src/features/change-impact` | **28 pass / 0 fail** (67 assertions) |
| Full root suite | `bun test` | **1090 pass / 2 skip / 0 fail** (1092 tests, 97 files) — the 2 skips are pre-existing (TLS SNI transport, DB-less regression repo) |
| Backend syntax | `node --check` on all change-impact files | **OK** |
| Frozen install | `bun install --frozen-lockfile` | **no changes** (175 packages); `bun.lock` and both manifests untouched |
| Isolation | `git status --short` | one untracked dir, `backend/src/features/change-impact/` |

A first full-suite run showed 2 CLI process-contract failures caused by self-inflicted contention from running two suites concurrently against the same local API/DB; a clean re-run passed with 0 failures. No code change was involved.

No frontend build was run because no frontend file changed.

## 9. Deferred integrations

- No HTTP route, controller, or UI. The engine is exercised through `index.js` / the adapter only.
- `analyzeWorkspaceDiff` consumes two *supplied* workspace documents. It does not read Phase 38 snapshot storage; the snapshot side is deliberately a plain-data interface (`createChangeImpactAdapter().analyzeSnapshotDiff({ before, after, changes?, environmentId? })`) so a later phase can feed it Phase 38 snapshots without this feature depending on Phase 38 internals.
- The adapter's default loaders use `collectionRepository`/`environmentRepository` (`list` → `findById`) when injected, and also accept plain `collectionSource`/`environmentSource` functions for testing.
- Not implemented, per scope: snapshot-diff UI, environment drift, cross-environment verification, auto-remediation, promotion workflows, and any AI/model/API/SDK analysis. Severity is explicit rules only; the core emits no prose.

## 10. Boundary confirmation

- `backend/src/features/change-impact/` is the **only** change on this branch; nothing outside it imports the feature.
- No Phase 36 or Phase 38 file was read, edited, or depended on. No file under `backend/src/features/{executions,collection-runner,workspace-snapshots,execution-intelligence}/` or `frontend/` was modified.
- No shared frontend file, `App.jsx`, theme/CSS, `.github/workflows/**`, `hackerrank.yml`, `package.json`, or `bun.lock` was modified (`git status` shows a single untracked directory).
- The main working tree at `C:/Users/arsat/downloads/postman` was not disturbed; the pre-existing uncommitted frontend work there is untouched.
