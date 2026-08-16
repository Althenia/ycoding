# Session Skill Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authoritative session-local skill status API and TUI command that report actual successful skill loads, lifecycle boundaries, explicit conflicts, and expandable transcript content.

**Architecture:** Extend existing skill and activation schemas with normalized conflict snapshots, then derive one latest status per skill by folding complete durable session history and current instruction keys. Expose that read model through the V2 Protocol/Server and generated clients; consume it in a new TUI Session command while sharing one expandable transcript presentation across reference and model-tool activations.

**Tech Stack:** TypeScript, Effect v4, Effect Schema/HttpApi, Drizzle SQLite, SolidJS/OpenTUI, Bun tests, generated Promise and Effect clients.

## Global Constraints

- Work only in `.worktrees/session-skill-status` on branch `session-skill-status`.
- Do not modify `packages/opencode`; it is V1 reference-only.
- Runtime dependency direction remains Schema -> Core/Protocol -> Server; Client may depend on Schema/Protocol but not Core/Server.
- Do not add dependencies, migrations, status events, or status projection tables.
- Preserve **Prompt > Skills**; add **Session skills** under the Session command category.
- Status is session-local; parent and child sessions never aggregate.
- Conflict declarations are explicit and report-only.
- Completed compaction and agent switch are inactive boundaries; latest successful reload wins.
- Generated client files change only through `bun run generate` in `packages/client`.
- Run tests and `bun typecheck` from package directories, never repository root.

---

### Task 1: Conflict and Activation Snapshot Contracts

**Files:**
- Modify: `packages/schema/src/skill.ts`
- Modify: `packages/schema/src/session-message.ts`
- Modify: `packages/schema/src/session-event.ts`
- Modify: `packages/core/src/skill.ts`
- Modify: `packages/core/src/tool/skill.ts`
- Modify: `packages/core/src/session.ts`
- Modify: `packages/core/src/session/message-updater.ts`
- Test: `packages/core/test/skill.test.ts`
- Test: `packages/core/test/tool/skill.test.ts`
- Test: `packages/core/test/session-skill.test.ts`

**Interfaces:**
- Produces: `Skill.Conflicts` with `{ skills: Skill.ID[]; instructions: Instruction.Key[] }`.
- Produces: optional `conflicts` on `Skill.Info`, `SessionMessage.Skill`, `SessionEvent.Skill.Activated`, and `SkillTool.Output`.
- Preserves decoding of historical activation rows by making new snapshot fields optional and normalizing absent values to empty declarations in the read model.

- [ ] **Step 1: Add failing schema and loader tests**

Test valid metadata, duplicate removal, blank IDs, malformed shapes, and historical activation decoding. The core assertions must include:

```ts
expect(skill.conflicts).toEqual({
  skills: [SkillV2.ID.make("other")],
  instructions: [Instructions.Key.make("core/instructions")],
})
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run from `packages/core`:

```bash
bun test test/skill.test.ts test/tool/skill.test.ts test/session-skill.test.ts
```

Expected: failures because conflict fields and activation snapshots do not exist.

- [ ] **Step 3: Add the shared schema**

Define the contract in `packages/schema/src/skill.ts` and reuse it everywhere:

```ts
export const Conflicts = Schema.Struct({
  skills: Schema.Array(ID),
  instructions: Schema.Array(Instruction.Key),
}).annotate({ identifier: "Skill.Conflicts" })
export type Conflicts = typeof Conflicts.Type
```

Expose optional `conflicts` on `Skill.Info`. Parse `metadata["opencode/conflicts"]` in `packages/core/src/skill.ts`, require an object with optional arrays, trim values, reject blanks/non-strings, and deduplicate while preserving first order.

- [ ] **Step 4: Snapshot reference and model-tool activation**

Publish `skill.conflicts` through `SessionEvent.Skill.Activated`, project it into `SessionMessage.Skill`, and return it in `SkillTool.Output`:

```ts
return {
  name: skill.name,
  directory,
  output: toModelOutput(skill, files),
  conflicts: skill.conflicts,
}
```

The event/message fields remain optional so existing persisted rows decode.

- [ ] **Step 5: Run GREEN checks**

Run:

```bash
cd packages/core
bun test test/skill.test.ts test/tool/skill.test.ts test/session-skill.test.ts
bun typecheck
cd ../schema
bun typecheck
```

Expected: all selected tests pass and both type checks exit 0.

- [ ] **Step 6: Commit the contract slice**

```bash
git add packages/schema/src/skill.ts packages/schema/src/session-message.ts packages/schema/src/session-event.ts packages/core/src/skill.ts packages/core/src/tool/skill.ts packages/core/src/session.ts packages/core/src/session/message-updater.ts packages/core/test
git commit -m "feat(core): snapshot skill conflicts"
```

---

### Task 2: Session Skill Status Read Model

**Files:**
- Create: `packages/core/src/session/skill-status.ts`
- Modify: `packages/core/src/session.ts`
- Test: `packages/core/test/session-skill-status.test.ts`

**Interfaces:**
- Consumes: conflict snapshots from Task 1.
- Produces: `SessionSkillStatus.Info` and `SessionSkillStatus.list(messages, instructionKeys)`.
- Produces: `SessionV2.Service.skills(sessionID)` returning one latest record per successfully loaded skill.

- [ ] **Step 1: Add failing fold tests**

Build deterministic message arrays covering reference activation, completed `skill` tool output, failed/running tool exclusion, prose exclusion, repeated activation, completed compaction, failed/running compaction, agent switch, reload, symmetric skill conflicts, instruction conflicts, missing targets, and inactive targets.

Representative assertion:

```ts
expect(SessionSkillStatus.list(messages, [Instructions.Key.make("core/instructions")])).toContainEqual(
  expect.objectContaining({
    id: SkillV2.ID.make("review"),
    state: "active",
    activatedBy: "tool",
    conflicts: [{ type: "instruction", id: "core/instructions", name: "core/instructions" }],
  }),
)
```

- [ ] **Step 2: Run RED**

Run from `packages/core`:

```bash
bun test test/session-skill-status.test.ts
```

Expected: failure because `session/skill-status.ts` is absent.

- [ ] **Step 3: Implement the pure fold**

Keep status logic in `packages/core/src/session/skill-status.ts`. Fold messages in durable order, replacing a skill record on each successful activation. On completed compaction or agent switch, mark every currently active record inactive with that boundary. Decode completed model-tool structured results without accepting failed, streaming, or running states. Resolve conflicts only after the fold.

Use a tagged schema for state:

```ts
const State = Schema.Union([
  Schema.Struct({ state: Schema.Literal("active") }),
  Schema.Struct({
    state: Schema.Literal("inactive"),
    inactiveReason: Schema.Literals(["agent_switched", "compacted"]),
  }),
])
```

- [ ] **Step 4: Connect complete history and current instruction keys**

Add `SessionV2.Service.skills(sessionID)`. Verify the session exists, read all `SessionMessageTable` rows in ascending sequence once, decode once, read current instruction source keys through the session location's existing instruction services, then call the pure fold. Do not use `SessionHistory.load`, because it intentionally drops pre-compaction messages.

- [ ] **Step 5: Add service-level isolation and deleted-source tests**

Prove parent/child sessions return separate records and that status uses snapshot content/declarations even when the current skill catalog no longer contains the skill.

- [ ] **Step 6: Run GREEN checks**

Run:

```bash
cd packages/core
bun test test/session-skill-status.test.ts test/session-skill.test.ts
bun typecheck
```

Expected: selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit the read model**

```bash
git add packages/core/src/session/skill-status.ts packages/core/src/session.ts packages/core/test/session-skill-status.test.ts packages/core/test/session-skill.test.ts
git commit -m "feat(core): derive session skill status"
```

---

### Task 3: Protocol, Server, and Generated Clients

**Files:**
- Modify: `packages/protocol/src/groups/session.ts`
- Modify: `packages/server/src/handlers/session.ts`
- Test: `packages/server/test/session-location.test.ts`
- Regenerate: `packages/client/src/promise/generated/**`
- Regenerate: `packages/client/src/effect/generated/**`
- Regenerate: `packages/client/src/effect/api/**`

**Interfaces:**
- Consumes: `SessionV2.Service.skills(sessionID)` from Task 2.
- Produces: `GET /api/session/:sessionID/skills`, operation ID `v2.session.skills`.
- Produces: generated Promise and Effect client methods under `session.skills`.

- [ ] **Step 1: Add failing handler/contract coverage**

Extend the location-scoped session API test to request `/api/session/:sessionID/skills`, verify successful encoding, and verify standard session-not-found behavior.

- [ ] **Step 2: Run RED**

Run from `packages/server`:

```bash
bun test test/session-location.test.ts
```

Expected: 404 or missing route before the endpoint exists.

- [ ] **Step 3: Add the Protocol endpoint**

Add the endpoint beside `session.skill`:

```ts
HttpApiEndpoint.get("session.skills", "/api/session/:sessionID/skills", {
  params: { sessionID: Session.ID },
  success: Schema.Struct({ data: Schema.Array(SessionSkillStatus.Info) }),
  error: SessionNotFoundError,
})
```

Apply `sessionLocationMiddleware` and OpenAPI identifier `v2.session.skills`.

- [ ] **Step 4: Add the Server handler**

Map the endpoint to `session.skills(ctx.params.sessionID)`, map `SessionV2.NotFoundError` with the existing helper, and return `{ data }`.

- [ ] **Step 5: Regenerate clients through the owning tool**

Run from `packages/client`:

```bash
bun run generate
```

Expected: Promise generated types/client, Effect generated client, and Effect API adapter update. Do not edit generated files manually.

- [ ] **Step 6: Run GREEN and generation checks**

Run:

```bash
cd packages/server
bun test test/session-location.test.ts
bun typecheck
cd ../protocol
bun typecheck
cd ../client
bun run check:generated
bun typecheck
```

Expected: tests pass, generated check has no post-generation diff, and all type checks exit 0.

- [ ] **Step 7: Commit API surfaces**

```bash
git add packages/protocol/src/groups/session.ts packages/server/src/handlers/session.ts packages/server/test/session-location.test.ts packages/client/src
git commit -m "feat(server): expose session skill status"
```

---

### Task 4: Session Skills Command and Dialog

**Files:**
- Create: `packages/tui/src/component/dialog-session-skills.tsx`
- Create: `packages/tui/src/util/session-skills.ts`
- Modify: `packages/tui/src/routes/session/index.tsx`
- Test: `packages/tui/test/session-skills.test.ts`
- Test: `packages/tui/test/keymap-registration.test.ts`

**Interfaces:**
- Consumes: generated `client.api.session.skills({ sessionID })`.
- Produces: command `session.skills`, title **Session skills**, category **Session**.
- Produces: pure grouping/filter/detail helpers in `util/session-skills.ts` for deterministic tests.

- [ ] **Step 1: Add failing helper and command tests**

Test active-before-inactive grouping, conflict indicator composition, inactive reason labels, case-insensitive filtering, empty results, and session-only command registration.

```ts
expect(sessionSkillLabel({ state: "inactive", inactiveReason: "compacted", conflicts: [] })).toBe(
  "INACTIVE - COMPACTED",
)
```

- [ ] **Step 2: Run RED**

Run from `packages/tui`:

```bash
bun test test/session-skills.test.ts test/keymap-registration.test.ts
```

Expected: missing helper/module and command failures.

- [ ] **Step 3: Implement pure presentation helpers**

Create functions that filter by ID/name, sort active then inactive while preserving server order inside groups, and format independent state/conflict labels. Keep JSX out of the helper.

- [ ] **Step 4: Implement the dialog**

Follow `DialogSkill` and `DialogSelect` conventions. Fetch on open, show locked loading/error views, provide retry, group **Active** and **Inactive**, and replace the list with a detail view on selection. Preserve the filter when returning. The detail view shows activation source, message ID, scope, latest boundary, conflicts, declarations, and collapsed exact content.

- [ ] **Step 5: Register the command in the Session route**

Add:

```ts
{
  title: "Session skills",
  name: "session.skills",
  category: "Session",
  run: () => dialog.replace(() => <DialogSessionSkills sessionID={ctx.sessionID} />),
}
```

Do not change `prompt.skills` or `DialogSkill`.

- [ ] **Step 6: Run GREEN checks**

Run:

```bash
cd packages/tui
bun test test/session-skills.test.ts test/keymap-registration.test.ts
bun typecheck
```

Expected: selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit the command UI**

```bash
git add packages/tui/src/component/dialog-session-skills.tsx packages/tui/src/util/session-skills.ts packages/tui/src/routes/session/index.tsx packages/tui/test/session-skills.test.ts packages/tui/test/keymap-registration.test.ts
git commit -m "feat(tui): add session skills menu"
```

---

### Task 5: Unified Expandable Transcript Rendering

**Files:**
- Modify: `packages/tui/src/routes/session/index.tsx`
- Modify: `packages/tui/src/mini/tool.ts`
- Test: `packages/tui/test/tool-output-display.test.ts`
- Test: `packages/tui/test/mini/tool.test.ts`
- Test: `packages/tui/test/prompt/skill.test.ts`

**Interfaces:**
- Consumes: activation content snapshots and completed model skill tool output.
- Produces: collapsed-by-default `Loaded` rows for both activation paths with no generic duplicate output.

- [ ] **Step 1: Add failing display tests**

Test the specialized skill title/status/content extraction, collapsed display budget behavior, pending and failed labels, and preservation of `$skill` segmentation.

- [ ] **Step 2: Run RED**

Run from `packages/tui`:

```bash
bun test test/tool-output-display.test.ts test/mini/tool.test.ts test/prompt/skill.test.ts
```

Expected: failures because reference skill rows are not expandable and model skill output is still rendered generically.

- [ ] **Step 3: Share the expandable skill body**

Implement one local presentation component used by `SessionSkillMessage` and `Skill`. It renders:

```text
✦ Skill "<name>"  Loaded
  + Skill content
```

Use `toolOutputDisplay` for bounded preview/expansion, initialize closed, and ignore clicks while terminal text is selected.

- [ ] **Step 4: Remove duplicate generic skill output**

Exclude `skill` from `ToolPart.rawOutput()` and let the specialized `Skill` component render `props.output`. Preserve error rendering and pending `Loading skill...` behavior.

- [ ] **Step 5: Align mini transcript formatting**

Update `mini/tool.ts` skill titles to use the same explicit `Loaded` terminology without exposing raw wrappers twice.

- [ ] **Step 6: Run GREEN checks**

Run:

```bash
cd packages/tui
bun test test/tool-output-display.test.ts test/mini/tool.test.ts test/prompt/skill.test.ts
bun typecheck
```

Expected: selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit transcript rendering**

```bash
git add packages/tui/src/routes/session/index.tsx packages/tui/src/mini/tool.ts packages/tui/test/tool-output-display.test.ts packages/tui/test/mini/tool.test.ts packages/tui/test/prompt/skill.test.ts
git commit -m "feat(tui): expand loaded skill rows"
```

---

### Task 6: Complete-Diff Verification and Delivery

**Files:**
- Verify all changed paths.
- Modify only files required to repair verified failures.

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: validated branch merged into local `main`.

- [ ] **Step 1: Review complete diff and generated ownership**

Run:

```bash
git status --short
git diff main...HEAD --check
git diff main...HEAD --stat
```

Confirm no `packages/opencode`, dependency, lockfile, migration, or hand-edited generated changes exist.

- [ ] **Step 2: Run targeted and package-wide verification**

Run from each package:

```bash
cd packages/schema && bun typecheck
cd ../core && bun test test/skill.test.ts test/tool/skill.test.ts test/session-skill.test.ts test/session-skill-status.test.ts && bun typecheck
cd ../protocol && bun typecheck
cd ../server && bun test test/session-location.test.ts && bun typecheck
cd ../client && bun run check:generated && bun test && bun typecheck
cd ../tui && bun test test/session-skills.test.ts test/keymap-registration.test.ts test/tool-output-display.test.ts test/mini/tool.test.ts test/prompt/skill.test.ts && bun typecheck
```

Expected: every command exits 0 with no skipped affected tests.

- [ ] **Step 3: Run integration review and one repair wave if required**

Review correctness, bounded work, session isolation, compaction semantics, and maintainability on the complete diff. Repair only evidenced findings, rerun the failing focused check, then rerun Step 2.

- [ ] **Step 4: Commit remaining validated repairs and plan**

```bash
git add docs/superpowers/plans/2026-07-26-session-skill-status.md <validated-repair-paths>
git commit -m "test: verify session skill status"
```

Skip the repair paths and use `docs: add session skill implementation plan` when only the plan remains uncommitted.

- [ ] **Step 5: Merge into local main**

Verify the original `main` worktree is clean, then run there:

```bash
git merge --no-ff session-skill-status -m "feat: add session skill status"
```

Run `git status --short` and `git log -5 --oneline`. Expected: clean main worktree with the merge commit at `HEAD`. Do not push or open a pull request.
