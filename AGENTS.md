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

### 10.2 Dependency graph

Mandatory chains:

- `1 → 2 → 3 → 4 → 5 → 6 → 7`
- `9 → 10 → 21`
- `11 → 12 → 13 → 14 → 15`
- `16 → 17`
- `22 → 23`
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

### 10.5 Current roadmap state

As of the Phase 7 merge:

- Phases **1–7: COMPLETE**.
- Phases **1–6: PROTECTED / FROZEN baseline**.
- Phase **7: merged shared import foundation**.
- Phases **8, 9, 11, 18, 19, 22: eligible parallel lanes** from the Phase 7 merged baseline.
- All other phases remain blocked by their dependency chain or by explicit user assignment.

The user may advance this state over time. When a phase passes and merges, update only this subsection plus any dependency/ownership facts that actually changed; do not rewrite historical phase definitions.
