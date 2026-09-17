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
6. Before design, implementation, validation, or submission work, read §9 for the user's strict project rules and the current phase boundary.

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

### 9.1 Current phase: research and architecture only

- The authorized deliverables are this `AGENTS.md` update and `ASTRA_ARCHITECTURE.md`. Do not write production code, scaffold the app, change dependencies, or implement features in this phase.
- Inspect the entire app repository and its instructions before proposing changes. Clone and study the calendar reference named in `INSTRUCTIONS.md`; inspect its frontend, backend, manifests, lockfile, configuration, setup flow, and UI. Attempt its documented execution and report blockers honestly.
- Research Postman, Bruno, Insomnia, and Hoppscotch using primary sources. Focus on HTTP execution, CORS, auth, variables, collections, tabs, history, persistence, response handling, cancellation, extensibility, and security.
- Produce three materially different, realistic architectures. For each, specify components, the complete request flow, state ownership, persistence, execution location, extensibility, testing, and tradeoffs.
- Compare task coverage, UX, correctness, simplicity, risk, coupling, persistence, testability, maintainability, extensibility, performance, and ease of modification by coding agents.
- Select the smallest architecture that cleanly supports the product. Avoid microservices, queues, event buses, multiple databases, and distributed infrastructure without a concrete requirement.
- Write `ASTRA_ARCHITECTURE.md` using the 14 sections specified in the user's brief: Task Understanding; Existing Repo Assessment; Research Findings; Architecture A; Architecture B; Architecture C; Comparison; Selected Architecture; Final Component Diagram; Core Data Models; End-to-End Request Flow; Key Engineering Decisions; Risks / Failure Modes; Implementation Order.
- Lock the component boundaries, data models, API contracts, state ownership, auth and variable semantics, history/response/error models, and six workflows: send, save to collection, use variables, apply auth, inspect response, and reopen history. Include a concrete UI design direction.
- Selection in the design document is an architectural decision for the proposed implementation, not evidence of human endorsement or permission to implement. Begin production implementation only when the user requests the next phase.
- The user requested the final architecture freeze after external review. `ASTRA_ARCHITECTURE.md` revision 1.0, frozen September 17, 2026, is the implementation baseline. Read its decisions, invariants, API contracts and stage gates before any future implementation or architecture change. Architecture B and the six-capability scope are settled; record any required deviation and its evidence instead of silently reopening the design. The environment/transport proof and application verifier remain unexecuted gates, not implied passes.

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
