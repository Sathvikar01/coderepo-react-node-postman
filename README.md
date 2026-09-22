<h1 align="center">Tracer — API Flight Recorder</h1>

<p align="center">
  A keyboard-first HTTP workspace for composing, sending, organizing, and analyzing API requests — with a built-in API flight recorder.
</p>

Tracer is a full-stack React and Express application. Requests execute through the Express API on the server and results are persisted in MongoDB, so a signed-in profile can build a real HTTP request, send it, inspect the response, save it into a collection, switch environments, and reopen it from history.

## API Flight Recorder

When a request works today and fails tomorrow, Tracer answers three questions: *what changed*, *what is the smallest cause*, and *how do I reproduce it safely*. The core flow is:

```text
record → compare → minimize → reproduce
```

Every send **records** an immutable, secret-redacted Execution Passport: compiled request evidence, variable and authentication sources, policy decision, pinned destination, timings, and a response contract. **Compare** two runs to see ordered causal evidence and the first meaningful divergence — request, environment, auth, script, cookie, DNS, policy, or response changes — plus lightweight contract checks for removed fields, type changes, unexpected statuses, and required-header changes. **Minimize** a failure with bounded probes (capped at 12, cancellable, flaky-predicate aware) that remove query rows, headers, and JSON fields until only the smallest reproducing request remains. **Reproduce** from a redacted capsule: export a `ReproCapsuleV1` bundle with placeholders instead of secrets, import it through the same normalized boundary as cURL import, open it as an unsent dirty draft, and send it manually to see the failure again. Importing never auto-Sends and never auto-Saves, and automatic mutating probes run only against approved local or mock targets.

A deterministic end-to-end demo of the whole flow runs against the seeded app:

```bash
bun run demo:flight-recorder
```

## Built With

- [React 19](https://react.dev/) and [Vite 8](https://vite.dev/) for the frontend
- [Bun](https://bun.sh/) as the workspace package manager and JavaScript runtime
- [Express 5](https://expressjs.com/) for the HTTP API
- [MongoDB](https://www.mongodb.com/) and [Mongoose](https://mongoosejs.com/) for persistence
- [Zod](https://zod.dev/) for request validation
- [JSON Web Tokens](https://jwt.io/) and [bcrypt](https://github.com/dcodeIO/bcrypt.js) for sign-in
- Native `node:net` / `node:tls` sockets for target HTTP execution, with no additional HTTP client dependency

## Project Structure

```text
.
├── backend/                     # Express API, business logic, and MongoDB persistence
│   └── src/
│       ├── app.js               # Express application and route mounting
│       ├── index.js             # Startup, restart recovery, and maintenance
│       ├── features/
│       │   ├── auth/            # Sign-in, session, and profile switching
│       │   ├── profiles/        # Profiles and per-profile preferences
│       │   ├── collections/     # Versioned collection aggregates and requests
│       │   ├── environments/    # Named environments and secret references
│       │   ├── executions/      # Compiler, target policy, transport, capture
│       │   ├── history/         # Execution receipts, history, retention
│       │   └── demo/            # Real local HTTP targets backed by MongoDB
│       ├── scripts/seed.js      # Deterministic seeded baseline
│       └── shared/              # Configuration, middleware, errors, utilities
├── frontend/
│   ├── src/features/            # Product views: requests, collections, environments, history
│   ├── src/shared/              # API client, reusable controls, formatting
│   └── public/                  # Local static assets
├── skills/validate/             # Acceptance validator
└── transcript exports live in /transcripts at submission
```

Every backend domain keeps routes, controllers, services, repositories, and models separate. Controllers validate with Zod and map HTTP; services own the rules; repositories are the only code that queries MongoDB.

## Prerequisites

- [Bun](https://bun.sh/) 1.3 or newer
- [MongoDB](https://www.mongodb.com/docs/manual/administration/install-community/) 8.0 or newer, reachable on `127.0.0.1:27017`
- Bash (Linux, macOS, or Git Bash on Windows) to run `setup.sh`

The application targets ports 3000 (frontend) and 8000 (backend). Both values live in `hackerrank.yml` and `frontend/vite.config.js`.

## MongoDB Behavior

Tracer stores everything it needs in the `request_desk_demo` database: accounts, profiles, preferences, collections, environments, demo orders, and execution history.

`setup.sh` refuses to run a destructive seed against any database other than `request_desk_demo` on a local host. It creates missing `.env` files, generates a `JWT_SECRET`, a separate `EXECUTION_FINGERPRINT_KEY`, and demo target tokens on first run, then seeds the baseline.

**Seeded baseline (restored by every full start):**

| Record             | Count                             |
| ------------------ | --------------------------------- |
| Workspace account  | 1                                 |
| Profiles           | 2                                 |
| Collections        | 4 (2 per profile)                 |
| Environments       | 4 (Local and Staging per profile) |
| Preference records | 2                                 |
| Demo orders        | 10 (5 per dataset)                |
| Execution history  | 0                                 |

A full `bun start` intentionally reseeds this baseline. Data survives browser reloads and backend-only restarts (`bun run dev` inside `backend/`), but a full start restores the seeded state.

## Seeded Access

Sign in with the demo account, then choose either profile:

| Email                      | Password      |
| -------------------------- | ------------- |
| `alex.morgan@example.test` | `password123` |

These credentials exist only for local evaluation. Tracer generates its own signing secret, fingerprint key, and demo target tokens at setup time; no secret is committed to the repository.

Each profile owns an **Orders API** collection (with `Read` and `Write` folders and five saved requests) and an **HTTP Examples** collection, plus **Local** and **Staging** environments. Both environments point at the in-process demo target at `http://127.0.0.1:8000/demo/v1`, which serves genuine HTTP responses backed by MongoDB and requires a bearer token.

## Run Instructions

Install dependencies and seed the database:

```bash
bun install && bash setup.sh --seed
```

Start the complete application:

```bash
bun start
```

Then open `http://localhost:3000`.

`bun start` runs `setup.sh --start` first (which reseeds), then starts the Express API on port 8000 with `bun --watch` and the Vite dev server on port 3000. Vite proxies `/api` to the backend.

## Using the Workspace

- **Keyboard.** `Ctrl/Cmd+Enter` sends the active request, `Ctrl/Cmd+S` saves it into its collection, arrow keys move between request, response, and sidebar tabs, and the splitter between the request and response panes resizes with arrow keys (`Enter` resets it).
- **Layout.** Drag the splitter between the request builder and the response to set your own balance; the position is remembered locally. Below 840 px the collection panel becomes an overlay that closes with `Escape`.
- **Brand.** The Tracer symbol and lockup live in `frontend/public/brand/` as original SVGs (symbol, monochrome, light, and dark lockups) with the favicon at `frontend/public/favicon.svg`.
- **Themes.** The header toggle switches dark and light. Both themes derive from the same design tokens in `frontend/src/styles.css`.
- **cURL import.** The header's **Import cURL** button parses a pasted command — URL, method, ordered headers, JSON/text/form body, `--max-time`, and `-u` credentials — previews it with warnings, and opens it as an unsaved draft. Importing never saves or sends. Credentials from `-u` stay a send-only override instead of being stored in the request, and file reads, shell substitution, proxy/TLS options, multipart bodies, and unknown flags are rejected rather than guessed.
- **Generated documentation.** Each collection's **Documentation** action renders docs straight from the saved aggregate: method and URL, query, headers, body, effective auth, variable references, and saved response examples. Variable values are never shown, literal credential text is masked, and the whole document can be copied or downloaded as Markdown. There is no separate documentation store, so docs always describe the last saved state.
- **Cookie jar.** `Set-Cookie` headers from target responses are stored per profile, and matching cookies are sent on later requests to the same host. The **Cookies** sidebar tab lists the jar with domain/path scope, flags, and expiry, and can delete a single cookie or clear the jar. A request that defines its own `Cookie` header is sent exactly as written and skips the jar for that send, with a warning. Malformed attributes fail closed instead of being guessed, and stored cookie values are redacted from history and response bodies.
- **Examples and mocks.** After a send, **Save as example** copies the status, ordered headers (duplicates kept), content type, and body into a profile-scoped example, together with the match rules you select from the request's query parameters and headers. **Mock Send** resolves the current request against those examples on the server and shows the saved response with a clear mock banner: it never dispatches network traffic, never writes history, and never replaces **Send**. Requests that match nothing report a mock miss listing the method, path, and candidate count. **Copy mock URL** copies the profile's capability route (`/api/v1/mocks/<profileId>/<token>`); calls to it match the same rules and return the saved bytes without a session, and a wrong token or another profile's route returns 404. Examples can also be created and edited by hand from the **Examples** sidebar tab.
- **Flight Recorder.** Every history entry has a **Passport** action opening the API Flight Recorder with its **Passport**, **Compare**, **Minimize**, and **Capsule** sections: the immutable execution receipt with request/response fingerprints, a causal **Compare** of any two runs with the first meaningful divergence and contract drift, bounded failure **Minimize** with start/status/cancel, and **Export Capsule** / **Import Capsule** for redacted reproduction capsules that always open as unsent, unsaved dirty drafts.

## Command Reference

| Command                 | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `bun install`           | Install every workspace package                                |
| `bash setup.sh --seed`  | Prepare environment files, generate secrets, seed the baseline |
| `bash setup.sh --start` | Same as `--seed`, used by `bun start`                          |
| `bun start`             | Seed, then run the API and the frontend together               |
| `bun run seed`          | Reseed the database without starting servers                   |
| `bun run demo:flight-recorder` | Run the deterministic Flight Recorder demo (app must be running) |
| `bun test`              | Run the backend unit tests (Bun's built-in runner)             |
| `bun run dev:backend`   | Backend only, with reload                                      |
| `bun run dev:frontend`  | Frontend only                                                  |

## Product Limits and Behavior

- **Execution budget:** 100–30,000 ms per request, 15,000 ms by default. Cancelling stops the local operation; it cannot undo effects that already reached the target.
- **Target policy:** only publicly routable HTTP and HTTPS addresses are permitted. Private, loopback, link-local, multicast, reserved, and NAT64/6to4 addresses are rejected before dispatch, except the seeded demo target on `127.0.0.1:8000/demo/v1`.
- **Body capture:** responses are captured up to 1 MiB encoded and 1 MiB decoded independently. A capture overflow reports the `size_limit` outcome; a history copy keeps at most the first 256 KiB of a body and says so.
- **History retention:** every accepted send writes an immutable snapshot and its terminal outcome. Visible bodies are trimmed beyond the newest 200 completed sends per profile, and records expire after seven days. Deleting history removes stored bodies but keeps a minimal receipt so a duplicate execution id is never dispatched again.
- **Collections:** up to 50 collections per profile, 100 requests and 20 folders per collection, 2 MiB canonical JSON per collection.
- **Environments:** plain variables are stored as written and are visible to anyone who can read the profile. Secret references store only an alias; the value is resolved on the server at send time and never returned to the browser.
- **Cookies:** up to 200 live cookies per profile, 4 KiB per cookie, and 8 KiB for a generated `Cookie` header. Cookies are matched by RFC 6265 domain, path, and Secure rules and are never sent outside their scope, to unrelated hosts, or after expiry. Session cookies (no `Max-Age`/`Expires`) live for the running backend process — a restart drops them, matching a browser session — while cookies with an explicit expiry survive restarts. Expired and stale-session cookies are purged lazily.
- **Examples:** up to 50 examples per profile with unique names, 256 KiB per stored body (live responses are truncated and marked when larger), and at most 100 query-parameter and 100 header match rules. Credential headers (`Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`, `X-API-Key`) are rejected as match rules, and mock routes carry an unguessable per-profile token instead of a session.

Tracer never sends application sign-in tokens to a target. Target requests carry only the credentials you configure through request or collection authentication, plus cookies stored in that profile's own jar from target responses.
