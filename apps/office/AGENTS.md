# Native Godot desktop client

Adapted from the approved YCoding Office handoff. The repository root guide still applies.

## Authority

YCoding remains the sole authority for prompts, sessions, agents, provider/tool execution, permissions, history, and persistence. This project is only a client. Use the verified local HTTP/SSE API; never import backend implementation modules or open its database.

The real wire vocabulary and routes live in the runtime itself: event names in `packages/schema/src/session-event.ts`, `packages/schema/src/event-manifest.ts` and the other `packages/schema/src/*-event.ts` inventory files, and HTTP routes in `packages/protocol/src/groups/`. Treat those as the wire reference. Do not invent route names, event names, or DTO fields.

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
| Map | 41 x 23 tiles = 1312 x 736 px, aspect 1.783 |
| Rows 0-1 | north wall band, pierced only by the doorway at cols 9-10 |
| Rows 2-10 | north room band (9 rows) |
| Rows 11-12 | central corridor (2 rows) |
| Rows 13-21 | south room band (9 rows) |
| Row 22 | south wall (solid, not drawn) |
| Cols 1-12 | reception, both bands, split by nothing: the west column |
| Col 26 | the only divider, solid across both bands and open at the corridor |
| Cols 13-25, 27-39 | product/engineering (west of the divider) and ops/CEO (east of it) |
| Col 0, col 40 | west and east walls |

`ZONES` in `office_world.gd` is the authority: reception north and south (cols 1-12,
both bands), product (cols 13-25 north), engineering (cols 13-25 south), ops (cols 27-39
north), CEO (cols 27-39 south), and the corridor (cols 1-39, rows 11-12) between them.
So there are FOUR rooms plus reception and the corridor, not six rooms, and the plan is
41x23 with a SINGLE divider, not 40x21 with two. Reception carries no anchors: it is the
circulation band the doorway opens into, so nothing routed to lives there. `test_layout.gd`
proves the zones tile the floor exactly, the shell is closed, the doorway is the only
opening, and the corridor is clear.

**Shell** — `ui/shell/office_shell_layout.gd` owns the window split;
`main.gd` applies it on start and on every resize.

| Region | Size |
| --- | --- |
| Sidebar | 264 wide (grows to its content floor at larger text), a docked column at x=0 spanning the content height |
| Office | the largest world-aspect rect that fits the CONTENT area east of the sidebar, centred in it |
| Prompt composer | `min(840, visible_office_width - 2*gutter)`, centred in the visible office, floated above the bottom |
| Gutter | 24 normally, 16 in the compact layout |
| Chrome toggles | `maxf(TOGGLES_W, ChromeToggles.cluster_width(scale))` wide, top-right, but its region is capped to the room beside the sidebar; the cluster wraps into as many rows as fit (`ChromeToggles.wrap_to`) so a large text scale on a narrow window costs rows rather than overlapping the roster |
| Contextual drawer | a declared overlay (`"drawer"` in `OVERLAYS`), right-hand side, width capped at `DRAWER_MAX_SHARE` of the visible office and height stopping above the composer |

There is no header, and the sidebar does NOT float: the window is split into two
regions, so the office begins exactly at the sidebar's right edge and the sidebar covers
no office pixels at all. The composer and the contextual drawer float, because they belong
to the office they describe. The sidebar carries the mode badge, the sessions, the team
and the agent selector, and it is the app's persistent left navigation rather than a panel
that can be lost behind the world.

One consequence is deliberate and should not be "fixed" by distorting the map: a docked
column makes the content area narrower than the world's aspect, so the office bands
vertically for the aspect fit (about 76% of the content height at 1280x720) and the
backdrop shows through the band. The office still spans the full content width, and it
keeps the world's shape so the anchor-occlusion guarantees stay true.

**Routes** — `ui/shell/office_route.gd` owns the closed set of surfaces (`office`,
`sessions`, `statistics`) and `ui/shell/office_router.gd` owns which one is showing. The
rail's rows only ASK for a route; the composition root routes. Navigating changes what is
displayed and nothing else: it never stops the service, cancels work, changes the prompt
target, or clears attention, and the root holds no transport reference in the router for
it to reach. `OfficeRoute.shows_world()` decides whether the office and composer are
visible, so the detail routes get the whole content region.

`test_shell_layout.gd` proves the sidebar touches the left edge and spans the content
height, the office never intersects it, the composer centres in the visible office and
clears the sidebar, the office region is exactly the world's aspect, the cluster reserves
the width its own labels need, and no floating surface hides an anchor that something
routes to. The toggle cluster and the drawer are also asserted never to overlap the
sidebar or the composer at every supported scale and window. `test_routes.gd` proves
navigation leaves a real store's work state, epoch and staleness untouched and keeps
attention pending on every route; `test_drawer.gd` proves the drawer is bounded, that
Escape releases the innermost thing first, that closing returns focus to the composer, and
that a draft survives closing by either path.

## Truthfulness rules

- `OfficeDirector` consumes presentation state and emits cosmetic actions only. It never launches subagents, approves tools, prompts models, or writes session history.
- Runtime state updates and human attention never wait for travel, bubbles, or animation.
- Speech and history entries require a canonical source. Never invent acknowledgments, test successes, meetings, or private reasoning. A status caption is not a quote.
- A normal launch enters `LIVE`: it reads the local service registration and attaches when one is present, and otherwise states the missing registration rather than fabricating an office. `DEMO` is explicitly synthetic, cannot perform live mutations, and is reachable only by an explicit user action. `LIVE` preserves the same prompt admission, delivery, and approval semantics as the TUI. Never auto-switch DEMO to LIVE.
- In LIVE the client performs the mutations the UI exposes: prompting, model switching and answering human attention. Report a service refusal; never swallow it.
- A fabricated or placeholder value must be labelled as such wherever it renders. The synthetic model catalogue is marked in the composer; DEX/discovery values are never presented as the runtime's own.
- Composer state belongs to the work it is aimed at, never to the window. The target it names is the folder its prompt would actually reach; its model is the target's own unless the user chose one for that target; and a prompt id is scoped to `(target, text)`, so the same words aimed at another project are a new input rather than a retry the service reconciles.
- The `x-ycoding-directory` header carries a URI-ENCODED path. The service runs `decodeURIComponent` on that header (packages/server/src/location.ts), so a raw path corrupts any folder whose name contains a percent sign and makes a non-ASCII folder name fail with HTTP 500. The workspace header is a plain id and is not encoded. Assert this on the encoder directly: a stub transport never sees the headers Godot puts on the wire, so a test through a double reports a clean pass regardless.
- The transcript renders through inert plain labels only, and that is a boundary rather than a limitation: a message can contain shell-shaped markup from anywhere, so no control that renders markup may be added, and markdown is deliberately NOT rendered. Detail is carried as text - a fenced block as its own row with its language; a tool result with its output, cut and MARKED past a bound; the files a message names; an unclosed fence treated as prose so nothing the runtime sent is lost. Private reasoning is excluded from every kind.
- The transcript is read from the service's own message list, not only from events the client happened to observe. `ConversationHistory` owns the projection and the read state on `ConversationApi`; the drawer renders canonical rows and the live observations merged, with a durable row displacing a remembered one for the same message. Private reasoning is dropped at the projection and never rendered as a message; a runtime status is labelled as one. A read is keyed to the session it was started for, so an answer for a session the user has left is never installed, and a failed read leaves the history unread with its reason rather than showing stale rows.
- The inspector states the assignment's task and its place in the family, in both directions: a child names its parent, a parent names its direct children, and sessions are named by id as well as display name because an agent configuration is reusable and two sessions sharing one are two actors. Use the direct-children accessor for that; the family accessor returns the whole tree including the session and its ancestors. A row opens its exact source, which for a delegation is the child it was handed to.
- Human attention is a FAMILY property, not a session's: the drawer shows the family thread, so it must offer every request that family is waiting on, and each card names the session it belongs to. It stays reachable on every route, because a blocked session does not stop being blocked when the user looks at another page. A control offered there names its own subject rather than resolving the current selection.
- A shell view is READ-ONLY detail about a command the runtime already ran: the `session.shell.started`/`ended` events carry `Shell.Info`, and `shell.list`/`shell.get`/`shell.output` expose the captured output pageable by cursor. Never add an input control to it and never present a page or a truncated capture as the whole output. The status is the runtime's; classify every declared status rather than testing for `running`, so a status this build does not know is not treated as finished. An `ended` event updates the shell it names instead of appending a second row for one command.
- A test must never write a real preference. Redirect both `project_ledger.file_path` and `view_state.file_path` to throwaway paths before a test selects a folder. Verify that real preference existence and bytes remain unchanged; do not delete a real preference to establish the baseline.
- A location-scoped route is re-read whenever the location changes, and the read is started rather than waited on so choosing a folder never stalls the window. While the answer is unknown nothing is carried over from the previous location: an answer for a folder the user has left does not describe where they are, and starting a new read is what discards the older one.
- Reduced motion removes interpolation and the walk cycle, never an actor's arrival or its facing. An actor that is told to move still ends at its destination.
- A control that cannot act is disabled and states why. An enabled affordance that silently does nothing is a defect.
- Route runtime configuration edits through `ConfigApi` and the service's read/preview/commit operations. Offer only Global and Project write scopes; keep Folder, Session and virtual-source ownership distinct. Capture the key, draft, scope and revision when preview starts, invalidate Apply when any changes, and adopt the service's settled readback after commit. Reject redacted placeholders at every nesting depth before issuing a request. Prove the visible controls reach the selected scope with root-level interaction tests.
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
- A test may `await t.process_frame`; the runner builds its suites in `_init`, runs them in `_initialize`, and settles frames before summarising, so an assertion after an await is counted. Do not run suites from `_init` or call `quit()` there: either leaves every awaited continuation suspended and silently uncounted while the suite still reports PASSED.
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
