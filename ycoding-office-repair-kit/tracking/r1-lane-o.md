# Lane O — native capture: production boot does not fabricate a synthetic office

Lane O (native-capture). Repo `/Users/viadz/Workspace/Project/ycoding`, `main` @ `a4bb99e`, dirty tree (other lanes present).
Kit task R1-01 evidence `native_runtime`. No repository source edits; driver scripts live under the kit and are deleted at the end.

## Established before capture (read-only verification)

- `apps/office/app/main.gd:94` `_ready()` calls `_boot_live()`. `_start_demo()` is reachable only from
  `start_demo_mode()` / `_on_mode_toggle()` (verified by reading the file at the live worktree state).
- `_boot_live()` reads `YCODING_SERVICE_FILE`, then `XDG_STATE_HOME`, then `HOME`
  (`ServiceRegistration.candidates`, `apps/office/integration/service_registration.gd:18-25`), first existing
  file with a non-empty `url` wins. **All three are checked**, so AC1 must redirect all three.
- `NO_SERVICE_MESSAGE` = `"No local service registration found (service.json). Start it with \`ycoding service start\`, then retry."`
- This machine HAS a real registration at `~/.local/state/ycoding/service.json` (verified by existence test only;
  contents never read). AC1 therefore must override `HOME`/`XDG_STATE_HOME` as well, or the boot would attach to
  the real user daemon. AC2 uses `YCODING_SERVICE_FILE` (highest precedence) so the real registration is never reached.
- `apps/office/tools/capture_scene.gd` is unusable for this task: it requires `DemoCapture.started(_scene, true)`,
  i.e. it forces DEMO playback. Requirement forbids requesting demo playback in both captures.
  → owned driver written under the kit and invoked by absolute path.

STATUS: in progress.

## Attempt 1 — can Godot run a SceneTree script from outside the project? (probe)

Command and result recorded below.

## Step 1 — external driver feasibility (probe)

```
cd /Users/viadz/Workspace/Project/ycoding
kit/tools/godot_lock.sh Godot --path apps/office --headless \
  --script <kit>/lane-o-probe.gd
```
Output: `PROBE external script ok; HOME=/Users/viadz`. Exit **0** (the lock wrapper's exit was not captured by
`${PIPESTATUS[0]}` because the shell was `/bin/sh`; not needed — the engine printed the probe line and quit).

Result: Godot accepts a `SceneTree` script by absolute path outside the project. Driver could therefore live in the kit.

## AC1 — no service registration present

Driver: `<kit>/lane-o-capture.gd`. Wrapper: `<kit>/lane-o-disconnected.sh` (sets all three discovery
inputs the boot reads). Command (wrapper contents):

```
cd <kit>
export HOME=/nonexistent-ycoding-lane-o
export XDG_STATE_HOME=/nonexistent-ycoding-lane-o
export YCODING_SERVICE_FILE=/nonexistent-ycoding-lane-o/service.json
kit/tools/godot_lock.sh /Applications/Godot.app/Contents/MacOS/Godot \
  --path /Users/viadz/Workspace/Project/ycoding/apps/office --resolution 1280x720 \
  --script <kit>/lane-o-capture.gd -- --label=disconnected \
  --out=<kit>/evidence/r1-01-no-registration-1280x720.png
```

Observed engine output (full, from `lane-o-disconnected.log`):

```
[disconnected] scene instantiated
[disconnected] mode=LIVE conn=disconnected actors=0 interactions=0 root=''
[disconnected] stale=false last_error='No local service registration found (service.json). Start it with `ycoding service start`, then retry.'
[disconnected] detail_label='No local service registration found (service.json). Start it with `ycoding service start`, then retry.'
[disconnected] retry_available=true demo_playing=false live_playing=false
[disconnected] model_pill='No models' disabled=true
[disconnected] window=(1280, 720)
[disconnected] wrote /Users/viadz/Workspace/Project/ycoding/ycoding-office-repair-kit/evidence/r1-01-no-registration-1280x720.png (1280x720)
```

Artifact: `<kit>/evidence/r1-01-no-registration-1280x720.png`, 1280x720 PNG.
Synthetic content: **absent** at both the projection and the transport level (`actors=0`, `interactions=0`,
`root=''`, `demo_playing=false`).
Non-fatal noise: with `HOME` pointed at a nonexistent path Godot cannot write its `user://` dir or shader cache.
The frame still rendered and saved; the user dir is a cache, not the scene.

STATUS: AC1 captured, awaiting visual confirmation of the image.

### AC1 — visual reading of the saved PNG

`evidence/r1-01-no-registration-1280x720.png` (1280x720). Visible:
- Sidebar badge reads **LIVE** (top-right of the rail); the footer reads **`disconnected · 0 active`**.
- Directly under the product pill, in the warning colour:
  `No local service registration found (service.json). Start it with ` + "`ycoding service start`" + `, then retry.`
- **`Retry connection`** is rendered as a normal (enabled) pill directly under that message.
- Sections read **`No sessions observed yet.`** and **`No agents working.`**; the composer row shows
  **`No models`** greyed/disabled and the agent selector reads **`No agent`**.
- The office floor shows only the empty map and furniture; no character actor, no desk occupancy, no speech bubble,
  no session row. Nothing claims work or history.

Synthetic content: **absent**. Supporting image facts: zero session rows, zero team rows, zero actors on the floor,
and the transport-level proof in the log (`actors=0 interactions=0 root='' demo_playing=false`).

### AC1 — exact command and result (final run, exit recorded)

Wrapper script (kit-owned, `/tmp/lane-o-ac1.sh`, equivalent to the command below):

```
cd /Users/viadz/Workspace/Project/ycoding/ycoding-office-repair-kit
export HOME=/nonexistent-ycoding-lane-o
export XDG_STATE_HOME=/nonexistent-ycoding-lane-o
export YCODING_SERVICE_FILE=/nonexistent-ycoding-lane-o/service.json
tools/godot_lock.sh /Applications/Godot.app/Contents/MacOS/Godot \
  --path /Users/viadz/Workspace/Project/ycoding/apps/office --resolution 1280x720 \
  --script <kit>/lane-o-capture.gd -- --label=disconnected \
  --out=<kit>/evidence/r1-01-no-registration-1280x720.png
```
Exit **0**. Log: `evidence/r1-01-logs/lane-o-disconnected.log`.
All three discovery inputs (`YCODING_SERVICE_FILE`, `XDG_STATE_HOME`, `HOME`) are redirected, because
`_boot_live()` checks all three and this machine has a real registration at `~/.local/state/…`; leaving `HOME`
alone would have attached the capture to the live user daemon.
Artifact sha256 `e40532a3…` (`e40532a37c6a769245f04979645e84f377b9ac4d9c9b80dd5a08946f30a5050b`),
1280x720, 160,955 bytes.

## AC2 — a reachable service (loopback fixture)

Command (bash heredoc, cwd `<kit>`; fixture started without `--password`, stopped by `trap … EXIT`):

```
python3 $REPO/apps/office/tools/fixture_server.py --port 0   # -> http://127.0.0.1:64213 pid=17901
printf '{"url":"http://127.0.0.1:64213","pid":17901}\n' > <kit>/.lane-o-tmp/service.json
HOME=/nonexistent-ycoding-lane-o XDG_STATE_HOME= YCODING_SERVICE_FILE=<kit>/.lane-o-tmp/service.json \
tools/godot_lock.sh /Applications/Godot.app/Contents/MacOS/Godot \
  --path /Users/viadz/Workspace/Project/ycoding/apps/office --resolution 1280x720 \
  --script <kit>/lane-o-capture.gd -- --label=live --frames=180 \
  --seed-session=ses_lane_o_fixture \
  --out=<kit>/evidence/r1-01-live-attached-1280x720.png
```

Observed engine output (`evidence/r1-01-logs/lane-o-live.log`):

```
[live] scene instantiated
[live] mode=LIVE conn=live actors=1 interactions=0 root='ses_lane_o_fixture'
[live] stale=false last_error=''
[live] detail_label='Idle'
[live] retry_available=false demo_playing=false live_playing=true
[live] model_pill='Default' disabled=false
[live] window=(1280, 720)
[live] wrote /Users/viadz/Workspace/Project/ycoding/ycoding-office-repair-kit/evidence/r1-01-live-attached-1280x720.png (1280x720)
```
Exit **0**. Fixture server log: `evidence/r1-01-logs/lane-o-fixture-server.log`
(`fixture server listening on http://127.0.0.1:64213`; no password used).
Artifact sha256 `7df14ad3…` (`7df14ad3453b00e9c44450804828df53fabf13e2da0bd97da45896c8543d7376`),
1280x720, 150,677 bytes.

How the actor got there, without fabricating anything: the production boot attached through `start_live()`
from the registration, so `live_playing=true`. The driver then POSTed `/api/session`
(`{"id":"ses_lane_o_fixture"}`) to the same address the client attached to — using the client's own
`base_url()`/`credentials()` — and the fixture's own `session.created` frame arrived on the feed the client
was already subscribed to. The store only ever consumed a wire frame; the driver never wrote to the store.

### AC2 — visual reading of the saved PNG

`evidence/r1-01-live-attached-1280x720.png` (1280x720). Visible:
- Sidebar badge reads **LIVE** (green); there is **no DEMO badge** and no "synthetic" note anywhere.
- Second rail line reads **`Idle`** (not "Synthetic playback — no runtime work is executed").
- Sessions section holds one row, **`○ Agent`**; Team holds **`· Agent Playing`**.
- Footer reads **`/fixture/workspace · live · 1 active`** — the fixture's own location string, not a real path.
- Agent selector shows **`agent`** (enabled); the composer pill shows **`Default`** in an enabled (bright) pill,
  not the DEMO label `… · demo list`.
- The office floor shows **one** actor standing at the CEO room desk, and no second actor, no speech bubble,
  no attention marker.

Synthetic content: **absent**. Supporting image facts: one session row and one team row, both derived from the
single fixture-backed `session.created`; one actor on the floor; `demo_playing=false` in the log; the badge says
LIVE and the footer says `live · 1 active`. The `actors=1` figure is the fixture's own session, not fixture-file
demo content — this server serves `/api/*` only and the driver played no DEMO fixture.

## Cleanup and residual state

- Fixture server for AC2 was killed by the script's `EXIT` trap; `pgrep -fl fixture_server` empty afterward,
  and loopback port 64213 released (`lsof` empty in the first run).
- `pgrep -fl Godot` empty; `kit/tools/godot_lock.sh --status` reports `free`.
- No repository file modified by this lane (`git status` for `apps/office/**`, `packages/**` unchanged by Lane O).
- The kit driver `lane-o-capture.gd` was deleted after the final run; the wrapper scripts were not kept.
- Non-fatal engine noise in both runs: with `HOME` pointed at a nonexistent path Godot cannot create its `user://`
  data dir or shader cache. This does not affect the rendered frame or the saved PNG (both captures wrote a full
  1280x720 image), but it is a real message from the engine and is reported rather than hidden.

## What remains unverified

- The captures prove the boot *state* on this machine at this revision; they do not exercise a real user daemon
  (deliberately out of scope) and do not prove provider/model behaviour.
- AC2's populated content comes from the loopback fixture, so "real" means fixture-backed per the task, not
  a real YCoding runtime with real work in it.

STATUS: COMPLETE (both captures; no repository edits; no processes left).
