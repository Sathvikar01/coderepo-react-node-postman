# Phase 37 — Investigation Acceptance + Final Freeze

**Branch:** `phase37/investigation-acceptance`
**Base:** `main` @ `ef2388f`
**PR:** #37 (open, not merged)
**Verdict:** `PHASE 37 VERDICT: PASS — TRACER INVESTIGATION WORKFLOW ACCEPTED AND FROZEN`

## Objective

Prove the complete Tracer investigation workflow end to end — saved request succeeds →
unrelated change → replayable change → later failure → trustworthy regression boundary →
comparison → counterfactual proving the causal change → unrelated changes stay unverified →
minimal reproducer → truthful minimality → reproduction stability → secret-safe capsule →
capsule imports as an unsent/unsaved dirty draft → no auto-send/auto-save → manual
reproduction — and then freeze the repository.

The workflow is proven twice, on two independent surfaces:

- a deterministic backend acceptance suite driving the **real merged Phase 31–35 engines**
  through the investigation orchestrator with an in-memory harness, and
- a **real-browser** acceptance run against the canonical declared runtime (frontend 3000,
  backend 8000) that performs the whole flow through the actual UI, including a
  user-initiated Send of a capsule-imported draft.

## The causality invariant

`verified_cause` requires **both** halves of Phase 31 intervention evidence:

1. an apply probe whose result matches the failure predicate, and
2. a revert probe whose result does not.

Chronology, execution ordering, correlation, and first-divergence are *never* sufficient.
They are reported as `leading divergence` / `correlated change` and cannot be promoted.
Evidence missing either probe is rejected by the builder (`INVESTIGATION_EVIDENCE_INVALID`)
rather than published as a cause.

This is asserted with an explicit negative case: a scenario that has a resolved regression
boundary, a non-null first divergence, and non-empty comparison changes — and still produces
**zero** verified causes, reporting *"No change was experimentally verified as the cause."*

## Artefacts

| Path | Purpose |
|---|---|
| `backend/src/features/execution-intelligence/investigation/investigation-acceptance.test.js` | Sixteen-point deterministic acceptance + causality/isolation/SSRF invariants |
| `frontend/scripts/phase37-investigation-acceptance-e2e.mjs` | Real-browser acceptance over the canonical runtime, 18 checks |
| `README.md` | "Why Tracer is different" — leads with the investigation workflow |

## Gates

| Gate | Command | Result |
|---|---|---|
| Investigation acceptance | `bun test .../investigation/` | 40 pass / 0 fail |
| Phase 37 suite alone | `bun test investigation-acceptance.test.js` | 8 pass / 0 fail (98 expect) |
| Full test suite | `bun test` | 1070 pass / 2 skip / 0 fail (97 files, 4173 expect) |
| Backend syntax | `find backend/src -name '*.js' -print0 \| xargs -0 -n1 node --check` | 218 files, exit 0 |
| Frontend build | `cd frontend && bun run build` | exit 0, 1.77 s |
| Frozen install | `bun install --frozen-lockfile` | 294 packages, lockfile byte-identical to `main` |
| Seed / reset | `bash setup.sh --seed` | deterministic, baseline restored after restart |
| Investigation demo | `bun run demo:investigation` | 14/14 |
| Flight Recorder demo | `bun run demo:flight-recorder` | 47/47 |
| Collection Runner regression | `bun test collection-runner/ execution-intelligence/` | 205 pass / 1 skip / 0 fail |
| CLI tests | `bun test backend/src/features/cli/` | 99 pass / 0 fail |
| CLI + CI parity demo | `bash examples/ci/ci-demo.sh` | pass (exit 0 pass / 1 fail) |
| Browser acceptance | `P37_CDP=... bun frontend/scripts/phase37-...-e2e.mjs` | `PHASE37_E2E_PASS 18/18`, twice |
| Load smoke | `locust -f tests/load/locustfile.py --headless` | 0.00 % failure at 5 / 25 / 50 users |
| GitHub Actions | `gh pr checks 37` | contract, browser-e2e, locust-load, headless runner — all pass |

### Load results

| Level | Users | Requests | Failure | p50 | p95 | p99 |
|---|---|---|---|---|---|---|
| Light | 5 | 212 | 0.00 % | 45 ms | 180 ms | 300 ms |
| Moderate | 25 | 1042 | 0.00 % | 210 ms | 1100 ms | 2300 ms |
| Burst | 50 | 1316 | 0.00 % | 120 ms | 440 ms | 820 ms |

## Security verification

- **Secret safety** — the capsule of an auth-bearing request contains `[REDACTED]` and a
  `{{authorization}}`-style placeholder, never the literal; the required-input list is
  documented instead of the value.
- **Profile isolation** — an investigation started under one profile is `INVESTIGATION_NOT_FOUND`
  for every other profile.
- **SSRF / policy** — a policy-blocked target dispatches **zero** network calls.
- **No auto-send / no auto-save** — a capsule import yields a dirty, unsent, unsaved draft;
  the fetch log across the import shows no send and no save until the user acts.
- **Manual reproduction** — the imported draft reproduces the failure only after an explicit
  user-initiated Send.

## Freeze verification

- `bun.lock`, every `package.json`, `hackerrank.yml`, and `.github/workflows/**` are unchanged
  from `main`.
- Diff vs `main`: 3 files, 1108 insertions, 0 deletions (purely additive).
- Repository is private (`gh repo view` → `isPrivate: true`, `visibility: PRIVATE`).
- Archive: 2.81 MB, includes `README.md`, excludes `GUIDELINES.md` / `skills/` / `AGENTS.md`
  and all ignored content.
- No secrets in any new artefact; all credential-looking values are synthetic fixtures.

## Known deviations

- **Pre-existing open PRs.** PRs #33–#36 (phases 39, 40, 41 and a hotfix) were already open
  against `main` when Phase 37 began. Closing another phase's PR is outside this phase's
  authorization, so the condition is reported rather than resolved.
- **Windows `bun start` PATH.** On this host, `concurrently` spawns `cmd.exe` children, and
  `%APPDATA%\npm` contained only the Unix `bun` shim, so `bun run dev:backend` could not
  resolve. A local `bun.cmd` shim (outside the repo) resolved it and the declared command then
  started both services correctly. This is a machine-local tooling gap, not a repository
  defect, and no repository file was changed to work around it.
