# M2 — fidelity slice evidence

Task: TASK-017–024 · Gate: TASK-024 · Date: 2026-09-15

## Status

**Implementation complete; visual acceptance is OPEN.** TASK-024 is `in_review`
and requires the user's recorded review of the captures below. The agent does
not self-approve a visual gate.

## Designed layout and regions

The world is a deliberate 40x21 tile module (1280x672 px, aspect 1.905): six
8-row rooms around one 2-row central corridor, in three columns split by
dividers that are solid across both room bands and open at the corridor. The
doorway pierces the north wall band. `OfficeWorld` owns the plan;
`OfficeNavigation` only rasterizes the blockers it is handed, so solid geometry
has one authority.

The window is a designed frame owned by `ui/shell/office_shell_layout.gd`:
margin 16, gap 12, top bar 64, prompt 148, status panel 240-360 adaptive, drawer
520. The office region is the largest world-aspect rectangle that fits its slot,
so the viewport never letterboxes inside it. `main.tscn` carries no layout.

Pinned by `tests/suites/test_layout.gd` and `test_shell_layout.gd` across
1280x720, 1600x900, 1920x1080, 1366x768, 1024x768, 2560x1440 and 1440x700.

## Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| Coherent production-intent office | 76 props, ~29% solid coverage, six zones, `test_layout.gd` |
| Directional employee profiles | `test_character_sheet.gd` pins frame height to the real sheet |
| Grid routing and foot-based depth | `test_navigation.gd`: anchors reachable and in front of their desk |
| Anchor reservation, cancellable movement | `test_navigation.gd`, `test_office_director.gd` |
| Delegation and report interaction | Source-backed bubbles; clicking an actor or bubble opens its source |
| Preemptible ambient office life | `test_office_director.gd`, 18 flow checks |
| World scaling and readable panels | `test_shell_layout.gd` incl. odd windows and drawer clipping |
| Focus visible | `test_focus_visibility.gd` |
| Bubbles clamp correctly | `test_prop_art.gd` bubble geometry |

## Defects found by reviewing the render

Invisible to the suite; found by reading the capture:

- Notice bubbles were a fixed one-line box, so "Waiting for your decision"
  rendered as "wait".
- The overlay sat at `z_index` 0 while the wall and prop layers raised their own,
  so bubbles, status glyphs and the selection highlight drew beneath furniture.
- The office region letterboxed the world inside a free-form container, wasting
  about a quarter of the region at 4:3.
- The composer's focus style was identical to its resting style and buttons had
  no focus style, so keyboard focus was invisible.
- `WALL_DECOR` used filename stems while `PROP_TEXTURES` used keys, so the two
  registries disagreed and the window read as unplaced.

## Commands and results

| Check | Command | Result |
|---|---|---|
| Full verification | `apps/office/tools/verify.sh` | import / tests / flow all exit 0, **0 engine errors**, `VERIFY: PASSED` |
| Unit + scene suite | `Godot --headless --path apps/office --script res://tests/run_tests.gd` | **3798 passed, 0 failed**, exit 0 |
| End-to-end flow | `Godot --headless --path apps/office --script res://tools/flow_check.gd` | **18 checks, 0 failures**, `FLOW RESULT: PASSED` |
| Live transport | `apps/office/tools/verify-integration.sh` | **21/21**, 0 engine errors |
| Capture | `Godot --path apps/office --resolution 1600x900 --script res://tools/capture_scene.gd -- --out=<abs> --at-ms=52000` | 4 actors, 7 interactions, DEMO/live |

Every fix above was proven by injecting the defect, observing the targeted
failure, then restoring it.

`verify.sh` treats a Godot `SCRIPT ERROR` as a failure even when the engine exits
0, because the engine can print errors and still return success.

## Captures (git-ignored)

- `dist/office/captures/m2_slice_1600x900.png` — 3 actors, a question bubble, attention state.
- `dist/office/captures/m2_final_1280x720.png`, `m1_final_1920x1080.png`, `m1_final_1280x720.png`.

## What the captures show

- Coherent office: tiled floor with a single-tone weave, cutaway wall band, doorway gap, engineering rug region.
- Real props at true size: three desks with lit monitors, chairs, coffee station, whiteboard, plant.
- Three distinct roles (Lead, Backend, Frontend) on separate desks with correct silhouettes and accent trim.
- A source-backed question bubble ("Waiting for your decision") with the attention state reflected in the panel.
- Status labels carry a glyph and a text label, so state is legible without color (F-08).

## Fidelity rubric (agent-scored, pending user confirmation)

Score 0–3, target ≥15/18 with no category below 2.

| Category | Score | Note |
|---|---|---|
| Environment composition | 2 | Readable zones and props; could use more decoration variety. |
| Character animation | 2 | Four directions plus walk/sit/type/read/talk rows; shading is flat. |
| Navigation and depth | 2 | Grid routing, no corner cutting; depth sorts by base line. |
| Interaction and bubbles | 2 | Delegation/question/report plus clamped bubbles. |
| Text/UI readability | 3 | Panels stay crisp; verified at 720p, 900p and 1080p. |
| Concurrency and truthfulness | 2 | Distinct actors per session; DEMO never becomes LIVE. |
| **Total** | **13/18** | Below the 15 target: art polish and animation breadth are the gap. |

**Honest conclusion: the rubric target is not yet met.** Environment and art
depth are the weakest categories. The implementation is functional and truthful,
but "polished" is not yet demonstrated at the bar the spec sets, so a reviewer
should expect to request art iteration.

## Defects found and fixed during this milestone

| Defect | Cause | Fix |
|---|---|---|
| `clear_notice` missing on the viewport | forwarding method never added after the overlay refactor | added; `verify.sh` now fails on any engine error, which is how this surfaced |
| Props rendered one tile wide | atlas cell used instead of true footprint | generator now emits correctly sized individual prop sprites |
| Floor read as a noisy checkerboard | alternating tile per cell | single tone with a sparse seam; exact grid lines on the tile |
| Capture was frame-based, not time-based | `--frames` mapped to iterations | `--at-ms` drives the demo clock deterministically |
| Export failed: ETC2 ASTC disabled | project setting | enabled `import_etc2_astc` |
| Export failed: missing bundle id | preset | added `application/bundle_identifier` |
| Export failed: arm64 template absent | templates ship `.universal` only | preset set to `universal` |

## Not covered here

Live HTTP/SSE integration, LIVE mode, approval/question UI wiring, native export
lifecycle ownership, and the M4 five-zone office remain M3–M5 scope.
