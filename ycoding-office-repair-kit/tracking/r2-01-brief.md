# R2-01 / R2-02 implementation brief (orchestrator-authored)

Status: **ready to dispatch.** Do not start until R1-01 has landed in `app/main.gd`, because
R2-01 changes the same placement code and `app/main.gd` must have exactly one writer at a time.

## What changes, and where

The office stops being full-bleed and the sidebar stops floating. The shell becomes a two-region
tile. The authoritative design is `tracking/r2-shell-contract.md`; this brief names the exact edits.

| File | Change |
| --- | --- |
| `apps/office/ui/shell/office_shell_layout.gd` | `office_region()` is computed inside the content area east of the sidebar, not centred across the window. `overlays()` stops returning the sidebar as an overlay and returns it as a reserved region. Add a compact breakpoint (< 1000 logical width -> 56-wide rail). |
| `apps/office/app/main.gd` | `_apply_regions()` places the office in the new region and the sidebar as a tile. The drawer's literal `Rect2` placement (marked "provisional" in the source) must be derived, not hardcoded. |
| `apps/office/AGENTS.md` | The "Shell" table and prose currently document the floating contract as current behaviour. Update it in the same change. |
| `apps/office/office/maps/hq/office_world.gd` | The comments claiming cols 1-12 are a "lobby the sidebar floats over" and that anchors sit at row 16+ to clear the floating composer become false. Re-derive, or state the real invariant. |
| `apps/office/tests/suites/test_shell_layout.gd` | Re-point the floating assertions at the new contract. |
| `apps/office/tests/suites/test_layout.gd` | `test_lobby_band_holds_no_anchors` (line 137) must be re-derived and RE-ENABLED. |

## The three traps, each verified

1. **Five tests never run.** `run_tests.gd` calls only `suite.run(self)`; there is no reflection. Four
   `test_shell_layout.gd` tests and `test_layout.gd:137 test_lobby_band_holds_no_anchors` are defined
   but absent from their `run()` bodies. Wire them back before relying on them, or the suite stays
   green while the layout is wrong.
2. **The world plan disagrees with its guide.** `AGENTS.md` says 40x21 / six rooms / dividers at cols
   12 and 26; the code is 41x23 with one divider at col 26 (four rooms). Fix the document to match the
   code, or change the code deliberately - but do not leave them disagreeing.
3. **The chrome cluster is broken independently of the layout.** Five controls share `TOGGLES_W := 76`
   and every unhidden toggle renders the literal text "Hide", so two buttons are indistinguishable and
   the cluster is clipped in the render (`evidence/r0-05-no-registration.png`). Either widen it and
   label each control by what it toggles, or reduce the control count.

## Acceptance (executable, and each must be a real assertion)

- The sidebar never overlaps the office region at any supported size or text scale.
- The office region is world-aspect and fills all remaining width and height (no dead band beyond the
  aspect letterbox, and `office_aspect()` still equals the world's by construction).
- The composer is centred in the visible office rect within 2 logical units and keeps at least one
  gutter on each side.
- The composer never covers a work anchor.
- At logical width < 1000 the sidebar becomes a rail and the composer still clears it.
- Every size in `supported_sizes()` plus 100/150/200% text scale lays out with no overlap and no
  clipped control.
- At least one native capture at 1280x720 and one at 1600x900 showing the docked sidebar, taken
  through the capture tool AFTER it has been given its explicit demo opt-in.

## Ownership

One lane owns `office_shell_layout.gd` + `main.gd` for this change. A second lane may concurrently own
`chrome_toggles.gd` + `office_theme.gd` for the cluster/typography work, provided it does not edit
`office_shell_layout.gd`. `AGENTS.md` and the two test suites go with the layout lane.

## Constraints

- Lock every Godot run through `ycoding-office-repair-kit/tools/godot_lock.sh`.
- Never run a git mutating command; never stage or commit.
- Update the affected `AGENTS.md` in the same change: the root guide requires documentation to move
  with behaviour, and this change inverts a documented contract.
