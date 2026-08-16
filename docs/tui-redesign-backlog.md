# TUI redesign backlog

Status: **Proposed / deferred after rebuild**

This is the tracked handoff for work that must resume in a fresh Session after the current merge. It does not describe implemented behavior or completed verification. Current source, tests, Schema, Protocol, and measured post-rebuild evidence remain authoritative.

## Operating constraints

- Run build, capture, typecheck, tests, and Aphrodite commands serially. Do not measure while another process edits TUI surfaces or regenerates captures.
- Treat `.aphrodite/rev347/suites` and `.aphrodite/rev347/penpot` as frozen design evidence. Do not edit the suites to match implementation output.
- Treat `.aphrodite/renders` and previous comparator output as stale until the current source has been rebuilt and the owning capture tests have passed in the same run.
- Do not stage or commit generated capture renders.
- Record only new executed evidence. Do not carry forward an earlier score as a baseline.

## Ordered backlog

### 1. P0 — Establish the post-rebuild design baseline

**Outcome**

Produce the first trustworthy design-conformance baseline from the rebuilt TUI, current deterministic captures, and the Aphrodite page-09 comparator.

**Verified current state**

- The root `build:tui` script owns the current distributable TUI build.
- Screen capture tests write deterministic text renders under `.aphrodite/renders`.
- `.aphrodite/rev347/tools/run-suite.ts` grades the static renders selected by `capture-map.ts`; it does not render the TUI itself.
- Component boards are reported as `not-run` until the comparator has an evidence-backed offset model. They must not be counted as passes.
- Existing renders and scores may predate the merged source and are not valid evidence for this baseline.

**Scope**

1. Build the current TUI.
2. Run every owning screen capture test and fix capture assertions only when current intended text changed.
3. Run the full page-09 comparator against the newly written renders.
4. Record the source revision, exact commands, per-board comparator result, aggregate result for graded boards, and explicit `not-run` boards in this tracked backlog or its approved successor evidence record.

**Acceptance checks**

- `bun run build:tui` exits successfully for the current source revision.
- Every invoked capture test passes before its output is treated as current.
- `run-suite.ts` runs after capture generation, not before it.
- The recorded baseline distinguishes `pass`, `fail`, and `not-run`; it contains no inherited score.
- `git status --short .aphrodite/renders` is reviewed, and generated renders are not staged or committed.

**Relevant paths**

- `package.json`
- `packages/tui/test/screen/*capture.test.tsx`
- `packages/tui/test/screen/capture.ts`
- `.aphrodite/rev347/tools/run-suite.ts`
- `.aphrodite/rev347/tools/capture-map.ts`
- `.aphrodite/rev347/suites/`
- `.aphrodite/renders/`

### 2. P1 — Design contracts for blocked boards 32, 50, 52, and 54

**Outcome**

Approve explicit product and public-contract behavior for the four blocked dialogs before implementing or scoring their UI:

- board 32 — Session goal;
- board 50 — Export options;
- board 52 — Workspace changes;
- board 54 — Tag.

**Verified current state**

- Frozen suites and mapped component captures exist for all four boards.
- Current TUI components and fixture captures exist, but fixture text and selectable rows do not by themselves establish product behavior or a public API contract.
- The current comparator intentionally reports component boards as `not-run` because their expectations are board-relative while captures are terminal-absolute.

**Scope**

Split each board into contract work before UI work:

1. Define user outcome, invocation path, inputs, actions, validation, cancellation, durable effects, errors, and restart behavior in the relevant `specs/v2` contract.
2. If public behavior changes, implement Schema → Core/Protocol → Server, regenerate Client output with the owning command, and add contract tests.
3. Only then connect the production TUI component and its real route or command.
4. Add capture and comparator evidence after the behavior is real.

Do not satisfy a board with hard-coded fixture options, dummy callbacks, synthetic success, or a TUI-only state that has no accepted product behavior.

**Acceptance checks**

- Each board has an approved contract naming every action and terminal outcome before UI implementation begins.
- Any public API change has Schema and Protocol coverage, owning Client regeneration, and a production handler.
- The production dialog invokes the accepted operation and renders validation, cancellation, success, and failure truthfully.
- Focused implementation tests pass before capture generation.
- Dialog scoring remains `not-run` until an evidence-backed comparator offset model exists; no fixture-only render is reported as implementation completion.

**Relevant paths**

- `.aphrodite/rev347/suites/32-dialog-session-goal.json`
- `.aphrodite/rev347/suites/50-dialog-export-options.json`
- `.aphrodite/rev347/suites/52-dialog-workspace-changes.json`
- `.aphrodite/rev347/suites/54-dialog-tag.json`
- `packages/tui/src/component/dialog-session-goal.tsx`
- `packages/tui/src/ui/dialog-export-options.tsx`
- `packages/tui/src/component/dialog-workspace-file-changes.tsx`
- `packages/tui/src/component/dialog-tag.tsx`
- `packages/tui/test/screen/dialog-remaining-capture.test.tsx`
- `packages/schema/`
- `packages/protocol/`
- `packages/core/`
- `packages/server/`
- `packages/client/`
- `specs/v2/`

### 3. P1 — Clarify cache-diagnostics scope and measure Pro usage pressure

**Outcome**

Make production labels distinguish latest-step cache/context telemetry from Session-lifetime provider-request totals, then collect fresh evidence for long-context repetition and physical request amplification in a new Session.

**Verified current state**

- `SessionCacheDiagnostics.fromMessages` derives context and provider-cache fields from the latest assistant step after the latest completed compaction.
- `SessionProviderRequest.summary` aggregates logical requests, physical attempts, helper requests, tokens, and cost over the Session's durable request ledger.
- Current presentation uses broad Session wording and does not consistently expose that scope distinction at every diagnostic surface.
- No accounting or runtime defect is currently reproduced. Usage pressure after a long-lived development Session is an investigation input, not proof of a defect.

**Scope**

1. Choose production labels such as `Latest step` and `Session lifetime` wherever both scopes are presented.
2. Change production copy first; reintroduce focused tests only after those exact labels exist in production.
3. In a fresh Session, exercise representative long-context work and record logical requests, physical attempts, helper calls, continuation/fallback counts, and normalized token categories without recording prompt content or credentials.
4. Separate expected repeated context from retry amplification, helper traffic, or duplicated accounting before proposing a runtime change.

**Acceptance checks**

- Every affected production diagnostic surface names the scope of displayed values unambiguously.
- Focused tests assert production labels and real presentation data, not proposed strings embedded only in tests.
- Fresh-Session evidence identifies the exact logical-to-physical relationship and the source of any repeated context.
- A runtime or accounting fix starts only after a deterministic reproduction demonstrates incorrect behavior; otherwise the item closes as measured pressure without a defect.

**Relevant paths**

- `packages/core/src/session/cache-diagnostics.ts`
- `packages/core/src/session/provider-request.ts`
- `packages/tui/src/routes/session/provider-usage.tsx`
- `packages/tui/src/util/cache-diagnostics.ts`
- `packages/tui/test/cli/tui/provider-usage-command.test.tsx`
- `docs/provider-efficiency.md`
- `docs/runtime.md`

### 4. P1 — Reproduce the real-binary DeepSeek control-token defect

**Outcome**

Reproduce literal DeepSeek tool-control delimiters appearing in the transcript together with missing tool execution on the rebuilt real binary before changing protocol lowering.

**Verified current state**

- The AI route client contains textual tool-control parsing and lowering.
- A synthetic Core test covers one DeepSeek textual-control shape.
- A fixture or render-harness pass cannot establish that the real provider stream uses the same byte sequence, chunking, route, or event lowering.
- No fresh post-rebuild real-binary reproduction is recorded in tracked evidence.

**Scope**

1. Use the rebuilt binary and a configured DeepSeek route to request one harmless, deterministic local tool call.
2. Confirm both symptoms in the same run: literal control delimiters are visible and the expected tool has no durable execution record.
3. Capture only sanitized route, model, event-shape, and chunk-boundary evidence; exclude credentials, private prompts, raw headers, and unrelated provider payloads.
4. Isolate the failure to provider framing, textual-control parsing, AI event lowering, or Core tool dispatch.
5. Add the smallest recorded or protocol-level regression test, then fix the verified lowering boundary.

**Acceptance checks**

- The pre-fix real binary deterministically reproduces both visible delimiters and missing execution, or the item is closed as not reproduced without a code change.
- The regression test fails for the reproduced event shape before the fix and passes afterward.
- The fix emits a normal tool-call event, removes control delimiters from assistant text, and results in one durable tool execution.
- Neighboring native and OpenAI-compatible tool-call tests remain passing.

**Relevant paths**

- `packages/ai/src/route/client.ts`
- `packages/ai/src/protocols/openai-chat.ts`
- `packages/ai/src/protocols/openai-compatible-chat.ts`
- `packages/ai/src/providers/openai-compatible.ts`
- `packages/ai/test/provider/openai-compatible-chat.test.ts`
- `packages/core/test/aisdk.test.ts`
- `packages/core/src/session/runner/llm.ts`

### 5. P2 — Resume page-09, dialog, and rail scoring

**Outcome**

Continue measured design-conformance work only after item 1 establishes rebuilt captures and a fresh baseline.

**Verified current state**

- Frozen page-09 design evidence and board-to-capture mapping exist under `.aphrodite/rev347`.
- The comparator grades full-screen terminal boards and explicitly reports component dialogs as `not-run` until a justified offset model exists.
- Rail and dialog source have changed since earlier renders may have been produced, so old render files and scores cannot establish current conformance.

**Scope**

1. Start from the fresh item-1 report and select the highest-impact unmet expectation by board, row, column, anchor, and text.
2. Regenerate the owning capture after each accepted source change before remeasuring.
3. Derive a dialog offset model from frozen design evidence before grading boards 20–57.
4. Measure rail geometry together—width, section pitch, marker width, gaps, and content columns—rather than changing one compensating offset in isolation.
5. Preserve frozen suites, Penpot evidence, and analysis artifacts; keep generated renders uncommitted.

**Acceptance checks**

- Every claimed improvement cites a comparator run produced after its owning capture test passed.
- Findings distinguish transcript and rail columns rather than comparing only row text.
- A regression is reverted or explicitly accepted with measured evidence; hopeful source-only changes do not count as progress.
- Component boards remain `not-run` until the offset model is implemented and validated.
- `.aphrodite/renders` is absent from the staged diff.

**Relevant paths**

- `.aphrodite/rev347/suites/`
- `.aphrodite/rev347/penpot/`
- `.aphrodite/rev347/tools/run-suite.ts`
- `.aphrodite/rev347/tools/capture-map.ts`
- `packages/tui/test/screen/`
- `packages/tui/src/routes/session/rail.ts`
- `packages/tui/src/routes/session/rail-section.tsx`
- `packages/tui/src/ui/dialog.tsx`

## Fresh-session start

From the repository root, read the handoff and governing contracts first:

```sh
git status --short --branch
sed -n '1,280p' docs/tui-redesign-backlog.md
sed -n '1,260p' AGENTS.md
sed -n '1,220p' docs/product-direction.md
sed -n '1,240p' .aphrodite/rev347/tools/run-suite.ts
sed -n '1,220p' .aphrodite/rev347/tools/capture-map.ts
```

Load the `YCoding`, `TUI design conformance`, and `TUI verification gates` skills before implementation. Then establish the post-rebuild baseline with these commands, one at a time:

```sh
bun run build:tui
(cd packages/tui && bun test --timeout 60000 test/screen/*capture.test.tsx)
(cd .aphrodite/rev347/tools && bun run-suite.ts)
git status --short .aphrodite/renders .aphrodite/rev347/suites/last-run.json
```

These commands are prescribed start steps, not results. Record their actual outcomes only after they run, and do not stage generated renders.
