# Tracer — Instrument Workbench

## Direction

Tracer is an API flight recorder, so its interface behaves like an instrument workbench: a narrow command rail, a resizable resource index, a focused request canvas, and an evidence deck for responses and Flight Recorder analysis. The Phase 29 composition is an anti-reference; this system keeps the product truth and replaces the visual grammar.

## Visual system

- **Ground:** near-black graphite in dark mode and mineral bone in light mode.
- **Ink:** warm bone on graphite; graphite on bone.
- **Signal:** mint marks the one current selection, primary action, or successful outcome. It is never ambient decoration.
- **Caution:** burnt amber marks Local Runtime and warnings. Red is reserved for errors/destructive actions.
- **Type:** Roboto for UI text; the existing monospace stack only for methods, URLs, code, data, and measurements.
- **Shape:** 8–12 px radii on work surfaces, 6–8 px on nested controls, pills only for compact status/method chips.
- **Depth:** surface contrast and one soft directional shadow; no bordered shadow cards.

## Topology

1. **Command rail** — brand, workspace toggle, import, environments, Local Runtime, theme, profile.
2. **Resource index** — Build/Observe destinations plus the active collection tree or analysis list.
3. **Canvas** — request tabs, request composer, response evidence deck.
4. **Focused workspaces** — Runner, Docs, and Flight Recorder use large anchored inspectors rather than visually generic centered cards.

## Interaction language

- Unlumen File Tree discipline: stable rows, single moving hover layer, strong active marker, nested indentation, context action visible on hover and focus.
- Unlumen Sidebar 001 discipline: distinct fixed header/body/footer regions, collapsible groups, resizable desktop index, overlay index below 900 px.
- Unlumen Motion Tabs discipline: active tab marker moves between destinations; panel changes use short direction-aware transform/opacity transitions; labels never wait on animation.
- Motion is 120–220 ms, interruptible, and removed or reduced under `prefers-reduced-motion`.

## Responsive model

- **≥1180 px:** rail + resource index + request/response canvas.
- **768–1179 px:** rail + overlay resource index + canvas.
- **<768 px:** compact top command bar, full-width single-pane canvas, resource index drawer, stacked request/response panes.

## Accessibility contract

Visible focus, semantic controls, roving tabs, escape-to-close, focus restoration, reduced motion, non-color status cues, 44 px touch targets at narrow widths, and zero unintended horizontal overflow.
