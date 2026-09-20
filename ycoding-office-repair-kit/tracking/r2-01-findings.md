# R2-01 implementation findings (measured, orchestrator-recorded)

These findings were recovered from lane R before its provider stream failed. Lane R had
made **no edits** — `office_shell_layout.gd` was still untouched — so nothing is
half-written. All numbers below are **measured from real Godot probes** the lane ran
under the lock (exit 0, 0 engine errors), not calculated.

## Measured combined minima

| Control | scale 1.0 | 1.25 | 1.5 | 1.75 | 2.0 |
| --- | --- | --- | --- | --- | --- |
| Sidebar min width | 200 | 250 | 300 | 350 | 400 |
| Composer min width | 295 → 400 | | | | (height 109 → 143) |
| Toggles min | (244, 31) — constant | | | | |

## The blocking gotcha: Godot clamps size UP to the minimum

`control.size` is clamped up to `get_combined_minimum_size()`. Probe 2 placed the
sidebar at 56 px and it **painted at 200 px**. So the brief's "compact breakpoint
(< 1000 logical width → 56-wide rail" is **not achievable by assigning a smaller
rect** — it requires a real compact CONTENT mode in `sidebar_panel.gd` (collapse the
rows, drop labels) so the minimum itself shrinks. That file is owned by the
`main.gd`/shell lane for this change.

**Correction to the brief:** the compact rail is a content-mode change, not a width
assignment. Do not "fix" it by setting a size the engine will silently override.

## Trap 3 confirmed by measurement

The toggles cluster's real minimum width is **244**, while `office_shell_layout.gd`
reserves `TOGGLES_W := 76`. So the cluster is painted 244 wide today against a 76-wide
reserved rect — that is the clipping visible in the native capture. Lane N was fixing
this and left it ONE ASSERTION SHORT (see `r2-lane-n.md` and the orchestrator note
below): `ChromeToggles.cluster_width(1.0)` returns 429 while the built cluster
measures 454.

## World plan (for the documentation correction)

Code: 41x23, a SINGLE divider at col 26, four rooms — `ZONES` holds six rects
(reception_n, reception_s, product, ops, engineering, ceo). Guide (`apps/office/AGENTS.md`)
says 40x21, six rooms, dividers at cols 12 and 26. The guide is stale; correct the
document to the code.

## A vacuous test to replace, not preserve

`test_shell_layout.gd`'s hidden-chrome pair (`test_hidden_chrome_frees_every_anchor`,
`test_hidden_overlays_occlude_nothing`) passes `HIDEABLE` — the full hide list — as the
`hidden` argument while iterating, so both assertions are **vacuous**: they can never
fail. They also self-pass once the sidebar becomes a tile. Re-point them into real
assertions rather than keeping the vacuous form.

## Orchestrator note on lane N's unfinished state

The suite was **RED with exactly one real failure**:

    passed: 6479
    failed: 1
      FAIL: the declared width 429 covers the built cluster 454 at 100%

### Root cause: a DOUBLE BUILD, not a wrong estimator

Lane N's note and the failing assertion both framed this as the width *estimator*
under-counting. That framing is wrong, and the orchestrator disproved it directly.

A standalone probe built `ChromeToggles` the ordinary way (add to the tree, let the
engine call `_ready` once) and measured:

    panel min = 378.0        declared cluster_width(1.0) = 429.0

The declaration **already covered** the built panel with 51 px to spare. The suite
wanted 454, so the difference had to be in how the suite builds the panel, not in the
arithmetic. `_engine_minimum` (test_chrome_toggles.gd:78) does:

    root.add_child(toggles)   # the tree calls _ready()
    toggles._ready()          # ...and then calls it AGAIN

`chrome_toggles.gd`'s `_ready` had **no build guard**, so a second call appended a
SECOND `HBoxContainer` row of five controls. A probe of the panel's children after
that sequence showed two rows of five:

    PANEL children=2 min=(378.0, 45.0)
      panel child HBoxContainer min=(354.0, 25.0) kids=5
      panel child HBoxContainer min=(354.0, 25.0) kids=5

One row's minimum is 354; two rows of text widen the panel's combined minimum to the
454 the suite reported. So the assertion was counting a defect it had itself
provoked, and the estimator was innocent.

The codebase already had the correct pattern: `sidebar_panel.gd` carries
`var _built := false` and an `_ensure_built()` that returns early. `chrome_toggles.gd`
simply lacked it. The fix follows the established pattern — guard `_ready` on
`_built` — which also prevents a double build in production if `_ready` ever runs
twice for one instance.

**Lesson for the next lane:** when an assertion quotes two numbers, do not assume the
smaller one is the wrong one. Measure both sides independently first; here the
"wrong" estimator was right and the "reference" measurement was the artifact.

## A self-inflicted regression, recorded honestly

The orchestrator applied the `_built` guard directly and, in doing so, **deleted the
newline between `func _refresh_labels() -> void:` and its body**, producing:

    func _refresh_labels() -> void:	for entry in ENTRIES:

That merged signature-and-body line is a parse error, so the entire `ChromeToggles` global
class failed to resolve, and the suite reported cascading "Could not parse global class"
errors that pointed at the **callers** instead of the cause. A reader could easily have
blamed `test_production_boot.gd` or `main.gd`, which were innocent.

Two things made it findable rather than mysterious:
1. A clean `--editor --quit` reimport reproduced the failure with the real location:
   `Parse Error: Unindent doesn't match the previous indentation level. at: GDScript::reload (res://ui/shell/chrome_toggles.gd:230)`.
2. Printing the file with its whitespace made visible (one `T` per tab) showed the merged
   line immediately at 217.

The lesson is the one this session keeps repeating: **a plausible-looking small edit still
needs the parse gate run before its result is reported.** The guard itself was correct; the
edit that carried it was not. A first draft of this very note attributed the failure to a
stale class cache, and the reimport disproved that.

Note: the `.godot` class cache and editor directory were deleted while diagnosing. That is
a git-ignored, regenerable cache, regenerated by a fresh import; no source or committed
artifact was affected.
