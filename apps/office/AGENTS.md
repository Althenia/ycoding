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

## Designed dimensions and regions

Change a dimension here and nowhere else. Both designs have exactly one authority,
and a test pins each one, so an edit that breaks the design fails loudly instead
of appearing as a visual defect later.

**World** — `office/maps/hq/office_world.gd` owns the plan; `OfficeNavigation`
only rasterizes the blockers it is handed, and `main.tscn` carries no layout.

| Region | Extent |
| --- | --- |
| Map | 40 x 21 tiles = 1280 x 672 px, aspect 1.905 |
| Rows 0-1 | north wall band, pierced only by the doorway |
| Rows 2-9 | north room band (8 rows) |
| Rows 10-11 | central corridor (2 rows) |
| Rows 12-19 | south room band (8 rows) |
| Row 20 | south wall (solid, not drawn) |
| Cols 1-11, 13-25, 27-38 | three room columns, split by dividers at cols 12 and 26 |
| Col 0, col 39 | west and east walls |

Six rooms of equal height share one corridor, and every room opens onto it.
Dividers are solid across both room bands and open at the corridor, so the
corridor is the only route between columns. Near walls are cut away so the plan
stays readable. `test_layout.gd` proves the zones tile the floor exactly, the
shell is closed, the doorway is the only opening, and the corridor is clear.

**Shell** — `ui/shell/office_shell_layout.gd` owns the window frame;
`main.gd` applies it on start and on every resize.

| Region | Size |
| --- | --- |
| Margin | 16 |
| Gap between overlays | 12 |
| Sidebar | 264 wide, floats over the office |
| Prompt composer | derived, centred east of the sidebar |
| Chrome toggles | float top-right |
| Conversation drawer | floats above the composer |

There is no header. The office is full-bleed and the panels float over it, so the
world is never letterboxed inside a tiled frame. The composer centres in the area
east of the sidebar, which is what keeps the two from colliding on a narrow
window. `test_shell_layout.gd` proves the overlays tile without overlapping, the
composer clears the sidebar, the office region is exactly the world's aspect, and
neither overlay hides an anchor that something routes to.

## Truthfulness rules

- `OfficeDirector` consumes presentation state and emits cosmetic actions only. It never launches subagents, approves tools, prompts models, or writes session history.
- Runtime state updates and human attention never wait for travel, bubbles, or animation.
- Speech and history entries require a canonical source. Never invent acknowledgments, test successes, meetings, or private reasoning. A status caption is not a quote.
- `DEMO` is explicitly synthetic and cannot perform live mutations. `LIVE` preserves the same prompt admission, delivery, and approval semantics as the TUI. Never auto-switch DEMO to LIVE.
- In LIVE the client performs the mutations the UI exposes: prompting, model switching and answering human attention. Report a service refusal; never swallow it.
- A fabricated or placeholder value must be labelled as such wherever it renders. The synthetic model catalogue is marked in the composer; DEX/discovery values are never presented as the runtime's own.
- Reduced motion removes interpolation and the walk cycle, never an actor's arrival or its facing. An actor that is told to move still ends at its destination.
- A control that cannot act is disabled and states why. An enabled affordance that silently does nothing is a defect.
- Assignment identity is scoped by real session, not by reusable agent definition.
- The client-internal fixture names are not wire names. Translate them to the real vocabulary before they reach the store; a fixture name inside a reducer is a defect.

## Verification

- `tests/run_tests.gd` must execute production modules and exit nonzero on a failed assertion.
- Run: `"$GODOT_BIN" --headless --path apps/office --script res://tests/run_tests.gd`.
- Import check: `"$GODOT_BIN" --headless --path apps/office --editor --import`.
- A parse success is not visual or functional correctness. Greybox is M1 only; fidelity claims require genuine captures and user review.
- Do not commit generated cache, export, or secret files. One owner at a time edits shared scene/tileset resources.
- Never stage, commit, reset, or switch branches without explicit authorization.
