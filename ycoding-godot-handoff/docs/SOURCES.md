# Source and assumption ledger

Prepared 2026-09-15. Repository reads were pinned to the commit below. Public Godot documentation was consulted for API/authoring guidance; the actual installed engine must still be pinned locally. No latest-version number or performance benchmark is asserted by this handoff.

## Repository sources — inspected through GitHub

Base commit: `8544ea9fa55e0c86dcc09ac7d4b43dc7ee6dba10`.

- **R1 — architecture:** `https://github.com/Althenia/ycoding/blob/8544ea9fa55e0c86dcc09ac7d4b43dc7ee6dba10/docs/architecture.md` — read first 170 source lines; package ownership, TUI boundary and event/read-model direction.
- **R2 — agent guide:** `https://github.com/Althenia/ycoding/blob/8544ea9fa55e0c86dcc09ac7d4b43dc7ee6dba10/AGENTS.md` — inspected relevant visible sections on authority, scope, prompt/session rules, subagents and testing; not claimed as a complete local audit.
- **R3 — workspace guard:** `https://github.com/Althenia/ycoding/blob/8544ea9fa55e0c86dcc09ac7d4b43dc7ee6dba10/script/ycoding-workspace.ts` — explicit JS package allowlist and discovery.
- **R4 — root package:** `https://github.com/Althenia/ycoding/blob/8544ea9fa55e0c86dcc09ac7d4b43dc7ee6dba10/package.json` — declared Bun version/workspaces/scripts.
- **R5 — event protocol:** `https://github.com/Althenia/ycoding/blob/8544ea9fa55e0c86dcc09ac7d4b43dc7ee6dba10/packages/protocol/src/groups/event.ts` — global SSE route, volatility contract and connected epoch.
- **R6 — session protocol:** `https://github.com/Althenia/ycoding/blob/8544ea9fa55e0c86dcc09ac7d4b43dc7ee6dba10/packages/protocol/src/groups/session.ts` — read source lines 1–345; subagent DTOs/pagination, canonical snapshot and list/create/active routes. Other operations require further local inspection.

## Primary public technical sources

- **G1 — project organization:** `https://docs.godotengine.org/en/stable/tutorials/best_practices/project_organization.html` — scene-adjacent resources, naming and ignored import directories.
- **G2 — scene organization:** `https://docs.godotengine.org/en/stable/tutorials/best_practices/scene_organization.html` — composition root and reusable scene boundaries.
- **G3 — AStarGrid2D:** `https://docs.godotengine.org/en/stable/classes/class_astargrid2d.html` — grid path calculation API; not a promise of crowd avoidance.
- **G4 — TileMapLayer:** `https://docs.godotengine.org/en/stable/classes/class_tilemaplayer.html` — layer-based tile map scene structure.
- **G5 — multiple resolutions:** `https://docs.godotengine.org/en/stable/tutorials/rendering/multiple_resolutions.html` — pixel scaling/stretch tradeoffs; verify actual engine project settings.
- **G6 — HTTPClient:** `https://docs.godotengine.org/en/stable/classes/class_httpclient.html` — polling, response status and incremental body chunks.
- **G7 — SSE specification:** `https://html.spec.whatwg.org/multipage/server-sent-events.html` — line framing, UTF-8, fields and event dispatch; this does not add replay capabilities to YCoding.
- **G8 — Godot command line:** `https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html` — native executable usage, import/test/export and user arguments.
- **G9 — movie capture:** `https://docs.godotengine.org/en/stable/tutorials/animation/creating_movies.html` — engine-rendered Movie Maker capture; app fixture arguments are our own proposal.

## User-provided requirements

This conversation approved Godot option B, local HTTP, normal prompting, automatic workplace behavior, chat bubbles, conversation history and increased fidelity. Prior videos were concept mockups. No pixel-art pack, Godot project, local engine version, API credential or tested native build was provided as part of this handoff request.

## Original design proposals

Project placement, milestone gates, proposed resource budgets, presentation event names, task estimates, actor timing, UI layout and asset-selection process are design choices in this pack. They are not quoted as facts from the repository or engine documentation. Synthetic fixture messages are authored examples, not reports of work that occurred.
