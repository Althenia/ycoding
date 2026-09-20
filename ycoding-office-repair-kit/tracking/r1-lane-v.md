# R1 lane V — native classified work-state capture

Task: R1-03 `native_runtime` evidence — a real native render of an actor in a
CLASSIFIED work state driven by a real tool event (not the PROCESSING fallback).

Status: IN PROGRESS (note flushed incrementally).

## Fixture beat targeted and why

`apps/office/fixtures/oauth-workplace.jsonl` record #24 (`oauth-024`) is
`{"kind":"activity.changed","payload":{"activity":"testing"}}` for
`session_id": "demo-qa"` at `at_ms: 53000`.

`integration/fixture_translator.gd::_activity` maps `testing` through
`ACTIVITY_EVENTS["testing"] = Wire.TOOL_CALLED` and, for that branch, emits the
corrected real pair sharing one `callID`:

- `session.tool.input.started` at `52999` with `{"assistantMessageID","callID":
  "call_activity","name":"shell"}`
- `session.tool.called` at `53000` with `{"assistantMessageID","callID":
  "call_activity","input":{},"executed":true}` (no name field, matching
  `packages/schema/src/session-event.ts`)

`OfficeStore.learn_tool_name` stores `shell` under `call_activity`; the call
entered at 53000 is classified by `WorkState.from_tool("shell")` => `TESTING`.
Target capture time 56000 ms: QA has finished walking and holds its rest pose,
while `demo-frontend` is still PROCESSING — both states visible in one frame.

(Godot serialization: every invocation goes through
`ycoding-office-repair-kit/tools/godot_lock.sh`.)

## Timing hazard observed

First attempt used `apps/office/tools/capture_scene.gd` under
`godot_lock.sh`, timeout 300000 ms. It hit the 300 s ceiling with no output.
Not a lock wait: no Godot process was running when it was launched, and after the
timeout `pgrep -fl Godot` showed only another lane's headless
`tests/run_tests.gd` run (started after mine) plus its `godot_lock.sh` wrapper,
and `godot_lock.sh --status` said the lock was later held by `pid-32044`
(that other lane). A concurrent run of `res://tests/run_tests.gd` on `apps/office`
imports/compiles the project concurrently, which is the documented hang mode.

Because a 300 s non-GUI capture is a serious cost, lane V uses a kit-local driver
instead of the repository tool: `ycoding-office-repair-kit/tools/capture_classified_state.gd`,
invoked by absolute path (`--script <abs> --`), which prints per-actor canonical
state (`work_state` int + label, presence, activity, learned tool names, walking)
alongside the PNG, and runs in the background so a lock wait cannot consume the
tool timeout. Repository source is unmodified.

