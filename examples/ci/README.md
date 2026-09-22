# Tracer CLI — CI demo

A minimal, database-free fixture that proves the headless runner is CI-ready.

| File                 | Purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `target-server.js`   | Deterministic `Bun.serve` target on `127.0.0.1:4571` (`TRACER_CI_PORT` to override). |
| `tracer-project.json`| Canonical `TracerProjectV1` fixture: a passing folder and one failing request. |
| `make-project.mjs`   | Regenerates the fixture through the real serializer (stable ids, no churn). |
| `ci-demo.sh`         | Starts the target, validates, runs the passing and failing collections, and asserts exit codes `0` and `1`. |

```bash
bun examples/ci/make-project.mjs   # only when the fixture changes
bash examples/ci/ci-demo.sh
```

`ci-demo.sh` writes JSON and JUnit reports to `artifacts/ci/` (git-ignored) and exits non-zero if any expectation is violated. The [Tracer CLI workflow](../../.github/workflows/tracer-cli.yml) runs the same scenario on every pull request and uploads those reports as artifacts.
