# Agent instructions — YCoding Godot handoff

## Scope and authority

This file governs work **from this handoff pack**. It is not a replacement for the YCoding root guide. Read the actual checkout's root and scoped `AGENTS.md` files, current code/tests, Schema/Protocol and current docs before editing. The user has explicitly approved adding a Godot desktop surface while retaining the TUI and existing runtime; reconcile the existing TUI-only policy in a small documented change rather than bypassing it or treating it as a permanent prohibition.

Do not overwrite the existing root `AGENTS.md` with this file. Use [templates/ROOT_AGENTS_CHANGE.md](templates/ROOT_AGENTS_CHANGE.md) as a narrow edit brief. [templates/DESKTOP_AGENTS.md](templates/DESKTOP_AGENTS.md) is the scoped guide to adapt for the new native app directory.

## Product invariants

- Native Godot frontend only. Keep local HTTP/SSE; do not add Electron, a web bridge, Kafka, Redis, extra databases or a second agent runtime without a demonstrated requirement and an explicit decision.
- Preserve ordinary TUI-style prompting. The desktop displays orchestration; it does not manufacture it. Root agent configuration is not silently changed to roleplay a CEO.
- Runtime facts drive meaningful activity. Ambient motions are cosmetic, interruptible and contain no fabricated conversation or model calls.
- Speech/history must point to actual source messages or be visibly labeled synthetic in DEMO mode. A status caption is not an agent quote. A nod is allowed; an invented “Got it” reply is not.
- Execution never waits for a path, animation, bubble, chair, meeting or screen capture. The status panel reflects canonical state even while a brief visual reenactment completes.
- Use the repository's existing source-epoch, synchronization and prompt-retry semantics. The inspected global SSE feed is volatile; do not invent replay guarantees or assume `Last-Event-ID` replays history.
- The Godot client never opens or mutates YCoding's database directly. Display preferences may use a local config file; business history remains server-owned.
- “CEO”/manager is a visual role, not permission to override guardrails. Desktop approvals use the same choices and backend mediation as the TUI.

## Work hygiene

Record `git status --short` and HEAD before work. Preserve uncommitted/untracked changes. Never reset, clean, stash, stage, commit, push, switch branches or create a worktree unless explicitly asked. Do not install paid assets, incur model spend for tests, or change OS security settings without authorization. Never print or check in secrets. Do not dump environment variables, credential files or private transcripts into evidence.

First identify the correct checkout. `Althenia/ycoding` was inspected remotely; a similarly named Rust repo or a changed branch must be audited independently. Paths and example event labels in this pack are not evidence that local symbols exist.

## Implementation style

Use typed GDScript for the Godot client. Group scenes/scripts/resources by feature, use lowercase snake_case paths and PascalCase nodes, and centralize dependency wiring at the app root. Keep reducers/parsers ordinary testable objects; do not turn every concept into an autoload. Use a small state machine/director rather than a general workflow framework. Do not maintain two pathfinding engines; start with AStarGrid2D plus a small anchor reservation layer.

For TypeScript changes, obey the existing repository guide. Never edit generated clients/OpenAPI or managed resources by hand. Regenerate through owning commands only when public contracts change. A Godot read-model adapter must not require Core/Server implementation imports.

## Tests and evidence

For behavior changes: write a focused failing test, implement the smallest complete change and rerun the test plus adjacent coverage. Synthetic fixtures are appropriate at the external transport boundary; tests must exercise the production reducer/director/parser, not a duplicate implementation. Keep unit, transport integration, live-provider, visual and export evidence separate.

The inspected root `bun test` intentionally fails; discover affected-package commands. Never say a test, application boot, Godot scene, API integration or export passed unless it ran. Godot parse success alone is not visual quality or functional correctness. Check error output as well as process exit status.

Fidelity is a gate. Greybox art can validate M1 only. M2/M4 acceptance requires genuine Godot captures, coherent licensed art and user review. Do not substitute another Python-drawn animation, generated illustration or a screenshot of a design document for implementation footage.

## Session protocol

Read `tracking/HANDOFF.md`, `tracking/tasks.json` and the relevant milestone. Work on the first dependency-ready task; do not repeatedly replan the approved direction. Update task status and evidence, regenerate `TRACKING.md`/`TODO.md`, and append the session log. One owner controls shared `.tscn`/`.tres` resources to avoid conflicting edits. Parallel agents may work on independent parser tests, assets or documentation with explicit file ownership.

Stop at genuine credential, spend, destructive-action or visual-approval boundaries. Continue independent safe work when blocked. End each work session with: changed paths; exact checks/outcomes; unverified work; blocking decision; next task ID. Use `prompts/CONTINUE_PROMPT.md` for handoff. No hidden background work or “done” claims based only on plans.
