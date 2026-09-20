# R1-05 lane W — Stream, stop and surface errors (read-only brief)

Scope: deepen the STREAM and STOP paths only, from live code at HEAD a4bb99e.
Every claim cites `path:line`. Unverifiable items are marked **unverified**.

## Streaming path

### 1. Frame transport — correct and complete

- `HttpTransport.stream(path)` begins an SSE GET (`apps/office/integration/http_transport.gd:71`); `poll(budget_ms)` advances every in-flight request within a per-frame budget and returns entries since the last call (`http_transport.gd:79-88`).
- `SseParser.feed(chunk)` is byte-oriented and chunk-boundary safe: bytes buffer until a full line terminator, so a UTF-8 sequence split across reads is never decoded in isolation (`apps/office/integration/sse_parser.gd:26-60`). Only the blank line dispatches (`sse_parser.gd:111-122`); an unterminated event stays pending (`sse_parser.gd:64-71`).
- Frame kinds: one `event` per complete frame, one terminal `closed`, or `error` on failure (`http_transport.gd:25-27`, `208-223`). A non-JSON payload yields `data: null` with the reason in `error` but does **not** kill the stream (`http_transport.gd:228-238`).
- Oversize line (>1 MiB) sets `SseParser.last_error()` and drops the buffer (`sse_parser.gd:143-148`); the stream then fails with `SSE framing failed: <reason>` (`http_transport.gd:209-211`).
- **Partial frame cannot produce a wrong "finished" state at the transport layer.** An event still unterminated at close is discarded and reported in the `closed` entry's `error` field as `"unfinished trailing event discarded at end of stream"` (`http_transport.gd:220-223`). The transport never synthesises a completion from EOF.

### 2. Live envelope unwrapping — correct

- `LiveTransport._handle` unwraps the SSE envelope: on kind `event` it emits `envelope["data"]` (the decoded wire event) rather than the envelope, because the store consumes wire events that carry `type` (`apps/office/integration/live_transport.gd:128-147`). A payload that is not a Dictionary is dropped (`live_transport.gd:143-146`).
- On kind `error` it sets `CONNECTION_RECONNECTING`, reports the failure, and emits `reload_required` rather than pretending the feed resumed (`live_transport.gd:150-158`). This is the correct volatile-feed contract (`gateway_contract.gd:24-27`).

### 3. Store text handling — **streamed assistant text is dropped**

`OfficeStore.apply` (`apps/office/core/office_store.gd:264-321`) matches only some of the vocabulary declared in `Wire`.

Handled text-adjacent events:
- `session.text.started`, `session.reasoning.started` are grouped with `session.execution.started` / `session.step.started` into one `apply_activity(..., WorkState.Kind.PROCESSING, type)` call (`office_store.gd:285-286`). This sets only `actor.activity_label = event_type` (`office_store.gd:490-498`).

Content-carrying events declared in the wire vocabulary but **NOT matched anywhere in the store**:
- `session.text.delta` (`packages/schema/src/session-event.ts:428-437`)
- `session.text.ended` (`session-event.ts:439-447`)
- `session.reasoning.delta` (`session-event.ts:467-475`)
- `session.reasoning.ended` (`session-event.ts:478-486`)
- `session.step.ended`, `session.step.failed` — declared at `apps/office/core/wire.gd:21-22`, zero uses outside `wire.gd` (verified by grep).

`session.text.started`/`reasoning.started` are the only stream events the store knows, and they carry **no** `delta`/`text`; the model-visible text lives on `.delta`/`.ended`. Consequence: **partial text is neither accumulated nor rendered — it is silently discarded.** `ConversationPanel` (`apps/office/ui/conversation/conversation_panel.gd`) only ever renders `store.conversation_items()` for kinds `delegation|question|answer|report|review|file_change` (`conversation_panel.gd:14-24`) and there is no kind or row for assistant text; `conversation_items` filters the `interactions` array (`office_store.gd:211-213`), and no text event writes to it.

`session.text.delta`/`reasoning.delta` are declared `Event.ephemeral` (`session-event.ts:428,467`) — live-only, not in the durable log. `Event.ephemeral` survives `Event.latest()` because `latest` de-dupes by `type` only (verified by the analogous `SessionStatusEvent.Idle` contrast, not by executing the manifest; treat the manifest-membership claim as **unverified**). Regardless of manifest membership, `LiveTransport._emit` emits whatever the service frames (`live_transport.gd:203-205`), so the store would receive the delta if the service sends it; the store drops it because **no `match` arm exists**.

### 4. Malformed / partial frame → wrong "finished" state

- Store level: a malformed frame cannot mark *this actor* finished (no arm matches, so `apply` returns false). The risk is the opposite: **text is lost while the actor still flips IDLE** on a later `session.execution.succeeded`, so the UI shows a settled actor with no transcript item.
- `session.execution.succeeded` → `apply_settled(..., "succeeded")` (`office_store.gd:297`, `535-546`) sets `work_state = IDLE` and `settled_status = "succeeded"` from the wire alone, with no requirement that any assistant text was ever received. `session.execution.failed` → `"failed"` (`:298`), `session.execution.interrupted` → `"cancelled"` (`:299`). These are verbatim from the event, so a truncated stream followed by a real success event is not misreported *by the store*; but a truncated stream with **no** terminal execution event leaves the actor PROCESSING forever (no timeout at store level).
- **Kit rule check — "Mark finished from EOF alone": satisfied at the transport, not exercised end-to-end.** The transport never emits `closed`→finished, but there is no test proving no spurious completion via the full store path.

## Cancellation path

### Surfaces that exist

- `SessionApi.interrupt_session(session_id)` — POSTs `Gateway.interrupt(id)` = `/api/session/:sessionID/interrupt` with **no body**, returns `""` when issued or a reason when refused (`apps/office/integration/session_api.gd:110-126`; route `apps/office/integration/gateway_contract.gd:46-47`). Live route contract confirmed: `HttpApiEndpoint.post("session.interrupt", ...)` success `NoContent`, error `SessionNotFoundError`, "Idle interruption is a no-op" (`packages/protocol/src/groups/session.ts:970-981`).
- `SessionApi.poll(budget_ms)` routes responses/errors/closed and returns leftover entries (`session_api.gd:157-171`). Polled once per frame in LIVE (`apps/office/app/main.gd:595`).
- `OfficeMain.stop_session(session_id)` — the only composition-root entry point (`main.gd:756-759`). Refuses in DEMO with a stated reason (`main.gd:757-758`); otherwise delegates to `sessions_api.interrupt_session`.
- `OfficeMain._on_interrupt_failed(session_id, reason)` — reports a refusal through `prompt_panel.show_notice(reason)` (`main.gd:748-749`), connected at `main.gd:275`.

### Findings

1. **No UI control invokes stop.** `stop_session` has **zero callers** anywhere in `apps/office` (grep across all `.gd`: only its own definition at `main.gd:756`). There is no Stop button: `PromptPanel` builds only `_attach`, `_approval`, `_pill`, `_send` (`apps/office/ui/prompt/prompt_panel.gd:92-114`); `SidebarPanel` and `ChromeToggles` have no stop control (grep: no matches). `test_composer_submit.gd:286-287` pins only the send control. Consequence: **the user has no way to cancel from the desktop**; the API path is unreachable from the UI.

2. **The successful path is never surfaced.** `SessionApi.interrupted` (`session_api.gd:23`) is **not connected** in `main.gd` — only `session_created`, `create_failed`, and `interrupt_failed` are (`main.gd:273-275`). So if the request were reachable, a 204 acknowledgement would produce no user-visible confirmation at all.

3. **No local animation is stopped, because there is none to stop.** `_send` is a plain button (`prompt_panel.gd:113-114`); there is no typewriter/reveal machinery (grep for `typewriter|visible_characters|reveal` finds only unrelated art code). So the kit's specific anti-pattern — "stopping the typewriter animation is not cancellation" — is **not committed**; the current failure is worse in a different way: there is no stop affordance at all.

4. **Runtime acknowledgement is genuinely awaited where the request exists.** The client does not optimistically set state on stop: `interrupt_session` only records the intent (`session_api.gd:121-123`) and state changes are driven by the runtime's durable `session.execution.interrupted` event (`office_store.gd:299`) or by the `interrupted` signal (unconnected). A refusal is surfaced (`session_api.gd:199-204,221-223` → `main.gd:748-749`). So the kit rule "Stop requires runtime acknowledgement or reconciliation" is **satisfied in the API/transport layer** and **vacuous at the UI layer** because no UI reaches it.

5. **Partial history.** There is no assistant-text history to preserve (streaming gap above). `apply_settled(..., "cancelled")` sets IDLE + `settled_status = "cancelled"` (`office_store.gd:299,535-546`); the status is recorded but `settled_status` is only asserted by `tools/flow_check.gd:190` and `test_office_store.gd:154` — it is not rendered anywhere in `ui/` (grep: no `settled_status` in `ui/`). No reconciliation of an admitted-but-unfinished prompt exists (that is R1-04 scope).

6. **Unknown/idle interrupt.** `SessionApi.last_error()` distinguishes a 404 refusal naming the session (`session_api.gd:199-204`); an idle session returns 204 and is reported as `interrupted` even though nothing was running — matching the route contract's no-op ("Idle interruption is a no-op", `session.ts:980`).

## Ranked gap list

Ranking: correctness impact on R1-05's acceptance ("Render provider output progressively where supported; stop is server-owned; timeout/rate-limit/auth errors remain visible") × rollback cost. Every item is a required behavior from the kit matrix, not polish.

### G1 — Streamed assistant text is never accumulated or rendered (matrix: "Malformed/partial stream", "real streamed updates")

- **Missing:** no store arm for `session.text.started`/`.delta`/`.ended` or `session.reasoning.started`/`.delta`/`.ended`, and no conversation item kind that can hold assistant text.
- **Change:** `apps/office/core/office_store.gd:283-321` (add `Wire.TEXT_STARTED/DELTA/ENDED`, `Wire.REASONING_STARTED/DELTA/ENDED` arms); `apps/office/core/wire.gd:20-30` (declare the six constants); a new `record_interaction` path keyed by `assistantMessageID`+`ordinal`; `apps/office/ui/conversation/conversation_panel.gd:14-24` (`KIND_LABELS`/`KIND_ORDER`) to render the assistant item.
- **Corrected behavior:** accumulate `delta` per `assistantMessageID`/`ordinal` in a bounded buffer; on `.ended` replace the accumulation with the durable `text` (`session-event.ts:439-447`); never render `session.reasoning.*` as conversation content (kit: "Do not expose hidden model reasoning as conversation content"); mark an item incomplete if the stream ends without `.ended`. Live-only deltas must not be treated as durable history; on reload the durable `.ended` value is the source.
- **Proof:** store unit test in `apps/office/tests/suites/test_office_store.gd` feeding started→delta→delta→ended and asserting the accumulated value and the incomplete marker on delta-without-ended. Native capture of a real stream is R1-06.

### G2 — Stop has no UI affordance and no acknowledgement surface (matrix: "Cancellation")

- **Missing:** `stop_session` has zero callers; `SessionApi.interrupted` is unconnected.
- **Change:** add a Stop control in `apps/office/ui/prompt/prompt_panel.gd:107-115` (beside `_send`), emit a new `stop_requested` signal, connect it in `apps/office/app/main.gd:102-121` (`_wire_signals`); connect `sessions_api.interrupted` at `apps/office/app/main.gd:273-275` and surface it via `prompt_panel.show_notice`.
- **Corrected behavior:** pressing Stop calls `stop_session(selected_session)`; the control is enabled only in LIVE with a running session and disabled with a stated reason otherwise (per `apps/office/AGENTS.md` truthfulness rule); the 204 acknowledgement and any refusal both become visible. Do **not** set local IDLE on press — state remains runtime-owned via `session.execution.interrupted` (`office_store.gd:299`).
- **Proof:** `test_composer_submit.gd`-style unit test asserting the signal path and that no local state changes before the runtime event; store unit test asserting `execution.interrupted` → `settled_status == "cancelled"` (already covered at `test_office_store.gd:154` region — extend, do not duplicate).

### G3 — Clean stream close is ignored; a dead feed can still show LIVE (matrix: "Timeout/disconnect")

- **Missing:** `LiveTransport._handle` has no `kind == "closed"` branch (`apps/office/integration/live_transport.gd:128-158`), even though `HttpTransport` emits `KIND_CLOSED` on a clean stream end (`apps/office/integration/http_transport.gd:223`).
- **Change:** `apps/office/integration/live_transport.gd:150-158` — on `closed`, set `CONNECTION_RECONNECTING`, report the reason (including the trailing-event discard note), and emit `reload_required`.
- **Corrected behavior:** a server-closed feed is an uncertain/reconnecting state, never a live one, and rejoins via the canonical reload (`live_transport.gd:213-225`).
- **Proof:** `apps/office/tests/suites/test_live_transport.gd` — feed a `closed` entry and assert `connection_changed` reconnecting + `reload_required` emitted. (Distinct from the existing `error` test at `test_live_transport.gd:253`.)

### G4 — Error payloads are discarded; auth/model/rate-limit errors are not actionable (matrix: "Provider auth/model error", "Rate limit/quota")

- **Missing:** `apply_settled` ignores `data` (`office_store.gd:297-299,535-546`); `session.retry.scheduled` (`packages/schema/src/session-event.ts:605-616`) is unmatched; `session.status` retry metadata is dropped (`office_store.gd:475-488` keeps only `status.type`).
- **Change:** `office_store.gd:297-299` pass `data["error"]` (shape `{type, message}`, `packages/schema/src/session-error.ts:6-9`) into `last_error`/a settled detail; `office_store.gd:475-488` retain `attempt`/`message`/`next`/`action` (`packages/schema/src/session-status-event.ts:15-32`); add a `Wire.RETRY_SCHEDULED` constant and arm rendering `attempt`/`at` (`session-event.ts:605-616`).
- **Corrected behavior:** a failed execution shows the sanitized runtime message; a retry shows the attempt and the runtime-supplied next/action only when actually supplied; never invent a reset time (kit matrix).
- **Proof:** `test_office_store.gd` — `execution.failed` with `error.message` asserts it reaches the surfaced error; `session.status` retry asserts attempt/next retained; absent fields stay absent.

### G5 — Local 401/403, provider auth, and "service unreachable" are one flat string (matrix: "Local service 401/403", "Local service unavailable")

- **Missing:** `LiveTransport._on_response` formats every non-2xx as `"The service returned HTTP %d."` (`live_transport.gd:172-176`); there is no distinction between the local service being absent, unauthorized, or refusing on the provider's behalf.
- **Change:** `apps/office/integration/live_transport.gd:170-176` (and the stream rejection at `http_transport.gd:128-131` surfaces via `_handle` `error`) branch 401/403 into an auth classification; `apps/office/app/main.gd:207-213` already distinguishes "no registration".
- `OfficeMain._enter_disconnected_live(message)` sets `store.last_error` to `NO_SERVICE_MESSAGE` ("No local service registration found (service.json). Start it with `ycoding service start`, then retry.") when no message is supplied (`apps/office/app/main.gd:14-19,209-218`).
- **Corrected behavior:** three distinguishable states — no local service (registration absent, as above), local service 401/403 (connection/auth path, `sidebar_panel.gd:277-284`), and provider refusal (sanitized runtime message, G4).
- **Proof:** `test_live_transport.gd` unit feeding a 401 health response and asserting the auth classification; `test_production_boot.gd` already covers the absent-registration state.

### G6 — Hard guardrail reviews offer an `always` reply (matrix: "Tool permission/review" — "Auto-approve hard review")

- **Missing:** the drawer offers all three literals for both kinds (`apps/office/ui/conversation/conversation_panel.gd:55,268-280`) and ignores `Guardrail.Request.hardReview` (`packages/schema/src/guardrail.ts:57-59`), which the store already retains in the request data (`office_store.gd:331-345`).
- **Change:** `conversation_panel.gd:265-280` — when `hardReview` is true, offer only `once`/`reject`.
- **Corrected behavior:** a hard review exposes only one-time approval or rejection; the runtime remains the enforcing authority.
- **Proof:** **no existing suite covers the attention reply row** (grep: zero tests reference `attention_replied`/`REVIEW_REPLIES`; `test_office_store.gd:436` asserts only that a guardrail review is pending). Add the case to `apps/office/tests/suites/test_conversation.gd`.

### G7 — Oversize-frame failure is fatal to the whole stream (matrix: "Malformed/partial stream")

- **Missing:** an oversize line (>1 MiB) sets `SseParser.last_error()` (`sse_parser.gd:143-148`) and the stream fails (`http_transport.gd:209-211`), losing the connection; preserved partial text is then only recoverable by reload.
- **Change:** `apps/office/integration/sse_parser.gd:40-58` — consider discarding the offending frame and continuing vs failing; at minimum `LiveTransport` already routes the failure to `reload_required` (`live_transport.gd:150-158`), so the corrected behavior is that the connection must rejoin rather than silently end.
- **Corrected behavior:** valid partial text received before the oversize frame is not lost; incomplete/error status is shown.
- **Proof:** `test_sse_parser.gd` + `test_live_transport.gd`.

### G8 — `step.*` / `compaction.delta` vocabulary is declared but unmatched

- **Missing:** `Wire.STEP_ENDED`/`STEP_FAILED` declared with zero uses (`wire.gd:21-22`); `session.compaction.delta` absent from `Wire` and the store. This is lower impact because step boundaries are derivable from execution/text events.
- **Change:** only if a required matrix behavior needs it; otherwise leave and note. Do not add dead arms.

### G9 — Settled status is recorded but never rendered

- **Missing:** `settled_status` is set (`office_store.gd:541`) but no `ui/` file reads it (grep: zero hits in `ui/`). Cancellation/failure/success are therefore invisible except through the sidebar's `last_error`.
- **Change:** surface settled status in the conversation drawer or actor status; coordinate with R2-03's Send/Stop control.
- **Proof:** a sidebar/conversation render test.

**Dependency note:** G1 and G2 are the R1-05 acceptance core. G3–G5 are the error-matrix requirements. G6 is a safety requirement but independently gated (server-side enforcement already exists). G8/G9 are conditional/lower priority.

## Already correct — do not rewrite

1. **SSE framing (`sse_parser.gd`)** — byte-oriented, chunk-boundary safe, WHATWG field syntax, CRLF/CR/LF handling, comment/heartbeat skipping, unknown fields ignored, one leading space stripped (`sse_parser.gd:26-127`). Unterminated event stays pending (`:64-71`). Tested in `test_sse_parser.gd`.
2. **Bounded non-blocking transport (`http_transport.gd`)** — per-frame budget, one poll per request, body drained until budget spent, no caller blocks (`http_transport.gd:79-88,112-134,160-172`). Connect timeout for streams vs request timeout for JSON (`:29-30,117-127`).
3. **One terminal entry per request** — `response` or `error` for JSON; `event`* → `closed` or `error` for streams (`http_transport.gd:175-223,275-283`). `cancel` drops late results (`:92-98`).
4. **SSE envelope unwrapping** — the wire payload is emitted, not the envelope, with the reasoning documented (`live_transport.gd:128-149`).
5. **Volatile-feed recovery design** — on stream error: reconnecting state + `reload_required`; canonical reload re-lists sessions and replays each durable log until the `log.synced` watermark (declared `gateway_contract.gd:91`), emitting `reload_ready` only when every log answered (`live_transport.gd:150-158,213-296`; `gateway_contract.gd:24-27,69,91`). `OfficeStore.mark_stale`/`adopt_reload` one-way staleness (`office_store.gd:720-756`). This is fully correct; reuse it.
6. **No wrong "finished" from EOF** — the transport discards an unfinished trailing event and reports it (`http_transport.gd:220-223`); the store never synthesises `succeeded/failed/cancelled` except from the real terminal events (`office_store.gd:297-299`).
7. **Interrupt API contract** — no-body POST to the correct route, `""`/reason returns, 204 success, 404 refusal naming the session, no local state mutation, refusal surfaced (`session_api.gd:110-126,194-228`; tests in `test_session_api.gd`).
8. **Tool-name correlation and tool state** — `session.tool.input.started` → `learn_tool_name` bounded at 64, applied by `callID` (`office_store.gd:506-533`); correct per schema.
9. **Attention queue** — permission/guardrail asked are recorded answerable (`office_store.gd:331-355`) and retired on reply (`apps/office/app/main.gd:435-442`; runtime-answered question at `office_store.gd:591-596`; `attention_queue.gd:46-79`).
10. **Epoch invalidation** — an epoch change discards cursors without discarding history and never claims a watermark (`office_store.gd:270-279,760-772`).
11. **No typewriter/animation-only cancellation** — nothing to un-do; the anti-pattern the kit warns about is absent from the codebase.

## Unknowns

- **Whether the service actually emits `session.text.delta` to `/api/event`.** The schema declares it `Event.ephemeral` (`session-event.ts:428`); `Event.ephemeral` events may or may not appear in `Event.latest(Definitions)` (de-dupe rule not executed). The store's missing arm is a defect either way, but whether a live run would observe the deltas is **unverified** and cannot be resolved without sending a model request (forbidden here). R1-04/R1-06 must confirm.
- **Whether `session.execution.failed`/`session.status retry` carry an actionable `message` in practice** — shape verified (`session-error.ts:6-9`, `session-status-event.ts:15-32`), live payload **unverified**.
- **Whether `hardReview` is actually set by the runtime** — field declared optional (`guardrail.ts:59`), never observed live. **Unverified.**
- **Native rendering / capture evidence** — none produced (no Godot run permitted; another lane holds the lock). All proof notes are headless-suite boundaries.
- **Godot test harness invocation** — the exact headless command is `"$GODOT_BIN" --headless --path apps/office --script res://tests/run_tests.gd` (`apps/office/AGENTS.md` Verification). Not run here per lane constraints; the implementer must run it.

<!-- SECTION-END:END -->