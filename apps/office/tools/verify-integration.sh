#!/bin/sh
# Live integration verification for the native office client.
#
# Starts the loopback fixture server, drives the real transport against it, and
# shuts the server down. This is separate from verify.sh because it requires a
# listening server; verify.sh covers the unit and scene suites.
#
#   apps/office/tools/verify-integration.sh
set -u

GODOT_BIN="${GODOT_BIN:-/Applications/Godot.app/Contents/MacOS/Godot}"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/ycoding-office-integration"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

command -v python3 >/dev/null 2>&1 || {
	echo "verify-integration: python3 is required for the fixture server"
	exit 1
}

python3 "$PROJECT/tools/fixture_server.py" --port 0 >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
# shellcheck disable=SC2064
trap "kill $SERVER_PID 2>/dev/null" EXIT INT TERM

BASE=""
attempt=0
while [ "$attempt" -lt 50 ]; do
	BASE=$(sed -n 's/.*http:\/\/\(127\.0\.0\.1:[0-9]*\).*/\1/p' "$LOG_DIR/server.log" | head -n 1)
	[ -n "$BASE" ] && break
	attempt=$((attempt + 1))
	sleep 0.1
done

if [ -z "$BASE" ]; then
	echo "verify-integration: fixture server did not report a port"
	cat "$LOG_DIR/server.log"
	exit 1
fi

echo "fixture server: http://$BASE"
"$GODOT_BIN" --headless --path "$PROJECT" --editor --quit >"$LOG_DIR/import.log" 2>&1
"$GODOT_BIN" --headless --path "$PROJECT" --script res://tests/integration/transport_contract.gd -- "--base=http://$BASE" \
	>"$LOG_DIR/integration.log" 2>&1
CODE=$?

errors=$(grep -cE "SCRIPT ERROR|Parse Error|Compile Error" "$LOG_DIR/integration.log" 2>/dev/null || true)
printf 'integration    exit=%s engine_errors=%s\n' "$CODE" "$errors"
grep -E "INTEG:|FAIL:" "$LOG_DIR/integration.log" | sed 's/^/  /'

if [ "$CODE" -ne 0 ] || [ "$errors" -ne 0 ]; then
	echo "  failing output: $LOG_DIR/integration.log"
	grep -E "SCRIPT ERROR|Parse Error|FAIL:" "$LOG_DIR/integration.log" | head -n 10
	echo "VERIFY-INTEGRATION: FAILED"
	exit 1
fi

echo "VERIFY-INTEGRATION: PASSED"
exit 0
