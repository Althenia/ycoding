# R4-03 resumed audit — semantic choreography

Scope: read-only discovery of the delegate/work/question/report/review flow through
the reducer, the director and the animation queue, plus the one contained repair.
Task R4-03 is **NOT complete**. Defects 2-4 below are reported, not fixed.

Evidence classes: `verified_in_checkout`, `verified_at_runtime`, `proposed_target`.

## Boundary

Runtime authority is preserved. The director plans cosmetics only; nothing in the
animation path admits a prompt, answers a request, retries a provider attempt, or
writes session history. `OfficeDirector` cannot prompt, approve or launch. The
existing suite (`test_office_director.gd`) asserts attention preempts and never
queues, and that a late callback cannot revive a stale sequence.

## Traced flow, with owner paths

| Stage | Path |
|---|---|
| Wire vocabulary | `apps/office/core/wire.gd:19` `TASK_UPDATED`, `:54-69` `CHANGE_*` |
| Event -> canonical state | `apps/office/core/office_store.gd:832` `apply_task_change`; `:448` `apply_attention`; `:370` `apply` |
| Presentation record | `apps/office/core/actor_presentation.gd:52-56` `is_running`; `apps/office/core/work_state.gd`; `apps/office/core/presence.gd:29` `is_working` |
| Compose / act | `apps/office/app/main.gd:759` `_on_event`, `:781` `_react`, `:836` `_maybe_report`, `:851` `_enact_work`, `:880` `_enqueue`, `:890` `_promote_next`, `:943` `_tick_ambient` |
| Animation queue | `apps/office/office/director/office_director.gd:25` `plan`, `:73` `enqueue`, `:87` `dequeue`, `:105` `is_current`, `:116` `plan_ambient` (now `:125`) |
| World / animation | `apps/office/office/maps/hq/office_world.gd` `apply_work_state`/`apply_station`/`apply_report`/`apply_ambient`; `apps/office/office/actors/office_actor.gd` `set_route`/`_walk` |
| Schema authority | `packages/schema/src/session-orchestration.ts` (`Change`, `Question`); producers `packages/core/src/session/orchestration.ts:495,624,723-729,785-812` |

`Change` is a tagged union; `SessionOrchestration.Question` declares only
`{id, text, data?, time}`. `identities()` mints `inputID` as `msg_task_<hash>` distinct
from the child `sessionID` (`packages/core/src/session/orchestration.ts:207`), so the
store's `change.get("inputID", change.get("toolCallID", ""))` fallback is defensive
only and does not mis-key the event identity.

## Defect 1 — FIXED (this change)

Ambient life was offered to an actor still on shift.

`OfficeDirector.plan_ambient` excluded only `is_running()` and `attention_required`.
`is_running()` (`actor_presentation.gd:52-56`) is false for `WAITING` (a provider retry,
`office_store.gd:601`) and `BLOCKED` (a failed tool or assignment) — yet
`Presence.is_working` (`presence.gd:29`) keeps their seat and `station_of` returns the
desk for both. `main.gd:943` `_tick_ambient` skips only `attention_required`, so a
retrying or failed agent was sent to the focus chair or play room by
`apply_ambient` -> `apply_station` while its status said it was blocked.

Fix: `plan_ambient` now requires `actor.work_state == WorkState.Kind.IDLE`, which is the
one state with nothing in hand. Attention is still checked separately, because a
blocked-on-a-human actor is not necessarily non-IDLE on the wire.

### Tests and exact results

New case `test_ambient_is_withheld_from_an_actor_still_on_shift` in
`apps/office/tests/suites/test_office_director.gd`, registered in the suite's own
`run(t)`. No new suite file, so `tests/run_tests.gd` is untouched.

RED (predicate unfixed), single run of the repo runner:
`--headless --path apps/office --script res://tests/run_tests.gd`

    passed: 8968
    failed: 2
      FAIL: Waiting holds its seat rather than taking ambient life
      FAIL: Blocked holds its seat rather than taking ambient life
    RESULT: FAILED        engine_errors=0

Exactly the two intended failures; the IDLE positive case passed in the same run.

GREEN (predicate fixed):

    passed: 8970
    failed: 0
    RESULT: PASSED        engine_errors=0

Mutation probe, proving the IDLE positive case bites rather than passing by accident:
forcing the predicate true produced three failures, including
`an idle actor is still offered ambient life`, and the production file was restored
byte-identically (`sha256 824a6c9d...ea27` before and after).

Full neighboring gate, `apps/office/tools/verify.sh`:

    Godot: 4.7.2.stable.official.ed1daf0bf
    import         exit=0 engine_errors=0
    tests          exit=0 engine_errors=0
    flow           exit=0 engine_errors=0
      passed: 8970
      checks: 34, failures: 0
    VERIFY: PASSED

All runs serialized through `ycoding-office-repair-kit/tools/godot_lock.sh` and bounded
to 2048 MB. Runs are headless engine checks, not native captures, so the
`native_runtime` evidence R4-03 requires is still missing.

## Defect 2 — OPEN: an orchestration question is blank and unanswerable

`apply_task_change` pushes `change.question` into `AttentionQueue` with no `summary`
(`office_store.gd:856-872`), unlike `apply_attention`, which sets
`detail["summary"]` (`:448`). The drawer card reads `data.summary`
(`conversation_panel.gd:459`) and `_add_question_choices` reads `data.options`
(`:543`). An orchestration `Question` carries neither, so the user sees
"Needs you · Question" with an empty body and "No choices were supplied." The question
text does reach the interaction timeline via `record_interaction`, so only the
attention card is affected.

This matches the known cross-surface trap: typed option labels exist on the schema
question-request surface, not on the orchestration question carried by a task update.
Settle which surface is canonical before wiring a reply. Owner: `ui/conversation` plus
`app/main.gd` for the reply route — both outside this lane's write set.

## Defect 3 — OPEN: report target is computed and ignored

`OfficeStore.report_target_for` (`office_store.gd:188`, tested at
`test_shift_change.gd:204-209`) has no consumer. `OfficeWorld.apply_report` always
routes to the `ceo` station, and `main._maybe_report` decides only whether to move, not
where. A nested child therefore reports to the root's desk rather than its own parent's.
Reachable whenever a subagent has children. Fixing it needs `apply_report` to take the
target station and `main.gd` to pass `report_target_for` in — `main.gd` is owned by the
settings lane.

## Defect 4 — OPEN: write-only state in the composition root

`main.gd:82` `_pending` and `:83` `_active` are appended, erased and cleared but never
read. `_pending` is a second copy of the director's queue with no bound of its own; it
grows for the life of a session because a successful `enqueue` appends every time while
only the director's internal queue is drained. That is memory-growth territory (R8-02),
not a choreography-correctness defect. Owner: `app/main.gd`, outside this lane's write
set.

## Unknowns

- No native capture or video was produced, so the visual result of defect 1's fix at
  normal speed is unverified. It should be re-checked alongside R4-08.
- Whether `CHANGE_STARTED` should also assert a work state is unresolved
  (`work_state.gd:74-80` has no arm for `"started"`, and `apply_task_change` has no case
  for it), but its producer is not `SessionOrchestration.launch`, so no wire path was
  found that reaches the office app with it.
- `CHANGE_BACKGROUNDED` exists in the schema union with no office handling; no producer
  was found publishing it to this client.

## Not claimed

- R4-03 is not complete: defects 2 and 3 are semantic choreography gaps still open, and
  the required `native_runtime` evidence has not been produced.
- No fidelity claim is made against the supplied reference image. The existing
  `test_layout.gd` and `test_shell_layout.gd` pin reachability and region geometry; they
  are not fidelity evidence.