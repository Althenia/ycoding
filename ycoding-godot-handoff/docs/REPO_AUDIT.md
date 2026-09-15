# Repository audit used to prepare this pack

**Inspection date:** 2026-09-15. **Remote:** `Althenia/ycoding`. **Branch observed:** `main`. **Commit pinned for file reads:** `8544ea9fa55e0c86dcc09ac7d4b43dc7ee6dba10`.

This was a source read through the connected GitHub tool, not a clone/build/test or an inspection of the user's uncommitted local changes. It does not establish that the user's local checkout has the same implementation.

| Source | Observation | Consequence |
|---|---|---|
| R1: `docs/architecture.md` | Current documentation calls the product TUI-only; Core independent of UI; Protocol/Server/Client own boundaries | Adding Godot needs a deliberate supported-surface change, not another runtime |
| R2: root `AGENTS.md` | Desktop/web restoration currently prohibited; explicit current user request must be reconciled; preserve unrelated changes; verify code/tests; background subagents are durable child sessions | Narrow guide edit; no wholesale replacement; retain runtime/permission authority |
| R3: `script/ycoding-workspace.ts` | Explicit allowed JavaScript package names discovered under `packages/`; unexpected packages fail | Preserve the allowlist. A native `apps/office` addition needs explicit policy/check coverage, not an unnecessary JS wrapper |
| R4: `package.json` | Bun/TypeScript workspace, `bun@1.4.2`, package-scoped checks; root test script deliberately exits unsuccessfully | Reuse local declared toolchain and affected-package tests; do not apply historical Rust checkout instructions |
| R5: `packages/protocol/src/groups/event.ts` | `GET /api/event` SSE is explicitly volatile; disconnections miss events and slow-consumer overflow fails stream; `server.connected` carries source epoch | No assumed replay; stale/resync UI and snapshot recovery mandatory |
| R6: `packages/protocol/src/groups/session.ts` | `session.snapshot` returns projected messages, source epoch and exact watermark; subagent launch separates description/prompt; child list uses pagination; list/create/active routes present | Build source-linked history and scoped identity; audit local DTO/sync semantics before coding |

## Not verified here

Exact installed Godot version; local branch/uncommitted changes; service auth token/port/registration mechanism; actual prompt route/payload in the local build; raw event payload mapping; current subagent tool behavior during a live request; exact message/report linkage; complete approval endpoint shapes; Godot project existence; asset licenses; performance; successful tests or exports.

These are implementation audit tasks, not reasons to fabricate details. `contracts/wire-audit.json` starts incomplete by design and must be populated from local evidence. The normal user prompt workflow and no-new-runtime boundary remain valid regardless of TypeScript module drift.

## Required local migration

Verify and edit the actual root README, product-direction, architecture and contributor guidance where they claim TUI-only exclusivity. State that Godot desktop is approved/in development while TUI remains supported. Add a scoped native app guide/check when the app exists. Keep historical unsupported surfaces excluded. Do not rewrite every old document or restore a removed Electron/browser product.

Full stable source locators are in [SOURCES.md](SOURCES.md). Facts above describe the inspected snapshot; implementation uses the current local source/tests as authority.
