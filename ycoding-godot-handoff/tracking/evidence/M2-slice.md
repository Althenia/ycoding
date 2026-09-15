# M2 — fidelity slice evidence

Task: TASK-017–024 · Gate: TASK-024 · Date: 2026-09-15

## Status

**Implementation complete; visual acceptance is OPEN.** TASK-024 is `in_review`
and requires the user's recorded review of the captures below. The agent does
not self-approve a visual gate.

## Commands and results

| Check | Command | Result |
|---|---|---|
| Full verification | `apps/office/tools/verify.sh` | import exit 0 / tests exit 0 / flow exit 0, **0 engine errors**, `VERIFY: PASSED` |
| Unit + scene suite | `Godot --headless --path apps/office --script res://tests/run_tests.gd` | **302 passed, 0 failed**, exit 0 |
| End-to-end flow | `Godot --headless --path apps/office --script res://tools/flow_check.gd` | **18 checks, 0 failures**, `FLOW RESULT: PASSED` |
| Capture | `Godot --path apps/office --resolution 1600x900 --script res://tools/capture_scene.gd -- --out=<abs> --at-ms=34000` | 3 actors, 3 interactions, DEMO/live |

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
