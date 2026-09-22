# Phase 30 baseline audit — Tracer UI/UX rebuild

target: http://localhost:3000/ (seeded local Tracer workspace, 2026-09-22)
goal: replace the presentation and interaction model while preserving every existing request, runner, persistence, security, and Flight Recorder contract

## Evidence captured

- Browser inspection completed on the real seeded frontend + Express + MongoDB stack.
- Current surface inspected at 1280×720 in dark and light themes, including request builder, response inspector, dialogs, collection runner, documentation, and Flight Recorder.
- Impeccable detector: `node C:\Users\arsat\.agents\skills\impeccable\scripts\detect.mjs --json frontend/src` → `[]`.
- Source inventory: 18 feature domains, 102 feature/shared files, `App.jsx` 1,519 lines, `styles.css` 3,082 lines.
- Unlumen UI inspected with computer-use: File Tree, Sidebar 001, and Motion Tabs Menu.

## Prioritized issues

| # | Area | Confirmed baseline issue / opportunity | Severity | Replacement direction | Effort |
|---|---|---|---|---|---|
| 1 | Information architecture | The current shell puts global controls, collection navigation, request tabs, request editing, and response analysis into one continuous frame. The product works, but the mental model is “many strips” instead of a navigable request workspace. | HIGH | Use a three-zone workbench: a durable project rail, a contextual resource tree, and a focused request/response canvas. Keep global actions in one command surface. | L |
| 2 | Request/response hierarchy | Request editing and response inspection are split by a 50/50 splitter with several independent tab rows. The primary send/save decision is visually competing with secondary actions. | HIGH | Make Send the single dominant action, keep Save adjacent but secondary, and use a request/response stage with a clear “compose → run → inspect” progression. | L |
| 3 | Navigation density | Collections, History, Cookies, and Examples are peer tabs even though collections are navigation and the other three are analysis/state tools. | HIGH | Separate “Build” navigation (collections, environments, docs) from “Observe” navigation (history, cookies, examples, Passport). Preserve direct keyboard access. | M |
| 4 | Modal overuse | Environments, import, code, runner, docs, Local Runtime, and Flight Recorder are modal/drawer experiences layered over the workbench. They are functional, but users lose context and focus when switching tasks. | HIGH | Reserve dialogs for confirmations and compact forms. Use a full-height inspector or route-like workspace for runner/docs/Flight Recorder, with an explicit back/close affordance and URL/deep-link state where feasible. | L |
| 5 | Collection tree affordance | The current tree relies on small chevrons, hover-only action menus, and folder/request rows with similar visual weight. | MED | Use a file-tree grammar: stable row height, one shared hover layer, animated active indicator, visible context menu trigger on focus, and clear folder/request distinction. | M |
| 6 | Dense request editor | Params, Headers, Body, Auth, Pre-request, Tests, Assertions, and Settings are all peer tabs; important state is expressed by tiny count labels. | MED | Use a compact section rail with status badges, persistent active section, and a summary strip for method/URL/auth/body state. Keep all eight sections and their semantics. | M |
| 7 | Flight Recorder discoverability | Passport, Compare, Minimize, and Capsule are correct but appear only after opening history/runner actions; the flow is not a first-class analysis destination. | MED | Make the recorder a named analysis workspace with a stable stepper and evidence timeline. Preserve immutable receipts, redaction, and unsent capsule import. | L |
| 8 | Responsive model | At narrow widths the current sidebar becomes an overlay while the header retains many controls. This is workable but not a mobile-first task model. | MED | On 375 px, collapse to one active pane with a bottom/edge switcher; on 768 px, use a two-pane inspector; retain full three-zone workbench at 1024+ px. | L |
| 9 | Empty/loading/error cohesion | Empty and loading copy is present, but states are shaped by each feature rather than one shared state grammar. | MED | Define one state vocabulary: skeleton, empty with next action, inline validation, blocking error, recoverable error, and success toast. | M |
| 10 | Interaction language | Phase 29 detector is clean, but the rebuild should establish a deliberate motion vocabulary instead of inheriting unrelated transitions across features. | LOW | Borrow only Unlumen’s principles: transform/opacity motion, spring hover layer, direction-aware tabs, measured panel height, and reduced-motion parity. | M |

## Confirmed strengths to preserve

- Real server-side execution and response truth, including status, timing, sizes, headers, body, resolution, warnings, and persistence metadata.
- Send vs Save separation, dirty drafts, request-tab ownership, async reconciliation, and keyboard shortcuts.
- Profile isolation, environment secret references, local-runtime approval, SSRF policy, cookies, examples/mocks, and history retention semantics.
- Collection Runner ordering, iteration bounds, stop/continue behavior, run variables, per-step history, cancellation, rerun, Passport, and Compare.
- Flight Recorder contracts: immutable redacted Passport; causal Compare; bounded/cancellable Minimize; capsule export/import as an unsent dirty draft.
- Existing focus restoration, visible focus rings, reduced-motion hooks, semantic roles, and the current light/dark theme toggle.

## Accessibility findings

The existing code already uses semantic buttons, labels/ARIA descriptions, tablists, dialog semantics, focus-visible styles, and reduced-motion media queries. The rebuild must retain these contracts and add:

- a skip-to-content link and landmark hierarchy for the new shell;
- a single roving-tab model for project/resource/request/response navigation;
- focus-safe full-height inspectors and drawers with `overscroll-behavior: contain`;
- `aria-live="polite"` for send/save/run/toast status and inline errors;
- keyboard alternatives for resize, tree expand/collapse, menus, drag, and mobile pane switching;
- no color-only meaning for HTTP method, outcome, policy, or recorder divergence.

## Unlumen patterns deliberately adapted

- File Tree: nested rows, stable IDs, default-open folders, file-type cues, one shared hover highlight, and restrained active emphasis.
- Sidebar 001: composable header/content/footer seams, collapsible groups, persistent resize handle, pointer-capture drag, and an effects opt-out persisted locally.
- Motion Tabs Menu: dynamic active label width, direction-aware content transitions, measured panel height, click-outside collapse, and spring press feedback.

These are interaction principles only. Do not add Unlumen, Motion, Tailwind, or other dependencies; implement equivalent behavior with the existing React/CSS stack.

## Handoff boundary for Sol

Sol owns the replacement visual world, frontend module split, component implementation, CSS/tokens, and browser verification. This report intentionally contains no frontend implementation changes. Preserve all backend files and all request/execution/persistence contracts. Treat the current Phase 29 interface as an anti-reference: retain behavior and semantics, replace visual grammar and interaction composition.

## Required verification matrix

- Real workflows: login → profile → create/edit/save/send/inspect/history; collection → runner → failure → Passport → Compare → Minimize → Capsule; capsule → import → dirty draft → reproduce.
- State: reload persistence, cancellation, validation errors, profile isolation, unsaved draft prompts, focus restoration, and no console errors.
- Responsive: 375, 768, 1024, 1440 px; zero unintended horizontal overflow.
- Themes: dark and light with equivalent contrast and states.
- Keyboard: shell navigation, tree, request sections, response sections, dialogs, menus, splitter, runner, recorder.
- Final gate: clean install, full `bun test`, backend syntax, frontend tests/build, seed/reset, real runtime, complete E2E, responsive/theme matrix, Flight Recorder demo, Locust smoke, `skills/validate/SKILL.md`, and GitHub Actions/Baseline Gate.
