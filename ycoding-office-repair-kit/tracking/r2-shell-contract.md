# R2 shell contract (orchestrator-authored)

Status: **proposed design, derived from the six supplied references and the live
layout code.** R0-D is producing the formal gap table; this file fixes the
decisions that R2 implementers must follow so two lanes cannot invent
incompatible shells. Numbers are design targets, not measurements of a running
client.

## Authority conflict being resolved

`apps/office/AGENTS.md` ("Shell") documents a **floating** sidebar 264 wide over a
full-bleed office, and `ui/shell/office_shell_layout.gd` implements that model
(`SIDEBAR_W := 272.0`, `overlays()` places the sidebar inside the office's
coordinate space, `office_region()` is the world-aspect rect anchored to the
window centre).

The approved latest scope supersedes this: REQUEST.md requires a "Persistent
application sidebar on the left" with "Main Office workspace occupies the
remaining application area", and ADDENDUM.md names the "floating rail" as part of
the superseded prototype. UI_SPEC.md:15-22 agrees ("sidebar target 264 logical
units … It touches the application left edge and fills the content height").

**Decision:** the office is no longer full-bleed. The shell becomes a two-region
tile: a persistent sidebar column that touches the left edge and spans the content
height, and an office region that occupies every remaining pixel. Panels stop
floating over the world; only the composer still overlays the office.

## Target geometry (logical units, 100% text scale)

| Region | Rule |
| --- | --- |
| Sidebar | 264 wide, anchored to the left edge, full content height, never overlays the office |
| Office region | the largest world-aspect rect that fits the remaining content area, centred inside it |
| Composer | `min(840, visible_office_width - 2*gutter)`, centred in the **visible office rect**, bottom margin 24 (16 compact) |
| Gutter | 24 normal, 16 compact (< 1000 logical width) |
| Compact mode | below 1000 logical width the sidebar collapses to a 56-wide rail; the full sidebar opens as a dismissible overlay on explicit request |

Composer default empty height ~112, growing with text to
`min(240, 0.35 * visible_office_height)` then scrolling internally. The text
editor and send/stop control must remain reachable at every supported size.

## What R2 must NOT do

- Do not keep `office_region()` anchored to the window centre; it must be computed
  inside the content area east of the sidebar.
- Do not letterbox the world inside the office region. `office_aspect()` must still
  equal the world's aspect by construction.
- Do not change the world plan (`office_world.gd`) or the eight-room design; only
  the region it is drawn into changes.
- Do not add a new UI-scaling owner. UI scale stays a FONT factor via
  `OfficeTheme.font`; the world camera keeps its own scaling.

## Capture-tool dependency (raised by lane G, verified by file list)

`tools/capture_scene.gd`, `capture_variants.gd`, `capture_report.gd`,
`capture_effort.gd` and `measure_runtime.gd` all instantiate `main.tscn` and
depend on boot-time DEMO to produce a populated office. R1-01 removes that boot
default, so after R1 they will render an empty office unless they explicitly
request demo playback.

This is a **legitimate developer-tool use of demo**, not a production path, so the
fix is to have each tool opt in explicitly (an env var or an explicit call), never
to restore the boot default. A lane owning `apps/office/tools/` must do this in the
same change as R1-01, and the tools must still never be reachable from a normal
production launch.

`tools/verify.sh` runs the import check, the unit suite and `flow_check.gd`, and
fails on any `SCRIPT ERROR` / `Parse Error` / `Compile Error` in the captured logs —
so a capture tool left broken is caught there, not silently.

Existing `tests/suites/test_shell_layout.gd` pins the **rejected floating model**
(`test_office_is_full_bleed`, `test_chrome_stays_a_minority_of_the_frame`,
`test_sidebar_does_not_cover_the_office_centre`, `test_hidden_chrome_frees_every_anchor`,
`test_sidebar_never_covers_an_anchor`). Per REQUEST.md ("Update incompatible old
floating-layout tests/docs with the product change rather than weakening tests"),
these must be **re-pointed at the new contract**, not deleted:

**Dead-test correction (verified).** `tests/run_tests.gd` calls only
`suite.run(self)` — there is no reflection and no discovery. Four tests in
`test_shell_layout.gd` (`test_chrome_stays_a_minority_of_the_frame`,
`test_hidden_chrome_frees_every_anchor`, `test_hidden_overlays_occlude_nothing`,
`test_toggle_cluster_is_reachable`) and `test_layout.gd:137
test_lobby_band_holds_no_anchors` are defined but never invoked, so they do not
run today and nothing may cite them as a passing gate. R2 must wire them back into
their `run()` bodies (or delete them with a stated reason) **before** relying on
them. In particular `test_lobby_band_holds_no_anchors` is the invariant that R2
inverts, so it must be re-derived and re-enabled rather than trusted.

- the sidebar never overlaps the office region (it is a tile, not an overlay);
- the office region is world-aspect and fills all remaining width and height;
- the composer is centred in the visible office rect within 2 logical units and
  keeps at least one gutter on each side;
- the composer never covers a work anchor;
- at logical width < 1000 the sidebar becomes a rail and the composer still clears it;
- every supported size in `supported_sizes()` plus 100/150/200% text scale lays out
  without overlap or clipping.

`apps/office/AGENTS.md` "Designed dimensions and regions" must be updated in the
same change, since it currently states the floating contract as current behavior.
