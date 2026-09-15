# Project layout and ownership

**Proposed target:** native Godot app in `apps/office/` within the existing repository. This tree describes work to create; it is not the content of this handoff ZIP and is not claimed to exist yet.

## Placement alternatives

| Approach | Idea | Best when | Main weakness |
|---|---|---|---|
| Native app in the same repo — chosen | `apps/office/` is an independent Godot project consuming the service | Protocol changes and app work should be reviewed together | Root TUI-only policy must deliberately change |
| Separate desktop repo | Standalone Godot project pinned to a YCoding API version | Independent release/ownership is necessary | Cross-repo contract drift and more release coordination |
| Bun wrapper package | `packages/desktop` holds scripts around Godot | Existing monorepo build tasks materially need package participation | Extra wrapper/allowlist plumbing with little initial value |

Do not hide a new product from the existing policy checker by choosing `apps/`. Update the supported-surface policy explicitly and add appropriate native-project verification. Keep `package.json` workspaces unchanged unless a real JS package is added.

## Repository tree

```text
ycoding/
├── AGENTS.md                         # existing; narrow desktop policy edit
├── README.md                         # existing; supported surfaces/status
├── package.json                      # existing Bun workspace; optional root run shortcuts
├── packages/                         # existing runtime/protocol/TUI packages, preserved
├── script/                           # existing checks; add only scoped native checks as needed
├── docs/
│   ├── architecture.md               # ownership/dependency boundary update
│   ├── product-direction.md          # TUI + Godot direction; honest implementation status
│   └── office/                       # this handoff, if deliberately copied here later
└── apps/
    └── office/
        ├── AGENTS.md                 # scoped native-client guide
        ├── project.godot
        ├── export_presets.cfg        # no credentials
        ├── .gitignore
        ├── app/
        │   ├── main.tscn
        │   ├── main.gd               # composition root, mode, lifecycle
        │   ├── app_config.gd
        │   └── app_theme.tres
        ├── integration/
        │   ├── ycoding_gateway.gd    # public client-facing operations/signals
        │   ├── http_transport.gd     # regular HTTP requests; existing auth
        │   ├── sse_stream.gd         # incremental transport/framing
        │   ├── demo_transport.gd     # synthetic playback only
        │   ├── event_mapper.gd       # verified wire facts → presentation changes
        │   └── snapshot_sync.gd      # epoch/generation/refresh ownership
        ├── state/
        │   ├── office_store.gd       # bounded read model, never durable authority
        │   ├── actor_identity.gd
        │   └── conversation_projection.gd
        ├── office/
        │   ├── director/
        │   │   ├── office_director.gd
        │   │   └── interaction_queue.gd
        │   ├── navigation/
        │   │   ├── office_navigation.gd
        │   │   └── anchor_registry.gd
        │   ├── maps/hq/
        │   │   ├── hq.tscn
        │   │   ├── hq.gd
        │   │   ├── hq_tileset.tres
        │   │   └── hq_layout.tres
        │   ├── actors/
        │   │   ├── employee.tscn
        │   │   ├── employee.gd
        │   │   ├── employee_animation.gd
        │   │   └── profiles/         # display identity, role, art; no model secrets
        │   ├── props/
        │   │   ├── desk.tscn
        │   │   ├── door.tscn
        │   │   ├── coffee_station.tscn
        │   │   └── interaction_anchor.gd
        │   └── art/                  # selected shared tiles/sprites + provenance
        ├── ui/
        │   ├── shell/
        │   ├── prompt/
        │   ├── workspace/
        │   ├── agent_inspector/
        │   ├── conversation/
        │   ├── approval/
        │   ├── session/
        │   └── speech_bubble/
        ├── tests/
        │   ├── run_tests.gd
        │   ├── unit/
        │   ├── integration/
        │   ├── fixtures/
        │   └── visual/               # scene/test harness, not generated capture files
        ├── demo/
        │   ├── demo_director.gd       # fixture clock; never a second choreography engine
        │   └── scenarios/
        ├── tools/
        ├── licenses/
        └── addons/                   # optional, version-pinned and justified
```

Create directories when their feature is implemented, not hundreds of empty placeholders. Colocate feature scenes/scripts/resources; keep shared code only where genuinely reused. These choices align with Godot's scene/project organization guidance [G1, G2 in SOURCES](docs/SOURCES.md).

## Main scene

```text
Main (Node)
├── Gateway (Node)
├── SnapshotSync (Node)
├── OfficeDirector (Node)
├── Shell (Control, full-window)
│   ├── WorkspacePanel
│   ├── OfficeViewportContainer
│   │   └── OfficeViewport (SubViewport)
│   │       └── HQ (Node2D)
│   │           ├── Floor (TileMapLayer)
│   │           ├── GroundDecorations (TileMapLayer)
│   │           ├── YSortedWorld (Node2D)
│   │           │   ├── FurnitureBases
│   │           │   └── Employees
│   │           ├── Foreground (Node2D)
│   │           ├── Anchors
│   │           └── Camera2D
│   ├── ScreenSpaceBubbleOverlay
│   ├── PromptPanel
│   ├── InspectorDrawer
│   └── ConnectionBanner
└── UiTimers
```

Use a world viewport so pixel-world scale is independent of crisp native-resolution text. Anchored bubbles in screen space must use the viewport/camera transform, clip at world edges and never cover critical controls. Transparent zones must not intercept selection. Some furniture may need split back/front sprites; one giant Y-sorted furniture layer is not a substitute for correct per-object depth.

`Employee` is a `CharacterBody2D` root with a foot-origin collision shape, visual sprite/animation child, selection area and display anchors. Do not create a CharacterBody2D inside another root while assuming the outer node moves itself. AStarGrid2D computes routes; movement code follows them. Dynamic avoidance/anchor reservations are separate responsibilities [G3, G4].

## Dependency rules

`wire transport → adapter/sync → read model → director + UI → actor animation`.

The prompt/approval UI calls a narrow gateway. The director cannot call model/delegation APIs. Actors know nothing about service DTOs. Asset IDs and desk coordinates never enter canonical agent/session schemas. Reusable components emit signals rather than reaching into unrelated scene trees. Keep app-scoped dependencies as regular nodes/objects; use autoload only for a proven app-wide lifecycle requirement.

## Generated and local state

Ignore `.godot/`, local credentials, logs, exports and raw captures. Track source `.tscn`/`.tres`, source images and version-appropriate persistent UID/import metadata according to the pinned engine; do not blanket-ignore `.uid`. Export templates and downloaded paid sources are not automatically redistributable. `user://` may hold view preferences, not a shadow execution or conversation database. See [assets](docs/ASSETS.md) and [local setup](docs/LOCAL_SETUP.md).
