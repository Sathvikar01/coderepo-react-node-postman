# Tracer Feature Coverage

Updated: 2026-10-14  
Branch: `main`

This is the repository-visible coverage map for the ten submission capability groups. It distinguishes UI reachability from backend authority and names the browser/screenshot evidence rather than treating code existence as product coverage.

Status vocabulary:
- **COMPLETE** — user-facing entry point exists and the capability is exercised through tracked browser/API/tests.
- **TARGETED** — shipped and reachable, with targeted rather than one monolithic browser suite.
- **PENDING CI** — implementation exists on this branch but the exact head has not yet cleared its required GitHub gate.

| # | Capability | UI entry point | Backend/API authority | Persistence / evidence | Browser/test coverage | Screenshot coverage | Status |
|---:|---|---|---|---|---|---|---|
| 1 | Request authoring & execution | Request builder, Send/Cancel, Import cURL, code snippet/export controls | Request compiler → target policy → DNS/transport → execution service; request-tools API for validated import/snippets | Execution history + immutable execution receipt | Phase 30 E2E, Baseline Gate, execution unit/integration suites | Phase 30 / full-UI audit surfaces | COMPLETE |
| 2 | Collections & generated documentation | Collections tree, collection menus, Documentation view | Collections API/service/repository; generated docs consume saved aggregate | Mongo collection aggregate + immutable versions | Phase 30 E2E, collection/docs tests | Full-UI audit collection/docs states | COMPLETE |
| 3 | Environment management | Variables rail command / environments drawer, active-environment picker | Environment API/service + server-side variable/secret resolution | Mongo environment aggregate + versions; secret values remain server config only | Phase 30 E2E + environment/persistence tests | Full-UI audit environment states | COMPLETE |
| 4 | Authentication & session state | Sign-in/profile picker, request auth editor, Cookies tab | Auth/profile middleware, request compiler auth resolution, cookie service | Account/profile data; profile-scoped cookie jar | Phase 30 E2E + auth/cookie/security suites | Full-UI audit auth/cookie surfaces | COMPLETE |
| 5 | Response analysis & history | Response inspector, History tab, replay/save actions | Execution normalization/history APIs | Immutable terminal history + receipt/passport evidence | Phase 30 E2E, Flight Recorder demo, response/history suites | Phase 30 / full-UI audit response states | COMPLETE |
| 6 | Automated testing & multi-request runs | Request tests/scripts, collection/folder Run dialog, CLI/CI surfaces | Script sandbox, assertions, collection runner, CLI | Run results/reports and execution history | Runner tests, CLI workflow, Baseline Gate, Phase 30 workflow | Runner/full-UI audit surfaces | TARGETED |
| 7 | Examples & deterministic mocks | Examples tab, Save as example, Mock Send / mock URL controls | Examples/mocks APIs; mock resolution never uses live transport | Profile-scoped examples + capability token | Example/mock route, persistence and browser acceptance coverage | Full-UI audit example/mock states | TARGETED |
| 8 | Workspaces, collaboration & versioning | Compact Workspace rail command, Manage/Activity/Reviews, Versions dialogs | Workspace/member/role APIs, versions API, authenticated SSE freshness | Workspaces, activity, immutable resource versions | Phase 24 24/24, Phase 24B 29/29, permission/security suites | Collaboration/versioning browser captures | COMPLETE |
| 9 | Flight Recorder & investigation | History → Passport / Compare / Investigate / Why? | Execution-intelligence and Investigation cores; Why? backend projection | Receipts, comparisons, investigation records, reproduction evidence | Flight Recorder demo, Phases 36/37 browser suites, Phase 49 browser suite | Investigation / Why? browser captures | COMPLETE |
| 10 | Change verification & human review | **Verify** rail command → Change Safety dialog → canonical Verification Proof → Reviews | `/api/v1/change-safety` orchestrates existing Phase 39/40/41/42/43/45/46/47 cores; Reviews stays Phase 50 authority | Saved collection versions, contract registry, rehearsal checkpoints/execution history, Verification Proof, review rows | `change-safety-e2e.mjs` plus backend orchestration tests and the direct Proof→Review E2E, run by the required **Phase 30 E2E + Load** job | CI artifact `change-safety-browser-evidence`: analysis at 1440/1024/768/375, proof at 1440/375 | COMPLETE |

## Capability 10 browser journey

The browser path exercised by `frontend/scripts/change-safety-e2e.mjs` is:

```text
saved collection revision
  → Analyze saved change
  → Impact
  → Environment Drift
  → Generate/publish missing Contract from a real source-environment response
  → Rehearsal against target environment
  → Contract Compatibility
  → Phase 41 Verification
  → Verification Proof
  → existing Proof / Review surfaces
```

The frontend does not recompute any of those states. Selection and presentation live in React; all authoritative analysis, execution, comparison, verification, and proof generation live in existing backend cores.

## Phase 54 acceptance gate

PR #74 (`phase54/change-safety-browser-workflow`) completed and merged this workflow, closing issue #71. The gate items are now satisfied as follows:

1. Baseline Gate passes on `main` and is re-run on the final submission branch.
2. Tracer CLI passes as a required gate.
3. Phase 30 E2E + Load passes as a required gate.
4. The tracked Change Safety browser script completes without console/runtime errors.
5. The browser script produces the named `change-safety-browser-evidence` screenshot artifact at 375 / 768 / 1024 / 1440 plus generated-proof views.
6. Issue #71 is closed; no capability remains in **PENDING CI**.
