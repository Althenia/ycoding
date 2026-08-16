# Explicit Copy and Silent Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make passive terminal selection highlight-only and prevent proactive subagent bookkeeping narration unless the user explicitly requests status.

**Architecture:** Keep selection behavior centralized in `packages/tui/src/util/selection.ts` and root event routing in `packages/tui/src/app.tsx`; remove mouse-triggered clipboard writes while preserving explicit keyboard copy. Keep durable subagent state unchanged and modify only model-facing tool and TeamView wording in Core so the model retains orchestration data without volunteering status counts.

**Tech Stack:** TypeScript, SolidJS/OpenTUI, Effect, Bun test, Prettier.

## Global Constraints

- Mouse release and right-click never write passive terminal selections to the clipboard.
- `Cmd+C` copies the active selection on macOS; `Ctrl+C` copies it elsewhere.
- `Esc` clears selection; no-selection `Ctrl+C` remains available to normal TUI commands.
- `terminal.copy_on_select` remains decodable but is deprecated and behaviorally ignored.
- Subagent status is silent unless the user explicitly asks for it.
- Durable TeamView, orchestration state, notifications, sidebar, and subagent execution remain unchanged.
- Blocking subagent failures may still be reported as task blockers.

---

### Task 1: Explicit keyboard-only selection copy

**Files:**

- Modify: `packages/tui/src/util/selection.ts`
- Modify: `packages/tui/src/app.tsx`
- Create: `packages/tui/test/util/selection.test.ts`
- Modify: `packages/tui/test/app-lifecycle.test.tsx`
- Modify: `docs/configuration.md`

**Interfaces:**

- Consumes: OpenTUI key events with `name`, `ctrl`, `meta`, and `super` modifiers; existing `Selection.copy(...)`.
- Produces: `Selection.handleSelectionKey(renderer, toast, event, clipboard, platform)` that consumes only explicit copy or Escape when a selection exists.

- [x] **Step 1: Write failing selection-key tests**

Create tests proving macOS `meta+c`, non-macOS `ctrl+c`, Escape, and no-selection fallthrough. Use fake renderer, clipboard, toast, and event objects; assert clipboard writes and event consumption exactly.

- [x] **Step 2: Run the focused test and verify failure**

Run:

```bash
cd packages/tui
bun test test/util/selection.test.ts
```

Expected: FAIL because `handleSelectionKey` does not accept platform input and does not recognize macOS Command.

- [x] **Step 3: Implement platform-aware explicit-copy handling**

Update `SelectionKeyEvent` to include optional `meta` and `super`. Add a platform argument and recognize:

```ts
const copy =
  platform === "darwin" ? (event.meta || event.super) && event.name === "c" : event.ctrl && event.name === "c"
```

Do not consume ordinary `Ctrl+C` on macOS. Preserve Escape clearing and focused-selection behavior.

- [x] **Step 4: Remove passive mouse-copy routing**

In `App`:

- register the selection key interceptor whenever a selection exists, independent of `copy_on_select`;
- pass `process.platform` to `handleSelectionKey`;
- remove `copyOnSelectEnabled`;
- remove root `onMouseDown` right-click copy;
- remove root `onMouseUp` copy.

Do not alter explicit click-to-copy controls in dialogs.

- [x] **Step 5: Add root-render regression coverage**

Update the lifecycle/source test to assert the application root no longer wires passive mouse selection to `Selection.copy`, while keyboard interception remains registered.

- [x] **Step 6: Document compatibility behavior**

In `docs/configuration.md`, retain `copy_on_select` in the schema example but label it deprecated and ignored. State that passive selection highlights only and explicit copy is `Cmd+C` on macOS or `Ctrl+C` elsewhere.

- [x] **Step 7: Run focused and full TUI verification**

Run:

```bash
cd packages/tui
bun test test/util/selection.test.ts test/app-lifecycle.test.tsx
bun run typecheck
bun test
```

Expected: all pass.

- [x] **Step 8: Commit selection behavior**

```bash
git add packages/tui/src/util/selection.ts packages/tui/src/app.tsx packages/tui/test/util/selection.test.ts packages/tui/test/app-lifecycle.test.tsx docs/configuration.md
git commit -m "fix(tui): require explicit selection copy"
```

---

### Task 2: Silent subagent bookkeeping narration

**Files:**

- Modify: `packages/core/src/tool/subagent.ts`
- Modify: `packages/core/src/session/orchestration.ts`
- Modify: `packages/core/test/tool-subagent.test.ts`
- Modify: `packages/core/test/session-orchestration.test.ts`
- Modify: `docs/runtime.md`

**Interfaces:**

- Consumes: `SubagentTool.description`, immediate launch output, and `SessionOrchestration.renderTeamView(tasks)`.
- Produces: model-facing text that keeps TeamView JSON available while explicitly forbidding proactive status narration.

- [x] **Step 1: Write failing wording tests**

Add assertions that:

- the tool description says orchestration status is internal unless explicitly requested;
- the launch result does not promise proactive user notification;
- TeamView text contains the durable JSON and an internal-use/silence instruction;
- existing child IDs and states remain present.

- [x] **Step 2: Run focused Core tests and verify failure**

Run:

```bash
cd packages/core
bun test test/tool-subagent.test.ts test/session-orchestration.test.ts
```

Expected: FAIL on old “working in the background” and notification wording.

- [x] **Step 3: Rewrite the subagent tool description and launch result**

Use concise model-facing wording:

- launch result: child launched; no polling required;
- silence rule: do not mention launch, running/completed/failed counts, or routine state changes unless the user explicitly asks for subagent status;
- blocker exception: report a failure only when it prevents the requested outcome.

Keep structured output, session ID, background execution, progress steering, and durable settlement unchanged.

- [x] **Step 4: Add an internal-use TeamView preamble**

Change the TeamView prefix to state that the JSON is internal orchestration context and must not be surfaced unless the user explicitly requests subagent status. Keep the JSON shape, ordering, byte bound, and volatile-message placement unchanged.

- [x] **Step 5: Update existing tests without weakening durable assertions**

Replace expectations for “working in the background” with the new concise launch text. Assert TeamView JSON still decodes and includes the same child states and IDs.

- [x] **Step 6: Document runtime policy**

Add a short section to `docs/runtime.md`: subagent state remains visible in the TUI and available to the model for coordination, but the parent does not proactively narrate bookkeeping unless explicitly asked.

- [x] **Step 7: Run focused and full Core verification**

Run:

```bash
cd packages/core
bun test test/tool-subagent.test.ts test/session-orchestration.test.ts
bun run typecheck
bun test
```

Expected: all pass.

- [x] **Step 8: Commit narration behavior**

```bash
git add packages/core/src/tool/subagent.ts packages/core/src/session/orchestration.ts packages/core/test/tool-subagent.test.ts packages/core/test/session-orchestration.test.ts docs/runtime.md
git commit -m "fix(core): keep subagent status internal"
```

---

### Task 3: Final repository verification

**Files:**

- Modify: `docs/superpowers/plans/2026-07-27-explicit-copy-silent-subagents.md` only to mark completed steps.

**Interfaces:**

- Consumes: Task 1 and Task 2 commits.
- Produces: verified clean repository state.

- [x] **Step 1: Run repository gates**

```bash
bun run typecheck
bun run lint
bun run lint:effect-patterns
bun run check:ycoding-workspace
bun run check:ycoding-brand
bun run build:tui
bun run smoke:tui
bun run smoke:runtime
git diff --check HEAD~2..HEAD
```

Expected: commands exit 0; lint may print existing warnings only.

- [x] **Step 2: Verify commit and working-tree state**

```bash
git status --short --branch
git log -3 --oneline
```

Expected: clean `main` branch with separate TUI and Core behavior commits after the plan/spec commit.
