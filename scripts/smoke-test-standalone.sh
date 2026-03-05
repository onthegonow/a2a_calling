#!/usr/bin/env bash
set -euo pipefail

# A2A-97: fast smoke coverage for packaged standalone server startup + SQLite-backed routes.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARY_PATH="${1:-}"

if [[ -z "$BINARY_PATH" ]]; then
  for candidate in \
    "$PROJECT_DIR/native/macos/src-tauri/binaries/a2a-server-universal-apple-darwin" \
    "$PROJECT_DIR/native/macos/src-tauri/binaries/a2a-server-aarch64-apple-darwin" \
    "$PROJECT_DIR/native/macos/src-tauri/binaries/a2a-server-x86_64-apple-darwin"
  do
    if [[ -x "$candidate" ]]; then
      BINARY_PATH="$candidate"
      break
    fi
  done
fi

if [[ -z "$BINARY_PATH" || ! -x "$BINARY_PATH" ]]; then
  echo "Standalone binary not found or not executable: ${BINARY_PATH:-<unset>}" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d)"
CONFIG_DIR="$TMP_ROOT/config"
LOG_FILE="$TMP_ROOT/server.log"
mkdir -p "$CONFIG_DIR"

PORT="$((
  $(node -e "const net=require('net'); const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{console.log(s.address().port); s.close();});")
))"

PID=""
cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "Smoke test failed: $1" >&2
  if [[ -f "$LOG_FILE" ]]; then
    echo "---- server log tail (last 50 lines) ----" >&2
    tail -n 50 "$LOG_FILE" >&2 || true
  fi
  exit 1
}

A2A_RUNTIME=test \
NO_AUTO_UPDATE=1 \
A2A_CONFIG_DIR="$CONFIG_DIR" \
OPENCLAW_CONFIG_DIR="$CONFIG_DIR" \
"$BINARY_PATH" "$PORT" >"$LOG_FILE" 2>&1 &
PID="$!"

health_ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/a2a/status" >/dev/null 2>&1; then
    health_ok=1
    break
  fi
  sleep 1
done

if [[ "$health_ok" -ne 1 ]]; then
  fail "server did not become healthy within 60 seconds"
fi

# A2A-97: hit conversation list endpoint to exercise SQLite-backed dashboard storage path.
curl -fsS "http://127.0.0.1:${PORT}/api/a2a/dashboard/calls" >/dev/null \
  || fail "dashboard calls endpoint failed (possible SQLite/native binding issue)"

create_resp="$(
  curl -fsS -X POST "http://127.0.0.1:${PORT}/api/a2a/dashboard/invites" \
    -H 'content-type: application/json' \
    -d '{"name":"CI Smoke","tier":"public","expires":"1h"}'
)"

invite_id="$(node -e "const payload=JSON.parse(process.argv[1]); process.stdout.write(payload.token && payload.token.id ? payload.token.id : '');" "$create_resp")"
if [[ -z "$invite_id" ]]; then
  fail "invite creation returned no token id"
fi

curl -fsS -X POST "http://127.0.0.1:${PORT}/api/a2a/dashboard/invites/${invite_id}/revoke" >/dev/null \
  || fail "invite revoke failed"

if ! kill -0 "$PID" 2>/dev/null; then
  fail "server exited unexpectedly during smoke checks"
fi

kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
PID=""

echo "Standalone smoke test passed for ${BINARY_PATH}"
