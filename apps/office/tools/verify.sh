#!/bin/sh
# Full local verification for the native office client.
#
# Runs the import check, the unit/scene suite, and the end-to-end flow check,
# then fails if any stage exits nonzero OR emits a Godot script/parse error.
# A passing exit code alone is not sufficient: the engine can print SCRIPT ERROR
# and still exit 0, so stderr is inspected explicitly.
#
#   apps/office/tools/verify.sh
set -u

GODOT_BIN="${GODOT_BIN:-/Applications/Godot.app/Contents/MacOS/Godot}"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/ycoding-office-verify"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"
STATUS=0

run_stage() {
	stage="$1"
	shift
	log="$LOG_DIR/$stage.log"
	"$@" >"$log" 2>&1
	code=$?
	errors=$(grep -cE "SCRIPT ERROR|Parse Error|Compile Error" "$log" 2>/dev/null || true)
	printf '%-14s exit=%s engine_errors=%s\n' "$stage" "$code" "$errors"
	if [ "$code" -ne 0 ]; then
		echo "  stage failed; see $log"
		tail -n 15 "$log"
		STATUS=1
	fi
	if [ "$errors" -ne 0 ]; then
		echo "  engine reported errors; see $log"
		grep -E "SCRIPT ERROR|Parse Error|Compile Error" "$log" | head -n 10
		STATUS=1
	fi
}

printf 'Godot: '
"$GODOT_BIN" --version

run_stage import "$GODOT_BIN" --headless --path "$PROJECT" --editor --quit
run_stage tests "$GODOT_BIN" --headless --path "$PROJECT" --script res://tests/run_tests.gd
run_stage flow "$GODOT_BIN" --headless --path "$PROJECT" --script res://tools/flow_check.gd

grep -hE "passed:|checks:|FLOW RESULT|RESULT:" "$LOG_DIR"/tests.log "$LOG_DIR"/flow.log 2>/dev/null | sed 's/^/  /'

if [ "$STATUS" -eq 0 ]; then
	echo "VERIFY: PASSED"
else
	echo "VERIFY: FAILED"
fi
exit "$STATUS"
