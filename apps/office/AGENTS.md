# Native Godot desktop client

Adapted from the approved YCoding Office handoff. The repository root guide still applies.

## Authority

YCoding remains the sole authority for prompts, sessions, agents, provider/tool execution, permissions, history, and persistence. This project is only a client. Use the verified local HTTP/SSE API; never import backend implementation modules or open its database.

`contracts/wire-audit.json` in the handoff pack records the locally verified operations, DTOs, auth, location scope, and the real event vocabulary. Treat it as the wire reference. Do not invent route names, event names, or DTO fields.

## Shape

- Typed GDScript, a single composition root (`app/main.gd`), feature-cohesive scenes/scripts, lowercase snake_case paths, PascalCase nodes.
- `core/` is pure presentation logic with no scene-tree dependencies and is what the headless tests exercise. `office/` and `ui/` are the Godot-facing layers.
- Keep UI text at readable screen resolution; keep pixel-world assets on one integer grid.
- Do not grow a general-purpose workflow framework, and do not add autoloads without a genuine lifecycle need.

## Truthfulness rules

- `OfficeDirector` consumes presentation state and emits cosmetic actions only. It never launches subagents, approves tools, prompts models, or writes session history.
- Runtime state updates and human attention never wait for travel, bubbles, or animation.
- Speech and history entries require a canonical source. Never invent acknowledgments, test successes, meetings, or private reasoning. A status caption is not a quote.
- `DEMO` is explicitly synthetic and cannot perform live mutations. `LIVE` preserves the same prompt admission, delivery, and approval semantics as the TUI. Never auto-switch DEMO to LIVE.
- Assignment identity is scoped by real session, not by reusable agent definition.
- The client-internal fixture names are not wire names. Translate them to the real vocabulary before they reach the store; a fixture name inside a reducer is a defect.

## Verification

- `tests/run_tests.gd` must execute production modules and exit nonzero on a failed assertion.
- Run: `"$GODOT_BIN" --headless --path apps/office --script res://tests/run_tests.gd`.
- Import check: `"$GODOT_BIN" --headless --path apps/office --editor --import`.
- A parse success is not visual or functional correctness. Greybox is M1 only; fidelity claims require genuine captures and user review.
- Do not commit generated cache, export, or secret files. One owner at a time edits shared scene/tileset resources.
- Never stage, commit, reset, or switch branches without explicit authorization.
