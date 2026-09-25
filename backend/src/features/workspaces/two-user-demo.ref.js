// Phase 24 — reference output of the two-browser collaboration demonstration.
//
// Re-run with the stack up:
//   1. bun src/features/workspaces/seed.js
//   2. bun start                       (terminal 1)
//   3. bun src/features/workspaces/two-user-demo.mjs   (terminal 2)
//
// The script drives TWO independent authenticated contexts (Alex and Jordan) over
// the real HTTP API. It requires a live server and a seeded database, and it
// exits non-zero on the first failed expectation. The recorded transcript lives in
// docs/collaboration-verification.md.
