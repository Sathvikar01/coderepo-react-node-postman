# Phase 29 — Product UI/UX Polish

Branch: `phase29/ui-ux-polish`. Base: latest approved `main`.
Frontend presentation only. No new capability, no semantic or data change, no new
dependency, no lockfile change, no backend edit.

## Method

1. Started the real product (`bun start`, ports 3000/8000, seeded MongoDB) with the
   credentials from `README.md` and inspected the live DOM.
2. Audited the running app programmatically because there was no visual review channel:
   measured computed contrast with effective-background stacking, element hit areas via
   `elementFromPoint` probing, focus-indicator presence per tab stop, and page overflow —
   at 375 / 768 / 1024 / 1440 in both themes.
3. Ran the `impeccable` detector against the changed stylesheets to catch generic-UI tells,
   and studied Unlumen component patterns (tab indicators, switch, progress, list motion)
   to adapt their behaviour using only the existing stack.
4. Fixed findings in place, then re-ran every sweep against the same live app.

Scratch scripts, logs, and the audit report live outside the repository.

## Baseline findings

| Signal | Baseline | After |
|---|---|---|
| `impeccable` anti-patterns (`frontend/src`) | 3 — `side-tab` ×2 (`docs.css:274`, `styles.css:2189`), `layout-transition` (`styles.css:2873`) | 0 |
| Contrast failures (login, light) | `button.primary-button` 4.37:1 | 0 findings |
| Controls under the 24px minimum | 5 (`request-tab-close` 20×20, bare checkbox 17×17, `pane-splitter` 7px tall, `json-toggle` 18×18, switch 40×22) | 0 |
| Focus stops without a visible indicator | 7 rules suppressed it with `outline: 0` | 0 of 43 stops (request view, 1440/375 × dark/light) |
| Dialog close returning focus to its trigger | 0 of 7 dialogs | 7 of 7 |
| Distinct mono stacks declared | 4 stacks across 15 declarations | 1 (`--font-mono`) |

## Before → after decisions

### Design system

| Before | After | Why |
|---|---|---|
| Four hardcoded mono stacks across 15 declarations in styles.css (body, JSON tree, docs, capsule editor each could differ) | One `--font-mono` token | The same kind of content rendered in different faces depending on the panel |
| Ad-hoc durations/easings (`120ms ease-out`, `220ms ease`, `160ms ease-out`) | `--dur-fast` / `--dur` / `--ease` tokens | One motion rhythm instead of five |
| `prefers-reduced-motion` honoured by 3 selectors | Global reduced-motion block | The setting must hold for every animation, including new ones |
| Dead `.mono` and `.sidebar-footer` rules | Removed | Dead code |

### Contrast (WCAG AA)

| Before | After | Why |
|---|---|---|
| Light `--brand/--blue/--accent/--success/--method-get` `#0b8a5c` | `#096d47` | The accent failed on tinted and hover surfaces (4.10–4.48:1); now 4.88–6.38:1 across every surface it lands on |
| Light `--danger` `#c6303f`, light `--quiet` `#6e7a89`, light `--muted` `#5a6672`, light `--info` `#1b6fa8` | `#b8242f`, `#606b7a`, `#57636f`, `#17618f` | Secondary text and semantic tones were below 4.5:1 on the app's own backgrounds |
| Dark `--quiet` `#6e7a89` | `#7e8a9c` | Quiet labels were unreadable on `--surface` |
| Active environment row's hint inherited the muted colour | `var(--ink)` on the active row | The one row a user is looking at had the faintest hint |
| Destructive confirm used `--danger-ink` on the danger fill | `var(--danger-container)` (dark), `#fff` unchanged (light) | 6.6:1 instead of a low-contrast pairing |

### Keyboard and pointer access

| Before | After | Why |
|---|---|---|
| Six `:focus { outline: 0 }` rules out-specified `:focus-visible` | Removed; the search field keeps `outline: 0` but its container draws a `:focus-within` ring | Typing fields had no keyboard focus indicator at all |
| `Modal` read `document.activeElement` inside an effect that runs twice under `StrictMode` | Opener captured once per dialog via a ref | Closing any dialog dropped focus to `<body>`; every dialog now restores its trigger |
| `request-tab-close` 20×20, `pane-splitter` 7px tall, `json-toggle` 18×18, switch 40×22, bare 17×17 checkbox | 24px minimum through real sizing or transparent `::after` overhang | Pointer targets must clear the 24px minimum without changing the visual weight |
| Eight dialog buttons carried no class, so they fell back to native grey chrome (3.49:1, no shared states) | One zero-specificity base rule scoped to their containers | Consistency without out-specifying component rules |
| Environments header button lost its only text below 600px and had no accessible name | `aria-label` + `title` | An icon-only control must still have a name |

### Removing generic-UI tells

| Before | After | Why |
|---|---|---|
| Toast and docs notice used thick single-side accent borders | Full border plus a tone-coloured icon; the notice became a neutral inset panel with a `[role="status"]` success variant | The most recognisable generated-UI tell; tone is now carried by icon and border together |
| Run progress animated `width` | Animated `transform: scaleX()` | Layout-property animation caused reflow on every tick |

### Motion language

| Before | After | Why |
|---|---|---|
| Tabs switched only colour/border on selection | Center-out `::after` underline that scales, plus hover states | Selection reads as one continuous movement across the tab strips |
| Pane splitter was a static 46px grip | Grip widens on hover, with the larger hit area kept invisible | Affordance without visual noise |
| Buttons, view switch, and tab close had no hover/transition treatment | Shared duration/easing transitions | Controls answer the pointer consistently |

## Deliberately not changed

- Sidebar drag-to-resize, theme cross-fade, and a non-text border-contrast token bump —
  outside the phase's scope or unverifiable without a visual channel.
- No JSX restructuring, no renamed workflows, no new icons, no new dependencies, no
  backend, network, persistence, or test-contract changes.

## Verification (same code, live app, seeded database)

- `bun install --frozen-lockfile` — no changes; `bun.lock` and every manifest untouched.
- `bun test` — 813 tests, 1 skip, 0 fail. `cd frontend && bun test` — 275 pass, 0 fail.
- Backend syntax check across `backend/src/**/*.js` — clean.
- `cd frontend && bun run build` — production build succeeds.
- `bash setup.sh --seed` — deterministic reset (1 account, 2 profiles, 4 collections,
  4 environments, 10 demo orders).
- Runtime smoke with the declared `bun start` — `:8000/api/v1/health` reports connected
  and `:3000` serves the app.
- 27 shipped surfaces × dark + light at 1440, plus 7 surfaces × 375 / 768 / 1024 × dark +
  light: 0 contrast, 0 hit-area, 0 focus-indicator, and 0 overflow findings.
- Keyboard sweep: 43 focus stops in the request view with a visible indicator in every
  viewport/theme; Escape closes and focus returns to the trigger in all four combinations;
  reduced-motion collapses transition durations; arrow keys move through all four tab strips.
- Full Flight Recorder demo — 47/47 checks, including the record → compare → minimize →
  reproduce flow, passport immutability, SSRF boundary, mutating-probe restrictions, and
  secret scanning.
