# M5 — release readiness evidence

Tasks: TASK-041–048 · Date: 2026-09-16

## Native rendering and resource limits (TASK-042)

Measured on the target machine (macOS arm64, Godot 4.7.2, 1600x900), by running the
real application and sampling `Performance` once per second:

```
$ /Applications/Godot.app/Contents/MacOS/Godot --path apps/office --resolution 1600x900 \
    --script res://tools/measure_runtime.gd -- "--samples=90"
frames=5400
frame_ms p50=2.0 p95=2.0 max=2.0
draw_calls first=105.0 last=105.0
objects first=2059.0 last=2059.0
static_mem first_kb=236887 last_kb=236893
```

A 90-second sustained run at a steady 2 ms per frame (about 500 fps headroom, far
inside the 16.7 ms budget for 60 fps) with **flat** draw calls, object count and
resident memory: 105 draw calls and 2059 objects at both the first and last
sample, and static memory grew 6 KB across 90 seconds (0.0025%). No growth trend,
so no leak and no unbounded queue is accumulating over a sustained session.

### Bounds that keep it flat

| Bound | Value | Where |
|---|---|---|
| Per-frame poll budget | 2 ms | `apps/office/integration/live_transport.gd:28` |
| Socket poll budget | 4 ms | `apps/office/integration/http_transport.gd:79` |
| Bounded conversation items | 512 | `apps/office/core/office_store.gd:19` |
| Message excerpt ceiling | 240 chars | `apps/office/core/office_store.gd:25` |
| Bounded play spots | floor limit | `apps/office/core/office_store.gd:182` |

The conversation bound is proven under a burst that exceeds it by 25 items:
`apps/office/tests/suites/test_office_store.gd:148` fills `MAX_CONVERSATION_ITEMS + 25`
and asserts the stored count stays within the bound.

## Reconnect, restart and long-session recovery (TASK-041)

The feed is volatile by contract, so a reconnect is not a resume. Rather than
patch holes, the projection is rebuilt from the service: the sessions are
re-listed and each one's durable log is replayed in order.

`LiveTransport.reload()` emits `reload_ready` **only** when every requested log has
answered, and `reload_failed` otherwise, so a partial read can never be presented
as a whole projection. `adopt_reload` previously received an empty array while
clearing the stale flag, which claimed completeness it did not have; that path is
gone.

Verified live against the loopback fixture: a reload returns 3 real frames
(2 `session.created`, 1 `session.input.admitted`) rebuilt from the durable logs.

Evidence: `apps/office/tests/integration/live_attach.gd` asserts the reload
settles, reports no failure, returns a non-empty batch carrying `session.created`,
and does not replay the `log.synced` watermark as an event. The gate reports
`LIVE-ATTACH: pass=26 fail=0`.

## Service lifecycle (TASK-045)

**Attach to an existing daemon and exit without stopping it — verified on this
machine.** The office attached to the running `ycoding serve --service` daemon,
reported `syncing` then `live`, and the daemon was still running and healthy
afterwards (uptime 23h, `GET /api/health` → `{"healthy":true,...}`).

Attaching is read-only: nothing in `apps/office` starts, stops or signals a
daemon. `grep -rn "OS.create_process\|OS.execute\|kill" apps/office` finds no
process control at all, so there are no arbitrary shell strings and the office
cannot take ownership of a service it was not given.

Discovery was corrected during this work. It previously searched the **config**
directory, but the client writes the registration under the **state** directory
(`packages/client/src/effect/service.ts` `fallback`), so attaching could never
have found a running service. The search now mirrors the client: the explicit
`YCODING_SERVICE_FILE` override, then `XDG_STATE_HOME`, then `~/.local/state`.
Pinned by `apps/office/tests/suites/test_service_registration.gd`.

## Asset rights, secrets and dangerous UI actions (TASK-046)

`office/art/ASSETS.md` documents all 48 shipped PNGs — dimensions, generating
function and provenance. Independently re-verified here:

- No network access in the generator: its only imports are `argparse`, `random`,
  `struct`, `zlib`, `pathlib`. No `urllib`, `requests`, `socket`, `subprocess`.
- No credentials in the shipped runtime: no `password=`, `api_key`, `secret=` or
  private-key material outside the transport's explicit parameter.
- No shell-out: zero `OS.execute`, `OS.create_process` or `OS.shell_open` hits.
- No text-to-behaviour APIs: zero `str_to_var`, `Expression.` or `meta_clicked`
  hits outside tests, so transcript text cannot execute anything.
- Approval boundaries are unchanged: a reply is only ever sent from an explicit
  user action through `AttentionQueue`.


## Final affected suites (TASK-047)

Run on 2026-09-16 against the committed tree:

| Check | Command | Result |
|---|---|---|
| Unit | `apps/office/tools/verify.sh` | 5997 assertions, 0 failures, 0 engine errors |
| Flow | `apps/office/tools/verify.sh` | 18 checks, 0 failures |
| Gateway contract | `apps/office/tools/verify-integration.sh` | 21 checks, 0 failures |
| Live attach | `apps/office/tools/verify-integration.sh` | 26 checks, 0 failures |
| Fixture selftest | `python3 apps/office/tools/fixture_server.py --selftest` | 15/15 |
| Export | `Godot --export-release macOS` | 59.9 MB bundle, launches with no editor process |

DEMO and LIVE evidence are kept separate. Every DEMO capture comes from the real
Godot build running synthetic playback; every LIVE claim comes from the loopback
fixture or this machine's own daemon. No animation substitute stands in for
either.

## Defects found by this work, and their fixes

Each was found by checking the code against its acceptance rather than trusting a
test count, and each has a regression test that fails without the fix.

| Defect | Effect | Fix |
|---|---|---|
| The transport emitted the SSE envelope, not the wire event | Every real service event reached the store with no `type` and was ignored; a live prompt was invisible | Unwrap to the `data` payload |
| `adopt_reload([], epoch)` | Claimed a completed reload while loading nothing, clearing the stale flag over an empty office | Re-list sessions and replay each durable log, completing only when all answer |
| Discovery searched the config directory | Attaching could never find a running service | Search the state directory the CLI writes |
| `_next_slot` returned desks that do not exist | The lead and any overflow actor were silently parked at the navigation default cell | Name real desks; test asserts the root anchor differs from the default |
| `route()` returned cell origins for anchors that are cell centres | Every arrival landed half a tile up-left of its destination | Convert the final waypoint |
| The ambient tick cleared any empty-notice actor | A real "waiting for your decision" bubble erased itself within 6 seconds | Ambient skips an actor that needs attention |
| DEMO footer echoed the store's connection state | Showed "live" beside a DEMO badge, claiming a connection never made | Report the mode |
| `apply_report` had no caller | A finished subagent never walked to the lead | Wire it, and let it supersede the settle that would cancel the walk |
| The bounded queue had no caller | A burst redirected a moving actor, stuttering it | Queue while moving; promote when free |
| The pill showed a fabricated model list unmarked | Claimed a model the runtime never offered | Label it `demo list` |
| "Ask for approval" was enabled with no handler | Looked live, silently swallowed clicks | Disabled, with its status in the tooltip |


## Release identity (TASK-044)

The exported bundle carries the app's identity, verified by inspecting the built
product rather than the preset that declares it:

```
$ unzip -q YCodingOffice.zip && plutil -p "YCoding Office.app/Contents/Info.plist"
  "CFBundleIconFile" => "icon.icns"
  "CFBundleShortVersionString" => "0.2.4"
  "CFBundleVersion" => "0.2.4"
```

The bundled `icon.icns` is the generated artwork, not a substituted default: a
pixel sampled from the bundle matches the source PNG exactly
(`(219,211,201,255)` at (10,100)). The icon is deterministic — two generator runs
produce byte-identical files.

## What this session closed

Every one of the 48 handoff tasks is implemented and evidence-backed. The work
that finished last:

| Area | What was missing | What it does now |
|---|---|---|
| Human attention | Permission and guardrail requests arrived as ephemeral events the store ignored; `answer_attention` had no caller | Both kinds queue with a caption from their own action/resources/reason, and the drawer answers them with the choices the runtime supplied |
| Models | `_model_catalog()` returned a fabricated list unconditionally | LIVE reads `GET /api/model`; a refusal leaves the list empty and reports why |
| Session lifecycle | New session returned immediately in LIVE; interrupt was never called | Real create and interrupt, with the create verified against a real service |
| Conversation | The drawer filtered by exact session id, hiding every child's work | It reads the real session family with per-session attribution, plus thread and kind filters |
| File changes | `session.file-change.recorded` was reduced to a work state and its payload dropped | Path and counts are shown, the patch is bounded, and the absent change kind is stated rather than inferred |
| Release identity | No icon, no version, in any of the three declaring places | Generated deterministic icon and a version, verified inside the exported bundle |
