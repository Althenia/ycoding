# R1 lane S — office store wire defects D2 / D3 / D5 (D4 report only)

Repo `/Users/viadz/Workspace/Project/ycoding`, branch `main`, HEAD `a4bb99e`, dirty working tree
(other lanes). Owned paths: `apps/office/core/office_store.gd`,
`apps/office/core/attention_queue.gd`, `apps/office/integration/fixture_translator.gd` (D3 payload
only), `apps/office/tests/suites/test_office_store.gd`,
`apps/office/tests/suites/test_attention_queue.gd`.

## Step 1 — live schema verification (every defect checked before any edit)

### D2 — REAL

`packages/schema/src/session-event.ts:492-497` (`namespace Tool`, `ToolBase`):

```ts
const ToolBase = {
  ...Base,                       // sessionID
  assistantMessageID: SessionMessage.ID,
  callID: Schema.String,
}
```

`packages/schema/src/session-event.ts:529-540` — `session.tool.called`:

```ts
export const Called = Event.durable({
  type: "session.tool.called",
  ...options,
  schema: {
    ...ToolBase,
    input: Schema.Record(Schema.String, Schema.Unknown),
    executed: Schema.Boolean,
    state: SessionMessage.ProviderState.pipe(optional),
  },
})
```

Declared field list: `sessionID`, `assistantMessageID`, `callID`, `input`, `executed`, `state?`.
**No `tool`, no `name`.**

`packages/schema/src/session-event.ts:499-507` — `session.tool.input.started`:

```ts
export const Started = Event.durable({
  type: "session.tool.input.started",
  ...options,
  schema: {
    ...ToolBase,
    name: Schema.String,
  },
})
```

Declared field list: `sessionID`, `assistantMessageID`, `callID`, `name`. The name lives here.

Wrong client read: `apps/office/core/office_store.gd:481`
`var name := str(data.get("tool", data.get("name", "")))` — both absent on `called`, and the event
carrying the name (`session.tool.input.started`) is not in `Wire` and not in the store's `match`.
Consequence confirmed at `apps/office/core/work_state.gd:59-66`: `from_tool("")` falls through to
`Kind.PROCESSING`, so READING / TYPING / TESTING are unreachable from the tool path in LIVE.

### D3 — REAL

`packages/schema/src/session-event.ts:63` — `session.created` declares `model: Model.Ref.pipe(optional)`.
`packages/schema/src/model.ts:14-18` — `Model.Ref`:

```ts
export const Ref = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  variant: VariantID.pipe(optional),
})
```

Declared field list: `id`, `providerID`, `variant?`. **No `ref`.**

Wrong client read: `apps/office/core/office_store.gd:394`
`var ref := str((model as Dictionary).get("ref", ""))` → always `""` in LIVE. Consequence: the value
is a *composition*, not a rename. `apps/office/core/model_catalog.gd:59-66` `ModelCatalog.format_ref`
already produces the client's `provider/id#variant` config form, and the consumer
(`apps/office/app/main.gd:686-693` `_default_model_ref()` → `prompt_panel.gd:196` `_model_ref`
compared via `ModelCatalog.parse_ref`) expects exactly that form.

### D5 — REAL

`packages/schema/src/permission.ts:24-30` (`RequestFields` used by `permission.v2.asked` at
permission.ts:43 via `Request.fields`):

```ts
const RequestFields = {
  sessionID: SessionID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  save: Schema.Array(Schema.String).pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  source: Source.pipe(optional),
}
```

plus `id` (permission.ts:32-35). Declared field list: `id`, `sessionID`, `action`, `resources`,
`save?`, `metadata?`, `source?`. **No `reason`.**

`reason` is declared only on the guardrail request — `packages/schema/src/guardrail.ts:49-61`
(`Guardrail.Request`): `reason: Schema.String` at guardrail.ts:57, served by
`guardrail.asked` at guardrail.ts:83.

Wrong client read: `apps/office/core/office_store.gd:348`
`var reason := str(data.get("reason", "")).strip_edges()` in the *shared* `permission_summary`.
The code degrades to the neutral caption, so this is caption honesty, not a crash: it renders a
reason for a request family whose schema cannot carry one.

### D4 — REAL, NOT FIXED (product surface decision required)

Store: `apps/office/core/office_store.gd:522-543` builds a question attention entry only from
`session.task.updated` / `change.type == "question_asked"`, whose `question` is
`SessionOrchestration.Question` = `{ id, text, data?, time }` — no `options`. See step 6.

## Step 2 — RED

Command (cwd `/Users/viadz/Workspace/Project/ycoding`), after adding the failing assertions and the
`TOOL_INPUT_STARTED` wire-name constant, with no fix applied yet:

```
ycoding-office-repair-kit/tools/godot_lock.sh /Applications/Godot.app/Contents/MacOS/Godot \
  --headless --path apps/office --script res://tests/run_tests.gd
```

Log tail:

```
=== office test summary ===
passed: 6339
failed: 10
  FAIL: the model ref is composition
  FAIL: the model ref survives
  FAIL: an absent variant adds no suffix and a slashed id survives
  FAIL: an incomplete model neither blanks nor mangles the reference
  FAIL: read classifies through its callID (expected 1, got 5)
  FAIL: shell classifies through its callID (expected 3, got 5)
  FAIL: edit classifies through its callID (expected 2, got 5)
  FAIL: the attributed tool name is kept (expected edit, got tool)
  FAIL: its own callID still classifies (expected 3, got 5)
  FAIL: a permission has no reason field, so none is rendered
RESULT: FAILED
```

Every failure is the intended behavioral mismatch, not setup or parse:

- `expected 1/2/3, got 5` — 5 is `WorkState.Kind.PROCESSING` (`work_state.gd:7`), i.e.
  `from_tool("")` fell through. That is D2 exactly.
- `the model ref is composition` / `the model ref survives` / the two variant cases — D3: `model_ref`
  stayed empty (or held the fixture string) because the store read the undeclared `ref`.
- `a permission has no reason field, so none is rendered` — D5: the shared `permission_summary`
  rendered the payload's `reason` key.

No `SCRIPT ERROR` line appeared in this run. The D2 case `an unannounced call is not classified`
already passed at RED, because a nameless call was already `PROCESSING`; that criterion is recorded as
already satisfied and is not manufactured.

## Step 3 — the fixes

All in `apps/office/core/office_store.gd` except the D3 fixture payload.

### D2

- `office_store.gd:16-20` — new `TOOL_INPUT_STARTED := "session.tool.input.started"` constant (a real
  wire name; `Wire` is not in this lane's owned paths, and nothing else needs it).
- `office_store.gd` reducer — a `TOOL_INPUT_STARTED` arm calling `learn_tool_name`.
- `learn_tool_name` stores `data["name"]` under `data["callID"]` in a bounded store
  (`_tool_names`, `TOOL_NAME_LIMIT = 64`). It returns false for a missing `callID` or `name`, so
  nothing is invented.
- `apply_tool(called = true)` looks the name up by `callID` and classifies with
  `WorkState.from_tool(name)`. A call whose name was never announced stays `PROCESSING`.
- `adopt_reload` clears `_tool_names`, so a replaced projection cannot keep stale names.

Why correlate by `callID`: it is the only field `session.tool.input.started` and
`session.tool.called` share, and the runtime keys its own tool map by exactly that id
(`packages/core/src/session/runner/publish-llm-event.ts:250-257` publishes
`callID: event.id` with `name: event.name`; `:485-493` publishes `Called` with `callID: event.id`
and no name). These are raw tool-protocol call IDs, not locales. No field is invented, and no event
that does not carry a name is asked for one.

### D3

- `office_store.gd` `_apply_placement` — reads the declared `providerID` and `id` and composes with
  `ModelCatalog.format_ref({providerID, id, variant})`, which is the client's existing formatter
  (`core/model_catalog.gd:59-66`). A `model` object missing either half composes nothing and leaves
  the previous value intact, so it can neither blank nor mangle a known reference.
- `integration/fixture_translator.gd` — `DEMO_MODEL_REF: String` replaced by `DEMO_MODEL: Dictionary`
  `{id, providerID, variant}`, emitted as the `model` value. Labels and `_synthetic` marking unchanged.

### D5

- `office_store.gd` `permission_summary(data, fallback, has_reason)` — the `reason` read is gated by
  the request kind. `apply_attention` passes `kind == KIND_GUARDRAIL`, so a permission caption is
  `action — resources` (or the neutral fallback) and only a guardrail can contribute its declared
  reason. Nothing is invented either way.

### Scope note

An intermediate attempt put the per-call name store on `ActorPresentation`; `actor_presentation.gd` is
NOT in this lane's owned paths, so that was reverted and the state moved onto `OfficeStore`. Verified
with `git diff --stat apps/office/core/actor_presentation.gd` → empty output (unmodified).

## Step 4 — GREEN and whole-suite

Command (cwd `/Users/viadz/Workspace/Project/ycoding`):

```
ycoding-office-repair-kit/tools/godot_lock.sh /Applications/Godot.app/Contents/MacOS/Godot \
  --headless --path apps/office --script res://tests/run_tests.gd
```

Every assertion this lane added or converted passes; each initial failure name now appears only as a
pass:

```
passes: read maps to READING
passes: edit maps to TYPING
passes: unknown tool stays generic
passes: classifies through its callID
passes: attributed tool name is kept
passes: no announced name stays generic
passes: does not inherit the learned name
passes: still classifies
passes: is composition
passes: survives
passes: absent variant adds no suffix
passes: incomplete model neither blanks
passes: permission has no reason field
passes: guardrail reason is kept
```

Latest whole-suite run: `passed: 6444  failed: 22  RESULT: FAILED`. **All 22 failures and all 5
`SCRIPT ERROR` lines are in `apps/office/tests/suites/test_chrome_toggles.gd`**, a file owned by
another lane and edited during this lane's run (mtime moved 23:40:36; the failure count moved 17 → 22
between two consecutive runs). Examples of the failures and the error:

```
FAIL: sidebar names its surface (Hide, wanted prefix Panel)
FAIL: the cluster reports a real minimum size at 1.00
SCRIPT ERROR: Invalid call. Nonexistent function 'text_stripped_length' in base 'Button'.
          at: _measure (res://tests/suites/test_chrome_toggles.gd:95)
```

No failure and no `SCRIPT ERROR` originates in `office_store.gd`, `attention_queue.gd`,
`fixture_translator.gd`, `test_office_store.gd` or `test_attention_queue.gd`. This lane does not own
`test_chrome_toggles.gd` or `ui/shell/**` and did not edit them.

## Step 5 — D4 handoff (NOT fixed; product surface decision required)

Two distinct question surfaces exist, and the office reads one while its reply path and UI belong to
the other.

**Surface A — `SessionOrchestration.Question` via `session.task.updated` / `change.type ==
"question_asked"`.** This is what the store handles (`office_store.gd:522-543`).

- Shape: `{ id, text, data?, time }` (`packages/schema/src/session-orchestration.ts:49-54`).
- `id` is branded `SessionTask.QuestionID` with prefix **`qst_`**
  (`session-orchestration.ts:57`), generated as `qst_${sha256(...)}`
  (`packages/core/src/session/orchestration.ts:672-677`).
- `data` is `AnswerData` = opaque `Schema.Json` of at most 8 KiB
  (`session-orchestration.ts:36-37,52`). It carries **no typed `options`**.
- Published from the orchestration task flow: `publish(childID, { type: "question_asked", question })`
  (`packages/core/src/session/orchestration.ts:706`). This is the **parent-answers-child** delegation
  flow; `canAutoAnswer` and the autonomous-answer branch sit in the same handler
  (`orchestration.ts:660-704`).
- Its answer surface is the subagent route:
  `POST /api/session/:parentID/subagent/:childID/question/:questionID/answer`
  (`packages/protocol/src/groups/session.ts:481-491`), params `questionID: SessionOrchestration.QuestionID`
  (`qst_`).

**Surface B — `QuestionV2` via `question.v2.asked`.** This is where typed options live.

- Request: `{ id, sessionID, questions: Info[], tool? }`
  (`packages/schema/src/question.ts:47-51`).
- `Info` = `{ question, header, options: Option[], multiple?, custom? }`
  (`question.ts:38-44`), `Option` = `{ label, description }` (`question.ts:20-26`).
  **The only typed labelled-option shape on the wire.**
- `id` is branded `QuestionV2.ID` with prefix **`que_`** (`question.ts:10`).
- Published by the question tool service: `events.publish(Event.Asked, request)`
  (`packages/core/src/question.ts:95-114`; event defined at `question.ts:70`).
- Its answer surface: `POST /api/session/:sessionID/question/:requestID/reply`
  (`packages/protocol/src/groups/question.ts:52-58`), params `requestID: Question.ID` (`que_`).

**The mismatch.** The office store creates the attention entry from Surface A (`office_store.gd:522-543`,
id from `change.question.id`, a `qst_`), but:

- `ui/conversation/conversation_panel.gd:290,296` reads `data["options"][].label` from the flat attention
  data. That path carries `question = {id, text, data, time}` — `options` is absent.
- `core/attention_queue.gd:100-112` reads `data["questions"][].options[].label`. That path exists only on
  Surface B.
- The reply route the transport calls is `Gateway.question_reply` →
  `/api/session/:sessionID/question/:requestID/reply` (`gateway_contract.gd:55-56`), whose
  `requestID` is a `que_` (`packages/protocol/src/groups/question.ts:54`) — but the only id the office
  holds from Surface A is a `qst_`. So even a rendered question could not be answered through that
  route.

**Consequence.** In LIVE a question renders with "No choices were supplied." and is unanswerable from
the office. Real user-facing, but the fix depends on which event is canonical.

**Decision needed (product, not this lane):**

1. Adopt Surface B for user-facing questions. Handle `question.v2.asked` in the store (new `Wire`
   constant + reducer arm), build the attention entry from `questions[].options[].label`, and keep
   `Gateway.question_reply` as the reply path (its `que_` id then matches). Surface A's `question_asked`
   would then be the parent/child notification flow only.
2. Adopt Surface A as canonical. Then the office must answer through the subagent route
   (`session.ts:481-491`) with the `qst_` id, and the composer must not offer typed choices the event
   cannot carry — the `options` read is removed and the opaque `Question.data` (if it ever carries
   choices) would need a documented decode.
3. Treat them as two different attention kinds (a session question vs a subagent question), each with
   its own id space, reply route, and renderer.

This lane did not choose among them: the choice changes the public answer surface, the wire constant
set, and the composer affordance, and it is explicitly a product decision in the task brief. No code
was changed for D4.

## Step 6 — final gate

`apps/office/tools/verify.sh` (cwd `/Users/viadz/Workspace/Project/ycoding`) after the fixes:

```
Godot: 4.7.2.stable.official.ed1daf0bf
import         exit=0 engine_errors=0
tests          exit=1 engine_errors=0
flow           exit=0 engine_errors=0
  passed: 6454  failed: 17  (tests)
  RESULT: FAILED
  checks: 34, failures: 0
  FLOW RESULT: PASSED
VERIFY: FAILED
```

`import` and `flow` pass with 0 engine errors; the tests stage reports `engine_errors=0`
(`SCRIPT ERROR` count 0, `Parse Error`/`Compile Error` count 0). All 17 `FAIL:` lines are
`test_chrome_toggles.gd` assertions (matching `grep -viE "surface|marked present|marked absent|clamped
scale|read Hide|both states"` → none). The gate is honestly NOT PASSED whole-suite; this lane's own
surface is fully green inside it.

`pgrep -fl Godot` after the gate: no process (clean release of the serialization lock).

## Additional finding caught by this lane's own fix (not in the brief)

The shipped DEMO fixture's `testing` beat (`fixtures/oauth-workplace.jsonl`, record `oauth-024`,
`activity.changed` → `testing`) was translated to `session.tool.called` with the same absent payload
shape: `fixture_translator.gd:148` emitted `{"tool": "shell"}`. The old store read that key, so the
demo appeared to work while LIVE never could. After D2, that payload would have silently regressed the
DEMO `testing` state to PROCESSING.

Fixed inside the owned `fixture_translator.gd` payload: the `TOOL_CALLED` branch now emits the real
pair — `session.tool.input.started` with `name: "shell"` first, then `session.tool.called` with the
shared `callID` and no name. The input start is dated `at_ms - 1` because `DemoTransport.load_fixture`
sorts with a non-stable comparator (`demo_transport.gd:41`) and both events would otherwise tie; the
causal order must not depend on the sort's tie-break. `test_office_store.gd`
`test_the_demo_testing_beat_reaches_testing` drives the real `DemoTransport` over the real shipped
fixture into the real store, asserts TESTING, asserts the actor stays `synthetic`, and asserts the
input-start index precedes the called index.

## Residual finding handed off (not this lane's path)

`apps/office/tests/suites/test_sidebar.gd:318` still feeds `session.tool.called` the absent
`{"tool": "read"}` payload for `test_the_team_row_surfaces_the_reported_activity`. It still passes, but
only because `apply_tool` falls back to the literal label `"tool"` when no name was announced, so the
assertion `activity is not empty` no longer proves the intended "the row says what the agent is
doing". `test_sidebar.gd` is not in this lane's owned paths and was not edited; its owner should move
the fixture to the `session.tool.input.started` + `callID` pair, as `test_office_store.gd` now does.
