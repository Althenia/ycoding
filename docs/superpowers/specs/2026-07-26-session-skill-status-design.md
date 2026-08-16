# Session Skill Status Design

## Goal

Make skill activation explicit and inspectable in the V2 TUI.

Users can invoke the existing command palette, select **Session skills**, and inspect only the skills that were successfully loaded in the current session. Transcript skill rows use one expandable presentation for `$skill` activation and model `skill` tool activation, stay collapsed by default, and state clearly when loading completed.

## Scope

- Add explicit skill-conflict declarations to skill metadata.
- Snapshot loaded skill identity, content, and conflict declarations in existing activation records.
- Derive latest session-local skill state from durable session history and current instruction state.
- Expose the derived state through a public read endpoint.
- Add the **Session skills** command and status/detail dialogs to the V2 TUI.
- Unify transcript rendering for reference and tool activations.
- Regenerate client surfaces required by the public Protocol change.

The existing **Prompt > Skills** command remains the available-skill picker. The repository contains no V1 product package to modify.

## Definitions

### Successful activation

A skill is successfully activated by either:

1. a projected `session.skill.activated` message created by `$skill`, the skill picker, or the session skill endpoint; or
2. a completed assistant `skill` tool call whose structured result identifies the loaded skill.

Text that merely resembles a skill reference and failed, denied, interrupted, or incomplete tool calls are not activations.

### Active skill

The latest successful activation for a skill is active when no later completed compaction or agent switch exists in the same session.

### Inactive skill

The latest successful activation is inactive when the latest relevant boundary after it is:

- `compacted`: a completed compaction; or
- `agent_switched`: an agent switch.

A successful activation after the boundary becomes the latest activation and makes the skill active again.

### Conflict

A conflict is an explicit declaration, never a semantic inference. Conflicts are report-only and do not alter model context or activation state.

An active skill has a current conflict when:

- its declaration names another active skill in the same session;
- another active skill names it; or
- its declaration names a currently active instruction source.

Inactive skills retain declarations for inspection but have no current conflicts.

## Skill Metadata

Skill frontmatter accepts the following optional metadata:

```yaml
metadata:
  ycoding/conflicts:
    skills:
      - another-skill-id
    instructions:
      - core/instructions
```

`skills` contains skill IDs. `instructions` contains stable `Instruction.Key` values such as `core/instructions`.

Both arrays default to empty. IDs are trimmed, empty values are rejected, and duplicates are removed while preserving the first declaration order. A malformed `ycoding/conflicts` value is a deterministic skill-definition decode error rather than an inferred or partially accepted declaration.

Skill-to-skill conflicts are reported symmetrically when either active skill declares the other. Missing targets remain visible as declarations but are not current conflicts.

## Durable Activation Snapshot

Historical status must not change when a skill file is edited or deleted. Each successful activation therefore snapshots:

- skill ID;
- display name;
- exact loaded content; and
- normalized conflict declarations.

Reference activation extends the existing `session.skill.activated` event/message data. Model-tool activation extends the existing structured skill tool output. This introduces no event type, status event, projection table, or database migration.

## Server-Derived Read Model

Add `GET /api/session/:sessionID/skills` to the public Session Protocol group.

The endpoint performs:

1. one ordered query for the session's complete message history, including messages before the latest compaction;
2. one fold that records the latest successful activation per skill and the latest boundary after each activation;
3. one read of the current instruction sources;
4. one conflict-resolution pass over active skills and active instruction keys.

The operation is `O(message count + loaded skill count + declarations)` and performs no query per skill.

Each result has this logical shape:

```ts
{
  id: string
  name: string
  state: "active" | "inactive"
  inactiveReason?: "agent_switched" | "compacted"
  activatedBy: "reference" | "tool"
  activationMessageID: string
  content: string
  conflicts: Array<{
    type: "skill" | "instruction"
    id: string
    name: string
  }>
  declarations: {
    skills: string[]
    instructions: string[]
  }
}
```

The response contains one record per successfully loaded skill ID. The latest activation supplies the response data. Results never aggregate child sessions; a main session and each subagent session are evaluated independently by session ID.

Unknown sessions use the existing session-not-found contract. The endpoint is read-only and creates no durable events.

## TUI Command Flow

Register **Session skills** under the existing **Session** command-palette category. It is available only while viewing a session.

Selecting the command opens a dedicated dialog that:

- fetches the session-skills endpoint when opened;
- searches successfully loaded skills only;
- groups rows into **Active** and **Inactive**;
- displays state independently from conflict state;
- shows `ACTIVE`, `ACTIVE - CONFLICT`, `INACTIVE - COMPACTED`, or `INACTIVE - AGENT SWITCH`;
- shows `No skills loaded in this session` when empty;
- shows a retryable error state when loading fails; and
- opens latest-activation details when a row is selected.

The details view shows activation source, message reference, session scope, latest boundary, current conflicts, declarations, and exact loaded content. Content is collapsed by default. Back returns to the filtered list.

The existing **Prompt > Skills** command remains unchanged and continues to select an available skill for activation.

## Transcript Rendering

The highlighted `$skill` segment remains in the user message.

Both successful activation paths use the same visual language:

```text
✦ Skill "using-git-worktrees"  Loaded
  + Skill content
```

The content row is collapsed by default. Selecting the row expands the exact loaded content; selecting it again collapses it. Selecting terminal text does not toggle expansion.

Model tool states are:

- pending: `✦ Loading skill "..."...`;
- completed: `✦ Skill "..."  Loaded`;
- failed or denied: existing tool error presentation.

Failed model-tool loads remain visible as transcript errors but never appear in **Session skills**. The specialized skill renderer owns its content so the generic raw tool-output renderer does not duplicate `<skill_content>` below it.

## Compaction and Agent Switching

Completed compaction is an activation boundary because runner history begins at the latest completed compaction. A pre-compaction skill therefore becomes `inactive: compacted`, even if its name survives in the generated summary. Exact content must be loaded again to reactivate it.

An agent switch is also an activation boundary. Skills loaded before the switch remain listed as `inactive: agent_switched` until reloaded for the current agent context.

When more than one boundary follows an activation, the latest boundary determines the displayed inactive reason. A later successful activation supersedes every earlier activation and boundary for that skill.

## Main Chat and Subagent Behavior

Status is strictly session-local:

- the main chat lists only activations in the main session transcript;
- a subagent chat lists only activations in that child session transcript; and
- a parent subagent tool row does not import child-session skill status.

This matches the requirement that every listed skill was both loaded and represented in the transcript being viewed.

## Error Handling

- Unknown session: existing session-not-found response.
- Message or instruction read failure: endpoint failure; TUI shows retry.
- Deleted or edited skill definition: use the activation snapshot.
- Malformed conflict metadata: reject the conflict field during skill decoding; never infer or partially recover it.
- Failed, denied, interrupted, or incomplete model skill tool: exclude from the read model.
- Missing declared target: retain the declaration, omit a current conflict.

## Testing

### Schema and Core

- Decode valid skill and instruction conflict declarations.
- Reject malformed declarations.
- Normalize whitespace and duplicates.
- Snapshot declarations for reference and model-tool activation.
- Include successful reference and model-tool activations.
- Exclude prose mentions and failed, denied, interrupted, or incomplete tools.
- Mark an activation inactive after agent switch.
- Mark an activation inactive after completed compaction.
- Ignore incomplete or failed compaction as a boundary.
- Make reload after either boundary active.
- Use the latest successful activation when a skill repeats.
- Resolve active skill-to-skill conflicts symmetrically.
- Resolve active instruction conflicts.
- Keep inactive and missing targets out of current conflicts.
- Preserve snapshots after the source definition changes or disappears.
- Keep parent and child session results isolated.

### Protocol and Server

- Encode and decode the endpoint response.
- Return standard session-not-found behavior.
- Verify generated Effect and Promise clients expose the endpoint.

### TUI

- Register **Session skills** only in session context.
- Preserve the existing **Prompt > Skills** command.
- Render loading, empty, error, active, inactive, and conflict states.
- Filter loaded skills and preserve the filter when returning from details.
- Render latest activation details and collapsed content.
- Use one expandable skill presentation for reference and model-tool activation.
- Display `Loaded` on successful activation.
- Avoid duplicate generic tool output.
- Preserve actual `$skill` activation before prompt admission.

## Validation

Run targeted tests from each affected package, never the repository root. Run package type checks with `bun typecheck`. Because the public Protocol changes, run `bun run generate` from `packages/client` and validate generated surfaces. Run applicable TUI tests and manually verify the command flow in a live TUI session.

## Approval-Sensitive Delivery

The implementation runs on branch `session-skill-status` in `.worktrees/session-skill-status`. After all checks pass, commit the scoped changes and merge the branch into local `main`, as explicitly authorized by the user. Do not push or open a pull request.
