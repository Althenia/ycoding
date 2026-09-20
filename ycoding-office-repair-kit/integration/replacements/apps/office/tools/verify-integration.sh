#!/bin/sh
# Loopback transport integration, NOT a real external-provider smoke test.
set -u
GODOT_BIN="${GODOT_BIN:-/Applications/Godot.app/Contents/MacOS/Godot}"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ycoding-office-integration.XXXXXX") || exit 1
STATUS=0
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM
command -v python3 >/dev/null 2>&1 || { echo 'python3 is required' >&2; exit 1; }
run_stage() {
  stage=$1; shift
  "$@" >"$LOG_DIR/$stage.log" 2>&1
  code=$?
  if [ "$code" -ne 0 ] || grep -qE 'SCRIPT ERROR|Parse Error|Compile Error|FAIL:' "$LOG_DIR/$stage.log"; then
    STATUS=1
    printf '%s: FAILED (exit %s); log: %s
' "$stage" "$code" "$LOG_DIR/$stage.log"
    tail -n 15 "$LOG_DIR/$stage.log"
  else
    printf '%s: passed; log: %s
' "$stage" "$LOG_DIR/$stage.log"
  fi
}
run_stage import "$GODOT_BIN" --headless --path "$PROJECT" --editor --import
[ "$STATUS" -eq 0 ] || exit 1
python3 "$PROJECT/tools/fixture_server.py" --port 0 >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
BASE=""
attempt=0
while [ "$attempt" -lt 50 ]; do
  BASE=$(sed -n 's/.*http:\/\/\(127\.0\.0\.1:[0-9]*\).*/\1/p' "$LOG_DIR/server.log" | head -n 1)
  [ -n "$BASE" ] && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  attempt=$((attempt + 1)); sleep 0.1
done
[ -n "$BASE" ] || { echo "Fixture server startup failed; see $LOG_DIR/server.log" >&2; exit 1; }
run_stage transport "$GODOT_BIN" --headless --path "$PROJECT" --script res://tests/integration/transport_contract.gd -- "--base=http://$BASE"
run_stage attach "$GODOT_BIN" --headless --path "$PROJECT" --script res://tests/integration/live_attach.gd -- "--base=http://$BASE"
printf 'Loopback integration exit=%s; logs=%s
' "$STATUS" "$LOG_DIR"
exit "$STATUS"
