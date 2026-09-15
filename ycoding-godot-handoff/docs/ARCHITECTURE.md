# Architecture decisions

## Selected system

```text
Normal prompt / approval / interrupt
                 │
                 ▼
Godot prompt and control UI ──► YCoding gateway ──► Existing local HTTP API
                                                         │
                                                Existing YCoding runtime
                                                         │
                                                   Canonical state
                                                         │
Snapshots + volatile SSE ◄─────────────────────────────────┘
            │
        Adapter/sync
            │
       Office read model
         ┌──┴───────────────┐
         ▼                  ▼
 OfficeDirector       Inspector / history / transcript
         │
 Navigation + animations + ephemeral bubbles
```

No frontend execution authority. The root task policy, delegation, provider calls, permissions, durable state and worktree behavior remain in YCoding. Godot owns layout, display profiles, paths, actor animation and UI-local preferences.

## Meaningfully different behavior approaches

| Approach | Idea | Best when | Main weakness |
|---|---|---|---|
| LLM-controlled office | Add walk/talk/coordinate tools to the agent | A roleplay simulation is the actual product | Wastes inference, changes user workflow, creates competing truth |
| Runtime-driven presentation — selected | Map existing facts to deterministic visual actions | A truthful, lively coding workspace | Requires explicit mapping and stale-action handling |
| Fixed workflow director | Force plan → dev → QA → manager steps | A separate product promises a rigid process | Misrepresents flexible TUI behavior; inappropriate default here |

The selected approach combines deterministic semantic choreography with inexpensive ambient simulation. It does not add a second intelligent “office agent.”

## Chosen simplicity boundaries

**Transport:** local HTTP plus existing SSE. Use the service's current auth/discovery policy; do not disable it merely because the connection is local. No new capability-token system, WebSocket protocol, generic IPC proxy or broker is required for this scope.

**Read model:** in-memory, bounded and rebuildable. Prefer SSE as an invalidation signal plus coalesced canonical reads until verified delta semantics justify more. Do not reproduce the backend's whole event reducer in GDScript unnecessarily.

**Navigation:** one grid-based AStarGrid2D implementation suits an orthogonal office. It supplies path calculation, not magical collision avoidance. Add only the small anchor occupancy/yield behavior the 4–12 actor scenes need. A NavigationAgent2D/navmesh design is a later alternative if grid movement fails an actual requirement [G3].

**App UI:** Godot controls, a basic transcript/tool-output/diff inspector and separate pixel-world viewport. Full PTY and editor-like code tools are deferred. There is no embedded Chromium compromise in MVP.

**Persistence:** use existing canonical service APIs for all session/history data. A local configuration file can store office profile/desk preferences, theme, reduced motion, last selected workspace and panel size. It must not become a second chat, permission or run store.

**Testing:** deterministic synthetic fixtures drive the same adapter/director boundary, not duplicated demo-only animation logic. Local integration tests use the real transport against an isolated test service. Live-provider tests require explicit permission to spend.

## Scope ownership

Godot may need a small server read-model addition if the existing API cannot expose an irreducible fact needed for faithful history or status. First prove the gap using current code/tests and record it. Add the fact through Schema/Protocol/Core/Server ownership as appropriate and regenerate clients. Do not persist game coordinates or cosmetic bubble timing in canonical schemas.

## Biggest architectural failure modes

One avatar keyed only by agent type overwrites concurrent sessions. A global event ID treated as a durable cursor misses history after disconnect. Delayed animation claims a cancelled worker is still coding. An inferred “tests passed” label overstates a generic successful shell call. A replay-only fake chat becomes indistinguishable from live communication. Each is an explicit acceptance test in [TEST_PLAN.md](TEST_PLAN.md).

## Convergence

**Best candidate:** native Godot client with a small verified HTTP adapter, snapshot-first read model and deterministic OfficeDirector.

**Why:** preserves the user's TUI workflow and YCoding ownership while giving the workspace the art and interaction tooling it needs.

**Main risk:** art/animation scope and missing semantics tempt the implementation to fake activity.

**Open question:** local checkout/toolchain and exact wire details, resolved by M0 rather than guessed.

**Next experiment:** the accepted-quality two-actor Godot scene using labeled synthetic events, followed by a real prompt path through the existing service.
