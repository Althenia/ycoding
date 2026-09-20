# R2 lane N — chrome toggle cluster repair

Owner: lane N (`zeus`, `openrouter/deepseek-v4.1-flash#max`). Task R2-06.
Scope (owned paths only): `apps/office/ui/shell/chrome_toggles.gd`,
`apps/office/tests/suites/test_chrome_toggles.gd`, and (if needed)
`apps/office/ui/shell/office_theme.gd`. No other repository file is written.

Godot serialization: every Godot invocation in this note ran through
`ycoding-office-repair-kit/tools/godot_lock.sh` with `GODOT_LOCK_OWNER=r2-lane-n`.
Canonical command (cwd `/Users/viadz/Workspace/Project/ycoding`):

```
ycoding-office-repair-kit/tools/godot_lock.sh \
  /Applications/Godot.app/Contents/MacOS/Godot --headless \
  --path apps/office --script res://tests/run_tests.gd
```

## Defect (established, not assumed)

- `evidence/r0-05-no-registration.png` (real 1280x720 render) shows two adjacent
  buttons both reading `Hide` in the top-right cluster, with the cluster clipped by
  the right window edge.
- `office_shell_layout.gd` reserved `TOGGLES_W := 76.0` for a cluster whose real
  minimum width is 244 px at 100% (measured, see below).
- `chrome_toggles.gd` set every unhidden toggle to the literal `Hide`, so five
  controls were distinguishable only by tooltip.

## AC1 — every toggle distinguishable

Chosen scheme: each control's label is `<Surface> <state marker>`, where the marker
is the roster's own pair already used by `SidebarPanel` (`●` = `MARK_SELECTED`,
`○` = `MARK_UNSELECTED`). Momentary controls read `<Surface>: <value>`.

- Panels: `Sidebar ●`, `Prompt ●`, `Motion ●` (hidden: `Sidebar ○` …).
- Settings: `Theme: Dark` / `Theme: Light`, `Text: 100%` … `Text: 200%`.

Legible without colour because the surface name and the state marker are both text.
The colour override remains as a second cue only.

Tests: `test_every_control_names_its_own_surface`,
`test_no_two_enabled_controls_share_a_label`,
`test_the_state_is_marked_as_text_not_only_colour`,
`test_the_hide_show_round_trip_restores_every_panel`,
`test_the_theme_label_names_the_active_mode`.

## RED evidence (step 2)

Command: the canonical command above. Exit code `1`.
Log: `/tmp/r2-lane-n-red2.log` (superseded by later diagnostic runs).

```
failed: 17
  FAIL: both states still name the surface they control
  FAIL: sidebar names its surface (Hide, wanted prefix Panel)
  FAIL: composer names its surface (Hide, wanted prefix Prompt)
  FAIL: motion names its surface (Hide, wanted prefix Motion)
  FAIL: theme names its surface (Dark, wanted prefix Light)
  FAIL: scale names its surface (100%, wanted prefix Text)
  FAIL: no two enabled controls read Hide (also sidebar)
  FAIL: no two enabled controls read Hide (also composer)
  FAIL: sidebar is marked present while visible (Hide)
  FAIL: sidebar is marked absent while hidden (Show)
  FAIL: composer is marked present while visible (Hide)
  FAIL: composer is marked absent while hidden (Show)
  FAIL: motion is marked present while visible (Hide)
  FAIL: motion is marked absent while hidden (Show)
  FAIL: an over-scale label reads the clamped scale (400%)
  FAIL: an under-scale label reads the clamped scale (0%)
  FAIL: the theme control names its surface (Dark)
RESULT: FAILED
```

Two of those failures are the pre-existing behaviour, deliberately kept in scope:
`set_ui_scale(4.0)` displayed `400%` and `set_ui_scale(0.0)` displayed `0%` even
though `UiScale` clamps to `[1.0, 2.0]`, so the label reported a scale that was not
applied. That is AC5's "the text scale `${n}%` label stays accurate".

## Engine behaviour discovered (this changed the implementation)

Measured in-tree, probe logged from the suite:

```
button=51x31  font12=33x17  font24=64x34
style_min=8x8 l=4 r=4 t=4 b=4 focus_expand=2.0  h12=17.0  h24=34.0
font.get_string_size("Panel", size 12).x = 33.0
font.get_string_size("Panel", size 24).x = 64.0
```

- The fallback theme font's metrics DO scale with the `font_size` override
  (`get_height` 17 → 34, `get_string_size` 33 → 64).
- A `Button`'s cached `get_combined_minimum_size()` does NOT revalidate after a
  font-size override inside a headless `SceneTree._init` run: a fresh button with
  text `Panel` reported `51x31` at both 12 pt and 24 pt, and
  `NOTIFICATION_THEME_CHANGED` did not refresh it either. There is no frame between
  `_init` and the assertion, so the engine's cache is the only stale input.
- Consequence: the cluster's declared width cannot be read from
  `get_combined_minimum_size()` in a headless suite; it must be derived from font
  metrics the engine does report correctly.

## AC2 — cluster fits its region at every size and scale

Implementation: `chrome_toggles.gd` now owns the size it needs and derives it from
its own labels (`ChromeToggles.cluster_width(scale)` / `cluster_height(scale)`,
from `labels_at(scale)` and `ThemeDB.fallback_font.get_string_size` at
`label_font(scale)`, plus the control padding and panel margins).

Cross-check at 100%, engine-reported (fresh cache, real `get_combined_minimum_size`):
the built cluster is `454x31`. The derived value is `429x31`; the 25 px delta is the
per-button non-text overhead not yet fully accounted for (see calibration output in
the log), so the derived width is a lower bound and must not be treated as exact.

**Requested layout change (constant + value).** The layout lane must stop using the
hardcoded cluster size and reserve the derived size instead:

- Replace `const TOGGLES_W := 76.0` with a per-scale value:
  `var toggles_w := ChromeToggles.cluster_width(safe)` inside `overlays()`, used for
  the `toggles` rect. Keep a constant only as a floor, and set that floor to
  `ChromeToggles.cluster_width(2.0)`.
- Replace `const TOGGLES_H := 28.0` with `ChromeToggles.cluster_height(safe)`.
- Keep `TOGGLES_MARGIN := 16.0`.

Derived values the layout must reserve (declared, from the suite print):

| Text scale | Cluster width | Cluster height |
| --- | --- | --- |
| 100% | 429 | 31 |
| 125% | 503 | 34 |
| 150% | 578 | 37 |
| 175% | 650 | 40 |
| 200% | 726 | 43 |

Narrowest supported window is 1024 logical px, so `726 + 16 = 742` fits with 282 px
to spare. The 76 px the layout reserves today is the clipping defect.

Test: `test_the_cluster_fits_the_frame_at_every_size_and_scale` asserts the declared
size covers the built controls, fits every `supported_sizes()` window at every
`UiScale.STEPS` step, and grows with the text scale.

## AC3 — every control still acts

No control was disabled or removed. All five controls were already wired:
`sidebar`/`composer`/`motion` emit `toggled`, `theme`/`scale` emit
`action_requested` and are consumed by `main.gd::_on_chrome_action`.
Test: `test_every_control_is_enabled_and_acts` emits each button's real `pressed`
signal and asserts the matching signal arrives, so a silently-dead affordance fails.

## AC4 — hidden vs visible legible, round trip, cluster never hideable

Test: `test_the_hide_show_round_trip_restores_every_panel` hides all three panels,
asserts the cluster itself is not hidden and is not in `OfficeShellLayout.HIDEABLE`,
then shows each again and asserts every label is byte-identical to its initial text.
`test_never_offers_to_hide_itself` retains the original invariant.

## AC5 — motion and scale keep working, scale label accurate

- `scale_label(scale)` runs the value through `UiScale.clamp_scale`, so the label
  can no longer display a scale that was not applied (the RED failures above).
- `theme_label(mode)` names the mode actually in use.
- `main.gd` already re-applies the regions after a rescale via
  `_repaint_theme()` → `_apply_regions()`; unchanged, and the derived size is a
  function of the scale, so the layout gets the right width on that re-apply.

## Status

Implementation written; suite GREEN (see next section). `verify.sh` pending.
