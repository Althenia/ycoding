# Lane K — capture tools explicit demo opt-in

HEAD: a4bb99e (`main`), dirty tree per `git status` (other lanes' work present).
Owner paths: `apps/office/tools/capture_scene.gd`, `capture_variants.gd`,
`capture_report.gd`, `capture_effort.gd`, `measure_runtime.gd`, + optional
`apps/office/tools/demo_capture.gd`.

## Step 1 — mechanism found

- `apps/office/app/main.gd:95` `_ready()` still calls `_start_demo()` unconditionally.
  **Lane G has NOT landed its boot change.** Verified by reading the file at HEAD a4bb99e.
- The gated public entry point that already exists is `OfficeMain.start_demo_mode()`
  (`app/main.gd:219`), which resets the store and calls `_start_demo()` (fixture load +
  `demo.play(true)`).
- `_ready` runs after `SceneTree._initialize` (confirmed by the comment in
  `tools/flow_check.gd`), so a harness must retry the opt-in until `scene.demo != null`.
- Out-of-scope finding: `apps/office/tools/flow_check.gd` (run by `tools/verify.sh`) has
  the same boot-demo dependency and is NOT in this lane's allowed paths. It will break
  post-lane-G unless its owner fixes it. Reported, not edited.

## Step 2 — edits applied (minimal)

New shared helper `apps/office/tools/demo_capture.gd` (no `.uid` yet; engine will
generate one on import if it wants it). It:
- waits until `_ready` built the scene (`scene.demo != null` and `scene.store != null`);
- if `demo.is_playing()` is false, calls the public `OfficeMain.start_demo_mode()`
  (main.gd:219) — this satisfies BOTH the current tree (already playing → adopted
  as-is, no double-connect) and the post-lane-G tree (not playing → explicit opt-in);
- is bounded to 600 frames and exposes `failure()` so a fixture that never loads
  fails the run instead of hanging;
- deliberately does NOT touch `capture_mode`, so each harness keeps its existing
  clock handling and captured output is unchanged.

Each tool got only a `preload` + a guard at the top of `_process`:
- capture_scene.gd: guard + fail-loud on `failure()`
- capture_variants.gd: guard
- capture_report.gd: guard
- capture_effort.gd: guard
- measure_runtime.gd: guard

`_initialize` is unchanged in all five; CLI flags (`--out`, `--at-ms`, `--frames`,
`--samples`) and defaults are unchanged.

## Step 3 — lane G LANDED mid-run; re-verification required

While probing I hit a transient `Failed to load script "res://app/main.gd" with error
"Compilation failed"` — lane G was mid-write. It has now landed (main.gd mtime 23:20):

- `_ready()` now calls `_boot_live()` (production attaches to the registered service or
  states honestly that there is none). It does NOT call `_start_demo()`.
- `_start_demo()` doc: "Reachable ONLY through the explicit demo action ... the two
  callers are the user's own mode toggle and the sibling mode method it drives."
- `start_demo_mode()` is still public at :320 and guards the live disconnect.

So the gating mechanism is the composition root's public `start_demo_mode()`, which my
helper calls. The earlier pre-G baseline (actors=3 from boot default) is superseded;
all runs below are against the POST-G tree.

Also found (pre-existing, NOT lane K): `capture_effort.gd` triggers
`PromptPanel._entry_for` `ref["id"]` SCRIPT ERROR when `_model_ref` is empty at boot —
identical code exists at HEAD (`git show HEAD:...prompt_panel.gd`), and my guard is a
no-op when demo is already playing, so it is unrelated to this lane. Recorded for the
orchestrator; `prompt_panel.gd` is not in my allowed paths.

## Step 4 — verification (all against the SETTLED POST-G tree)

Lane G's `main.gd` (mtime 23:20) and `flow_check.gd` are final and untouched by me.
All commands run with cwd `/Users/viadz/Workspace/Project/ycoding` under
`ycoding-office-repair-kit/tools/godot_lock.sh`.

### AC1 — each tool explicitly opts into demo
Mechanism: shared `apps/office/tools/demo_capture.gd`, which calls the composition
root's public `OfficeMain.start_demo_mode()` (main.gd:320). Guard is a no-op when demo
is already playing, so it works in both worlds. Each of the five tools now `preload`s
the helper and guards the top of `_process`. `_initialize` and all CLI flags/defaults
are unchanged.

### AC2 — populated office, same fixture, same deterministic clock, same target frames
`/Applications/Godot.app/Contents/MacOS/Godot --path apps/office --resolution 1280x720 --script res://tools/capture_scene.gd -- --out=<abs> --frames=2100`
- EXIT=0
- `capture: reached 35000 ms of playback`
- `capture: actors=3 interactions=3 mode=DEMO conn=live`
- `capture: container=(1280.0, 718.0488) subviewport=(1280, 718) camera=(656.0, 368.0) zoom=(0.97561, 0.97561)`
- `capture: wrote .../post-g-capture_scene.png (1280x720)`
- The `--frames=2100` alias still maps to 35000 ms, so the CLI contract holds.

Round-trip identity: `shasum -a 256 baseline-capture_scene.png post-g-capture_scene.png`
gives `35d6647a364fe11e5d4f8ae364e02d000247613e7df7af949dbac7381a62ae7b` for BOTH. The
pre-G capture (boot default) and the post-G capture (explicit opt-in) are byte-identical,
which is the strongest form of "identical in kind".

Other tools, post-G, EXIT=0:
- `capture_report.gd --out=<abs>` → `report capture: sent demo-backend to report` then
  `wrote .../post-g-capture_report.png (1280x720)` (found a non-root actor ⇒ populated).
- `capture_variants.gd --out=<abs>` → `mode=light scale=2.0`, `overlap=false`,
  `sidebar=[P: (16.0, 16.0), S: (594.0, 688.0)] composer=[P: (622.0, 448.0), S: (642.0, 232.0)]`,
  `window=(1280, 720)`, wrote PNG.
- `capture_effort.gd --out=<abs>` → `effort capture: wrote .../post-g-capture_effort.png (code 0)`;
  3 consecutive runs all code 0.
- `measure_runtime.gd --samples=10` → `frames=600`, `frame_ms p50=7.0 p95=9.0 max=9.0`,
  `objects first=2206.0 last=2206.0`, `static_mem ... 239341 → 239347`. EXIT=0.

Independent post-G branch probe (forced boot demo off, reproducing the world where
`_ready` never starts it): `/tmp/...post_g_probe.gd` printed
`probe: playing after forced stop =false actors=0` then `probe: playing after helper =true`
then `probe: actors=3 interactions=3 mode=DEMO`.

### AC3 — a production launch must not reach the demo path
Probe instantiating `res://app/main.tscn` with no tool script and never opting in:
`probe/production_boot_probe.gd` → `AC3: production boot mode=LIVE playing=false
conn=live actors=0 interactions=0`, exit 0. The production boot reaches LIVE, does not
start synthetic playback, and fabricates no actor.

Lane G's own suite `apps/office/tests/suites/test_production_boot.gd` (wired into
`tests/run_tests.gd:46`) pins the same contract directly:
- `test_a_launch_without_a_registration_fabricates_nothing` — mode LIVE, no actors, no
  interactions, `not main.demo.is_playing()`.
- `test_demo_is_reached_only_through_the_explicit_action` — `_boot_with({})` stays LIVE
  with no playback; only `main.start_demo_mode()` enters DEMO.
- `test_leaving_demo_without_a_service_discards_the_synthetic_office`.

### AC4 — no tool is a production entry point
`project.godot:15` sets `run/main_scene="res://app/main.tscn"`. A normal launch runs the
scene directly and no tool script is attached; the tools run only via
`--script res://tools/<tool>.gd`. `demo_capture.gd` is a `RefCounted` with static
methods, preloaded **only** by the five tools — nothing under `app/` or `ui/` references
it (verified by grep), so production code cannot reach the opt-in. The gate is therefore
"you must launch with `--script` naming a harness"; a normal double-click launch cannot
reach it.

### Pre-existing defect found (NOT lane K, not fixed — outside my paths)
`capture_effort.gd` on the pre-settled tree emitted
`SCRIPT ERROR: Invalid access to property or key 'id' ... PromptPanel._entry_for (prompt_panel.gd:241)`.
Cause: `_open_effort()` calls `current_entry()`, which indexes `ref["id"]` on
`ModelCatalog.parse_ref(_model_ref)`; when `_model_ref` is still `""` at frame ~3 the
parse returns `{}` and the index errors. Identical code exists at HEAD
(`git show HEAD:apps/office/ui/prompt/prompt_panel.gd`), and `prompt_panel.gd` is not in
my allowed paths. It does not reproduce on the settled tree (3/3 clean runs) because the
timing window closed. Reported for the owner of `ui/prompt/prompt_panel.gd`.

### Final state
- `pgrep -fl Godot` → CLEAN: no Godot running. Lock free.
- Changed by me, and nothing else: the five tools + new `tools/demo_capture.gd` and its
  engine-generated `.uid`.

## Step 5 — final re-verification after removing an over-reach

I initially added a fail-loud bound to `demo_capture.started()` that called
`scene.get_tree().quit(1)`. A stub probe showed it spamming ~600 errors and calling
`quit` on a null tree when the scene was not in the tree, which is worse than the
problem it solved and was not required by AC1. I reverted it: `started()` now only
waits and returns false; `failure()` returns the reason. Each tool keeps its own
stop condition, so a genuine failure still ends a run rather than hanging.

Re-verified after the revert, all EXIT=0, no `SCRIPT ERROR` in any run:
- helper stub: `already-playing adopted =true`; `failure on healthy scene =''`;
  `still waiting =true`; `failure reason ='demo did not start within 600 frames'`;
  `fixture-error reason ='fixture not found: /nope'`.
- `capture_scene.gd --frames=2100 --out=<abs>` → exit 0, `actors=3 interactions=3
  mode=DEMO conn=live`, `wrote final-capture_scene.png (1280x720)`; engine-error
  count in the run log is 0.
- `capture_variants.gd` → `mode=light scale=2.0`, wrote PNG, exit 0.
- `capture_report.gd` → `sent demo-backend to report`, wrote PNG, exit 0.
- `capture_effort.gd` → `wrote ... (code 0)`, exit 0.
- `measure_runtime.gd --samples=10` → `frames=600`, `frame_ms p50=7.0 p95=9.0 max=9.0`.

Hash note: `final-capture_scene.png` differs from the earlier `post-g-capture_scene.png`
because `apps/office/ui/shell/chrome_toggles.gd` was modified at 23:46 by another lane,
after my 23:39 capture. The camera/container/subviewport numbers and the actor,
interaction, mode and connection counts are unchanged. This is another lane's visual
change, not a regression in this lane.

Final state: `pgrep -fl Godot` → CLEAN; lock free. No git mutating command was run and
nothing was staged. Only the five owned tools plus `tools/demo_capture.gd` (+ engine
`.uid`) were changed by me.
