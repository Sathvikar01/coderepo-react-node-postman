# Build Your Own Postman — Architecture and Product Design

> **Historical design record.** This file is the frozen pre-implementation architecture from September 17, 2026 and intentionally preserves the decisions and constraints as they were understood before implementation. It is **not** the best description of the shipped Tracer architecture. For the current system, reviewer flow, verification authority, and WHY evidence chain, start with [README.md](README.md) and [docs/REVIEWER_GUIDE.md](docs/REVIEWER_GUIDE.md).


Revision: 1.0 — FROZEN on September 17, 2026. Phase: design complete; implementation not started.

The user requested reconciliation of nine external reviews and a final architecture freeze. Architecture B is the implementation baseline below. The numbered decisions are frozen design decisions selected under that instruction, not claims that the user personally endorsed every technical detail. Runtime feasibility gates are mandatory before shipping. The freeze does not authorize implementation or claim that unexecuted checks passed.

## 1. Task Understanding

Build a polished full-stack HTTP client for developers and for HackerRank debugging assessments. A reviewer must be able to sign in, compose a real request, send it, inspect its result, save it, change its environment, and recover it from history. The application should expose understandable domain boundaries where realistic defects can later be introduced and diagnosed.

The governing local documents are `REQUIREMENTS.md`, `INSTRUCTIONS.md`, `GUIDELINES.md`, and `AGENTS.md`. The user explicitly requests three architectures and a locked design, with no production implementation in this phase.

### Selected product scope: six capabilities

| Capability | Concrete scope | End-to-end completion evidence |
|---|---|---|
| Request builder and execution | GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS; URL; ordered query/header rows; none, JSON, text, and URL-encoded bodies; send/cancel/timeout | A user-created request reaches a real HTTP endpoint; persisted execution agrees with observed result |
| Collections | Create, rename, reorder, duplicate and delete collections/folders/requests; one level of folders; move requests within a collection | Reload reflects saved structure and content from MongoDB, including atomic reordering |
| Environments | Named environments; ordinary variables and server-secret references; active selection; collection defaults; missing-variable errors | Same template targets distinct seeded datasets after environment switching; configuration persists |
| Target authentication | None, inherit collection, bearer, basic, API key in header or query; visible conflict validation | Real local endpoints accept correct credentials and return HTTP 401 for incorrect ones |
| Response inspection | Status, duration, body size, headers, raw text, JSON tree, text search, JSON expand/collapse, safe formatted XML/HTML source | Viewer handles success, HTTP errors, invalid JSON, empty responses, text, and bounded binary data |
| History | Every accepted send has an immutable request snapshot and terminal outcome; inspect, reopen, resend, save as request, delete and clear | History survives browser reload; reopening produces an editable draft; resend performs a new real HTTP call |

Sign-in/profile selection, tabs, theme, and preferences support these capabilities. They are not padded feature counts. No OAuth flow, scripts/tests editor, file upload, cookie jar, import/export UI, WebSocket client, GraphQL-specific editor, team collaboration, request runner, or code snippets in version one. JSON GraphQL POSTs can use the ordinary JSON builder without claiming a GraphQL feature.

The submission must remain private on GitHub, include authentic transcripts and any created skills, pass the designated verifier, add the specified collaborator, and be announced on the designated Discord. Ownership transfers only after acceptance. These are later milestones, not actions performed by this design phase.

## 2. Existing Repo Assessment

### Repository identity and evidence

The initial workspace was empty. The requested [guidelines starter](https://github.com/ProblemSetters/postman-guidelines) was cloned into `C:\Users\arsat\Downloads\postman` at commit `73ad6b71891975edfdd3b039fdf20e701c1b899e`.

The complete starter file inventory is nine files: `README.md`, `REQUIREMENTS.md`, `INSTRUCTIONS.md`, `GUIDELINES.md`, `AGENTS.md`, `skills/validate/SKILL.md`, and its three references (`static-checks.md`, `runtime-checks.md`, `report-format.md`). These documents were read. The starter has no frontend, backend, manifests, or executable calendar application; its README points to a separate reference. This distinction prevents treating missing app files as a broken implementation.

The [calendar reference](https://github.com/ProblemSetters/coderepo-react-node-calendar) was cloned separately into `C:\Users\arsat\Downloads\coderepo-react-node-calendar-reference` at commit `a671eef03644abe74e3ccb7d02c163b00d3241b5`. Its tracked file inventory, README, manifests, lockfile declarations, runtime configuration, formatting rules, seed lifecycle, representative frontend components, auth/profile flow, complete calendar CRUD path, and API/error/database boundaries were inspected. The supplied `assets/calendar-scheduling.jpg` was visually inspected as a reference screenshot, not as proof of a live run.

### Locked stack baseline

| Layer | Exact declared baseline |
|---|---|
| Frontend | React/react-dom 19.2.4; JavaScript/JSX; @fontsource/roboto 5.3.0 |
| Build | Vite 8.2.2; @vitejs/plugin-react 6.1.1 |
| Backend | Express 5.2.1; JavaScript ES modules executed with Bun |
| Persistence | MongoDB 8.0+ per reference README; Mongoose 8.24.1 |
| Validation and auth | Zod 4.3.6; jsonwebtoken 9.0.2; bcryptjs 3.0.2 |
| Other existing dependencies | cors 2.8.6; dotenv 17.3.1; concurrently 9.2.1 |
| Workspace/runtime | Bun 1.3+; one root workspace manifest and `bun.lock` |
| State and application HTTP client | React hooks and native browser fetch; no state/router/HTTP-client library |

These versions come from opened manifests and matching lockfile workspace entries. They are an inspected minimum, not a claim that each is the newest release. Retain the pinned baseline for reproducibility; review updates at implementation time without downgrading or expanding the approved dependency surface. No additional dependency is proposed. Freeze Bun 1.3.9 as the initial transport-proof runtime (the installed version, satisfying the sample minimum). A compatible newer Bun patch can be evaluated with the same proof suite if needed; no runtime replacement is implicit.

### Structure and reusable code

- Frontend: `src/App.jsx`, `src/main.jsx`, `src/styles.css`, `src/features/<domain>`, and `src/shared/{api,components,utils}`. Domain API modules call the shared fetch client, which understands `{ data }` and `{ error }` envelopes.
- Backend: `src/app.js`, `src/index.js`, `src/features/<domain>`, `src/shared/{config,middleware,errors,utils}`, and `src/scripts/seed.js`. Route → controller → service → repository → Mongoose model is demonstrated by calendars.
- Reuse the workspace manifests, scripts, auth foundation, database connection, error shape, modal/select/confirmation patterns, theme variables, local font imports, and frontend proxy.
- Replace calendar/event/availability/insight business domains, calendar branding, seed data, and date-specific controls during implementation. Do not copy unused scheduling code into the final product.
- Preserve the sample's Prettier and editor configuration. They differ on indentation (Prettier uses tabs, EditorConfig specifies spaces); use the existing Prettier configuration for JS/JSX formatting without adding a formatter dependency or silently changing either file.

### Runtime and operational contract

`hackerrank.yml` installs with `bun install && bash setup.sh --seed` and runs with `bun start`. Root `prestart` executes `bash setup.sh --start`; setup creates missing environment files, checks MongoDB, and resets seed data. Root start uses concurrently to launch backend and frontend. Backend listens on `0.0.0.0:8000` after database connection; Vite listens on port 3000 and proxies `/api` to 8000. Backend reload is `bun --watch`; frontend reload is Vite's own.

Read-only paths cover `backend/src/scripts/**`, both backend config files, and `frontend/vite.config.js`. Default-open files are `backend/src/app.js` and `frontend/src/App.jsx`. Keep these paths and command strings. Seed reset on **full start** is an assessment requirement: durable data survives browser reload and backend-only restart, but `bun start` intentionally restores the baseline. State this prominently in the final README and UI help.

The reference's archive rules omit the additional `GUIDELINES.md`/`skills/` exclusions needed in this app repository. Add those exclusions during implementation while preserving existing ones. Its sample JWT secret is a demo constant; the new setup must generate missing local secrets, with example placeholders documented, rather than shipping a real hardcoded signing key.

### Verification limits in this phase

Local Bun 1.3.9 and Node 24.14.1 were detected. No listeners were initially found on 3000, 8000, or 27017. MongoDB was not found on PATH, in the standard Windows Server installation path, or through the inspected Ubuntu WSL command. Git Bash is present. The exact reference install command encountered Bun cache `EPERM` errors for packages including `qs` and `vite` and stopped making visible progress. Its task-owned process tree was terminated; installation did not complete, setup/seeding was not reached, and no application servers were launched. The reference's tracked Git state remained unchanged; ignored partial install artifacts may remain. The source inspection and reference screenshot establish a design baseline, but do not establish that the reference or proposed app passed a live end-to-end audit. Installation/start and the live UI inspection remain prerequisites to implementation verification on a usable environment.

## 3. Research Findings

Sources were consulted on September 16, 2026. Product facts below motivate decisions; they do not imply compatibility with those products' complete file formats or internal architectures.

| Primary-source finding | Implication for this project |
|---|---|
| Postman's Browser Agent is subject to CORS, while its Desktop Agent executes locally and Cloud Agent executes from Postman infrastructure. [Agents](https://learning.postman.com/docs/getting-started/basics/about-postman-agent) | Make execution location explicit. A server executor avoids browser CORS but cannot claim access to the browser user's private machine. |
| Postman resolves variables at run time and supports collection/folder auth inheritance. [Variables](https://learning.postman.com/latest-v-12/docs/use/send-requests/variables/use-variables), [auth](https://learning.postman.com/docs/use/send-requests/authorization/specifying-authorization-details) | Preserve templates, resolve an execution snapshot, and make inherited auth visible. |
| Bruno distinguishes persisted collection/environment values from ephemeral runtime values; its V4 changes make persistence behavior significant. [Variable documentation](https://github.com/usebruno/bruno-docs/blob/main/variables/overview.mdx), [V4](https://www.usebruno.com/v4-release) | Specify secret and draft lifetimes explicitly. A masked field alone is not a storage policy. |
| Insomnia offers local, scratch, cloud, and Git storage modes; private environments and vault-backed values have distinct storage/export behavior. [Storage](https://developer.konghq.com/insomnia/storage/), [environments](https://developer.konghq.com/insomnia/environments/) | Storage mode is an architectural decision. This assignment requires MongoDB, so do not adopt file or browser storage as the source of truth. |
| Hoppscotch supplies agent/proxy/extension interceptors for browser restrictions and separates secret values from synced/exported ordinary variables. [Interceptors](https://docs.hoppscotch.io/documentation/features/interceptor), [variables](https://docs.hoppscotch.io/documentation/features/variables) | An execution boundary and secret boundary belong in the initial design. No browser extension should be required for assessment. |
| Hoppscotch automatically adds sent requests to history and allows reopening them. Postman distinguishes raw and typed response views. [History](https://docs.hoppscotch.io/documentation/features/history), [responses](https://learning.postman.com/docs/use/send-requests/response-data/responses) | Keep history snapshots separate from editable requests; retain source bytes rather than only a formatted JSON projection. |

Variable precedence differs across products. This app deliberately uses active environment → collection defaults, with no implicit global/request/script scopes. It is a small explicit contract, not a claim to reproduce another client's rules.

Node's HTTP API exposes raw response headers, stream handling, request destruction, and connection options. This motivates a small native transport adapter with controlled DNS rather than browser fetch for target traffic. [Node HTTP documentation](https://nodejs.org/api/http.html). Bun documents Node compatibility but it is not identical for all APIs; verify the exact adapter behavior under the pinned Bun runtime. [Bun compatibility](https://bun.sh/docs/runtime/nodejs-compat).

OWASP recommends validating destinations and DNS results, considering redirection and DNS rebinding, and applying network controls for SSRF defense. The selected design uses an HTTP(S) policy with pinned public addresses and one exact local demo exception; it does not use a blanket localhost allowlist. [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

## 4. Architecture A

### Browser execution with an Express persistence API

**Components.** React owns request compilation and executes native browser fetch. Express provides sign-in, collection/environment CRUD, and history storage through Mongoose. MongoDB remains the sole durable application store. No extra library or service is needed.

**Complete request flow.** User edits React draft → browser fetches ordinary variable context → resolves templates → applies auth → validates browser-compatible request → browser fetch executes external HTTP → browser captures exposed response → browser normalizes result → UI renders → Express validates and persists the submitted history snapshot; saves/preferences separately persist through CRUD APIs.

**State ownership.** Tabs/current drafts and execution controllers live in React memory. Collections, environments, history, and meaningful preferences live in MongoDB with frontend copies. Theme can be mirrored locally. Drafts are not saved requests. Secret values must be entered ephemerally in the browser because server-secret values should not be returned merely to compile a request.

**Persistence.** Explicit collection/environment writes are reliable server operations, but a browser crash or closed tab between target execution and history submission loses the outcome. Server validation cannot prove the client-reported response is authentic.

**HTTP execution.** All target requests originate from the browser's network. Cross-origin restrictions, forbidden headers, opaque `no-cors` responses, and inaccessible non-exposed response headers prevent a general-purpose API client. A same-origin local demo works but does not fix arbitrary API access. Adding a relay would move the design toward B and introduce a second execution mode.

**Extensibility.** Pure auth transformations and import/export are straightforward. Scripts need sandboxing; WebSocket support would depend on browser/platform limits. Collaboration on saved data can use the existing API, but browser-produced history has weaker trust and reproducibility.

**Testing.** Pure compiler tests, CRUD/MongoDB tests, and actual browser tests against CORS-enabled and CORS-denied fixtures are essential. Backend tests alone cannot expose the major restriction.

**Tradeoffs.** Fastest simple prototype; little server transport work. Strong coupling between UI runtime and HTTP behavior; secrets move toward the browser; incomplete header/response fidelity; history can be lost. Rejected because full API-client correctness is a hard requirement, even though local demos could appear to work.

## 5. Architecture B

### One modular Express backend with synchronous HTTP execution — selected

**Components.** React draft/editor and feature API modules; Express domain modules; one native HTTP executor inside the backend; Mongoose/MongoDB for saved aggregates, preferences, and execution/history records. A bounded in-memory registry tracks active operations only. A local demo router in the same server provides real HTTP test targets backed by seeded MongoDB data.

**Complete request flow.** User edits React draft → sends immutable draft and selected environment ID to Express → authenticated admission creates a redacted running history record → backend loads authorized collection/environment snapshots → resolves variables → applies auth → validates resolved target/body/headers → performs native HTTP request → captures bounded bytes and raw headers → normalizes/redacts outcome → atomically finalizes history → returns data envelope → React renders it against the originating tab/version. Explicit Save persists the definition independently.

**State ownership.** React owns open tabs, current drafts, temporary auth input, pending states, and body-view presentation. MongoDB owns collections/environments/history and per-profile preferences. Backend owns compilation and active AbortControllers. Session tokens follow the reference auth flow; target credentials never reuse the application API token.

**Persistence.** Collections are bounded aggregate documents with embedded folders/requests, allowing atomic structural edits on standalone MongoDB. Environments and preferences are separate documents. Each accepted send has a history document with running → terminal compare-and-set updates. No queue, broker, distributed lock, or replica-set transaction requirement.

**HTTP execution.** Target HTTP executes from the Express server. The frontend calls only its own API. The server applies destination policy, an overall deadline, cancellation, and byte limits. The synchronous browser API request stays open for at most the configured bounded execution interval plus database finalization time.

**Extensibility.** Add auth cases to one pure transformer; map future imports into versioned request definitions; export from stored templates with secret filtering. Scripts would require a separately approved sandbox design. GraphQL uses the HTTP adapter; a future WebSocket adapter is possible but excluded by the current platform contract. Collaboration would require shared ownership and conflict semantics, not a rewrite of transport.

**Testing.** Pure compiler/reducer/normalizer tests, native HTTP fixture tests, authenticated Express/MongoDB integration tests, and browser workflows. Test DNS policy separately from the live network using injected resolver/connect boundaries. No externally hosted endpoint is needed for core verification.

**Tradeoffs.** Moderate execution/security work and limited request duration, but a compact lifecycle, trustworthy normalization, and straightforward debugging. Closing a browser can abort a request; a server crash may leave an interrupted history entry. The design explicitly reports uncertainty rather than promising exactly-once remote effects.

## 6. Architecture C

### MongoDB-backed asynchronous execution records with polling

**Components.** React editor and polling client; Express CRUD and execution-admission APIs; MongoDB execution records acting as pending work; an in-process scheduler inside the existing backend launches native HTTP calls with bounded concurrency. No external queue or extra process is required, but this is logically a job system.

**Complete request flow.** Edit → submit draft/context → server resolves variables and auth → validates → stores a frozen queued execution → responds 202 → scheduler claims execution → executes HTTP → captures/normalizes → stores terminal response/history → browser polls status → renders result → preferences/saved definitions persist independently. Compilation before enqueue avoids variable changes affecting delayed requests.

**State ownership.** React owns tabs/drafts/view state; MongoDB owns collections, environments, history, preferences, and durable execution status. Scheduler owns sockets and cancellation signals; cancellation intent must also be stored so queued work is cancellable.

**Persistence.** Atomic state transitions and leases are required to avoid duplicate claims. A crash after the target accepts a POST but before recording success is ambiguous. Mark interrupted attempts rather than automatically replaying unsafe operations. Secrets cannot be placed unencrypted into queued snapshots; secure durable secret handling or reference re-resolution creates additional design work.

**HTTP execution.** Same backend network and security policy as B, with status polling instead of a held browser connection. Queued execution may survive browser closure, but full application restart still intentionally reseeds the database under the assignment contract.

**Extensibility.** Most natural foundation for future batch runners, long jobs, and collaborative execution tracking. Import/export/auth extension are comparable to B. Scripts still require a sandbox; WebSockets remain out of scope.

**Testing.** All B's transport/module tests plus claim races, queue saturation, lease expiration, queued cancellation, polling backoff, crash recovery, secret lifecycle, and reconnect scenarios.

**Tradeoffs.** Highest complexity and maintenance burden. Polling adds latency and load; stale leases/statuses are new failure modes. Useful only if durable background jobs or long executions become requirements. Rejected because the selected interactive scope does not justify a scheduler and its recovery semantics.

## 7. Comparison

Qualitative judgments for this assignment, not benchmark measurements. Hard acceptance failures outweigh small implementation-speed advantages.

| Criterion | A: browser execution | B: synchronous server | C: asynchronous server |
|---|---|---|---|
| Task coverage | Incomplete arbitrary-API behavior | Full selected scope | Full selected scope |
| Product UX | CORS and header surprises | Immediate bounded send/result | Polling and queued states |
| Correctness | Browser-dependent, client-reported history | One authoritative pipeline | Correct only with lifecycle/recovery discipline |
| Simplicity | Few modules, costly limitations | Smallest complete solution | Scheduler/status machinery |
| Implementation risk | High risk of fundamental gaps | Moderate transport/security risk | High concurrency/recovery risk |
| Frontend/backend coupling | Frontend owns transport semantics | Stable draft/result contract | Stable contract plus status protocol |
| Persistence reliability | Outcome lost on browser interruption | Running record before dispatch | Durable status, ambiguous remote effects remain |
| Testability | Browser essential for transport | Pure modules + local HTTP + MongoDB | Same plus temporal race tests |
| Maintainability | Browser caveats spread into UI | Feature boundaries and one pipeline | More state transitions and operational rules |
| Extensibility | Limited general HTTP support | Good for interactive HTTP features | Best for future batch jobs |
| Performance | No relay hop; browser-limited | One relay hop; no polling | Polling overhead and scheduling delay |
| Modification by coding agents | Easy UI edits, hidden browser constraints | Explicit domain/API invariants | More coupled lifecycle assumptions |

**Decision: B.** A fails a central capability. C solves background execution requirements this version does not have. B uses the required backend and database effectively while keeping the evaluator's setup simple.

## 8. Selected Architecture

### Structure and responsibilities

Use the exact sample conventions. The following is a future implementation map, not files created in this phase:

~~~text
.
├── AGENTS.md, ASTRA_ARCHITECTURE.md, README.md, GUIDELINES.md
├── package.json, bun.lock, hackerrank.yml, setup.sh
├── .editorconfig, .prettierrc, .prettierignore, .gitignore, .gitattributes
├── .vscode/launch.json
├── frontend/
│   ├── package.json, .env.example, index.html, vite.config.js, public/
│   └── src/
│       ├── App.jsx, main.jsx, styles.css
│       ├── features/
│       │   ├── auth/                   # Login and auth.api.js
│       │   ├── profiles/               # Sample profile picker pattern
│       │   ├── workspace/              # Shell, tabs/reducer, collection cache
│       │   ├── requests/               # URL/params/header/body/auth editors
│       │   ├── collections/            # Tree and collection.api.js
│       │   ├── environments/           # Editor and environment.api.js
│       │   ├── executions/             # Send/cancel/reconcile API and viewer
│       │   └── history/                # History list/detail and history.api.js
│       └── shared/{api,components,utils}/
├── backend/
│   ├── package.json, .env.example, public/
│   └── src/
│       ├── app.js, index.js
│       ├── features/
│       │   ├── auth/
│       │   ├── profiles/               # Profile model and preferences API
│       │   ├── collections/            # Bounded collection aggregate
│       │   ├── environments/
│       │   ├── executions/             # Compiler, policy, resolver, transport,
│       │   │                          # capture, normalizer and orchestrator
│       │   ├── history/                # Execution/history model + repository
│       │   └── demo/                   # Real HTTP targets and data repository
│       ├── shared/{config,middleware,errors,utils}/
│       └── scripts/seed.js
├── skills/validate/
└── transcripts/                        # Authentic export at submission
~~~

Every backend domain has separate routes, controllers, services, repositories and models where applicable. Controllers parse strict Zod schemas and map HTTP; services own rules; repositories alone query MongoDB. Keep preferences with profiles rather than another backend feature. Tests are adjacent to domain modules and use Bun's built-in runner. No shared workspace package, generic dependency-injection framework, new state manager, new HTTP client, or new component library.

The execution service coordinates these narrow functions:

| Boundary | Input → output / ownership |
|---|---|
| Compiler | Draft + frozen authorized context → method, literal URL, ordered headers, body bytes, redaction context; no I/O |
| TargetPolicy | Parses/normalizes URL and checks scheme/port/path; calls AddressResolver; checks every returned address → ValidatedTarget |
| AddressResolver | Hostname → all OS-resolver IPv4/IPv6 results; injectable in tests; no network dispatch |
| HttpTransport | ValidatedTarget + compiled bytes + abort/deadline → HTTP stream; cannot receive or resolve a raw target URL |
| ResponseCapture | Header/encoded-body stream → bounded decoded/raw representation and measured counters |
| ResponseNormalizer | Capture + redaction context → safe result; no persistence or execution |
| Execution service | Admission, context loading, active registry, single finalization and result delivery |
| History repository | Profile-scoped admission/terminal CAS, receipts, history reads and retention |
| Workspace reducer | Tab/draft identities, dirty state and current-result association; I/O remains in effects/API functions |

### State ownership

| State | Authority and persistence |
|---|---|
| Open tabs, unsaved drafts, temporary auth | React memory, maximum 10 tabs. Switching tabs preserves drafts; reload does not. Dirty-close and beforeunload warnings. No draft browser-storage mirror in v1. |
| Saved collection/request/environment | MongoDB. Explicit Save; pessimistic acknowledgment and revision checks. |
| Canonical loaded collection | One shared React cache per profile/collection, not separate stale whole-tree copies in tabs. |
| Active environment, last saved request, theme, collection order | MongoDB profile preferences; validate owned references. localStorage mirrors theme only for first paint. |
| Active operation | Bounded backend memory registry + acknowledged Mongo running record. Registry is not saved product data. |
| Result/history | Immutable terminal record in Mongo; live UI may temporarily hold a larger response body. |
| App session | Adapt reference JWT session/profile tokens and browser storage keys; separate from target auth. Clear tokens, all drafts/cache and responses at logout/expiry. |

Each send captures tabId, draftVersion, executionId and environment revision. Late results update only their original execution/tab. Edits during a send produce “Response for an earlier version.” Environment switching affects future sends. Profile switching prompts for dirty drafts, cancels active sends, clears old state, and ignores late results.

**Ordinary disjoint-tab saves do not require stale collection overwrites.** A tab stores its base RequestDefinition and edited request, not an independent full collection tree. Serialize saves per collection within the browser. Before saving request B, compare its base request with B in the shared canonical collection; if unchanged, apply B's edit to that latest aggregate and send its current revision. Saving A updates that cache without overwriting B's dirty draft. If B changed, its folder disappeared, or a server 409 occurs, retain the draft and show Reload/Save as/Cancel. Fetch the latest aggregate and compute changed request/folder IDs locally for the conflict UI. No automatic cross-client merge, force-overwrite-tree action, scoped PATCH API or bypass of aggregate validation in v1.

### Product design

Working name: **Request Desk**; repository: coderepo-react-node-postman. Keep the sample's Roboto, dark charcoal surfaces, blue accent, rounded controls and matching light theme. Use local original identity and system monospace for code.

~~~text
┌─────────────────────────────────────────────────────────────────────────┐
│ Request Desk       Profile workspace       Local environment ▾   Theme  │
├──────────────────────┬──────────────────────────────────────────────────┤
│ Collections | History│ List orders ×     Create order • ×      +        │
│ Search saved requests├──────────────────────────────────────────────────┤
│ + New collection     │ Orders / List orders                       Save  │
│ ▾ Orders API         │ GET ▾  {{base_url}}/orders                  Send  │
│   ▾ Read             │ Params   Headers   Body   Auth   Settings        │
│     GET List orders  │ ✓  status               pending                  │
│   POST Create order  ├──────────────────────────────────────────────────┤
│ ▸ HTTP examples      │ 200 OK      38 ms      842 B decoded              │
│                      │ Body | Headers | Details     Pretty | Raw        │
│ Environments         │ ▾ { "orders": […] }                              │
└──────────────────────┴──────────────────────────────────────────────────┘
~~~

Desktop uses a 64 px header, 260 px sidebar and editor above response, with 40–44 px controls and 8/12/16/24 px spacing. Below 840 px use the sample drawer/scrim; below 600 px stack the URL controls, make row editors key/value cards and switch between request/response sections. Code scrolls inside its panel; no horizontal page overflow. Check 360/768/1440 px widths and 200% zoom.

Accessible tablist/roving focus, native dialogs, labeled icons, focus restoration and aria-live execution status are required. Ctrl/Cmd+Enter sends and Ctrl/Cmd+S saves only inside the workspace. Save/Discard/Cancel protects dirty tabs; successful acknowledgment alone clears dirty state. Theme applies to errors, menus and dialogs. Respect reduced motion.

Show inherited auth and generated header names. Show a fixed JSON interpolation example in the body editor: numeric values may replace an unquoted placeholder; strings containing quotes/newlines must be JSON-escaped by the author. Interpolation is literal, not a scripting engine.

Response UI keeps the last result visible and labeled during a new send. It distinguishes application connection failure from target HTTP errors. Settings show timeout and body limits; the running state shows elapsed/remaining budget. Details shows a bounded redacted resolution trace: variable name and supplying scope, effective auth mode, managed header names and redacted final URL—never secret values.

A 3xx result displays Location and offers **Copy resolved URL** only. Resolve a relative Location against the executed URL, and disable this action for non-HTTP(S) values. Copying neither opens a browser page nor sends credentials. A later edited Send is a fresh execution through policy. No one-click follow/replay mutation ambiguity.

JSON pretty view expands depth 1 by default, renders at most 2,000 tree nodes and parses at most 256 KiB for the interactive tree; fall back to Raw with a performance notice beyond the budget. Raw is escaped, searchable text with paging at 500 lines; a single very long line has a bounded display chunk. Preserve the captured source independent of view formatting.

XML formatting uses a bounded inert XML parse/serialization; reject DTD/entity declarations and preserve mixed-content text. HTML uses a bounded lexical source formatter that respects quoted attributes/comments/raw-text elements and does not instantiate a live document or fetch resources. Both return escaped text, preserve Raw exactly, stop at depth 64/256 KiB, and show Raw with a reason on unsupported or invalid structure. Never insert target markup into live DOM, an iframe, or an HTML preview. Formatting is derived presentation, not a rewrite of the response.

### Non-goals and deferred work

Keep the six capabilities in §1. Deferred: draft recovery, smart conflict merge/scoped request writes, redirect sending, arbitrary secret creation/vaults, scripts/sandboxing, OAuth, cookie jars, multipart/file upload, import/export, batch jobs, collaboration, WebSockets, custom TLS certificates, general HTTP/2 fidelity and production hosting architecture. Auth inheritance, deterministic replay, public-target SSRF defense, bounded decompression and cancellation correctness are acceptance requirements, not optional polish. The first local-only slice can precede the public-target gate, but must fail closed for all external targets until that gate passes.

## 9. Final Component Diagram

~~~mermaid
flowchart LR
    UI[React UI + draft reducer] --> API[Feature API / native fetch]
    API --> HTTP[Express auth + profile + validation]
    HTTP --> CRUD[Domain services / repositories]
    CRUD --> DB[(MongoDB)]
    HTTP --> EXEC[Execution service]
    EXEC --> COMP[Compiler]
    COMP --> POLICY[TargetPolicy]
    POLICY --> DNS[AddressResolver]
    DNS --> POLICY
    POLICY --> VT[ValidatedTarget]
    VT --> TRANS[HttpTransport]
    TRANS --> EXTERNAL[Permitted external HTTP]
    TRANS --> DEMO[Exact local demo HTTP router]
    DEMO --> DREPO[Demo service / repository]
    DREPO --> DB
    TRANS --> CAP[ResponseCapture / decompression]
    CAP --> NORM[ResponseNormalizer / redaction]
    NORM --> EXEC
    EXEC --> REG[Active operation registry]
    EXEC --> HIST[History repository / terminal CAS]
    HIST --> DB
    EXEC --> HTTP
    HTTP --> API
~~~

There is one Express process and one MongoDB database. A small periodic retention cleanup is maintenance, not an execution scheduler/queue. The demo always goes through actual HTTP sockets.

## 10. Core Data Models

### Definitions and limits

API Mongo IDs are ObjectId strings; embedded request/folder/row IDs and execution IDs are UUIDs. Dates are UTC ISO 8601. Schemas reject unknown writable fields. Identity/ownership comes only from verified profile context.

- KeyValueRow: { id, key, value, enabled }. Ordered, duplicate query keys allowed; blank entirely empty editor rows omitted. Enabled missing keys are invalid.
- Variable: { id, key, kind: plain | secretRef, value?, alias?, enabled }. Key pattern [A-Za-z_][A-Za-z0-9_]*, unique within its scope. No recursive values.
- RequestDefinition: { schemaVersion: 1, id, folderId: UUID | null, name, method, urlTemplate, query[], headers[], body, auth, settings: {timeoutMs} }.
- Body union: none; json {text}; text {text,contentType}; urlencoded {rows}. GET/HEAD with a body is intentionally unsupported and rejected. JSON is validated after interpolation.
- Auth union: inherit; none; bearer {tokenTemplate}; basic {usernameTemplate,passwordTemplate}; apiKey {key,valueTemplate,in: header | query}. Collection auth cannot inherit; no folder auth.

All applicable limits are conjunctive. Maximum row/request counts are upper bounds, not promises that every item can simultaneously have its maximum size. Byte limits use UTF-8 unless a different representation is named.

| Bound | Limit and error |
|---|---|
| Names / descriptions | 80 / 1,000 characters |
| Key/value rows | 100 per list; key 256 bytes; value 8 KiB |
| URL template and final encoded URL | 8 KiB each, including merged query; URL_TOO_LARGE |
| Encoded query aggregate | 4 KiB, including existing URL query and generated auth query; QUERY_TOO_LARGE |
| Request headers | 16 KiB serialized name/value aggregate; HEADER_LIMIT |
| Request body | 64 KiB, template and compiled bytes; BODY_TOO_LARGE |
| Whole saved request | 128 KiB serialized JSON; REQUEST_TOO_LARGE |
| Variables | 100/scope, 8 KiB/value, 64 KiB serialized scope; VARIABLE_LIMIT |
| Collection | 100 requests, 20 folders, 2 MiB canonical JSON **and** 4 MiB BSON; COLLECTION_LIMIT |
| Profile | 50 collections, 20 environments, 10 open tabs |
| Incoming JSON parsers | 3 MiB collection writes; 1 MiB execution; 256 KiB environment/config; 100 KiB default |
| Target response headers | 32 KiB / 200 pairs, including duplicates; HEADER_LIMIT |
| Target body capture | 1 MiB encoded and 1 MiB decoded independently; size_limit outcome |
| Persisted history body | 256 KiB after redaction; explicit historyBodyTruncated, no re-execution |
| Live JSON result envelope | 8 MiB serialized ceiling, accounting for up to 6× text escaping |
| History record | 1 MiB BSON; omit excess body with warning before insert/finalize |
| History retention | 7 days; target newest 200 visible completed body records/profile; receipts persist until expiry |
| Concurrent executions | 1/tab in UI; 3/profile and 20/process on server |
| New-send rate | 60/minute/profile token bucket, burst 10; 429 + Retry-After. Duplicate/status requests: 120/minute/profile, burst 20. Authenticated cancel of an owned active execution is exempt from these buckets so saturation cannot prevent cleanup. |

Check stored sizes before writes and compiled sizes after expansion/encoding. Parser-limit violations return 413 before processing; syntactically valid aggregate-limit violations also return 413 with {limit,actual,unit,scope}, never a raw Mongo error. These are constraints, not contradictory capacities. Test 100 individually valid requests whose aggregate exceeds 2 MiB, as well as UTF-8, JSON-escape, query-percent-encoding and variable-expansion boundaries.

Build/cast the exact candidate persistence document, including embedded IDs/metadata, and measure BSON using the existing MongoDB driver exposed through Mongoose (verify the BSON sizing export in the pinned driver). No direct new bson dependency. Apply full aggregate validation to every write path, including duplicate/reorder/delete. Versioned domain data is never written through unvalidated positional shortcuts.

### Mongo documents and indexes

| Explicit collection | Model |
|---|---|
| workspaceaccounts | Sample account: name, normalized email, hidden bcrypt passwordHash, allowedProfileIds, active |
| profiles | Fixed seed identity, name, email, avatarColor, sortOrder |
| collections | ownerProfileId, name, nameKey, description, variables[], auth, folders[{id,name}], requests[], revision, timestamps |
| environments | ownerProfileId, name, nameKey, variables[], revision, timestamps |
| profilepreferences | unique ownerProfileId, activeEnvironmentId, lastSavedRequest reference, collectionOrder[], theme, sidebarCollapsed, responseView |
| histories | ownerProfileId, executionId, fingerprint, fingerprintKeyId, instanceId, status: running or terminal, outcome?, effectCertainty, source/context snapshots, response?, error?, startedAt, finishedAt?, expiresAt?, visible |
| demoorders | dataset: local or staging, fixed id, customer, items, totalCents, status |

Derive nameKey server-side as name.trim().normalize("NFKC").toLowerCase(); preserve trimmed display name. Unique (ownerProfileId,nameKey) indexes enforce collection/environment names without query-specific collation. This is locale-independent normalization, not a promise of universal linguistic case folding. Folder names use the same normalized comparison within a collection.

Other indexes: unique preferences owner; unique (ownerProfileId,executionId); history (ownerProfileId,visible,startedAt descending,_id descending); TTL expiresAt; unique demo (dataset,id). Running records have no expiry. Terminal finalization/recovery sets expiresAt to seven days later. Filter expired history on reads because TTL removal is asynchronous.

Collection mutations replace a bounded document under {_id,ownerProfileId,revision:expectedRevision}, incrementing revision. UUID references must exist and be unique; one folder level only. Folder/request ordering is array order within siblings. Duplicate folder copies its requests with new IDs; duplicate collection regenerates every embedded ID. Delete folder moves its requests to root atomically with explicit confirmation. Delete collection removes one aggregate, not history. Cross-collection Move is deferred; Save as can copy a request. Collection order is a preference list; missing/deleted IDs are ignored and new collections appended.

Deleted preference references normalize to no selection on read. Histories retain snapshots, so source deletion cannot mutate evidence. Ownership filters are required on each repository query, not merely prechecked in the service.

### Variables, target auth and secrets

Resolution precedence: collection defaults, then enabled active environment values. Empty string is a value; disabled rows are absent. Interpolate once in URL, query values, header values, body text/form values and auth values; names remain literal. Unknown variables fail before dispatch with variable names and field paths only. Request-local/global/script variables are deferred.

Managed auth conflicts with an explicit same-name header/query field are validation errors. Header names compare case-insensitively; duplicate enabled request headers are rejected. Response duplicates retain original casing/order. Reject CR/LF and invalid header tokens. Transport owns Host, Content-Length, Connection, Transfer-Encoding, Upgrade, Proxy-*, and Accept-Encoding. Existing URL query pairs precede enabled editor rows; encode once with URLSearchParams.

Limit secret aliases to seeded/configured choices. SERVER_SECRET_ALIASES_JSON is an environment-provided JSON array of {alias, env, profileIds}; env must match an allowed DEMO_* target-secret variable, never JWT_SECRET, EXECUTION_FINGERPRINT_KEY, MONGODB_URI or arbitrary environment names. Stable seeded profile IDs make this deterministic. Example shape: [{"alias":"local_token","env":"DEMO_LOCAL_TOKEN","profileIds":["<seed-profile-id>"]}]. No secret value appears in the map. Expose only authorized alias labels and configured status.

Setup creates missing .env files, then generates a random JWT_SECRET, a separate stable 32-byte EXECUTION_FINGERPRINT_KEY, and demo credentials **before** config validation or seeding. Generate once, preserve on backend restart, never print/commit values. Fingerprint key ID is a configured label, initially v1; rotation requires explicit clearing/expiration of outstanding receipts or retaining the old key, never silently treating old IDs as new. Boot fails with names only for malformed/duplicate/unauthorized aliases or missing mapped values; it never prints the JSON map or secrets.

Ordinary variables persist as entered; label that fact. Recognized saved credential fields must contain variable references. Transient literal auth overrides live only in tab/send memory and are excluded from saved definitions and durable snapshots. No arbitrary vault/secret creation UI. Authorization of an alias is rechecked on every execution and history replay. Application JWTs/cookies/proxy credentials are never copied to a target.

Redaction is a small explicit contract: replace managed Authorization/Proxy-Authorization, Cookie/Set-Cookie, configured API-key fields, and known resolved secret values (including generated Basic credentials and URL-encoded representations) in captured text/metadata. Redact before return/persistence. Sensitive binary bodies are omitted rather than claiming inspection succeeded. Preserve a required-input marker wherever a literal transient secret was removed. Logs contain IDs, outcomes and timing only. Unknown sensitive content cannot be detected reliably: plain fields and history may contain user-provided API data, so the UI explains retention and offers delete/clear. Do not promise general DLP or leak-proof arbitrary response capture.

### Session and reset contract

Retain the reference's bearer JWT sign-in/profile-selection approach, using renamed browser storage keys and fixed issuer/audience. Credentials are bcrypt-hashed; signin routes validate input. Authenticated API calls explicitly attach their application token; target transport takes only compiled target headers. Token expiration clears both session/profile tokens and all profile state. Logout clears browser state; reference-style stateless JWT logout is not server-side revocation.

API requests do not rely on ambient auth cookies; cross-origin forms do not acquire bearer tokens. Restrict API CORS to configured application origins, disable credentialed wildcard CORS, accept JSON on mutation routes, and reject unexpected Origin when present. This reduces CSRF exposure but does not solve XSS/token theft. Escaped response content is mandatory; deploy behind HTTPS in hosted environments.

Full bun start intentionally reseeds only the dedicated request_desk_demo database. Setup validates the exact allowed database name and a local Mongo host before any destructive seed step; never drop an arbitrary database supplied by MONGODB_URI. Clear only known app collections. A different database needs an explicitly changed safe configuration outside automatic default reset. Backend-only watcher restart preserves data and runs recovery, not reseeding.

### Execution request/result and snapshots

ExecutionInput: {executionId,tabId,draftVersion,request,context:{collectionId?,collectionRevision?,replayHistoryId?,environmentId?,environmentRevision?},authOverride?}. Collection and replayHistory context are mutually exclusive. Context revisions must match; otherwise 409 CONTEXT_CHANGED before dispatch. authOverride is a concrete none/bearer/basic/apiKey union for this execution only.

History snapshot contains the authored template, effective auth template after inheritance, redacted executed URL/header preview, source IDs/revisions/names, collection-default snapshot and environment label/revision. Secret values and literal overrides are removed. Replay loads the same profile's stored defaults via replayHistoryId and applies the currently chosen environment; original environment changes/deletion are visible and require explicit choice. Missing/redacted credentials must be re-entered. Saving a replay draft offers to copy needed defaults to the destination and names conflicts; it never silently adopts today's source auth.

ExecutionResult: {executionId,tabId,draftVersion,outcome,response?,error?,effectCertainty,persistence,historyId,startedAt,finishedAt,compileTrace}. Outcome and persistence are independent:
- outcome: response | validation_error | network_error | timeout | cancelled | size_limit | decode_error | interrupted.
- effectCertainty: not_dispatched | may_have_reached_target. Once dispatch starts, cancellation cannot promise rollback.
- persistence: {state:saved | failed | unknown, warning?}. Unknown means acknowledgment/finalization could not be established before budget expiry; never label it definitely failed or resend.

Response: {status,statusText,httpVersion,executedUrl,headers:[{name,value}],body:{encoding:utf8 | base64,value,mediaType,truncated,omittedReason?},timing:{totalMs,firstByteMs},size:{receivedBodyBytes,decodedBodyBytes,capturedBodyBytes,persistedBodyBytes},warnings[]}. firstByteMs is required and nullable if no response headers arrived; measured at first response headers, not first body chunk. totalMs covers dispatch through completion/abort, excluding MongoDB and UI round trip; preparing failures use zero with a not-dispatched label.

Send Accept-Encoding: gzip, deflate, br. Capture counts encoded HTTP message-body bytes before node:zlib streaming decode; decodedBodyBytes counts decoder output before truncation. Neither is a packet-wire size. Bound both streams independently at 1 MiB and keep the same overall deadline during decompression. Destroy upstream/decoder on either limit, malformed encoding, timeout or cancel. Support identity and one gzip/deflate/br encoding; unsupported/stacked encoding yields a bounded raw representation with a notice, not silent misdecoding. Invalid supported compression is decode_error with available metadata. Do not implement decompression through unbounded synchronous buffer helpers.

Reapply output limits after redaction; omit/cap content that expands. UTF-8 text, invalid UTF-8/binary base64, HEAD/204/304 empty bodies and invalid JSON have distinct presentation. A capture truncation makes outcome size_limit; a history-only 256 KiB truncation preserves the live HTTP outcome and marks historyBodyTruncated. History list excludes bodies. Duplicate-ID reconciliation may return the smaller persisted body and says so. No “exact full wire fidelity” claim.

### API contracts

Base /api/v1. Success {data}; error {error:{code,message,details?}}. Zod errors 400, unauthorized 401, forbidden profile 403, missing/non-owned resource 404, conflict 409, too large 413, rate/concurrency 429 with Retry-After, unavailable DB 503. Upstream 4xx/5xx are outer HTTP 200 response outcomes and never expire the app session.

| Method/path | Contract / consumer |
|---|---|
| POST /auth/login; GET /auth/session; POST /auth/switch-profile; POST /auth/logout; GET /profiles | Adapt reference shapes; login/profile menu/session restoration |
| GET/POST /collections | List summaries / create {name,description?,variables?,auth?}; sidebar/new collection; create 201 |
| GET /collections/:id | Authorized full aggregate/revision; editor |
| PUT /collections/:id | {expectedRevision,collection:{name,description,variables,auth,folders,requests}}; full validation + CAS; every saved structural/request edit |
| POST /collections/:id/duplicate | {expectedRevision,name}; copy with fresh IDs; menu action |
| DELETE /collections/:id?revision=n | Revision precondition; confirmation; 204 |
| GET/POST /environments; GET/PUT/DELETE /environments/:id | Summary/create/detail/versioned update/versioned delete; environment drawer |
| GET /environments/secret-aliases | Authorized {alias,configured}; register before /:id; secret picker |
| GET/PUT /preferences | Persist supported fields and validate owned references; selectors/theme/order; GET includes public executionPolicy limits |
| POST /executions | Synchronous ExecutionInput → ExecutionResult; Send |
| GET /executions/:executionId | Running/terminal receipt + retained result; reconciliation after connection failure; no new execution |
| POST /executions/:executionId/cancel | Idempotent cancel; terminal response if already finalized |
| GET /history?cursor=&limit=&method=&outcome=&q= | {items,nextCursor}; history list/search |
| GET /history/:executionId | Visible snapshot + retained result; inspect/open |
| DELETE /history/:executionId; DELETE /history | Hide/purge visible terminal payloads, retain dedupe receipt; clear excludes active; confirmation |
| GET /health | Operational endpoint: {status,database}; 503 when DB unavailable |

PUT environments uses {expectedRevision,environment:{name,variables}}; deletes take revision. POST environments takes name/variables and returns 201. GET lists expose IDs/names/revisions; full payload only on detail. DELETE operations return 204 except active history deletion (409 EXECUTION_ACTIVE).

History q is a trimmed literal substring, max 120 characters, searching stored request name and redacted executed URL only—not bodies/headers/secrets. Escape regex metacharacters; never evaluate a caller regex or Mongo expression. Method/outcome are enums; limit defaults 50, max 100. Cursor is validated base64url {startedAt,id}; owner scope and descending tuple predicate always apply. A new search resets cursor. Read deadlines bound regex scans of the retained history window.

Every new user Send generates a fresh executionId and calls the target, even if inputs are identical. An uncertain network retry of the **same attempt** preserves executionId, the exact original input snapshot and temporary credentials in memory. First reconcile with GET /executions/:id; do not silently resubmit. An explicit “Retry delivery” may resend the same envelope/ID. Terminal duplicate ID + matching fingerprint returns retained result; active duplicate returns 409 EXECUTION_RUNNING; differing fingerprint returns 409 EXECUTION_ID_CONFLICT. Normal “Send again” always uses a new ID and warns about uncertain prior side effects.

Fingerprint is HMAC-SHA256 over deterministic serialization of execution-affecting input, including context revisions/overrides; exclude UI tab metadata. Sort object keys, preserve ordered arrays; prefix schema version. One stable EXECUTION_FINGERPRINT_KEY is distinct from JWT secret. Retained dedupe guarantee lasts seven days, not forever and not “exactly once” at the remote service.

Deleting/clearing history atomically marks visible:false and removes snapshots/body while retaining executionId, fingerprint/key ID, outcome and expiry as a minimal receipt. Reconciliation/duplicate POST against that receipt returns 410 RESULT_REMOVED and never dispatches. Retention cleanup follows the same rule. TTL expiry ends the guarantee; UI never retries an old attempt whose receipt has expired. A receipt lookup returning 404 does not prove a prior target call never happened.

## 11. End-to-End Request Flow

### Canonical state machine

Runtime state is preparing → dispatching → receiving → terminal, with terminal transitions permitted from any active state. Mongo status remains running until terminal CAS; intermediate phases are process state to avoid extra DB writes on every network event.

| State | Entry and allowed exit |
|---|---|
| Rejected (not admitted) | Invalid auth/schema/size/rate or unavailable DB; application error, no target call |
| Preparing | Registry slot + acknowledged running history; freeze context, compile, validate, resolve; to dispatching or terminal |
| Dispatching | ValidatedTarget consumed; may begin network side effect; to receiving or terminal |
| Receiving | Headers arrived; bounded capture/decode; to terminal |
| Terminal | One immutable outcome wins; timers/sockets released; separate persistence acknowledgment |

Admission reserves an in-process slot synchronously by profile/execution ID after auth and shape validation, computes fingerprint, and inserts the redacted running record before dispatch. A duplicate insert looks up the existing receipt and releases only the duplicate handler's resources. Accepted requests with semantic errors finalize validation_error history; malformed/unauthorized envelopes do not enter history. Cancellation during admission sets a registry flag; failure to insert means no dispatch and a 503. The deadline starts at slot reservation and includes DB preparation/context/DNS.

Only finalizeOnce(candidate) may choose an outcome. It synchronously claims terminal state in the registry, destroys streams/timers as needed, then updates Mongo with a running-status predicate. All other response/cancel/timeout callbacks return the chosen terminal result. DB write retry may repeat that same idempotent finalization within the finalize budget; it must never retry the target. History is terminal only when that update is acknowledged; write timeout returns persistence:unknown. No later competing callback changes the selected outcome.

**Cancellation.** Explicit endpoint is primary, overall deadline is mandatory fallback. Known active ID sets cancel intent and destroys its upstream/decoder; a completed ID returns actual terminal state. Registry miss triggers profile-scoped receipt lookup, not immediate 404. Unknown ID returns 404; the UI can retry cancel at 100/250/500 ms while initial admission is pending, then stop retrying and show unconfirmed cancellation. Browser connection abort may be best-effort assistance, never the only cleanup signal.

Treat response close before response.writableEnded (or a confirmed underlying socket failure) as a disconnect candidate, verified under Bun. Never cancel solely on incoming request close: that can mean the POST body finished normally. If runtime disconnect delivery is unreliable, explicit cancel and deadline still bound resources. Closing a product tab requests cancel; closing the browser may leave an operation active until its deadline. Show that exact uncertainty in UI copy.

**Restart recovery.** After Mongo connection and before accepting product traffic, index.js invokes historyService.recoverInterrupted(instanceId). This single-process deployment atomically marks all remaining running records interrupted, sets conservative effectCertainty:may_have_reached_target and expiry, and performs no target replay. A backend-only bun --watch restart runs this sweep. Full seeded startup clears old records first, so the sweep is empty. Startup fails if recovery cannot establish DB readiness. Cancel/status after recovery read the terminal receipt. Horizontal multi-instance deployment is not supported by this recovery rule.

If finalization/admission acknowledgment is lost without a process restart, status reads and the maintenance pass reconcile running records older than 45 seconds with no live registry entry to interrupted via CAS. An already-terminal record wins over recovery. Mongoose buffering is disabled for execution writes, database operations have bounded driver/server waits, and late insert/context results must recheck cancellation, deadline and registry ownership before dispatch. A late database write never revives an operation or initiates HTTP. Recovery means the recorded result is unknown; it does not assert that no target effect occurred.

**Retention/delete races.** Individual delete requires terminal status in its predicate; if still running, return 409. Clear takes a fixed timestamp cutoff and deletes only records terminal at that cutoff. Finalization cannot recreate a deleted payload because its update requires running status. Once/minute, a non-overlapping async maintenance pass per process trims terminal visible history beyond newest 200/profile to receipts and retries next tick on failure. Do not block Send on cleanup. Temporary count excess is allowed; seven-day TTL is the expiry backstop. Destroy cleanup timers on shutdown.

### Timeout and proxy budget

Set these values explicitly during implementation; do not depend on claimed proxy defaults:

| Budget | Value / scope |
|---|---|
| Execution timeout | User 100–30,000 ms, default 15,000; from admission through resolution/capture |
| Finalization acknowledgment | 3,000 ms after outcome selection; expiry returns unknown persistence |
| API socket inactivity | 45,000 ms |
| Vite /api proxy timeout and proxyTimeout | 45,000 ms each |
| Browser application-request deadline | 60,000 ms; expiry enters reconciliation, not a fresh Send |
| API incoming headers / request upload | 10,000 / 10,000 ms; separate inbound protection, not target-response budget |

Backend owns maxExecutionMs/finalizeBudgetMs/ioMarginMs configuration; enforce 30,000+3,000 <45,000 <60,000. Vite repeats only the public 45,000 setting to avoid importing secret backend config; a contract check verifies agreement. Setting server.requestTimeout controls receiving the incoming request, not waiting for the outgoing target result. Verify actual Bun behavior, server socket handling, Vite proxy and the HackerRank front door with a near-30-second success and a 30-second timeout.

Keep hackerrank.yml command strings, fixed ports and protected paths. Read-only configuration files are author-owned setup files before submission; adding required timeout settings there during implementation does not remove their evaluator read-only status. No alternative public listen port or dynamic demo origin.

### Six primary workflows

1. **Send:** login → choose profile → New request → method/URL/rows/body → snapshot → authenticated admission → context/compile/policy → pinned HTTP → capture/normalize/redact → terminal CAS → original tab renders; History displays the record. Send never saves the draft.
2. **Save:** draft → Save dialog → collection/folder/name → apply request edit to current shared aggregate → full validation/CAS → acknowledge → clear dirty state. Reload uses Mongo data. Conflict keeps draft and offers Reload/Save as.
3. **Environments:** edit/save Local or Staging → select → send same template → distinct demo dataset. Freeze active revision per send. Unresolved variables/stale context identify the field and stop dispatch.
4. **Auth:** collection bearer with secret alias → request Inherit → real auth endpoint accepts → None or incorrect transient override returns a target 401 in the viewer, without logging out the app. Conflicting generated/manual header is rejected.
5. **Inspect:** status/timing/encoded-vs-decoded size → raw/pretty/body/header/details → search/collapse. Invalid JSON, compressed bodies, escaped markup, empty response and truncation each show the appropriate state without discarding captured source.
6. **History:** inspect immutable context/result → Open as request into dirty tab → choose current environment and supply removed secrets → new Send/new ID, or Save as with explicit variable defaults. Reconciliation of a lost delivery uses the original ID instead; it is not “Send again.”

## 12. Key Engineering Decisions

### Frozen decisions and invariants

The following decisions are authoritative for implementation; the review-disposition table records why. Changes require a recorded reason and user-directed scope change, or an explicitly documented failed feasibility gate that needs resolution.

1. Architecture B: one synchronous backend pipeline; no queues, background request scheduler, automatic redirects or target retries.
2. Native transport consumes ValidatedTarget only; React never dispatches arbitrary target HTTP.
3. Collection aggregate CAS remains the only persisted collection write model; shared-cache saves address normal disjoint-tab edits.
4. Secrets use bounded aliases/temporary overrides; no body logging, arbitrary environment access or browser draft persistence.
5. Exactly one terminal outcome per admitted execution; persistence acknowledgment and remote-side-effect certainty are separate.
6. Frozen snapshots: Send never mutates saved requests; terminal history content never becomes today's editable source. Explicit payload purge/retention may remove content but never rewrite its outcome.
7. Target 4xx/5xx are valid HTTP results. Cancellation cannot undo remote effects.
8. Every query/write/receipt is profile-scoped; JWTs are never target credentials.
9. UI results come from real HTTP; demo routes are traced through seeded requests, not exempted by pretending they are unused.
10. Mongo is authoritative for saved data/preferences; local theme is a first-paint mirror only.
11. All size/count bounds are conjunctive, checked at the representation where they apply, with named failure limits.
12. Readiness requires executed acceptance evidence; a frozen document is not a transport proof or submission pass.

### ValidatedTarget and pinned connection recipe

ValidatedTarget is an internal immutable object created only by TargetPolicy, never accepted from JSON:
{scheme,originalHostname,authority,port,pathAndQuery,ip,family,isIpLiteral,policyVersion}.
Transport accepts this object, compiled method/headers/body, deadline and cancellation. It cannot call DNS again, follow Location, select a proxy from process environment, or replace policy IP with the URL hostname.

1. Normalize with WHATWG URL. Permit HTTP/HTTPS and explicit ports 1–65535 for **verified public targets**, with scheme defaults when omitted. Reject userinfo, fragments, control characters, malformed escapes, zone IDs, localhost names, .local names and single-label names. Host classification applies to normalized literals too; reject alternate numeric IPv4 spellings to keep displayed authority unambiguous.
2. For DNS names, use dns.promises.lookup(host,{all:true}) and deduplicate all returned IPv4/IPv6 addresses; reject an empty/failed result or any prohibited address. “All” means all records returned by this resolution, not an assertion about every answer a DNS server might return later. For IP literals, skip DNS but apply exactly the same address policy.
3. Permit ordinary globally reachable unicast only; deny private, loopback, link-local, unspecified, multicast, reserved/documentation/benchmark ranges and metadata addresses. Conservatively deny transition/translation ranges (including 6to4, Teredo, NAT64 and mapped IPv6) rather than implementing embedded-address routing exceptions. Use locally encoded policy tables with IANA provenance and tests; no network lookup of policy at request time.
4. Sole private exception: canonical http://127.0.0.1:8000 and explicit demo route patterns under /demo/v1/. Reject encoded separators/backslashes, dot segments and ambiguous normalization in local paths before matching; never grant a general loopback prefix. The actual transport uses that validated literal.
5. Default connect recipe: issue node:http/https options with hostname set to validated ip and fixed family; send original authority in Host. For HTTPS DNS targets, set servername to originalHostname and explicitly verify certificate identity against originalHostname while retaining trusted-chain validation. For HTTPS IP literals omit SNI and verify IP SAN identity. Never disable rejectUnauthorized.
6. Use per-request connections (no cross-request socket reuse). A one-request agent/createConnection adapter may own the net/tls connection if required by Bun. A custom lookup can return only the already validated IP—never re-resolve. Prefer direct-IP dialing so security does not depend on Bun honoring lookup overrides. If neither native recipe passes the proof, stop; no insecure fallback, browser execution or undeclared library.
7. Validate socket.remoteAddress against the pinned IP before writing application bytes. A mismatch destroys the connection. Preserve bracketed IPv6/non-default-port Host syntax. Bound resolver wait and prevent a late DNS result from dispatching after cancellation.

Required denied fixtures: 127.0.0.1, 0.0.0.0, 2130706433, 0177.0.0.1, 0x7f000001, ::1, ::ffff:127.0.0.1, 64:ff9b::7f00:1, 2002:7f00:1::, 169.254.169.254, fd00:ec2::254, mixed public/private answers, a rebinding hostname, public-looking wildcard-DNS names resolving privately, userinfo, fragments, zone IDs, localhost.evil.example resolving privately, and /demo/v1/../api/v1 plus encoded variants. Test allowed HTTP(S) on nonstandard public ports, DNS SNI hostname success, wrong-host certificate rejection, IP SAN success/failure and no second lookup.

SSRF checks are not deferred after enabling public requests. Local-only Core mode must reject every non-demo target until this proof is green.

### Feedback disposition

| Review | Adopted / adapted | Not adopted or corrected |
|---|---|---|
| a. GPT 5.6 | Transport first, ValidatedTarget, public ports, nameKey, explicit state machine, bounded secrets | No arbitrary percentage-reduction target; remove duplication rather than necessary controls |
| b. Sonnet | Linux-first runtime gate, query/final-URL budgets, named aggregate errors, fingerprint key, defined q | Count maxima and aggregate caps can coexist; no need to raise collection size. GUIDELINES enumerates eight README areas—there is no identifiable ninth requirement to invent. |
| c. GLM | Direct-IP/SNI recipe, boot recovery, compression with two caps, keyed attempt identity, smaller history capture, named aliases and test method | Decompression/security are not assumed to be “15 lines” or verified by documentation; mandatory runtime tests remain |
| d. Gemini | Bounded 2,000-node tree, JSON hint, explicit redirect copy UX | Reject raw req.close cancellation, variable app ports, and unchecked positional collection writes. TLS identity can be preserved when dialing IP explicitly; lookup is not the only valid recipe. |
| e. GPT 6 astra | Core/Acceptance/Hardening stages, minimal slice, invariants, state/persistence separation, session/reset contracts | Public-target SSRF, secret isolation and bounded capture cannot be postponed until after public execution is enabled |
| f. Grok | Cross-layer timeout budget, same-attempt ID reconciliation, pinned connection, shared-cache conflict UX, trace and output bound | No asserted 120-second proxy default; no req.close dependency, force-overwrite tree or draft storage in v1 |
| g. muse | Traceability, async retention, stable key, admission rate limit, setup ordering | No auto-merge or one-click redirect sending; TTFB is nullable before any headers; GET bodies remain intentionally unsupported |
| h. Deepseek | Folder duplication, safe XML/HTML formatting, trace matrix, named limits, decision status, real-demo mapping | Keep bounded 2 MiB collection and explicit lower-level limits; do not misclassify conjunctive bounds as invalid |
| i. Kimi | Lifecycle/secret/limit concerns checked against full document and strengthened | “Architecture C and final sections missing” is inconsistent with the complete 14-section local document; likely partial input, not evidence of missing design |

Deferred suggestions stay deferred unless scope is deliberately changed: sessionStorage recovery risks persisting arbitrary credentials in URLs/bodies even when auth fields are removed; redirect sending adds method/body/credential-transfer semantics; automatic merges add conflict algorithms. Copy URL, dirty warnings and clear 409 recovery cover v1 without those assumptions.

### Evidence for disputed technical points

These sources establish API behavior/design rationale, not proof of compatibility under the pinned Bun runtime:

- [Node HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html): IncomingMessage close describes request completion; requestTimeout is inbound receive time, and socket timeout is distinct.
- [Node TLS](https://nodejs.org/api/tls.html#tlsconnectoptions-callback): connection host, SNI servername and certificate identity are distinct controls; SNI is a hostname, not an IP.
- [Bun compatibility](https://bun.sh/docs/runtime/nodejs-compat): compatibility varies by API; documented zlib availability still needs exact-runtime proof.
- [Node zlib](https://nodejs.org/docs/latest-v24.x/api/zlib.html): streaming gzip/deflate/Brotli decode is available; limits and cancellation are this app's responsibility.
- [Vite proxy](https://vite.dev/config/server-options.html#server-proxy) and [proxy options](https://github.com/sagemathinc/http-proxy-3): current docs use http-proxy-3 with separate timeout/proxyTimeout controls. Do not assume defaults from a different library/version.
- [Mongo atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/): document writes are atomic and expected-value predicates protect conflicting updates.
- [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) and [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/): provenance for locally tested address classifications.

## 13. Risks / Failure Modes

### Mandatory verification matrix

Use built-in Bun unit/integration tests plus a **scripted manual browser walkthrough**: recorded steps, inputs and observed results using the available Codex browser tool, with screenshots where useful. This is not a committed Playwright suite and adds no package. A future automated browser test dependency would need separate approval.

| Proof | Evidence required |
|---|---|
| Native transport | Actual socket destination, no second DNS lookup, original Host/SNI, good/bad certificates, IP SAN and alternate-port cases |
| Cancellation | Before dispatch, during DNS/headers/body/decode, explicit cancel race, response-at-deadline; target destroyed even if disconnect callback is suppressed |
| Proxy budget | Near-30-second success and 30-second timeout through browser → Vite → Express, plus unknown-result reconciliation |
| Idempotency | Same ID/envelope twice causes one target mutation; new ID/same inputs causes another; changed input/same ID is conflict; purge yields 410 without dispatch |
| Capture/viewer | Duplicate headers, JSON/text/HTML/XML/empty/binary/invalid UTF-8, gzip/deflate/br, corrupt stream, compressed bomb and encoded/decoded limits |
| Persistence | Mongo-backed create/read/update/delete; normalized-name conflicts; revision conflicts and disjoint-tab cache saves; oversized valid-items aggregate |
| Crash/database failure | Admission DB failure causes no dispatch; post-dispatch acknowledgment loss reports unknown; backend-only restart sweeps interrupted; cancel reads recovered receipt |
| Safety/auth | No app JWT/cookie forwarded; profile boundary enforced; alias allowlist and redaction checked in API/DB/logs; hostile source never executes or fetches assets |
| UI | All six flows, 360/768/1440 px, zoom, both themes, keyboard/dialog focus, loading/empty/error/conflict/dirty states |
| Lifecycle | Safe seed DB guard, exact clean install/start, deterministic counts, full-start reset, cleanup of only audit-owned processes |

Public-network checks may need controlled reachable infrastructure; they supplement local tests and are never necessary for ordinary seeded product use. TLS fixtures use a test-only CA injected into the transport test context, not disabled validation or relaxed production policy. Address resolvers/connectors may be injected only by test construction, never user API flags.

### Seed and demo traceability

Seed one demo account, two profiles, four collections (two/profile), four environments (Local/Staging per profile), two preference records, ten orders (five/dataset), zero histories. Use fixed IDs and coherent neutral names. Credentials for demo login belong in README (alex.morgan@example.test / password123, explicitly demo-only). Demo target secrets are generated environment values, not this login password.

Each profile has Orders API and HTTP Examples. Collection variables: base_url for the active dataset, examples_url=http://127.0.0.1:8000/demo/v1, and secret-ref aliases as needed. Loopback-only demo endpoints use explicit async handlers; no sync sleeps/large hot-path crypto. They are target stand-ins exposed through seeded saved requests and must be included in the verifier mapping, not simply exempted as “test routes.”

| Capability / target family | UI → application API → service/repository → Mongo / target evidence |
|---|---|
| Builder + Orders CRUD (5 saved requests/profile) | Builder Send → POST /executions → execution pipeline → histories; target GET list/detail, POST, PATCH, DELETE /demo/v1/:dataset/orders[/id] → demo service/repository → demoorders |
| Collections/folders/requests | Tree menus/Save → collections APIs → aggregate service/repository → collections; includes duplicate folder and revision conflict |
| Environments | Drawer/selector → environments/preferences APIs → respective services → environments/profilepreferences; Local/Staging produce different dataset results |
| Target auth (4 saved requests/profile) | Auth editor/Send → executions → /demo/v1/auth/{bearer,basic,api-key-header,api-key-query}; compare config credentials; histories records real 200/401 |
| Response cases (12 saved requests/profile) | Send → executions → /demo/v1/examples/{echo,status/404,delay/1000,text,html,xml,invalid-json,empty,compressed/gzip,compressed/deflate,compressed/br}; HEAD uses echo; histories + viewer |
| History | List/detail/reopen/delete/clear → history APIs; lost-delivery UI → GET /executions/:id; history repository → histories |
| Supporting identity/preferences | Login/profile/theme/order → auth/profiles/preferences → repositories → workspaceaccounts/profiles/profilepreferences |

Total 21 requests/profile: Orders 5 + HTTP Examples 16 (auth 4 + response cases 12). Validate these counts and each route's seed reference. Echo supports builder methods with bounded input; status accepts a fixed documented set; delay accepts 0–30,000 ms; compressed endpoints serve bounded content. Order POST/PATCH bodies and IDs are validated. Seed order fields are id, customer, items[{sku,quantity,unitPriceCents}], totalCents, status; server computes totals, never trusts submitted total. Alias map/profile references and generated secret presence are validated before seed success.

### Runtime limits and remaining risks

Reference runtime remains unverified for the reasons in §2. The freeze adds no claim that the Bun transport, MongoDB flow, browser, compression, SSRF or proxy tests have run. The primary next-phase gate is a clean supported Linux environment and native transport proof. WSL Ubuntu with a native Linux Bun/cache and source checkout under its Linux filesystem is the first environment to try; reusing Windows wrappers/cache under /mnt/c would not test that remedy. Use local MongoDB 8+ in that environment, or an already available isolated container if supported; no hosted database dependency.

No design can infer whether an unacknowledged remote POST acted. Keep explicit effect uncertainty, never silently replay. In-memory rate/concurrency controls are per process, and boot recovery assumes one backend process. Unknown secret-bearing response data and arbitrary private-network access remain outside the claimed guarantees.

## 14. Implementation Order

All stages below belong to a later implementation request. The architecture is frozen now; no spike or product code is created in this phase.

| Stage | Scope and exit gate |
|---|---|
| 0 — Environment + transport proof | Resolve reference installation on supported Linux, start local MongoDB, run exact sample install/seed/start and click its UI. Before porting product domains, write an isolated disposable native-transport spike under Bun 1.3.9 proving pinned connection/SNI, abort/deadline, duplicate headers, bounded streaming decode and long-held proxy behavior. Test direct-IP recipe first; custom lookup only as a controlled pinned adapter alternative. Record exact commands/version/results. Failure blocks public-target implementation; no secret logging or insecure fallback. |
| 1 — Core local vertical slice | Adopt reference infrastructure and auth/profile flow; one collection/environment, GET+query, bearer auth, exact local demo target, history and basic Raw/JSON response. Full Save→Send→inspect→reopen path must use Express and MongoDB. External targets stay disabled until Stage 0 policy/transport proof passes. |
| 2 — Acceptance breadth | Complete all six capabilities, aggregate operations/folder duplication, methods/body/auth modes, revisions, normalized uniqueness, environments, real demo cases, explicit cancellation/reconciliation and recovery. Apply destination policy before enabling public URLs. |
| 3 — Acceptance quality | Compression/both byte caps, safe formatted markup, bounded tree/raw viewer, trace, history retention/purge semantics, responsive/keyboard/theme/error/conflict states. All matrix rows in §13 pass; no safety-critical item waits for optional hardening. |
| 4 — Clean-checkout acceptance | README documents delivered product and all eight enumerated GUIDELINES areas: identity, stack, structure, prerequisites, Mongo behavior, run instructions, command reference, seeded access. Explain limits/reset/history truncation as supplementary content, not an invented ninth requirement. Run designated skills/validate/SKILL.md with S01–S19, R01–R12 and bidirectional feature mapping. Fix FAIL; MANUAL remains unverified. |
| 5 — Private submission | Verify private coderepo-react-node-postman destination before pushing. Export genuine transcripts, retain created skills and validator in Git, exclude skills/GUIDELINES from <5 MB HackerRank archive while including README. Invite specified collaborator and complete actual submission/Discord steps. Transfer ownership only after acceptance and recipient are established. |
| Deferred hardening — outside v1 | Draft recovery, smarter merges, redirect execution, vault integration, pooled/multiprocess transports and production deployment concerns require new scope decisions. They do not relax any earlier acceptance gate. |

A green Stage 0 is a technical feasibility result, not production readiness. A green Stage 4 is the required application acceptance evidence. If a frozen invariant is infeasible on the approved stack, record the failing proof and the smallest proposed change for the user; do not reopen A/C or add dependencies merely for convenience.
