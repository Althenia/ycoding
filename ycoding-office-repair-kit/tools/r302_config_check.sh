#!/bin/sh
# Loopback network check for the office client's configuration bridge (R3-02).
#
# Runs the REAL `ConfigApi` over the REAL `HttpTransport` against a THROWAWAY stub of
# the `server.config` contract, so headers, basic auth, the JSON body, the
# `{location, data}` envelope, the stale-revision refusal, and the settled readback are
# all exercised for real. It is NOT a live-service test and NOT a release gate.
#
# The stub is kit-local (`tools/config_stub_server.py`) because
# `apps/office/tools/fixture_server.py` is owned by another area and is a release
# fixture.
#
#   sh ycoding-office-repair-kit/tools/r302_config_check.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OFFICE="$ROOT/apps/office"
GODOT="${GODOT_BIN:-/Applications/Godot.app/Contents/MacOS/Godot}"
LOCK="$ROOT/ycoding-office-repair-kit/tools/godot_lock.sh"
LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ycoding-r302-config.XXXXXX") || exit 1
STUB_PID=""
STATUS=0

cleanup() {
	if [ -n "$STUB_PID" ]; then
		kill "$STUB_PID" 2>/dev/null || true
		wait "$STUB_PID" 2>/dev/null || true
	fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM
command -v python3 >/dev/null 2>&1 || { echo 'python3 is required' >&2; exit 1; }

# The stub's own contract self-check first, so a stub that cannot serve the contract
# fails here rather than as a confusing client failure.
if ! python3 "$ROOT/ycoding-office-repair-kit/tools/config_stub_server.py" --selftest; then
	echo "R302: stub selftest FAILED" >&2
	exit 1
fi

GODOT_LOCK_OWNER=r3-02-omoikane sh "$LOCK" "$GODOT" --headless --path "$OFFICE" \
	--editor --quit >"$LOG_DIR/import.log" 2>&1
if grep -qE 'SCRIPT ERROR|Parse Error|Compile Error' "$LOG_DIR/import.log"; then
	echo "R302: import reported errors; see $LOG_DIR/import.log" >&2
	exit 1
fi

python3 "$ROOT/ycoding-office-repair-kit/tools/config_stub_server.py" \
	--port 0 --password stub-pass >"$LOG_DIR/stub.log" 2>&1 &
STUB_PID=$!

BASE=""
attempt=0
while [ "$attempt" -lt 50 ]; do
	BASE=$(sed -n 's|.*listening on http://\(127\.0\.0\.1:[0-9]*\).*|\1|p' "$LOG_DIR/stub.log" | head -n 1)
	[ -n "$BASE" ] && break
	kill -0 "$STUB_PID" 2>/dev/null || break
	attempt=$((attempt + 1))
	sleep 0.1
done
if [ -z "$BASE" ]; then
	echo "R302: stub did not start; see $LOG_DIR/stub.log" >&2
	exit 1
fi

# The suite needs the stub for its wire cases and the environment is how it finds it.
YCODING_CONFIG_STUB_URL="http://$BASE" YCODING_CONFIG_STUB_PASSWORD=stub-pass \
	GODOT_LOCK_OWNER=r3-02-omoikane sh "$LOCK" "$GODOT" --headless --path "$OFFICE" \
	--script res://tests/run_tests.gd >"$LOG_DIR/tests.log" 2>&1
code=$?
errors=$(grep -cE 'SCRIPT ERROR|Parse Error|Compile Error' "$LOG_DIR/tests.log" 2>/dev/null || true)
printf 'tests exit=%s engine_errors=%s\n' "$code" "$errors"
grep -E '^passed:|^failed:|RESULT:' "$LOG_DIR/tests.log" || true
grep -E '  FAIL:' "$LOG_DIR/tests.log" | head -20 || true
if [ "$code" -ne 0 ] || [ "$errors" -ne 0 ]; then
	STATUS=1
fi

printf 'R302 config check exit=%s; logs=%s\n' "$STATUS" "$LOG_DIR"
exit "$STATUS"