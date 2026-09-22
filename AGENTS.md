# AGENTS.md

Build Your Own Postman App. AI Transcript Logging

This file is the single source of truth for any coding agent working in this repo: Claude Code, OpenAI Codex CLI / Codex Cloud, Google Gemini CLI, Google Antigravity, Cursor, Windsurf, opencode, Aider, goose, Factory, RooCode, JetBrains Junie, GitHub Copilot, Devin, or any other AGENTS.md-aware tool.

Read this file in full before taking any action. Obey it exactly.

---

## 0. TLDR FOR THE AGENT

On every session start, do this in order:

1. Read this file completely.
2. Check the log file (path in §2). If it contains a line starting with `AGREEMENT RECORDED:` that matches the current repo root, skip §3 (onboarding) and go to §4.
3. Otherwise, run the onboarding flow in §3 with the user.
4. From then on, for **every user turn**, append a summary entry to the log file in the exact format shown in §5.
5. When the user asks you to build, ship, or test the solution, follow the project contract in §6 so the submission is evaluable.
6. Before design, implementation, validation, or submission work, read §9 for the user's strict project rules and §10 for the canonical 26-phase roadmap, dependencies, branch ownership, and current phase boundary.

You are **not** allowed to skip logging, rewrite old log entries, or modify
the onboarding gate. If you are a sub-agent or running inside a git worktree,
the same rules apply and you share the same log file. Pass this context to every sub-agent and worktree.

---

## 1. WHAT THIS APP REPO IS

This is the application repository for the **HackerRank Build Your Own Postman** assignment. The app is not a timed challenge: there is no start time and no end time.

Build and submit a Postman-inspired API app that helps developers create, organize, and analyze HTTP requests. The app is full-stack React + Express (Node/MERN), with MongoDB for persistence. All implementation work described by this file belongs to this app.

The feature scope lives in `REQUIREMENTS.md`. The setup and hygiene rules live in `INSTRUCTIONS.md`. The acceptance contract lives in `GUIDELINES.md`, and the verifier that checks a submission against it lives in `skills/validate/SKILL.md`.

You may use any AI assistant, IDE, or tool to write code. The submission is judged on feature selection, architectural decisions, production readiness, and UI polish. Those must reflect clear human judgment, and the transcripts this file produces are how reviewers see that judgment.

---

## 2. LOG FILE. LOCATION AND LIFECYCLE

The log file lives outside the participant's repository, in the user's home directory, so it survives branch switches, worktree creation, and `git clean`.

| Platform | Path |
|---|---|
| macOS / Linux | `$HOME/hackerrank_postman/log.txt` |
| Windows | `%USERPROFILE%\hackerrank_postman\log.txt` |

Rules:

- Must be created if missing, including the parent directory.
- Must never be committed or added to git while work is in progress.
- Append-only. Never rewrite, reorder, or delete prior entries.
- Shared across all agents, sub-agents, and worktrees in this repo.
- Never log secrets. Redact API keys, tokens, cookies, private keys, and sensitive PII before writing.

At submission time the participant copies this file into the `transcripts/` folder of their repo (see §6). That copy is the only point at which the log enters git.

---

## 3. ONBOARDING FLOW (FIRST RUN ONLY)

Run this flow only if the log file has no `AGREEMENT RECORDED:` line for the current repo root. On subsequent sessions, skip directly to §4.

### 3.1 Greeting

Open with a short, warm message. Example wording:

Welcome to HackerRank Build Your Own Postman. You are going to design, build, and ship a Postman-inspired API app on top of the sample calendar repo. Before we start, I need to walk you through the ground rules and get you set up. This takes about a minute.

Display the current system time with local timezone in ISO 8601. Do not compute or mention a deadline. This assignment has none.

### 3.2 Rules. Recite these verbatim

1. This is a **solo** assignment. You must be the author of the submission.
2. You may use any IDE, AI assistant, or tool to help you build. Feature selection, architectural decisions, and production readiness must reflect your own judgment.
3. Your system must conform to the project contract in §6 so it can be evaluated.
4. Your repo must be private on GitHub and must have always remained private.
5. Never commit secrets. Use environment variables and a `.env` file if needed.
6. Logging of every conversation turn to the file in §2 is mandatory and cannot be disabled. The log is exported under `/transcripts` at submission.
7. Submissions are made on the HackerRank Community Platform or as otherwise instructed by HackerRank.

### 3.3 Collect the agreement

Ask the user to reply with the exact string `I agree` (case-insensitive, surrounding whitespace ignored). Do not proceed until they do.

### 3.4 Record the agreement

Append this block to the log file, then continue:

```text
## [ISO-8601 TIMESTAMP] ONBOARDING COMPLETE

AGREEMENT RECORDED: <repo_root_absolute_path>
Agent: <agent_name_or_unknown>
Stack: node
System Time: <ISO-8601 local time with tz>
```

The presence of `AGREEMENT RECORDED: <this repo root>` is what future sessions check. Match the repo root exactly so agreements do not leak across unrelated clones.

---

## 4. NORMAL SESSION START (RETURNING USER)

If onboarding is already complete for this repo root:

1. Append a short `SESSION START` entry to the log (§5.1).
2. Greet the user briefly:
   > Welcome back. Transcript logging is on for this repo.
3. Proceed with whatever they ask for.

---

## 5. LOG FORMAT

### 5.1 Session start entry

```text
## [ISO-8601 TIMESTAMP] SESSION START

Agent: <agent_name_or_unknown>
Repo Root: <absolute_path>
Branch: <git_branch_or_unknown>
Worktree: <worktree_path_or_main>
Parent Agent: <parent_agent_name_or_none>
Stack: node
```

### 5.2 Per-turn entry (append after every user message you respond to)

```text
## [ISO-8601 TIMESTAMP] <short title, max 80 chars>

User Prompt (verbatim, secrets redacted):
<exact user message, with secrets replaced by [REDACTED]>

Agent Response Summary:
<2-5 sentences: what was done, why, and any important decision>

Actions:
* <file edited / command run / tool invoked>

Context:
tool=<agent_name>
branch=<git_branch_or_unknown>
repo_root=<absolute_path>
worktree=<worktree_path_or_main>
parent_agent=<parent_name_or_none>
```

### 5.3 Sub-agent and worktree rules

- A sub-agent (Task tool, delegated worker, etc.) **must** log its own entries using the same file. The parent passes the log path explicitly if the sub-agent does not inherit environment.
- Set `parent_agent=` to the parent's name so entries are traceable.
- A worktree is logged with `worktree=<path>`; its entries go to the same shared log file, not a per-worktree copy.
- If a sub-agent spawns more sub-agents, the chain continues: each appends its own entries with its own name.

### 5.4 What not to log

- API keys, tokens, session cookies, OAuth codes, private keys.
- User PII beyond what they explicitly pasted into a prompt.
- Full contents of large files or binary blobs. Reference by path instead.

---

## 6. PROJECT CONTRACT (EVALUABLE SUBMISSION)

The reviewer finds the participant's work through a **known repo layout**. Do not rename these folders.

### 6.1 Repo layout

```text
.
├── AGENTS.md                         # This file, copied into the participant repo
├── README.md                         # Product identity, stack, structure, run instructions, seeded access
├── frontend/                         # React app, kept from the sample calendar repo
├── backend/                          # Express API, kept from the Node sample calendar repo
├── skills/                           # Any skills the participant created, plus skills/validate from this repo
├── transcripts/                      # Exported AI transcripts (the §2 log file, plus any tool-native exports)
├── GUIDELINES.md                     # HackerRank Code Repo guidelines, copied from this repo
├── hackerrank.yml                    # HackerRank install and run configuration
└── setup.sh                          # MongoDB readiness and seed reset
```

### 6.2 Constraints that make the submission evaluable

- **Keep the sample stack.** Do not replace the frontend framework, backend framework, database layer, build tool, or package manager the calendar repo declares.
- **Install, build, and start from a clean checkout** with the exact commands in `hackerrank.yml`. No manual edits.
- **Export the log before submission.** Copy the §2 log file to `transcripts/` in the repo root. Do not edit it during the copy.
- **Read secrets from env vars only.** Never hardcode.
- **Run the verifier before submitting.** Follow `skills/validate/SKILL.md` and make every applicable check pass.

---

## 7. CROSS-PLATFORM AND AGENT-COMPATIBILITY NOTES

- **Path handling.** Always resolve the log path using the platform's home dir (`os.homedir()` / `pathlib.Path.home()` / `$HOME` / `%USERPROFILE%`). Never hardcode `/Users/...` or `C:\Users\...`.
- **Line endings.** Write the log in UTF-8 with `\n`. Don't emit `\r\n` even on Windows; most editors render `\n` fine.
- **Shell.** Don't assume bash. Prefer language-native APIs over shelling out. When you must shell out, provide both a Unix and a Windows form.
- **Tool-specific extras.** This file is the canonical source. If a tool (Claude Code, Cursor, etc.) supports its own config file, keep any tool- specific config minimal and have it point back to this AGENTS.md rather than duplicating rules.
- **Nested AGENTS.md.** If a sub-project adds its own AGENTS.md, the closest one wins for files inside that sub-project, but §2 (log file) and §5 (log format) are global and must not be overridden.

---

## 8. QUICK CHECKLIST FOR THE AGENT

Before you respond to any user message, confirm:

- [ ] I have read this file in this session.
- [ ] I know whether onboarding is required (checked the log).
- [ ] I will append a §5.2 entry after this turn.
- [ ] I will not log secrets.
- [ ] I will preserve the repo layout in §6.

If any box is unchecked, fix that first.

---

## 9. STRICT PROJECT RULES AND CURRENT PHASE

These rules record the user's assignment and attached architecture brief. Preserve §§2–5, including the append-only transcript and onboarding requirements.

### 9.1 Architecture status and protected baseline

- Research/architecture is complete. `ASTRA_ARCHITECTURE.md` revision 1.0, frozen September 17, 2026, remains the architectural baseline.
- Architecture B, the six-capability HackerRank scope, ports, stack, package manager, dependency freeze, request/execution invariants, persistence contracts, and security boundaries are settled.
- Phases 1–6 have passed acceptance and form the protected HackerRank baseline. Do not casually rewrite them. A later phase may touch protected code only when a real regression or a required narrow integration hook is demonstrated, with regression coverage.
- Phase 7 (Import Foundation / cURL) is complete and merged. Its normalized import adapter is the required boundary for later Postman/OpenAPI/Insomnia import adapters.
- Future implementation is governed by the canonical 26-phase roadmap in §10. The user's assigned phase/branch is the current authorization boundary.
- Do not infer that mentioning another phase authorizes work on it. If working in a phase branch, stay inside that phase unless the user explicitly reassigns scope.
- When a phase prompt and §10 disagree, stop broadening scope: follow the narrower constraint and report the discrepancy.

### 9.2 Product acceptance and engineering contract

- Deliver 5–10 meaningful capabilities for creating, organizing, executing, and analyzing HTTP requests. Choose a coherent scope; do not inflate the count with cosmetic controls.
- Every shipped capability must work end to end through a usable React UI, a real Express API, service logic, and MongoDB persistence where data is involved. Handle loading, empty, validation, authorization, success, and failure states.
- Preserve the reference's exact project organization: root Bun workspace, `frontend/src/features`, `frontend/src/shared`, `backend/src/features`, `backend/src/shared`, and `backend/src/scripts`. Keep backend routes, controllers, services, and repositories separate within domains.
- Preserve the declared JavaScript/JSX, React, Express, MongoDB/Mongoose, Vite, Bun, native frontend fetch, and React state approach. Reuse useful reference infrastructure and UI patterns; replace calendar-specific behavior only during implementation.
- Use dependency versions at least as recent as the inspected reference. Keep one root `bun.lock`. Follow `GUIDELINES.md`'s dependency freeze: new or replacement dependencies require a written reason and explicit approval before manifest/lockfile changes. The user's general request for current dependencies is not approval to expand the stack.
- Preserve `hackerrank.yml`'s install/run commands, ports 3000/8000, read-only paths, default-open files, environment setup, and reset-and-seed startup behavior. Install, build, and start must work from a clean checkout without manual repairs.
- Use the reference design system and theme behavior to deliver a modern, polished, responsive, keyboard-accessible UI. Use local assets, clear American English, and the existing formatting configuration. Remove dead code and temporary debugging output.
- Keep core demonstrations functional without external hosted services. For an HTTP client, provide real local HTTP endpoints and MongoDB-backed example data; do not replace execution with canned frontend responses.
- Keep application sign-in credentials separate from credentials attached to target requests. Never hardcode real secrets or commit local environment files. Treat the HTTP executor as a server-side request forgery boundary.
- Make human judgment traceable: document scope decisions and tradeoffs, preserve actual user corrections, and distinguish recommendations from decisions the user has expressly endorsed. Do not fabricate approval, transcripts, runtime results, or production-readiness claims.

### 9.3 Verification and submission

- Before submission, invoke the designated `skills/validate/SKILL.md` against the completed repository and resolve every applicable `FAIL`. Keep reports outside the repo as that skill requires. A `MANUAL` result is unverified, not a pass. Design review does not substitute for this audit.
- Name the final private GitHub repository `coderepo-react-node-postman` to follow the required naming pattern. The public starter and public calendar reference are upstream inputs; never publish participant work to them.
- The submission repository MUST be private from creation onward and MUST NOT be made public under any circumstances. Verify privacy before pushing any participant work. A local clone is not a hosted private submission.
- Store any skills created for this project under `/skills`; preserve `/skills/validate`. Export the required append-only log and available authentic AI transcripts under `/transcripts` before submission. Never invent missing transcript history or export secrets.
- Retain skills in the private GitHub repository while excluding `skills/` and `GUIDELINES.md` from the HackerRank archive through `.gitattributes`. Keep `README.md` in the archive and the archive below 5 MB.
- At the submission phase, add `content.team@problemsetters.com` as a collaborator, join the designated Discord, and post that the task was submitted. Record actual evidence; do not claim invitations, membership, or posts occurred when they did not. Resolve any missing destination/account details at that phase.
- Transfer repository ownership after the submission is accepted. Acceptance and the receiving account/organization must be established before transfer.
- Remote repository creation, collaborator invitations, Discord posting, submission, and ownership transfer are later submission steps, not part of the current design-only phase.


---

## 10. CANONICAL 26-PHASE ROADMAP, DEPENDENCIES, AND PARALLEL WORK

This section is the repo-level source of truth for phase numbers. Agents must not guess what a phase number means.

### 10.1 Canonical phase map

| Phase | Canonical name | Purpose / boundary |
|---|---|---|
| 1 | Repo + HackerRank Compliance Audit | Audit the repo against the frozen architecture and HackerRank contract. No feature expansion. |
| 2 | Execution Core Verification | Harden `compile → policy → DNS → transport → capture → normalize → history`. |
| 3 | Persistence & State Correctness | Collections, environments, preferences, history, ownership, revisions/CAS, restart/reset. |
| 4 | Frontend Workflow Correctness | Tabs, drafts, Send/Save, async reconciliation, conflicts, close/switch, profile isolation. |
| 5 | Response Inspector + Developer UX | Exact/safe response rendering, headers, bodies, metadata, redirects, truncation semantics. |
| 6 | HackerRank Acceptance Freeze | Clean-checkout acceptance, runtime, persistence, responsive/browser checks, packaging. Freeze baseline. |
| 7 | Import Foundation | cURL-first parser and normalized import adapter. Import opens drafts only; no auto-Send/Save. |
| 8 | Export + Code Snippets | Export normalized requests to cURL / JS fetch / Node / Python without leaking secrets. |
| 9 | Cookie / Session Jar | Profile-scoped cookie storage, matching, expiry, secure/path/domain rules, clear/delete UI. |
| 10 | Advanced Auth | Expand auth beyond baseline modes using existing secret-safe request/auth boundaries. |
| 11 | Script Sandbox | Safe pre-request/post-response scripting with strict capability, time, memory/output boundaries. |
| 12 | Assertions / Testing | First-class request assertions/tests built on the script/test result model. |
| 13 | Collection Runner | Ordered/bounded multi-request runs using assertions, variables, and existing execution authority. |
| 14 | CLI | Headless execution of the portable collection/run model with the same semantics as the app. |
| 15 | CI/CD Parity | Make CLI/runner behavior reproducible in CI with machine-readable outcomes and no UI-only semantics. |
| 16 | Portable Project Model | Define a portable, deterministic project representation for requests, variables, examples, and related metadata. |
| 17 | Git-Native Workflow | Version/diff/review the portable project model cleanly in Git without making Mongo the source format. |
| 18 | Local Execution Runtime / Agent | Explicit opt-in local/private target execution without weakening the normal SSRF boundary. |
| 19 | Examples + Mock Servers | Saved response examples plus deterministic mocks that never dispatch real network traffic. |
| 20 | Monitoring / Private Runners | Scheduled/remote execution using runner semantics, including private-runner boundaries. |
| 21 | Protocol Expansion | Add non-baseline protocol capabilities only after auth/cookie/runtime foundations are stable. |
| 22 | Generated API Documentation | Generate useful API/request documentation from the canonical request/project model. |
| 23 | Learning System | Tutorials/guided learning built on generated docs and real product workflows, not disconnected static content. |
| 24 | Collaboration + Versioning | Multi-user/version workflows after portable/Git foundations converge. |
| 25 | Ecosystem | Extensibility/integration surface around stable portable, runner, docs, and collaboration contracts. |
| 26 | AI + Enterprise Layer | AI-assisted and enterprise controls added last, on top of deterministic existing authority. |
| 27 | Execution Intelligence / API Flight Recorder | Evidence-grade execution receipts, causal comparison, redacted reproduction capsules, and bounded failure minimization. |
| 28 | Flight Recorder Acceptance | Prove and polish the complete Passport → Compare → Minimize → Capsule → Reproduce flow with one deterministic local demo. No new unrelated features. |
| 29 | Product UI/UX Polish | Raise the shipped frontend to an intentional, distinctive developer-tool standard. Presentation only: no new features, no behavioural or data changes, no new dependencies. |

### 10.2 Dependency graph

Mandatory chains:

- `1 → 2 → 3 → 4 → 5 → 6 → 7`
- `9 → 10 → 21`
- `11 → 12 → 13 → 14 → 15`
- `16 → 17`
- `22 → 23`
- `12 + 16 + 18 + 19 → 27`
- `27 → 28` (Phase 28 accepts and polishes the merged Flight Recorder; it may not reimplement it)
- Phase 20 should reuse runner/CLI semantics from 13–15 rather than invent a second execution model.
- Phases 24–26 start only after the platform foundations they depend on have converged; 24, 25, and 26 may later run in parallel if ownership is non-overlapping.

Current safe parallel expansion lanes after Phase 7:

- Phase 8 — Export + Code Snippets
- Phase 9 — Cookie / Session Jar
- Phase 11 — Script Sandbox
- Phase 18 — Local Execution Runtime / Agent
- Phase 19 — Examples + Mock Servers
- Phase 22 — Generated API Documentation

These lanes are parallel-safe only when they obey §10.3 ownership and do not opportunistically edit another lane's files.

### 10.3 Branch and ownership rules

Canonical branch naming:

- `phase<N>/<short-name>`
- Each phase branch starts from the latest approved `main` dependency point.
- Never build a new phase from another unmerged phase branch unless §10.2 explicitly requires that dependency.
- Merge completed phases through PR + green GitHub Actions. Do not merge directly into `main` from a worktree.

Current parallel branches:

| Phase | Branch | Primary ownership |
|---|---|---|
| 8 | `phase8/export-snippets` | `frontend/src/features/export/**`; narrow shared request-model helpers only if proven necessary |
| 9 | `phase9/cookie-session-jar` | `backend/src/features/cookies/**`, `frontend/src/features/cookies/**`; narrow execution integration |
| 11 | `phase11/script-sandbox` | `backend/src/features/scripts/**`, `frontend/src/features/scripts/**`; explicit script hook only |
| 18 | `phase18/local-runtime` | `backend/src/features/local-runtime/**`, `frontend/src/features/local-runtime/**`; narrow target-policy hook |
| 19 | `phase19/examples-mocks` | `backend/src/features/{examples,mocks}/**`, `frontend/src/features/{examples,mocks}/**` |
| 22 | `phase22/generated-docs` | dedicated generated-docs/docs feature modules; consume canonical request/project data without changing execution |
| 27 | `phase27/execution-intelligence` | `backend/src/features/execution-intelligence/**`, `frontend/src/features/execution-intelligence/**`; narrow execution, history, portable-model, and mock integration hooks only |
| 28 | `phase28/flight-recorder-acceptance` | Flight Recorder demo/acceptance artifacts under `**/execution-intelligence/**`; narrow import-boundary, workspace, and recorder UI changes only where a proven gap requires them |
| 29 | `phase29/ui-ux-polish` | `frontend/src/**` presentation: stylesheets, tokens, and shared component markup/ARIA only where a proven accessibility defect requires it; no backend files, no feature or workflow logic |

Shared/high-conflict files are integrator-owned unless the phase cannot be completed without a narrow change:

- `frontend/src/App.jsx`
- shared backend schemas / limits / error middleware
- shared frontend components/hooks
- execution compiler/policy/transport/lifecycle
- history/persistence contracts
- app bootstrap/config
- demo/seed
- manifests / lockfile
- `hackerrank.yml`
- `.github/workflows/**`
- `AGENTS.md`
- `ASTRA_ARCHITECTURE.md`

If a phase needs one of these, make the smallest possible change, explain why in the PR, and add regression coverage. Never use a shared file as a convenient place for unrelated phase logic.

### 10.4 Parallel-agent rules

Every agent/sub-agent must:

1. Read this entire file before coding.
2. Identify its exact phase from the current git branch.
3. Read that phase's row in §10.1 and dependency/ownership rules in §§10.2–10.3.
4. Treat phases 1–6 as protected HackerRank baseline.
5. Treat completed Phase 7 import normalization as shared infrastructure, not permission to rewrite its parser.
6. Do not assume another numbered phase's goals from memory; use this file.
7. Do not modify another active phase's owned paths.
8. If two phases require the same shared contract change, stop and route that change through the integrator rather than racing edits.
9. Rebase/merge latest approved `main` only at a deliberate integration point; do not repeatedly pull unrelated active branches into each other.
10. Before PR merge, run the phase gate plus the repository Baseline Gate. A phase is not complete merely because its local tests pass.


### 10.6 Executable phase specifications

When the user assigns a phase, the agent MUST execute the matching specification below directly. Do not ask the user for a separate phase prompt unless an essential ambiguity is genuinely missing. Each phase uses branch `phase<N>/<short-name>`, targets `main`, requires the repository Baseline Gate plus its phase-specific tests, and must finish with `PHASE <N> VERDICT: PASS` or `PHASE <N> VERDICT: BLOCKED`.

#### Phase 1 — Repo + HackerRank Compliance Audit
- **Branch:** audit/read-only against current baseline.
- **Goal:** trace the six frozen capabilities end to end and compare actual code/runtime to Architecture B, GUIDELINES, hackerrank.yml, tests, seed, and packaging.
- **Do:** verify request execution, collections, environments, auth, inspector, history, ownership, CAS, security, responsive/accessibility, clean commands.
- **Do not:** implement product features.
- **Exit:** concrete findings, severity/root cause/minimal fix/test, dependency-safe work split, exact acceptance blockers.

#### Phase 2 — Execution Core Verification
- **Branch:** `phase2/execution-core`.
- **Goal:** harden `compile → policy → DNS → transport → capture → normalize → history`.
- **Do:** adversarial SSRF/DNS, pinned destination, deadline/cancel/finalize races, framing, HEAD/204/304, gzip/deflate/br, size limits, redaction, receipt truth.
- **Primary paths:** `backend/src/features/executions/**`.
- **Do not:** add frontend/product features.
- **Exit:** execution/security matrix green.

#### Phase 3 — Persistence & State Correctness
- **Branch:** `phase3/persistence-state`.
- **Goal:** prove profile-scoped Mongo correctness for collections, environments, preferences, history, revisions/CAS, restart/reset.
- **Do:** stale/concurrent writes, duplicate races, secretRef round-trip, cursor/expiry, restart persistence, deterministic reset.
- **Primary paths:** backend persistence domains; minimal frontend reconciliation only if required.
- **Do not:** alter execution semantics without proven persistence bug.
- **Exit:** Mongo-backed race/ownership/restart tests green.

#### Phase 4 — Frontend Workflow Correctness
- **Branch:** `phase4/frontend-workflows`.
- **Goal:** harden tabs, drafts, Send/Save separation, async result ownership, conflicts, close/switch/logout/profile isolation.
- **Do:** edit-during-send/save, stale callbacks, reconciliation/cancel, Save As, dirty prompts, keyboard focus/close, history isolation.
- **Primary paths:** `frontend/src/App.jsx`, `frontend/src/features/workspace/**`, history/request workflow helpers.
- **Do not:** broad App.jsx refactor.
- **Exit:** reducer/workflow tests + responsive browser flows green.

#### Phase 5 — Response Inspector + Developer UX
- **Branch:** `phase5/response-inspector`.
- **Goal:** exact and safe response presentation.
- **Do:** status/timing/size/outcome, duplicate headers, raw fidelity, token-preserving JSON, safe XML/HTML fallback, binary/empty/multibyte bodies, live-vs-history truncation, redirects, errors/cancel/blocked metadata.
- **Primary paths:** `frontend/src/features/executions/**`; backend normalization only for proven contract bug.
- **Do not:** change transport behavior gratuitously.
- **Exit:** parser/view tests + browser inspector matrix green.

#### Phase 6 — HackerRank Acceptance Freeze
- **Branch:** `phase6/hackerrank-acceptance-freeze`.
- **Goal:** produce the protected known-good HackerRank baseline.
- **Do:** clean install, all tests, syntax/build, isolated seed/reset, runtime, ownership, seeded matrix, persistence, UI/responsive/accessibility, packaging/archive, GitHub Actions.
- **Do not:** opportunistically improve product; fix only real acceptance failures.
- **Exit:** `PHASE 6 VERDICT: PASS — HACKERRANK BASELINE FROZEN`; phases 1–6 become protected.

#### Phase 7 — Import Foundation
- **Branch:** `phase7/import-foundation`.
- **Goal:** establish one normalized import adapter, starting with cURL only.
- **Do:** safe cURL parsing, quoting/multiline, method/headers/body/auth, warnings, fail-closed file/shell/network flags, preview → dirty draft.
- **Primary paths:** `frontend/src/features/import/**`.
- **Do not:** auto-Send/Save; do not implement Postman/OpenAPI/Insomnia yet.
- **Exit:** parser/adapter/browser tests green; later adapters MUST reuse this boundary.

#### Phase 8 — Export + Code Snippets
- **Branch:** `phase8/export-snippets`.
- **Goal:** export normalized requests as cURL, JS fetch, Node, Python requests.
- **Do:** preserve method/URL/ordered query/duplicate headers/body, safe escaping, variable placeholders, secret protection, preview/copy.
- **Primary paths:** `frontend/src/features/export/**`.
- **Do not:** expose resolved secrets or send-only overrides; no execution/persistence mutation.
- **Exit:** round-trip/import-export and browser copy tests green.

#### Phase 9 — Cookie / Session Jar
- **Branch:** `phase9/cookie-session-jar`.
- **Goal:** profile-scoped HTTP cookie storage and replay.
- **Do:** Set-Cookie parsing, domain/path/host-only/Secure/expiry/Max-Age, replacement/deletion/order, explicit Cookie conflicts, persistence, inspect/delete/clear.
- **Primary paths:** `backend/src/features/cookies/**`, `frontend/src/features/cookies/**`; narrow execution hook.
- **Do not:** leak across profiles or bypass existing security/redaction.
- **Exit:** matching/security/restart/browser tests green.

#### Phase 10 — Advanced Auth
- **Branch:** `phase10/advanced-auth`.
- **Dependency:** Phase 9 merged.
- **Goal:** extend target authentication beyond baseline modes using the existing secret-safe auth boundary.
- **Do:** implement only explicitly selected advanced schemes that fit the product scope; model credentials as references/ephemeral inputs, deterministic header/query generation, collection inheritance, preview-safe metadata.
- **Primary paths:** dedicated auth modules + narrow request/compiler UI integration.
- **Do not:** hardcode/persist literals, weaken generated-header conflict checks, or build OAuth browser flows without an explicit supported contract.
- **Exit:** every added scheme has end-to-end UI/save/send/security tests and no secret leakage.

#### Phase 11 — Script Sandbox
- **Branch:** `phase11/script-sandbox`.
- **Goal:** bounded pre-request and post-response scripting.
- **Do:** allow explicit variable/header mutations, response reads, tests/assertions, bounded console; enforce time/output/memory practical limits.
- **Primary paths:** `backend/src/features/scripts/**`, `frontend/src/features/scripts/**`.
- **Block:** filesystem, process/env, child processes, arbitrary network, imports/require, escaping timers, prototype/global pollution.
- **Invariant:** mutated request still passes normal compiler/policy/transport; post-response script cannot rewrite HTTP truth.
- **Exit:** forbidden-capability, timeout, isolation, SSRF-bypass and browser tests green.

#### Phase 12 — Assertions / Testing
- **Branch:** `phase12/assertions-testing`.
- **Dependency:** Phase 11 merged.
- **Goal:** make request assertions a first-class deterministic feature.
- **Do:** status/header/body/JSON-path-like bounded assertions, named tests, pass/fail/error results, clear diagnostics, persisted definitions but immutable run results.
- **Primary paths:** assertions/test-result feature modules reusing script result model.
- **Do not:** invent a second scripting runtime.
- **Exit:** assertion semantics, edge cases, history/result display and browser tests green.

#### Phase 13 — Collection Runner
- **Branch:** `phase13/collection-runner`.
- **Dependency:** Phase 12 merged.
- **Goal:** run ordered request sets with variables/assertions using existing execution authority.
- **Do:** bounded iteration/order, stop/continue policy, per-request results, cancellation, variable scope, summary, rerun.
- **Primary paths:** dedicated runner backend/frontend modules.
- **Do not:** bypass per-request policy/auth/cookie/script/assertion rules or create an alternate transport.
- **Exit:** deterministic run/cancel/failure/variable propagation tests + browser runner flow green.

#### Phase 14 — CLI
- **Branch:** `phase14/cli`.
- **Dependency:** Phase 13 merged.
- **Goal:** headless collection/project execution with semantics matching the app runner.
- **Do:** parse explicit project/collection inputs, machine-readable output, exit codes, environment selection, secret injection through env/stdin-safe mechanisms.
- **Primary paths:** dedicated CLI entrypoints reusing runner services.
- **Do not:** duplicate runner logic or require GUI state.
- **Exit:** parity fixtures prove CLI and UI runner produce equivalent deterministic outcomes.

#### Phase 15 — CI/CD Parity
- **Branch:** `phase15/cicd-parity`.
- **Dependency:** Phase 14 merged.
- **Goal:** make runner/CLI reliable in CI.
- **Do:** stable exit codes, JSON/JUnit-like machine output if approved without dependency expansion, non-interactive secrets/env, artifact/report examples, CI documentation.
- **Do not:** add hosted infrastructure.
- **Exit:** representative CI job runs collections headlessly and fails/passes correctly.

#### Phase 16 — Portable Project Model
- **Branch:** `phase16/portable-project`.
- **Goal:** define deterministic portable representation of requests, collections, variables, examples, auth references, scripts/tests metadata where applicable.
- **Do:** versioned schema, canonical ordering/serialization, import/export validation, forward-compatible unknown-field policy, secret-safe representation.
- **Primary paths:** dedicated portable/project-model modules.
- **Do not:** make Mongo documents the interchange format or include secret values.
- **Exit:** canonical round-trip/hash/diff-friendly fixtures green.

#### Phase 17 — Git-Native Workflow
- **Branch:** `phase17/git-native`.
- **Dependency:** Phase 16 merged.
- **Goal:** make portable projects pleasant to version/review in Git.
- **Do:** deterministic file layout, meaningful diffs, conflict-safe IDs, validate/import changed project files, clear sync semantics.
- **Do not:** shell out to arbitrary Git commands from untrusted project content or replace Mongo runtime persistence with Git.
- **Exit:** edit/diff/merge/import round-trip scenarios green.

#### Phase 18 — Local Execution Runtime / Agent
- **Branch:** `phase18/local-runtime`.
- **Goal:** explicit opt-in access to approved localhost/private dev targets without weakening normal SSRF policy.
- **Do:** profile-scoped enablement, explicit host/IP allowlist, DNS-rebinding defense, pinned address, metadata block, IPv4/IPv6, timeout/cancel/redaction.
- **Primary paths:** `backend/src/features/local-runtime/**`, frontend local-runtime controls, narrow target-policy hook.
- **Do not:** wildcard private network by default; no installer/daemon unless separately authorized.
- **Exit:** normal mode remains blocked; approved local mode passes adversarial tests.

#### Phase 19 — Examples + Mock Servers
- **Branch:** `phase19/examples-mocks`.
- **Goal:** saved response examples and deterministic mocks.
- **Do:** save/manual examples, ordered headers/body/status/content type, explicit method/path/query/header match rules, deterministic priority, mock miss, edit/delete.
- **Primary paths:** `backend/frontend src/features/{examples,mocks}/**`.
- **Invariant:** mock execution makes zero real transport calls and is clearly marked.
- **Exit:** persistence/profile isolation/matching/zero-network/browser tests green.

#### Phase 20 — Monitoring / Private Runners
- **Branch:** `phase20/monitoring-runners`.
- **Dependency:** reuse Phase 13–15 runner/CLI semantics; Phase 18 may be required for private targets.
- **Goal:** scheduled/remote runs with deterministic runner outcomes.
- **Do:** schedules/configuration, bounded run history, status summaries, private-runner registration boundary if selected, secret-safe configuration.
- **Do not:** invent a second execution engine or claim production scheduler guarantees not implemented.
- **Exit:** scheduled/manual trigger parity, cancellation, result retention, isolation and failure-reporting tests green.

#### Phase 21 — Protocol Expansion
- **Branch:** `phase21/protocol-expansion`.
- **Dependency:** Phase 10 merged; also require relevant runtime/security foundations.
- **Goal:** add carefully selected non-baseline protocol support.
- **Do:** choose protocol(s) explicitly; define separate deterministic compiler/transport/result contract while sharing auth/variables/security where valid.
- **Do not:** force non-HTTP semantics through HTTP code or weaken SSRF/local-runtime boundaries.
- **Exit:** protocol-specific end-to-end tests + UI inspection + isolation from HTTP regressions.

#### Phase 22 — Generated API Documentation
- **Branch:** `phase22/generated-docs`.
- **Goal:** generate useful docs from canonical request/project data.
- **Do:** collection/request navigation, method/path/auth/variables/body examples, response examples where available, stable anchors, copyable snippets by consuming Phase 8 output if merged.
- **Primary paths:** dedicated docs-generation/view modules.
- **Do not:** mutate requests/execution or create a competing schema.
- **Exit:** deterministic generation, stale/missing-data behavior, responsive docs UI tests green.

#### Phase 23 — Learning System
- **Branch:** `phase23/learning-system`.
- **Dependency:** Phase 22 merged.
- **Goal:** contextual tutorials/guided learning tied to real product workflows/docs.
- **Do:** progressive lessons, runnable examples, completion state, links into actual requests/collections, beginner-to-advanced paths.
- **Do not:** ship disconnected static blog filler or fake execution results.
- **Exit:** learning flows launch real product actions and remain accessible/responsive.

#### Phase 24 — Collaboration + Versioning
- **Branch:** `phase24/collaboration-versioning`.
- **Dependency:** platform foundations converged; Phase 16–17 strongly preferred.
- **Goal:** explicit collaborative ownership/version workflows.
- **Do:** roles/permissions, change/version metadata, conflict/review behavior, auditability, profile/account isolation.
- **Do not:** silently introduce real-time distributed complexity; start with smallest coherent collaboration model.
- **Exit:** permission matrix, concurrent edit/version conflict, audit/history and browser flows green.

#### Phase 25 — Ecosystem
- **Branch:** `phase25/ecosystem`.
- **Dependency:** stable portable/runner/docs/collaboration contracts.
- **Goal:** extensibility/integration surface without destabilizing core.
- **Do:** define narrow extension/import/export/integration contracts, permission/capability boundaries, versioning, failure isolation.
- **Do not:** allow arbitrary plugin code to bypass security boundaries or mutate core state outside declared APIs.
- **Exit:** sample extension/integration proves capability isolation and backward-compatible contracts.

#### Phase 26 — AI + Enterprise Layer
- **Branch:** `phase26/ai-enterprise`.
- **Dependency:** last phase after deterministic platform foundations stabilize.
- **Goal:** add AI-assisted workflows and enterprise controls as optional layers.
- **Do:** AI may draft/explain/generate but deterministic validators/execution remain authority; enterprise controls may include governance/audit/policy features explicitly selected by the user.
- **Do not:** let AI auto-send dangerous requests, expose secrets, bypass policy/auth, or become the source of truth for execution/history.
- **Exit:** AI suggestions are reviewable/reversible/evidence-linked; enterprise permission/audit/policy tests green.

#### Phase 27 — Execution Intelligence / API Flight Recorder
- **Branch:** `phase27/execution-intelligence`.
- **Dependencies:** Phases 12, 16, 18, and 19 merged.
- **Goal:** implement the approved “Tracer as the API Flight Recorder” plan without replacing or broadening that specification.
- **Do, in order:** (1) Execution Passport / `ExecutionReceiptV1`; (2) Causal Run Comparison / `RunComparisonV1`, including the approved lightweight contract checks; (3) Reproduction Capsule / `ReproCapsuleV1`; (4) Failure Minimizer / `MinimizationJobV1`.
- **Primary paths:** dedicated backend/frontend execution-intelligence modules; the smallest proven hooks in execution finalization, history persistence, portable project import/export, examples/mocks, and workspace UI.
- **Invariants:** receipts and capsules are secret-redacted and versioned; comparisons are deterministic evidence rather than AI claims; capsules import as unsent dirty drafts; minimization uses the normal compiler/policy/DNS/transport/capture/normalize path with cancellation, deadlines, probe budgets, flaky-predicate detection, and safe-method/local-or-mock restrictions.
- **Do not:** create an alternate execution path, expose resolved secrets, auto-Send or auto-Save imported capsules, resume Phase 10 or Phase 23, or add unrelated Postman-parity features.
- **Exit:** Phase 27 feature/security/browser tests, the normal phase gate, and the repository Baseline Gate are green; finish with `PHASE 27 VERDICT: PASS` or `PHASE 27 VERDICT: BLOCKED`.

#### Phase 28 — Flight Recorder Acceptance
- **Branch:** `phase28/flight-recorder-acceptance`.
- **Dependencies:** Phase 27 merged into `main`.
- **Goal:** prove and polish the complete Flight Recorder flow `Passport → Compare → Minimize → Capsule → Reproduce` on top of the merged Phase 27 implementation. No new unrelated features.
- **Do:** build one deterministic demo over local seeded infrastructure only (successful request → one subtle change → request fails → compare the runs → identify the first meaningful divergence → minimize to the smallest reproducing request → export a redacted reproduction capsule → import it through the Phase 7 normalized import boundary → open as an unsent dirty draft → manually reproduce the failure); verify passport immutability after request/env/auth/cookie/assertion changes, comparison coverage of request/env/auth/script/cookie/DNS/policy/response changes, contract diff for removed fields, type changes, unexpected statuses, and required-header changes, minimizer budgets, cancellation, flaky predicates, SSRF and unsafe-method restrictions, mutating probes only against approved local or mock targets, capsule round-trip without semantic drift, capsule import never auto-Sending or auto-Saving, and zero resolved secrets in passports, comparisons, capsules, minimizer records, history, or errors; polish only what is necessary so users can clearly find Passport, Compare, Minimize, and Export Capsule, keyboard-accessible at 375 / 768 / 1024 / 1440; reposition README as **Tracer — API Flight Recorder** with core flow `record → compare → minimize → reproduce`, keeping HackerRank and run instructions intact.
- **Do not:** add unrelated features, broaden refactors, change dependencies or the lockfile, weaken any Phase 27 invariant, or rewrite protected baseline code without a proven regression.
- **Exit:** `bun install --frozen-lockfile`, `bun test`, backend syntax, frontend build, isolated seed/reset, the full Flight Recorder demo, baseline regressions, responsive browser smoke, GitHub Actions, and `skills/validate/SKILL.md` are green; finish with `PHASE 28 VERDICT: PASS — FLIGHT RECORDER ACCEPTED` or `PHASE 28 VERDICT: BLOCKED`.

#### Phase 29 — Product UI/UX Polish
- **Branch:** `phase29/ui-ux-polish`.
- **Dependency:** latest approved `main` (Phase 28 merged).
- **Goal:** the shipped product should read as one intentional, distinctive developer tool — dense but calm, precise, keyboard-usable, and visually consistent — without changing what it does.
- **Do:** inspect the real running app before editing; audit against an explicit design direction; unify type/mono/easing/duration tokens; repair contrast and minimum hit areas; make text-entry focus rings visible instead of suppressed; remove generic-UI tells (side-stripe notices, animated layout properties); give tabs, switches, and progress a single coherent motion language with `prefers-reduced-motion` parity; keep the light and dark themes equally correct; verify at 375/768/1024/1440.
- **Primary paths:** `frontend/src/styles.css`, feature stylesheets, and shared frontend components — presentation, tokens, and proven accessibility fixes only.
- **Do not:** touch backend code, request/execution semantics, persistence, tests' contracts, dependencies, or `bun.lock`; do not restructure the app shell, rename workflows, or add capabilities.
- **Exit:** `bun install --frozen-lockfile`, `bun test`, frontend tests, backend syntax, frontend build, isolated seed/reset, runtime smoke, baseline regressions, keyboard/contrast/target/overflow sweeps at 375/768/1024/1440 in light and dark, the full Flight Recorder flow, and `skills/validate/SKILL.md` green; finish with `PHASE 29 VERDICT: PASS — UI/UX POLISHED` or `PHASE 29 VERDICT: BLOCKED`.

### 10.7 Common phase completion gate

Unless a phase explicitly requires more, every implementation phase must:
- start from the correct approved dependency commit;
- keep its branch/worktree ownership isolated;
- add regression tests for every real bug fixed;
- run `bun test`;
- run backend syntax checks when backend code changed;
- run `cd frontend && bun run build` when frontend code changed;
- run relevant browser smoke at 375 / 768 / 1024 / 1440 for UI changes;
- pass existing GitHub Actions / Baseline Gate;
- leave git clean except intentional ignored local artifacts;
- open a PR to `main` and report commit, PR, tests, fixes, evidence, blockers;
- never claim PASS if required evidence was not executed.

### 10.5 Current roadmap state

As of the Phase 29 assignment:

- Phases **1–9, 11–12, 16, 18–19, 22, and 27–28: COMPLETE / MERGED**.
- Phases **1–6: PROTECTED / FROZEN baseline**.
- Phase **13: MERGED** as `e75d306` (Collection Runner); Phase **14: MERGED** as `bfcd441` (headless CLI); Phase **17: MERGED** as `cc8dc56`.
- Phase **27: MERGED** as `8fe4026` (Execution Intelligence / API Flight Recorder).
- Phase **28: MERGED** as `0a630e2` (Flight Recorder Acceptance).
- Phase **29: ACTIVE** on `phase29/ui-ux-polish`, based on latest `main` after the Phase 14 merge.
- Phase **29 owns presentation**: it is frontend-wide and overlaps every frontend feature path, so it merges before other frontend phases rebase; it adds no capability and changes no contract.
- Phases **10 and 23: INACTIVE** and must not be resumed as part of Phase 29.
- Other phases remain governed by their dependency chains and explicit user assignment.

The user may advance this state over time. When a phase passes and merges, update only this subsection plus any dependency/ownership facts that actually changed; do not rewrite historical phase definitions.
