#!/bin/sh
# Serialize Godot runs across concurrent repair lanes.
#
# Only ONE Godot process may touch apps/office at a time: a concurrent run on the
# same project leaves an import lock held and hangs past 300s. Lanes therefore
# acquire this lock before any Godot invocation and release it after.
#
# Usage:  godot_lock.sh <command> [args...]
#         godot_lock.sh --status
#
# The lock is a directory, because mkdir is atomic on every filesystem we build
# on. A stale lock from a killed lane is reclaimed after STALE_SECONDS only when
# no Godot process is actually running, so a real long run is never preempted.
set -eu

STALE_SECONDS=900
LOCK="/tmp/ycoding-office-godot.lock"

if [ "${1:-}" = "--status" ]; then
	if [ -d "$LOCK" ]; then
		echo "locked by: $(cat "$LOCK/owner" 2>/dev/null || echo unknown)"
	else
		echo "free"
	fi
	exit 0
fi

if [ "$#" -eq 0 ]; then
	echo "usage: godot_lock.sh <command> [args...]" >&2
	exit 2
fi

waited=0
while ! mkdir "$LOCK" 2>/dev/null; do
	if pgrep -fl Godot >/dev/null 2>&1; then
		:
	elif [ -f "$LOCK/acquired_at" ] && [ "$(( $(date +%s) - $(cat "$LOCK/acquired_at") ))" -gt "$STALE_SECONDS" ]; then
		echo "godot_lock: reclaiming stale lock (no Godot running)" >&2
		rm -rf "$LOCK"
		continue
	fi
	if [ "$waited" -ge 900 ]; then
		echo "godot_lock: timed out after ${waited}s waiting for $LOCK" >&2
		echo "godot_lock: current holder: $(cat "$LOCK/owner" 2>/dev/null || echo unknown)" >&2
		exit 3
	fi
	sleep 10
	waited=$((waited + 10))
done

date +%s >"$LOCK/acquired_at"
echo "${GODOT_LOCK_OWNER:-pid-$$}" >"$LOCK/owner"
trap 'rm -rf "$LOCK"' EXIT INT TERM

"$@"
