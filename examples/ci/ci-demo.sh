#!/usr/bin/env bash
#
# Phase 15 CI/CD parity demo.
#
# Proves, against a real local target and the real CLI, that:
#   1. `tracer validate` prepares a project without touching the network.
#   2. A passing collection exits 0.
#   3. A failing assertion exits 1.
#   4. JSON and JUnit artifacts are written and never contain secrets.
#
# The script never leaves a background server running, and it exits non-zero if
# any expectation is violated. Run it from anywhere:
#
#   bash examples/ci/ci-demo.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="$ROOT/examples/ci/tracer-project.json"
ARTIFACTS="$ROOT/artifacts/ci"
PORT="${TRACER_CI_PORT:-4571}"
BASE="http://127.0.0.1:${PORT}"

rm -rf "$ARTIFACTS"
mkdir -p "$ARTIFACTS"

export TRACER_CI_PORT="$PORT"
bun "$ROOT/examples/ci/target-server.js" >"$ARTIFACTS/target-server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
	kill "$SERVER_PID" 2>/dev/null || true
	wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "waiting for $BASE/health"
for _ in $(seq 1 100); do
	if curl -fsS "$BASE/health" >/dev/null 2>&1; then break; fi
	sleep 0.1
done
curl -fsS "$BASE/health" >/dev/null

# `bun run tracer ...` keeps cwd-independent absolute paths, so the CLI can be
# invoked exactly as a developer would from the repository root.
tracer() {
	(cd "$ROOT" && bun run tracer "$@")
}

echo
echo "== 1/3 validate (no network) =="
tracer validate "$PROJECT" --json --report "$ARTIFACTS/validate.json" >"$ARTIFACTS/validate.stdout.json"
echo "ok: validate exited 0"

echo
echo "== 2/3 passing collection (folder 'Passing') =="
set +e
tracer run "$PROJECT" \
	--environment Local \
	--folder Passing \
	--allow-local 127.0.0.1 \
	--timeout 60 \
	--json \
	--report "$ARTIFACTS/pass.json" \
	--junit "$ARTIFACTS/pass.junit.xml" >"$ARTIFACTS/pass.stdout.json"
PASS_CODE=$?
set -e
if [ "$PASS_CODE" -ne 0 ]; then
	echo "FAIL: passing collection exited $PASS_CODE (expected 0)" >&2
	exit 1
fi
echo "ok: passing collection exited 0"

echo
echo "== 3/3 failing assertion ('Missing order') =="
set +e
tracer run "$PROJECT" \
	--environment Local \
	--request "Missing order" \
	--allow-local 127.0.0.1 \
	--timeout 60 \
	--json \
	--report "$ARTIFACTS/fail.json" \
	--junit "$ARTIFACTS/fail.junit.xml" >"$ARTIFACTS/fail.stdout.json"
FAIL_CODE=$?
set -e
if [ "$FAIL_CODE" -ne 1 ]; then
	echo "FAIL: failing collection exited $FAIL_CODE (expected 1)" >&2
	exit 1
fi
echo "ok: failing collection exited 1"

for artifact in validate.json pass.json pass.junit.xml fail.json fail.junit.xml; do
	if [ ! -s "$ARTIFACTS/$artifact" ]; then
		echo "FAIL: missing report artifact $artifact" >&2
		exit 1
	fi
done
if ! grep -q "<failure" "$ARTIFACTS/fail.junit.xml"; then
	echo "FAIL: fail.junit.xml does not describe a failure" >&2
	exit 1
fi

echo
echo "CI parity demo passed. Artifacts: $ARTIFACTS"
