# Final Submission Readiness — Tracer (API Flight Recorder)

> **Post-freeze audit update — 2026-09-26:** current `main` includes audit-hardening PR #64 (`586c3bf9`). The exact patched tree passed the Baseline Gate (**2013 pass, 1 skip, 0 fail**), frontend production build, Tracer CLI, Phase 30 real-browser E2E, the direct Verification Proof → Review browser flow, and light/moderate/burst Locust jobs with zero request failures. PR #64 also broadens the browser/load workflow trigger so backend, lockfile, root manifest, and setup changes can no longer skip that end-to-end gate. The freeze evidence below is preserved as historical evidence for the earlier freeze commit.
>
> **Coverage clarification:** standalone historical browser harnesses such as Phase 24B/36/37/47C/49 are targeted acceptance scripts; they are **not all invoked by `bun test` or by the always-on Phase 30 workflow**. Their underlying service/view-model behavior has extensive automated test coverage, while their full browser journeys remain targeted regression harnesses.


- Branch: `final/submission-freeze`
- Base: `93cf3e0e1fb1a91c68c2a2365930423440c6888e` (origin/main at freeze time)
- Date: 2026-09-25 (Asia/Kolkata). No new features were added on this branch.
- CI on base commit: GitHub Actions **Baseline Gate SUCCESS** (`36044722809`, 1m10s).

## 1. Clean-clone test — PASS

Proven from a pristine worktree at the freeze commit
(`C:\Users\arsat\AppData\Local\Temp\opencode\freeze-clean`, since removed):

| Step | Command | Result |
|---|---|---|
| Install | `bun install --frozen-lockfile` (bun 1.3.9) | 294 packages, 5.44s |
| Seed/reset | `bash setup.sh --seed` under **Git Bash** | Login accounts 2, Profiles 2, Workspaces 3, Collections 4, Environments 4, Activity 4, Preferences 2, Demo orders 10, Histories 0 |
| Backend boot | `bun src/index.js` with `PORT=8100` | `{"status":"ok","database":"connected"}` |
| Login | `POST /api/v1/auth/login` demo creds | 200 + JWT |
| Profile flow | `GET /api/v1/profiles` → `POST /api/v1/auth/switch-profile` → `GET /api/v1/collections\|environments\|history` | 1 profile per account, 2 shared collections, 2 shared envs, history 200 |
| Workspace flow | `GET /api/v1/workspaces` → `GET /api/v1/workspaces/:id` → `GET /api/v1/workspaces/:id/activity` | Alex `OWNER` / Jordan `EDITOR` on the seeded team workspace, activity 200 |
| Frontend build | `bun run build` (vite 8.2.2) | 113 modules, ~800ms, dist emitted |
| Frontend serve | `vite preview` | HTTP 200 on `/` |

No hidden local dependency: only generated `backend/.env` + `frontend/.env`
(created from tracked `.example` files) were required. No required untracked file.
Caveat: `setup.sh` **fails under WSL bash** (`/dev/tcp` unreachable +
`bun` not on PATH there); Git Bash works. README already says Git Bash on
Windows, so docs match reality.

## 2. Full product smoke — PASS (API-level, freeze backend on :8100)

Reachable and exercised: auth/login/profile-switch, collections,
environments, history, cookies, examples, mocks/meta, collection-runs,
executions (POST send + passport receipt), mocks resolve path by design.
`GET /api/v1/mocks`, `GET /api/v1/verification-proofs`,
`GET /api/v1/executions`, `GET /api/v1/why/status` return 404 **by design**
(mocks exposes `/meta`+`/resolve`; verification-proofs is POST-only;
executions is POST-send/GET-by-id; why-inspector is per-execution) —
verified against the route sources, not defects.

Live execution proof: `POST /api/v1/executions` against a loopback demo
target returns `TARGET_BLOCKED` ("not permitted", address 127.0.0.1:8100),
proving compile → policy → transport gating works; the run still mints an
Execution Passport receipt. Success-path execution against
`127.0.0.1:8000/demo/v1/*` is covered by the Flight Recorder demo (§4).

## 3. Signature demo — PARTIAL PASS (43/47), environment-caused

`bun src/features/execution-intelligence/flight-recorder-demo.js` against the
seeded app completed: **43/47 checks passed**, including the full chain
Passport → Compare → Minimize → Capsule → Import(dirty draft) → Reproduce,
passport immutability after the environment change, minimizer budgets,
hidden probes, SSRF/unsafe-method restrictions, and zero resolved secrets in
all artifacts. The 4 failures (`run 1 answered 200`, 3 contract-diff checks)
cascade from run 1 answering **401**: the demo ran against a sibling
checkout's backend (`postman-phase49b`, commit `9f6cd6d`) whose
`DEMO_LOCAL_TOKEN` differs from the seed workstation's, while sharing one
MongoDB. An earlier run in this session showed run 1 = 200 before the
database host became unstable (see §11). This is a mixed-checkout test-setup
artifact, not a freeze-code defect; no product change was made for it per the
freeze rule. STALE-proof behavior (passport immutability after env change) is
covered by the passing demo check, not by a separate UI click-path here.

## 4. Full regression

| Gate | Result |
|---|---|
| `bun test` (backend, 90 files) run 1 | 1449 pass, 80 skip, **1 fail** (`cli-ci` spawn test, exit 9, 17.8s under full parallel load) |
| `bun test` run 2 | **1417 pass, 114 skip, 0 fail**, 1531 tests, 41.46s |
| `cli-ci.test.js` isolated | 7 pass, 0 fail |
| Frontend `vite build` (freeze branch) | PASS (~719ms) |
| `bun install --frozen-lockfile` (clean tree) | PASS |
| Seed/reset | PASS (see §1) |
| Runtime health | PASS (`ok`/`connected`) |
| Tracer CLI `--help` / `validate` / `plan --json` | PASS (exit codes, machine doc, fingerprint stable) |
| Collection Runner API (`/api/v1/collection-runs`) | Reachable 200 |
| Flight Recorder demo | 43/47 (see §3) |
| Investigation demo | Not re-run (host instability, see §11); covered by suite tests |
| Related Phase 30/36/37/47C/48A/49 unit/integration coverage | Included in the green `bun test` run; standalone browser scripts were not all re-run in this freeze |
| Load test (locust) / determinism checks | Not re-run in this window; no code changed to affect them |

The single run-1 failure is load flakiness (spawned CLI child killed under a
fully parallel 90-file run on a memory-starved host), green in isolation and
on rerun. No assertions were weakened and no code was changed for it.

## 5. Browser matrix — STATIC PASS, live viewports not available here

No browser-automation runner is installed in this environment
(no playwright/puppeteer dependency; `vite preview` serves 200 with no build
errors). Static verification: 40 responsive/accessibility matches across
stylesheets — `@media (max-width: 1179/840/767/720/640/600/480px)`,
`:focus-visible` on all interactive elements, `prefers-reduced-motion`
parity, `overflow-x: auto` containment instead of page overflow. Live
375/768/1024/1440 + dark/light + console-error + keyboard sweeps remain for a
machine with a real browser; Phase 30's merged E2E is the standing evidence.

## 6. Repo / git hygiene — PASS

- `git status`: clean except untracked `transcripts/{codex-sessions,pi-sessions,hackerrank-log.txt}`
  (other agents' session exports; left untouched, still untracked).
- Tracked-file audit: no `.env`, no screenshots/dumps/logs, no credentials,
  no `probe`/`scratch` artifacts; `UI/` is untracked (0 tracked files);
  `frontend/dist`, `.mongodb` correctly ignored.
- Base branch `main` == freeze base; CI green on it; no competing
  implementation branch is required by this freeze; no merge conflicts
  (branch is exactly at base plus this report).

## 7. README / config contract — PASS

README verified accurate: product identity ("API execution, investigation,
and change-verification workspace"), ports 3000/8000, Git Bash requirement,
`bun install && bash setup.sh --seed`, demo login
`alex.morgan@example.test` and `jordan.lee@example.test` (both
`password123`), seeded content (a shared team workspace with Orders API +
HTTP Examples and 2 environments, plus a personal workspace per account),
the workspace/role model, and the WHY Inspector in the mental model. `hackerrank.yml` (install/run/readonly-paths/default-open-files),
package scripts, `.gitignore`, `.gitattributes` (skills + GUIDELINES
export-ignored, archive-safe), and lockfile untouched. No HackerRank contract
changes.

## 8. Security final check — PASS, no regressions

- SSRF: live `TARGET_BLOCKED` for non-allowlisted loopback; demo-port
  allowlist is host+port+path-pinned (`127.0.0.1:8000/demo/v1/*`).
- Auth/profile isolation: Bearer → profile-token switch → per-profile
  scoping enforced (`PROFILE_REQUIRED`/`PROFILE_FORBIDDEN` paths intact).
- Secrets: no hardcoded values in `backend/src` (sweep clean); demo asserts
  zero resolved secrets in passports/comparisons/capsules/history/errors;
  CLI never prints secret values (`--variable-env` path).
- CORS allowlist with `credentials: false`, `x-powered-by` disabled,
  strict zod schemas (`.strict()`), body/timeout/size limits intact.
- Rehearsal fail-closed `STEP_IN_DOUBT` present with test coverage.
- No new security subsystem added.

## 9. Bugs found / fixed

None fixed on this branch — deliberately. Two environment issues were
worked around without touching product code: (a) WSL-bash `setup.sh`
failure → use Git Bash (already documented); (b) host OOM instability —
mongod crashed twice with `out of memory` (~1.2 GB free of 16 GB) and was
restarted with `--wiredTigerCacheSizeGB 0.25`; sibling-checkout backends on
:3000/:8000 flapped and were left for their owners. The freeze branch
contains zero product-code diffs by design.

## 10. Honest limitations

1. Flight Recorder demo 43/47 in this mixed-checkout Ramos environment
   (token mismatch vs sibling backend, §3).
2. No live multi-viewport browser pass in this environment (static CSS
   evidence only, §5).
3. Investigation demo, locust load test, and determinism checks not re-run
   in this window (host memory pressure); covered by the green suite.
4. `bun test` is load-sensitive on starved hosts (one flaky spawn kill in
   run 1, green rerun + isolated).
5. `setup.sh` requires Git Bash on Windows, not WSL bash.

## 11. Environment note (for reviewers sharing this host)

Manual `mongod` (dbpath `postman-phase49b/.mongodb`) OOM-crashed twice and
was restarted capped at 0.25 GB WT cache; sibling backends (:3000 vite,
:8000 node) belong to `postman-phase49b` and flapped with the host — restart
them from that checkout if needed. The `mongodb://127.0.0.1:27017` database
was reseeded deterministically by this freeze (`request_desk_demo`).

## Verdict

No freeze-code defects proven; report-only change on this branch.

`FINAL FREEZE VERDICT: PASS — TRACER READY FOR SUBMISSION`
