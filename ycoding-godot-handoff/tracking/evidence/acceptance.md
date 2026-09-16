# User acceptance evidence

Task: TASK-024 (fidelity), TASK-040 (four-role MVP) · Date: 2026-09-16

## Record

The user reviewed the rendered product as PNG captures from the real Godot build and
approved it with the instruction "approve proceed next." That single approval closes both
open gates, because the user was shown the fidelity captures and the working MVP in the
same review.

## What was shown

Every capture below was produced by running the real `apps/office` project under Godot
4.7.2, not by a mock or an animation substitute.

| Capture | What it shows |
|---|---|
| `dist/office/captures/art_styled.png` | The reference-style office: white desks, dark task chairs, coral sofas, glass windows, checker rugs, lounge floor |
| `dist/office/captures/ui_v2.png` | The two-row composer and the sidebar with the session tree |
| `dist/office/captures/effort_final.png` | The effort popover: lightning glyph, accent variant, model name, fill, knob, stop dots |
| `dist/office/captures/final_release.png` | The labelled working zones and the live connection control |

Captures are build artifacts and are not tracked; the commands that produce them are in
`apps/office/tools/` and are re-runnable.

## Scope of the approval

The user approved the visible product. This does not assert that every M5 acceptance line
is satisfied; those are verified separately by their own evidence files, and any line that
could not be verified is reported as an explicit gap rather than as a pass.
