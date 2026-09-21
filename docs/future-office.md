# Future office (proposal)

**Proposal only. This document is not a description of shipped behavior.** The
current product ships no office surface: the Godot client under `apps/office/` was
removed, and nothing in this repository implements the feature below. Keep this file
out of the published documentation set until an approved implementation exists.

## Product idea

An 8-bit, Gather-style office renders YCoding agents and their observable states as
characters in a shared room. Example state mappings:

| State                     | Presentation                                                  |
| ------------------------- | ------------------------------------------------------------- |
| idle                      | desk or standing                                              |
| planning                  | whiteboard                                                    |
| coding                    | workstation                                                   |
| testing                   | test station                                                  |
| researching               | library or research area                                      |
| waiting for approval      | visible pending indicator                                     |
| agent-to-agent delegation | character walks to the receiving agent, speech bubble appears |
| completion                | character returns and reports                                 |

## Architecture rule

The office is a projection of real YCoding state. It is never the workflow authority:
no user action and no agent decision is dispatched from the office first.

```
YCoding events/state -> workspace projection -> projected agents -> renderer
```

A projection type comparable to:

```ts
type WorkspaceAgentState = "idle" | "planning" | "coding" | "testing" | "researching" | "waiting" | "talking" | "error"
```

## Renderer

Preferred default for a browser client: a tilemap renderer inside the existing web
shell, with the host shell retaining navigation, transcript/chat, sessions, files,
terminal, approvals and settings, and the renderer owning only the pixel scene,
tilemap, sprites, animation, camera/input and spatial interaction. Do not reintroduce
a native engine client for this feature.

## Requirements carried over from the retired prototype

- A room is kept only when a real signal sends an actor there.
- A control that cannot act is disabled and states why.
- Every visual claim must be traceable to an observable event; the office must not
  invent, smooth over or anticipate session state.
- The office adds no execution authority and no second source of truth for session,
  agent or permission state.

## Reference material

- Archived pixel art and its provenance: `assets/office-source-art/`.
- Retired prototype implementation, UX decisions and state vocabulary: the `office`
  branch at `bbd04241e101211188011c1b1455d12e7b4546ce`, and Git history at
  `6aece46e0583f2c5db667c58f02786bcc66e3b7b`. Inspect them before designing; extract
  behavior and state requirements, not engine coupling.
- Engine-independent protocol and configuration work from the same branch stays on
  that branch until it is deliberately adopted.

## Out of scope

- Implementing the office in the current milestone set.
- Reinstating Godot, GDScript, exported desktop bundles or a desktop launcher.
- Any remote-control, authorization or persistence surface that exists only for the
  office.
