# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers and API engineers working locally who need to compose, organize, execute, inspect, and reproduce HTTP requests quickly without losing execution evidence.

## Product Purpose

Tracer is a keyboard-first HTTP workspace and API Flight Recorder. It helps developers move from request authoring to trustworthy execution evidence, compare a successful and failing run, minimize a failure, and export a redacted reproduction capsule.

## Positioning

Tracer treats every send as evidence: record → compare → minimize → reproduce. The execution path, security policy, response truth, and immutable history remain authoritative; UI affordances never bypass them.

## Operating Context

The product is used as a dense desktop developer tool with responsive tablet/mobile access. Core work spans collections, environments, request tabs, request/response editors, history, examples/mocks, collection runs, generated docs, and Flight Recorder analysis. The local evaluation build runs React/Vite on port 3000, Express on 8000, and MongoDB locally.

## Capabilities and Constraints

- Preserve the existing React 19, JSX, Vite, Express, MongoDB, Bun, native fetch, and CSS stack.
- Preserve all backend APIs, state/persistence contracts, Send vs Save rules, execution/security/SSRF behavior, Runner/CLI parity, portable formats, and Flight Recorder contracts.
- Add no product features and no dependencies.
- Keep every current workflow reachable and functional at 375, 768, 1024, and 1440 px in dark and light themes.
- Keep application credentials separate from target-request credentials and never expose resolved secrets.

## Brand Commitments

The product name is Tracer. The visual world may replace the existing Phase 29 composition. Graphite, Mint, and Bone can evolve, but Mint remains a precise active/success signal rather than decoration. The voice is direct American English for professional developer tooling.

## Evidence on Hand

- `README.md` documents the shipped capabilities and seeded workflows.
- `design/audit.md` captures the current UI audit and replacement priorities.
- `docs/phase30/ui-rebuild-report.md` inventories all visible workflows and the Sol handoff.
- `frontend/public/brand/` contains the existing original Tracer symbol and lockups.
- The seeded local runtime provides real request, response, runner, and Flight Recorder evidence.

## Product Principles

1. Execution truth is always more important than visual novelty.
2. The primary action and current state must be obvious at a glance.
3. Dense information should remain calm, navigable, and keyboard-first.
4. Analysis should reveal causality, not merely display records.
5. Every destructive, secret-sensitive, or network-affecting action must remain explicit.

## Accessibility & Inclusion

Preserve semantic controls, visible focus, dialog focus containment/restoration, keyboard alternatives, reduced-motion behavior, WCAG AA contrast, and non-color status cues. Responsive layouts must avoid unintended horizontal overflow and keep all primary workflows operable by keyboard.
