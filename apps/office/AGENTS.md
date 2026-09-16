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
- Keyboard shortcuts live in `app/shortcuts.gd` as a pure event-to-intent map. The registry never grabs input and never touches a node; `app/main.gd` owns what an intent does. Every shortcut carries the shortcut modifier because the arrows and WASD already pan the view, and the viewport ignores a modified key so one keystroke cannot pan and toggle at once. Typing wins: while the composer holds the caret only Escape is acted on.
- Colours come from `OfficePalette` through `OfficeTheme`, never from a literal. A palette mode changes contrast only: no state may become invisible by switching modes.
- Font sizes go through `OfficeTheme.font`, which applies the interface text scale. The scale is a FONT factor, not the window's content scale, because a content scale would magnify the office art along with the text.
- The text scale is bounded by `UiScale` and a request outside the range is clamped. Past the ceiling the shell cannot lay itself out, and a clipped panel hides state instead of enlarging it.
- A layout metric derived from text (a panel's content floor, a row's height) grows with the text scale; spacing between overlays does not. Re-apply the regions AFTER a rescale, or panels are placed against the sizes they had a moment ago.
- Assignment identity is scoped by real session, not by reusable agent definition.
- The client-internal fixture names are not wire names. Translate them to the real vocabulary before they reach the store; a fixture name inside a reducer is a defect.

## Verification

- `tests/run_tests.gd` must execute production modules and exit nonzero on a failed assertion.
- Run: `"$GODOT_BIN" --headless --path apps/office --script res://tests/run_tests.gd`.
- Import check: `"$GODOT_BIN" --headless --path apps/office --editor --import`.
- A parse success is not visual or functional correctness. Greybox is M1 only; fidelity claims require genuine captures and user review.
- Do not commit generated cache, export, or secret files. One owner at a time edits shared scene/tileset resources.
- Never stage, commit, reset, or switch branches without explicit authorization.

## Release artifacts

- Build a release artifact with `tools/build-release.sh --version <X.Y.Z> --target <target> --outdir <dir>`. Targets are `darwin-universal`, `linux-x64`, and `windows-x64`; the script requires a Godot 4.7.x binary and its export templates, overridable with `GODOT_BIN`.
- Archive names and their layouts are a contract with `script/install.sh` and with the release workflow. Changing a name or a layout requires changing every consumer in the same change.
- `config/version` in `project.godot` is the only place the build script sets a version, and it restores the file afterwards. The export presets leave `application/version` empty so they inherit it; a literal in a preset ships a build whose identity disagrees with its filename.
- A release build reports the version it was built with. Verify by reading `CFBundleShortVersionString` from the exported macOS bundle or by finding the version string in the exported data pack, not by running the binary's `--version`, which prints the engine version.
- The macOS artifact is a disk image built with `hdiutil`, holding the bundle and a shortcut to Applications so it can be dragged in. `hdiutil` and `ditto` have no equivalent off macOS, so the `darwin-universal` target must be built on macOS; the Linux and Windows targets build anywhere. The installer mounts the image, copies the bundle out with `ditto`, and releases the image on every path including failure.
- Signing and notarization stay disabled in the presets (`codesign/codesign=0`, `notarization/notarization=0`), so a bundle a user downloaded may be quarantined by Gatekeeper until they allow it. Do not strip the quarantine attribute on a user's behalf; the installer states the situation instead.
- Enabling signing needs three things that do not exist in the repository: an Apple Developer ID Application certificate with its password, an App Store Connect API key (or Apple ID credentials) for notarization, and those values stored as release secrets. Then set the `codesign/*` and `notarization/*` preset options and add the certificate import and notarization steps to `.github/workflows/release.yml`. Until then a release artifact is unsigned and that is the accurate description of it.
- `tools/verify.sh` and `tools/verify-integration.sh` are the app's test gates; a release build does not replace them.
