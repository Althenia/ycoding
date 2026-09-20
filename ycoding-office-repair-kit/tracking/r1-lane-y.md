# R1-05 lane Y — streamed text + Stop (implementation)

Complete this note as work proceeds. Flush after every step.

## Baseline

- Repo `/Users/viadz/Workspace/Project/ycoding`, git `main`, HEAD `a4bb99e`.
- Tree is DIRTY from other lanes (no git mutations performed).
- Baseline suite: 6834 passed, 0 failed, 0 parser errors. (to be confirmed live)

## Defect A — streamed text never accumulated/displayed (REAL)

Live schema contract (`packages/schema/src/session-event.ts`):
- `Text.Started` durable `{assistantMessageID, ordinal, phase?}` (~line 414)
- `Text.Delta` EPHEMERAL `{assistantMessageID, ordinal, delta: String}` (~line 428)
- `Text.Ended` durable `{assistantMessageID, ordinal, text: String, phase?}` (~line 439)
  comment: "Stream fragments are live-only; Text.Ended is the replayable full-value boundary."
- `Reasoning.Started`/`Delta`/`Ended` mirror the above (~455-486).

Wrong behaviour with `file:line`:
- `apps/office/core/wire.gd:26-27` declares ONLY `TEXT_STARTED` / `REASONING_STARTED`.
- `apps/office/core/office_store.gd:285-286` folds started events into `apply_activity(...)`
  (sets `actor.activity_label = event_type`), carrying no text.
- No `match` arm exists for `session.text.delta|ended` or `session.reasoning.delta|ended`,
  so streamed content is silently discarded.
- `conversation_panel.gd:14-24` `KIND_LABELS`/`KIND_ORDER` have no assistant/reasoning kind.

## Defect B — no Stop affordance (REAL)

- `apps/office/app/main.gd:756-759` `stop_session` has ZERO callers (grep over all `.gd`).
- `SessionApi.interrupted` (`integration/session_api.gd:23`) is not connected in `main.gd`
  (only `session_created`, `create_failed`, `interrupt_failed` near `main.gd:273-275`).
- `ui/prompt/prompt_panel.gd:92-114` builds only attach/approval/pill/send; no Stop.

## Defect C — cleanly closed feed still shows LIVE (REAL)

- `integration/http_transport.gd:223` emits `KIND_CLOSED` (`const KIND_CLOSED := "closed"`, line 27)
  on a clean stream end.
- `integration/live_transport.gd:_handle` matches only `response`, `event`, `error`.
  A `closed` entry therefore falls through with no connection-state change, so a dead feed
  keeps `CONNECTION_LIVE`.

## Fixes applied (to be recorded)

<!-- filled in as each edit lands -->