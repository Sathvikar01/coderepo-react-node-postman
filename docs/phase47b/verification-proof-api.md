# Phase 47B — Verification Proof API + Export/Import

Phase 47A defined what a verification proof *is*: a deterministic, content-addressed
statement about a set of rehearsed requests, with a keyed fingerprint over its own
identity. Phase 47B makes that proof **transportable and independently checkable**.
It adds a small authenticated API surface and a portable JSON artifact, and it adds
no verification semantics of its own.

## The question this phase answers

> Can a proof be generated, exported, imported later, and independently checked for
> integrity and evidence consistency — without trusting the UI that produced it?

Yes, and the answer is designed so that the *checker* never has to trust the
producer. A verifier receives the artifact, re-derives the fingerprint, re-checks the
embedded envelope, compares the recorded identity against a current observation, and
reports what it could and could not establish.

## Five operations

| Route | Purpose |
|---|---|
| `POST /api/v1/verification-proofs` | Build a proof (201) from a Phase 47A input |
| `POST /api/v1/verification-proofs/export` | Produce the portable artifact from a proof or an input |
| `POST /api/v1/verification-proofs/import` | Parse an artifact as **untrusted input**, with a report |
| `POST /api/v1/verification-proofs/verify` | Independently verify a proof or artifact |
| `POST /api/v1/verification-proofs/retrieve` | Confirm identity from an artifact the caller holds |

Every route is authenticated (`requireWorkspaceAuth`) and profile-scoped
(`resolveProfileContext`). There is no unauthenticated route and no cross-owner
read.

## Decision: generation-on-demand, no persistence

Project rule §9.2 asks for the smaller correct design. A proof is a **pure function**
of its inputs — plan, run, verification, impact, drift, contracts, evidence — and its
fingerprint is a keyed digest over that content. Persisting a proof would add mutable
server state that:

- can drift from the evidence it describes;
- needs migration whenever the proof schema changes;
- becomes a second source of truth alongside the artifact;
- creates a secret-retention surface that the artifact deliberately does not have.

So there is **no proof collection**. `retrieve` is stateless: it parses the artifact
the caller holds and confirms it is the identity that was asked for. The artifact *is*
the record. This is why `retrieve` returns `persisted: false` — not as a limitation,
but as the contract: nothing was written, and nothing needs to be deleted later.

The tradeoff is honest and documented: a caller who loses the artifact cannot recover
the proof from Tracer. The same property that makes the artifact a safe thing to
commit, diff, and mail is the property that makes it the only copy.

## The artifact

```json
{
  "kind": "tracer.verification-proof-artifact",
  "schemaVersion": 1,
  "proof": { "...": "the Phase 47A envelope, byte-for-byte" },
  "fingerprint": "<the proof fingerprint>",
  "fingerprintKeyId": "<the key id that produced it>",
  "integrity": {
    "algorithm": "HMAC-SHA-256",
    "canonicalization": "key-sorted-json-v1",
    "artifactFingerprint": "<keyed digest over the wrapper identity fields>"
  }
}
```

Properties:

- **Deterministic.** Key-sorted canonical JSON. The same proof always serializes to
  the same bytes. There is no export timestamp, no generated id, and no random
  filename, so two exports are byte-identical.
- **Self-describing.** The kind and version let a later reader recognize the format
  without out-of-band knowledge.
- **Defense in depth.** The embedded proof carries its own HMAC. The wrapper carries a
  second keyed digest over the wrapper's identity fields, so an edit to *only* the
  envelope is caught too.
- **Bounded.** A hard byte ceiling is enforced before parsing.
- **Secret-free.** No bodies, headers, cookies, tokens, or resolved credentials. Text
  that looks credential-shaped is refused on import rather than carried into a report.
- **Filename-safe.** The filename is derived from `proofId` and sanitized; it can never
  contain a path separator, and caller input never reaches it.

## Verification report

`PROOF_REPORT_STATUS`: `VALID` · `INVALID` · `STALE` · `MISMATCH` · `UNKNOWN`

Each check is reported independently as `PASS` / `FAIL` / `NOT_PROVIDED`:

`structure`, `schemaVersion`, `fingerprint`, `fixedPoint`, `consistency`,
`snapshotBinding`, `environmentBinding`, `evidenceConsistency`.

Status precedence, highest first:

1. **INVALID** — the proof fails its own integrity. Every downstream claim is
   meaningless, so nothing can soften this.
2. **STALE** — the recorded identity moved on. A proof of a snapshot that no longer
   exists cannot be a truthful statement about *now*, so identity drift explains a
   contradiction rather than being outranked by it.
3. **MISMATCH** — the proof is intact and current, but supplied evidence contradicts
   it. A real contradiction is never softened by a missing observation.
4. **UNKNOWN** — nothing contradicts the proof, but nothing confirms it either.
5. **VALID** — intact, current, and consistent.

### Staleness

`PROOF_STALENESS`: `CURRENT` · `STALE` · `UNKNOWN`

Staleness is an **identity and evidence comparison only**. There are no hidden clocks
and no wall-clock expiry. A proof does not "age"; the world it describes either still
matches or it does not.

If the current state is unavailable, the answer is `UNKNOWN` — never `CURRENT`. A
partial observation is still not a positive claim: confirming the snapshot while the
environment is unobserved yields `UNKNOWN`.

## Fail-closed boundaries

| Input | Result |
|---|---|
| Malformed JSON / non-object / wrong kind | `400 VERIFICATION_PROOF_ARTIFACT_MALFORMED` |
| Future artifact or proof schema version | `422 …_UNSUPPORTED_VERSION` (never upgraded) |
| Oversized artifact | `413 …_TOO_LARGE` with byte accounting |
| Tampered proof payload | `409` from the Phase 47A integrity check |
| Wrapper-only edit (incl. claimed fingerprint) | `409 …_ARTIFACT_TAMPERED` |
| Reserved keys (`__proto__`, `prototype`, `constructor`) at any depth | `400 …_MALFORMED`, no prototype pollution |
| Credential-shaped text | `422 …_SECRET_TEXT` |
| Evidence owned by another profile | `403 VERIFICATION_PROOF_CROSS_OWNER` |
| Identity that does not match | `404 VERIFICATION_PROOF_NOT_FOUND` |

A refusal never repairs, upgrades, coerces, or partially accepts the input.

## Import never does these things

`importProof` returns explicit, machine-readable flags so a caller can *prove* the
import was inert — rather than trusting a claim that it was:

```
persisted: false   executed: false   autoSend: false
autoSave:  false   upgraded: false
```

An imported proof does not enter the workspace, does not become a draft, is not sent,
and is not saved. It is data for inspection.

## Verification

```bash
cd backend
bun test --preload ./test/verification-proof-api.setup.js src/features/verification-proof-api
bun test src/features/verification-proof-api
```

- `verification-proof-api.test.js` — 44 service-level tests: determinism, purity,
  fail-closed parsing, report semantics, and the module surface. No HTTP, no database.
- `verification-proof.routes.test.js` — 27 route tests over a real Express app and a
  real HTTP server, covering the 20 required capabilities plus the export/import
  boundary suite.

The route harness stubs exactly two seams — bearer-token authentication and profile
lookup — in `backend/test/verification-proof-api.setup.js`. Nothing under `src/`
reads it, and `app.js` is unchanged by it.

## Scope boundaries

This phase does **not** change: Phase 47A semantics, Phase 41 verification rules,
rehearsal, the runner, transport, contract, impact, or drift modules, the frontend,
dependencies, the lockfile, or `hackerrank.yml`. It adds one feature directory, one
route mount, and one JSON body limit constant.

`jsonBodyProofArtifact` (3 MB) is deliberately larger than the artifact ceiling
(≈2.25 MB) so the artifact parser — not Express — produces the `TOO_LARGE` refusal
with byte accounting the caller can act on.
