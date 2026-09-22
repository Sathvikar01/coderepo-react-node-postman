# Phase 30 UI/UX rebuild — current-app analysis and Sol handoff

## Scope of this handoff

This is the reporting-only phase requested by the user. No frontend implementation, backend behavior, dependencies, or contracts were changed. The current interface was inspected as a functional inventory and anti-reference; Sol owns the replacement design and build.

## Runtime evidence

- Branch: `phase30/ui-rebuild`.
- Base: latest `origin/main` at `0ee5e54` (Phase 29 and submission docs cleanup merged).
- Runtime: seeded local MongoDB, Express API on 8000, Vite frontend on 3000.
- Browser: signed-in Alex Morgan profile; request send completed with a real `200 OK` response and persisted History/Passport data.
- Impeccable detector: zero findings on `frontend/src`.
- Inventory: 18 frontend feature domains; 102 feature/shared files; `App.jsx` 1,519 lines; `styles.css` 3,082 lines.

## Complete visible feature inventory

### Entry and identity

- Workspace login with seeded demo credentials and disabled/loading submit state.
- Profile picker for Alex Morgan/Jordan Lee, sign-out, retry, and profile isolation.
- Active environment selector, environment management list, environment editor, revision, plain values, secret aliases, enabled variables, add/remove, save/delete/cancel.
- Local Runtime dialog: enable/disable, exact approved-host list, add/remove host, server-side approval semantics.
- Dark/light theme toggle and persisted theme.

### Navigation and organization

- Collections sidebar with collection/folder/request tree, expand/collapse, active request, collection context menu, request context menu, new collection, new folder, rename, duplicate, delete, move, defaults, docs, run collection/run folder.
- Open request tabs with focus, close, dirty marker, scratch request creation, and close/switch semantics.
- Sidebar sections: Collections, History, Cookies, Examples.
- Seeded collections: Orders API (Read/Write folders plus five requests) and HTTP Examples (auth, method, status, delay, text/HTML/XML, invalid/empty JSON, gzip/deflate/brotli).

### Request authoring

- Request name and URL editing; method selection; Save; Code; Send/cancel; scratch-send distinction.
- Params editor: enable/disable, key/value, reorder, remove, add.
- Headers editor: same key/value row semantics.
- Body editor: none, JSON, text, form and content-type semantics.
- Auth editor: inherit, none, bearer, basic, API key header/query, send-only override, secret-safe variable references.
- Pre-request script editor and API disclosure.
- Post-response Tests script editor and bounded result behavior.
- Structured Assertions editor with status/header/body/JSON-path-like targets and diagnostics.
- Settings: timeout bounds, draft version, environment availability.
- Keyboard send/save shortcuts and resizable request/response splitter.

### Execution and response inspection

- Real Express execution through compiler → policy → DNS → transport → capture → normalize → history.
- Response summary: status/outcome, total timing, decoded/received sizes, HTTP version, local-runtime warning.
- Response tabs: pretty/raw Body with search and JSON tree, duplicate-safe Headers, Details for timing/size/resolution/variable sources/warnings, test results when present.
- Cancellation, blocked/failed/timeout/oversized/decode/interrupted states and safe error metadata.
- Save as example, Mock Send (zero network/history), Copy mock URL.

### State and analysis

- History search, method/outcome filters, pagination, clear-history confirmation, inspect, reopen, resend, save as, delete.
- Profile-scoped cookie jar: list, scope/flags/expiry, delete one, clear all.
- Examples panel: list/edit/delete, create hand-authored example, refresh, copy mock URL; post-send Save as example with match rules.
- Generated collection docs: overview, variables, request sections, auth/query/header/body/variables, copy/download, close.
- cURL import: parse preview, warnings/errors, import as unsaved dirty draft only.
- Code snippets: cURL, JavaScript fetch, Node http, Python requests; copy and close.

### Runner and Flight Recorder

- Collection/folder runner setup: ordered selection, environment, 1–25 iterations, stop-on-failure/continue, initial run variables, cancel.
- Runner progress and summary: per-step status/outcome/time, Passport and Compare actions, rerun.
- Passport: immutable request/response/policy/target evidence, redaction, resolution metadata.
- Compare: first meaningful divergence plus request/transport/response/contract changes.
- Minimize: recorded-path or saved-example target, local mutation consent, bounded probes, cancellation, flaky detection, minimized draft.
- Capsule: response-body inclusion toggle, redacted export, JSON preview/import, open as unsent/unsaved dirty draft.

## Current interaction model diagnosis

The existing product is functionally deep but compositionally flat. The top bar, sidebar tabs, collection tree, request tabs, response tabs, splitter, example controls, history actions, documentation, runner, and recorder each work in isolation. The rebuild should make the product legible as a small number of stable work modes rather than a stack of unrelated rows.

Recommended work modes for Sol to evaluate:

1. **Build** — collections, request tabs, request editor, Send/Save.
2. **Observe** — response, history, cookies, examples, mock state.
3. **Investigate** — Passport, Compare, Minimize, Capsule.
4. **Describe** — generated documentation and code snippets.

These are navigation/composition proposals, not new product features. Every current control still needs a reachable home.

## Design guardrails

- Treat Phase 29’s current visual language as anti-reference. Do not merely change colors, radii, shadows, or spacing.
- Keep a compact developer-tool density, but establish a new grid, navigation grammar, type hierarchy, and surface hierarchy.
- Use existing React 19, JSX, native fetch, Vite, CSS, and installed assets. No new dependencies or lockfile changes.
- Use deep frontend modules with small interfaces: shell state, resource tree, request canvas, response inspector, analysis workspaces, and overlay manager.
- Do not move execution or persistence semantics into presentation modules.
- Preserve Send vs Save, unsent dirty capsule imports, normal execution authority, SSRF/local-runtime safety, runner/CLI parity, and all Flight Recorder contracts.

## Handoff to Sol

Start from this report and `design/audit.md`. Read `AGENTS.md` Phase 30 rows and the full frontend source before implementation. The implementation should begin with a written visual direction/component architecture, then use test-first interaction probes for any newly exposed behavior or real bug fix. Keep all behavior changes out of scope unless a browser audit reproduces a broken control; for each such bug record reproduce → cause → smallest fix → regression coverage.
