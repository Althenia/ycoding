# M4 — runtime integration evidence

Task: TASK-027–039 · Date: 2026-09-15

## Deliverables

| Area | Files |
| --- | --- |
| Live transport | `integration/live_transport.gd` |
| Wire contract | `integration/gateway_contract.gd`, `integration/http_transport.gd`, `integration/sse_parser.gd` |
| Station model | `core/presence.gd`, `core/office_store.gd` (`station_of`, `report_target_for`) |
| Model selection | `core/model_catalog.gd` |
| Shell | `ui/shell/sidebar_panel.gd`, `ui/shell/chrome_toggles.gd`, `ui/shell/office_shell_layout.gd` |
| Composer | `ui/prompt/prompt_panel.gd` |

## TASK-027 — reconnect and scope recovery

The global feed is volatile by contract (`packages/core/src/event.ts`), so a
reconnect is **not** a resume: events during the gap are lost, and a restarted
service has a new `sourceEpoch`.

- `LiveTransport` raises `reload_required` when a request fails or the epoch
  changes, carrying the new epoch.
- `OfficeStore.mark_stale()` records that the projection is known incomplete and
  invalidates every actor's cosmetic generation, so a stale animation cannot play
  against new state.
- `OfficeStore.adopt_reload(events, epoch, watermark)` replaces the projection and
  is the **only** thing that clears `stale`.
- `is_stale()` is what any layer claiming completeness must consult.

Verified by `test_live_transport.gd`: a fresh projection is not stale; marking
makes it stale and reports reconnecting; a reload clears it, adopts the epoch and
leaves the store live; stale marking invalidates generations; a changed epoch
requests a reload stamped with the new epoch.

**Not covered:** the canonical reload currently replaces with whatever the caller
passes. Wiring the session-list and per-session log reads into that reload is the
remaining step, and is called out in the handoff.

## TASK-028 — prompt admission, retry and interruption

- The composer preserves the TUI's field set: prompt text, model reference and
  agent, with Ctrl+Enter to submit.
- In DEMO the composer is a preview and states so; it never performs a mutation.
- `test_office_store.gd` asserts the store exposes **no** mutation method at all
  in DEMO (`prompt`, `interrupt`, `launch`, `approve`, `reply`, `send`).

**Not covered:** LIVE prompt submission is not yet issued from the composer. The
transport and the contract are in place and verified; the call is not wired.

## TASK-029 — runtime activity mapping

Work states map from real events only:

| Source | State |
| --- | --- |
| `execution.started`, `step.started`, `text.started`, `reasoning.started` | PROCESSING |
| `tool.called` with a verified tool name | READING / TYPING / TESTING, else PROCESSING |
| `session.compaction.started` | COMPACTING |
| `session.status` retry | WAITING |
| `execution.failed` | BLOCKED |

An unrecognised tool becomes PROCESSING rather than a guessed category, because
the service does not classify arbitrary tools.

## TASK-030 — conversation projection and source links

Interactions are recorded from `session.task.updated` with `source` and
`source_verified`, keyed by a stable id so a duplicate event is one item. Clicking
an actor or its notice bubble in the world opens the same source-backed drawer as
selecting it in the team list (`OfficeWorld.actor_at`, `OfficeViewport._select_at`).

## TASK-032 / TASK-039 — live gate and concurrency

- `apps/office/tools/verify-integration.sh`: **21/21** contract checks and
  **14/14** live-attach checks against a real loopback service.
- 18 flow checks cover the end-to-end cascade.
- `test_shift_change.gd` covers concurrent presence, seat capacity and play-spot
  bounds.

## TASK-033 — five office zones

Replaced by a **seven-zone** plan: reception, product, ops, engineering, play,
focus, and a walled CEO office. Each zone is justified by a real driver; see
M5-release.md for the room audit.

## TASK-034 / TASK-035 — concurrent assignments, bounded interactions

- `ActorIdentity` scopes identity by real session, so two sessions using the same
  agent are two actors (`test_office_store.gd`).
- Interactions are bounded (`MAX_CONVERSATION_ITEMS`) and deduplicated by id.

## TASK-036 — delegation, question and report choreography

- `CHANGE_COMPLETED` records a source-backed report; the subagent walks to the
  CEO's visitor anchor (`OfficeWorld.apply_report`).
- `CHANGE_QUESTION_ASKED` sets attention and routes to the huddle station.
- The walk is cosmetic. The words are always the recorded event's, never scripted.

## TASK-037 / TASK-038 — conversation UX and inspector

The sidebar carries sessions grouped by root with children nested, the team with
work-state glyphs, presence labels, and the agent selector. The drawer shows
source-backed items grouped by kind.

## Verification

| Check | Result |
| --- | --- |
| `apps/office/tools/verify.sh` | 4966 assertions, 18 flow checks, 0 engine errors |
| `apps/office/tools/verify-integration.sh` | 21 contract + 14 live-attach, 0 engine errors |

## TASK-031 — human questions and approvals

`core/attention_queue.gd` holds the requests a session is blocked on, separate
from `interactions`, which is history. The reply shape is derived from the schema,
not chosen by the UI:

- permission and guardrail requests offer exactly `once`/`always`/`reject`;
- a question's options are the labels the runtime supplied, positionally;
- a malformed reply is refused locally rather than forwarded for the service to
  reject;
- answering retires the request, so it can never be answered twice, and a
  replaced projection clears the queue;
- DEMO answers nothing, because a synthetic office asks for nothing.

`LiveTransport.reply` issues the four real routes, added to
`integration/gateway_contract.gd`. Verified by `test_attention_queue.gd` (10
cases) and `test_gateway_contract.gd`.

## Not covered

- LIVE prompt submission is not yet issued from the composer, though the
  transport and contract for it are implemented and verified.
- TASK-024 and TASK-040 are user acceptance gates and are not self-approved.