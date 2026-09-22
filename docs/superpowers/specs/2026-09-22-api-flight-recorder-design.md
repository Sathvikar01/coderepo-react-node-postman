# Tracer as the API Flight Recorder

This document records the user-approved implementation specification. It is authoritative for Phase 27 and must not be broadened into generic Postman parity.

## Summary

Tracer answers: “Why did this request fail now, what is the smallest cause, and how can I reproduce it safely?” It does this through one evidence model shared by developers, QA engineers, and security-conscious teams.

Postman already offers AI agents, Native Git, offline requests, mocks, monitors, multiple protocols, and historical request inspection. Tracer therefore competes through a deeper integrated debugging and reproducibility workflow, not a larger feature count.

## Focused Feature Suite

1. **Execution Passport / `ExecutionReceiptV1`.** Every run gets an immutable, secret-redacted receipt recording the compiled request, variable and authentication sources, policy decision, pinned destination, redirects, timings, response fingerprint, and relevant revisions.
2. **Causal Run Comparison / `RunComparisonV1`.** Compare two executions semantically and identify the first meaningful divergence: request edit, environment change, authentication change, destination or DNS change, redirect, policy outcome, or response shape. Include lightweight contract checks for removed fields, type changes, unexpected statuses, and required-header changes.
3. **Reproduction Capsule / `ReproCapsuleV1`.** Export a versioned, redacted bundle containing the request template, required placeholder names, failure predicate, receipt fingerprints, and optional scrubbed response/example. Import opens an unsent dirty draft and never automatically sends or saves it.
4. **Failure Minimizer / `MinimizationJobV1`.** Automatically remove query parameters, headers, or JSON fields in bounded probes to identify the smallest request that still reproduces a failure. Automatic probes are limited to safe methods; mutating methods require an approved local or mock target.

## Architecture and Safety Boundaries

- Generate receipts through the existing `compile → policy → DNS → transport → capture → normalize → history` lifecycle. Do not create a second execution path.
- Store secret references and source metadata, never resolved secret values. Redact sensitive headers, query values, cookies, authentication, errors, and body fields before persistence or export.
- Implement comparison as deterministic pure logic over two receipts. Present evidence, never AI certainty.
- Run minimization probes through the normal execution service with cancellation, deadlines, a maximum probe budget, flaky-predicate detection, and target policy enforcement.
- Cap structured body diffs; use keyed fingerprints and metadata for large, truncated, or binary bodies.
- Import capsules through the normalized import boundary and preserve the Phase 7 invariant: preview first, dirty draft only, no auto-Send or auto-Save.
- Do not add a generic AI assistant, broader protocol support, another workflow builder, or unrelated Postman-parity features.

## Completion Contract

- Prove receipts and capsules contain no resolved secrets across headers, query strings, bodies, cookies, authentication, errors, and redirects.
- Verify semantic diffs for duplicate headers, ordered queries, environment revisions, auth references, DNS destinations, redirects, JSON paths, binary bodies, and truncation.
- Verify minimization budgets, cancellation, unstable predicates, rate limits, SSRF enforcement, and blocking of unsafe-method probes.
- Round-trip capsules while preserving request semantics and placeholder requirements; imported capsules remain unsent dirty drafts.
- Cover keyboard-accessible flows at 375, 768, 1024, and 1440 widths.
- Run the Phase 27 gate and protected Baseline Gate before completion.

