<h1 align="center">Tracer</h1>

<p align="center">
  A keyboard-first HTTP workspace for composing, sending, organizing, and analyzing API requests.
</p>

Tracer is a full-stack React and Express application. Requests execute through the Express API on the server and results are persisted in MongoDB, so a signed-in profile can build a real HTTP request, send it, inspect the response, save it into a collection, switch environments, and reopen it from history.

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

## Command Reference

| Command                 | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `bun install`           | Install every workspace package                                |
| `bash setup.sh --seed`  | Prepare environment files, generate secrets, seed the baseline |
| `bash setup.sh --start` | Same as `--seed`, used by `bun start`                          |
| `bun start`             | Seed, then run the API and the frontend together               |
| `bun run seed`          | Reseed the database without starting servers                   |
| `bun test`              | Run the backend unit tests (Bun's built-in runner)             |
| `bun run dev:backend`   | Backend only, with reload                                      |
| `bun run dev:frontend`  | Frontend only                                                  |

## Product Limits and Behavior

- **Execution budget:** 100â€“30,000 ms per request, 15,000 ms by default. Cancelling stops the local operation; it cannot undo effects that already reached the target.
- **Target policy:** only publicly routable HTTP and HTTPS addresses are permitted. Private, loopback, link-local, multicast, reserved, and NAT64/6to4 addresses are rejected before dispatch, except the seeded demo target on `127.0.0.1:8000/demo/v1`.
- **Body capture:** responses are captured up to 1 MiB encoded and 1 MiB decoded independently. A capture overflow reports the `size_limit` outcome; a history copy keeps at most the first 256 KiB of a body and says so.
- **History retention:** every accepted send writes an immutable snapshot and its terminal outcome. Visible bodies are trimmed beyond the newest 200 completed sends per profile, and records expire after seven days. Deleting history removes stored bodies but keeps a minimal receipt so a duplicate execution id is never dispatched again.
- **Collections:** up to 50 collections per profile, 100 requests and 20 folders per collection, 2 MiB canonical JSON per collection.
- **Environments:** plain variables are stored as written and are visible to anyone who can read the profile. Secret references store only an alias; the value is resolved on the server at send time and never returned to the browser.

Tracer never sends application session tokens or cookies to a target. Target requests carry only the credentials you configure through request or collection authentication.
