# R0-03 (lane I) — office wire contract vs live protocol

Read-only verification. Repo `/Users/viadz/Workspace/Project/ycoding`, branch `main`, HEAD `a4bb99e`.
Sources cited as `path:line`. "unverified" means not established live.

Scope note: `contracts/wire-audit.json` does not exist in the repository or in the kit
(`ls ycoding-office-repair-kit/contracts/` → only `verification-cases.json`), yet
`apps/office/AGENTS.md:9` names it as the wire reference and `apps/office/core/wire.gd:1`
names it as the source of its constants. `core/wire.gd:3-4` names the true sources.

## 1. Event vocabulary

All 28 event-name constants, all 9 `SessionOrchestration.Change` member constants and all 3
`SessionStatusEvent` status constants in `apps/office/core/wire.gd` resolve to real live names
(40 scalar constants total; the two remaining constants are the `EXECUTING_EVENTS` and
`SETTLING_EVENTS` groupings of those same names).

Concurrency note: the working tree changed while this lane ran. `apps/office/AGENTS.md`,
`apps/office/core/wire.gd`, `apps/office/integration/fixture_translator.gd`,
`apps/office/integration/gateway_contract.gd` and `apps/office/tests/suites/test_gateway_contract.gd`
were modified after this lane's first read (verified with `git status --porcelain` and `git diff`).
The constant *values* in `wire.gd` are unchanged by that edit (only the header comment moved), so the
table below is valid for both HEAD and the working tree. The `guardrail_reply` and provenance
findings are reported with their HEAD state and their correction noted in D1/D7.

| office constant | value | real? | live source | verdict |
| --- | --- | --- | --- | --- |
| `CONNECTED` (`wire.gd:10`) | `server.connected` | yes | `packages/schema/src/server-event.ts:5` | exact |
| `SESSION_CREATED` (`:11`) | `session.created` | yes | `packages/schema/src/session-event.ts:52` | exact |
| `SESSION_STATUS` (`:12`) | `session.status` | yes | `packages/schema/src/session-status-event.ts:36` | exact |
| `EXECUTION_STARTED` (`:13`) | `session.execution.started` | yes | `session-event.ts:247` | exact |
| `EXECUTION_SUCCEEDED` (`:14`) | `session.execution.succeeded` | yes | `session-event.ts:250` | exact |
| `EXECUTION_FAILED` (`:15`) | `session.execution.failed` | yes | `session-event.ts:254` | exact |
| `EXECUTION_INTERRUPTED` (`:16`) | `session.execution.interrupted` | yes | `session-event.ts:261` | exact |
| `TASK_UPDATED` (`:17`) | `session.task.updated` | yes | `session-event.ts:294` | exact |
| `STEP_STARTED` (`:18`) | `session.step.started` | yes | `session-event.ts:366` | exact |
| `STEP_ENDED` (`:19`) | `session.step.ended` | yes | `session-event.ts:379` | exact |
| `STEP_FAILED` (`:20`) | `session.step.failed` | yes | `session-event.ts:396` | exact |
| `TOOL_CALLED` (`:21`) | `session.tool.called` | yes | `session-event.ts:531` | exact |
| `TOOL_SUCCESS` (`:22`) | `session.tool.success` | yes | `session-event.ts:558` | exact |
| `TOOL_FAILED` (`:23`) | `session.tool.failed` | yes | `session-event.ts:572` | exact |
| `TEXT_STARTED` (`:24`) | `session.text.started` | yes | `session-event.ts:415` | exact |
| `REASONING_STARTED` (`:25`) | `session.reasoning.started` | yes | `session-event.ts:454` | exact |
| `INPUT_ADMITTED` (`:26`) | `session.input.admitted` | yes | `session-event.ts:226` | exact |
| `INPUT_PROMOTED` (`:27`) | `session.input.promoted` | yes | `session-event.ts:216` | exact |
| `FILE_CHANGE` (`:28`) | `session.file-change.recorded` | yes | `session-event.ts:595` | exact |
| `COMPACTION_STARTED` (`:32`) | `session.compaction.started` | yes | `session-event.ts:706` (v2) / `:630` (v1) | exact |
| `COMPACTION_ADMITTED` (`:33`) | `session.compaction.admitted` | yes | `session-event.ts:699` / `:620` | exact |
| `COMPACTION_ENDED` (`:34`) | `session.compaction.ended` | yes | `session-event.ts:713` / `:651` | exact |
| `COMPACTION_FAILED` (`:35`) | `session.compaction.failed` | yes | `session-event.ts:726` / `:680` | exact |
| `SESSION_DELETED` (`:39`) | `session.deleted` | yes | `session-event.ts:171` | exact |
| `SESSION_ARCHIVED` (`:40`) | `session.archived` | yes | `session-event.ts:181` | exact |
| `SESSION_UNARCHIVED` (`:41`) | `session.unarchived` | yes | `session-event.ts:191` | exact |
| `PERMISSION_ASKED` (`:53`) | `permission.v2.asked` | yes | `packages/schema/src/permission.ts:43` | exact |
| `GUARDRAIL_ASKED` (`:54`) | `guardrail.asked` | yes | `packages/schema/src/guardrail.ts:83` | exact |

`SessionOrchestration.Change` tagged-union members (`wire.gd:44-59`), live
`packages/schema/src/session-orchestration.ts:181-206`: `launched` (`:181`), `started` (`:193`),
`backgrounded` (`:194`, not declared in office), `progressed` (`:195`), `question_asked` (`:196`),
`question_answered` (`:197`), `cancel_requested` (`:198`, not declared), `cancelled` (`:199`),
`completed` (`:200`), `failed` (`:202`), `lost` (`:206`). All office `CHANGE_*` values (44-59) are
exact members.

`STATUS_*` (`wire.gd:62-64`) are the `SessionStatusEvent.Info` literals: `idle` (`session-status-event.ts:11`),
`retry` (`:14`), `busy` (`:30`). Exact. Note the office models status as a bare string; live shape is
`{ sessionID, status: { type: "idle" | "busy" | "retry", … } }` (`session-status-event.ts:36-41`), i.e.
the discriminant lives one level down at `status.type`, not at the event root.

`EXECUTING_EVENTS` / `SETTLING_EVENTS` (`wire.gd:67-77`) are client-internal groupings of exact names.

Unused-but-real live names relevant to the same surfaces (client coverage gap, not a wire defect):
`session.text.delta`, `session.reasoning.delta`, `session.tool.input.started|delta|ended`,
`session.tool.progress`, `session.retry.scheduled`, `session.agent.selected`, `session.model.selected`,
`session.forked`, `session.moved`, `session.renamed`, `session.input.consumed`,
`session.context.observed`, `session.skill.activated|deactivated`, `session.shell.started|ended`,
`session.revert.staged|cleared|committed`, `session.compaction.replaced`, `session.usage.updated`,
`session.diagnostics.updated`, `question.v2.asked` (`packages/schema/src/question.ts:70`),
`permission.v2.replied`, `guardrail.replied`, `global.disposed`.

## 2. Route inventory

Every route the office client can call, from `apps/office/integration/gateway_contract.gd`
(constants and path builders; `session_api.gd` and `model_catalog_api.gd` re-use
`Gateway` and declare no path of their own — `session_api.gd:56,61`, `model_catalog_api.gd:26`).

| office path (builder :line) | method used | live operation | live path | method match | live file:line | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/health` (`gateway_contract.gd:15`) | GET (`live_transport.gd:96`) | `health.get` | `/api/health` | yes | `packages/protocol/src/groups/health.ts:30` | exact |
| `/api/event` (`:23`) | GET stream (`live_transport.gd:97`) | `event.subscribe` | `/api/event` | yes | `packages/protocol/src/groups/event.ts:36` | exact |
| `/api/session` (`:17`) | GET (`live_transport.gd:222`) | `session.list` | `/api/session` | yes | `packages/protocol/src/groups/session.ts:263` | exact |
| `/api/session` (`:17`) | POST (`session_api.gd:108`) | `session.create` | `/api/session` | yes | `session.ts:283` | exact |
| `/api/session/active` (`:18`) | GET — **never called** | `session.active` | `/api/session/active` | yes | `session.ts:302` | exact but unused |
| `/api/model` (`:27`) | GET (`model_catalog_api.gd:26,105`) | `model.list` | `/api/model` | yes | `packages/protocol/src/groups/model.ts:10` | exact |
| `/api/session/{id}` (`:29-30`) | — **never called** | `session.get` | `/api/session/:sessionID` | yes | `session.ts:314` | exact but unused |
| `/api/session/{id}/snapshot` (`:32-33`) | — **never called** | `session.snapshot` | `/api/session/:sessionID/snapshot` | yes | `session.ts:329` | exact but unused |
| `/api/session/{id}/message` (`:35-36`) | — **never called** | `session.messages` | `/api/session/:sessionID/message` | yes | `packages/protocol/src/groups/message.ts:9` | exact but unused |
| `/api/session/{id}/prompt` (`:38-39`) | POST (`live_transport.gd:313`) | `session.prompt` | `/api/session/:sessionID/prompt` | yes | `session.ts:610` | exact |
| `/api/session/{id}/interrupt` (`:41-42`) | POST (`session_api.gd:61,132`) | `session.interrupt` | `/api/session/:sessionID/interrupt` | yes | `session.ts:970` | exact |
| `/api/session/{id}/model` (`:47-48`) | POST (`live_transport.gd:336-340`) | `session.switchModel` | `/api/session/:sessionID/model` | yes | `session.ts:561` | exact |
| `/api/session/{id}/subagent` (`:50-51`) | — **never called** | `session.subagent.list` | `/api/session/:parentID/subagent` | yes | `session.ts:437` | exact but unused |
| `/api/session/{s}/question/{r}/reply` (`:55-56`) | POST (`live_transport.gd:361`) | `session.question.reply` | same | yes | `packages/protocol/src/groups/question.ts:52` | exact |
| `/api/session/{s}/question/{r}/reject` (`:58-59`) | POST (`live_transport.gd:384`) | `session.question.reject` | same | yes | `question.ts:68` | exact |
| `/api/session/{s}/permission/{r}/reply` (`:61-62`) | POST (`live_transport.gd:363`) | `session.permission.reply` | same | yes | `packages/protocol/src/groups/permission.ts:119` | exact |
| `/api/session/{s}/guardrail/{r}/reply` (HEAD `gateway_contract.gd:64-65`) | POST (`live_transport.gd:365`) | `session.guardrail.request.reply` | `/api/session/:sessionID/guardrail/**request**/:requestID/reply` | yes | `packages/protocol/src/groups/guardrail.ts:43-45` | **was MISSING the `request` segment at HEAD (404) — already corrected in the working tree, see the concurrency note below** |
| `/api/experimental/session/{id}/log?after=&follow=` (`:69-74`) | GET stream (`live_transport.gd:247`) | `session.log` | `/api/experimental/session/:sessionID/log` | yes | `session.ts:948-953` | exact |

Kit's SSE claim about the log route is **verified live**: `session.ts:953` declares
`success: HttpApiSchema.StreamSse({ data: SessionLogItem })`, not a JSON body. `after` is
`NumberFromString` decoded to `Event.Seq` and **optional** (`session.ts:950-951`); `follow` is
`BooleanFromString` = the literals `"true"`/`"false"` and **optional** (`session.ts:951`). The
office always sends both (`gateway_contract.gd:69-74`), which the live route accepts, and
`live_transport.gd:243-247` opens it with `stream()` rather than `request()` — correct.

Route-count summary: 18 distinct office route/method combinations. **At HEAD, 1 does not exist live**
(the guardrail reply path); the working tree has already corrected it, so 0 remain. 5 exist but are
never called by any production path (`session.active`, `session.get`, `session.snapshot`,
`session.messages`, `session.subagent.list`). No method mismatches.

Additional live-adjacent facts verified:

- `Packages/protocol/src/groups/session.ts:610-621` — `session.prompt` payload is
  `{ id?: SessionMessage.ID, text, files?, agents?, metadata?, delivery?, resume? }`
  (`PromptInput.Prompt.fields` = `text` required, `files?`, `agents?` —
  `packages/schema/src/prompt-input.ts:22-26`). `live_transport.gd:312` sends
  `{"text", "delivery"}` plus optional `"id"` — all declared fields. `delivery` values are
  `"steer"|"queue"` (`packages/schema/src/session-delivery.ts:5`), matching
  `gateway_contract.gd:125-126`. Success is `{data: SessionPending.User}` (`session.ts:618`),
  which the office never reads (fire-and-forget) — not a defect, but unverified parsing.
- `session.ts:563` — `session.switchModel` payload is `{ model: Model.Ref }`;
  `live_transport.gd:333-341` sends exactly `{"model": {providerID, id, variant?}}`, and
  `Model.Ref` is `{ id, providerID, variant? }` (`packages/schema/src/model.ts:14-18`). Match.
- `session_api.gd:83-91` — create body sends `location: {directory}` and `model: {providerID,id,variant?}`.
  `Session.create` accepts `location?: Location.Ref` (`session.ts:286`) and `Model.Ref`; `Location.Ref`
  is `{ directory: AbsolutePath, workspaceID? }` (`packages/schema/src/location.ts:9-12`). Match.
- `session.ts:970-973` — `session.interrupt` declares no payload and returns
  `HttpApiSchema.NoContent`; `session_api.gd:129-132` sends `{}` (transport omits the body when the
  dictionary is empty — `http_transport.gd:303`). Match.
- SSE framing: `packages/server/src/event-feed.ts:36` emits `data: <json>\n\n` only — no `id:`,
  `event:` or `retry:` field, and `:78` emits `": keep-alive\n\n"` as a comment heartbeat. Matches
  `gateway_contract.gd:104-107` and `sse_parser.gd:11-13,80-82`. `event-feed.ts:36` merges
  `sourceEpoch` into every event payload.
- `gateway_contract.gd:69` always sends `after`; `live_transport.gd:247` passes `after=0`, i.e. the
  exclusive-sequence form "everything from the start", which the route documents
  (`session.ts:958-960`). Correct, though it means a client with a watermark does not use it here.

## 3. Response envelope shapes

Verdict: **the kit's trap claim is correct as a statement about the live protocol**, but no office
client code reads the snapshot at all, so the client cannot be said to parse it correctly or
incorrectly. There is no wrong-envelope parse in the current tree.

| route | live envelope | live file:line | client parse | client file:line |
| --- | --- | --- | --- | --- |
| `session.list` | `{ data: [...], cursor: { previous?, next? } }` | `session.ts:265-272`; server `packages/server/src/handlers/session.ts:58-61` | `body["data"]` | `live_transport.gd:234` (`_begin_session_replays`) |
| `session.active` | `{ data: Record<SessionID, SessionActive> }` | `session.ts:303` | none | not called |
| `session.get` | `{ data: Session.Info }` | `session.ts:316` | none | not called |
| `session.create` | `{ data: Session.Info }` | `session.ts:289` | `body["data"]["id"]` | `session_api.gd:186-188` |
| `session.snapshot` | **top level** `{ sourceEpoch, session, messages, watermark }` — no `data` | `session.ts:247-252`; server `handlers/session.ts:138-139` (`return { sourceEpoch: identity.sourceEpoch, ...projection }`) | none | not called |
| `session.messages` (list) | `{ data: Array<SessionMessage.Info> }` — **no `cursor`** | `message.ts:11-15` | none | not called |
| `session.message` (one) | `{ data: SessionMessage.Info }` | `session.ts:1001-1003` | none | not called |
| `model.list` | `{ location: Location.Info, data: Array<Model.Info> }` | `model.ts:10-12` via `Location.response` (`packages/schema/src/location.ts:23-31`) | `body["data"]`, requires it to be an Array | `model_catalog_api.gd:138-143` |
| `health.get` | **top level** `{ healthy, version, pid, sourceEpoch }` | `health.ts:11-16` | `body["sourceEpoch"]` top-level | `live_transport.gd:180` |
| `/api/event` SSE | `data: <event JSON>` frames only | `packages/server/src/event-feed.ts:36,78` | `entry["event"]["data"]` dict | `live_transport.gd:143-148` |
| `session.log` SSE | `data: <SessionLogItem JSON>` frames | `session.ts:953` | `entry["event"]["data"]` dict | `live_transport.gd:261-268` |

Client defects within this section:

- `gateway_contract.gd:95-97` declares `MESSAGES_CURSOR := "cursor"` and states in its comment that
  "the message list returns `data` plus a `cursor`". The live `session.messages` response has **no
  `cursor`** (`message.ts:11-15`). The constant is unused (`grep` finds only the declaration), so it
  is a misleading comment plus a dead constant rather than a runtime bug.
- `guardrail_reply` (Section 2 / D1) was the only route-level defect: at HEAD it 404'd, and
  `live_transport.gd:364-365` fires the request without reading the response at all, so the guardrail
  answer failed silently on the UI side; the refusal surfaced only as the transport's generic
  `"The service returned HTTP 404."` at `live_transport.gd:174-175`, which also flips the feed state
  to `CONNECTION_DISCONNECTED`, mislabelling a route 404 as a connection drop. Corrected in the
  working tree, but the mislabelling behaviour at `live_transport.gd:174-175` remains: any non-2xx
  from any request is reported as a connection loss.
- The snapshot's `watermark` is `EventLog.Synced` = `{ type: "log.synced", aggregateID, seq? }` where
  `seq` is **optional** and absent when the captured watermark is empty
  (`packages/schema/src/event-log.ts:14-21`). `gateway_contract.gd:91-93` declares
  `WATERMARK_SEQ := "seq"` and the code path that uses the watermark
  (`live_transport.gd:261-268`) only compares `type` against `WATERMARK_TYPE` and never reads `seq`,
  so the optionality is not exercised. `live_transport.gd:247` reloads every session with
  `after=0` instead of resuming from a watermark, so the "resume the log with `after = watermark.seq`"
  comment at `gateway_contract.gd:89-90` describes behaviour the client does not implement.

## 4. DTO field coverage

Fields the client reads vs the live schema. "Client" column cites the parse site.

| DTO | field read (client) | live declaration | verdict |
| --- | --- | --- | --- |
| `Session.Info` (list) | `id` (`live_transport.gd:242`) | `packages/schema/src/session.ts:36` | exact |
| `session.created` data | `parentID`, `agent` (`office_store.gd:363-364`) | `session-event.ts:59-60` | exact |
| `session.created` data | `location.directory` (`office_store.gd:389`) | `session-event.ts:58` (`Location.Ref.directory`) | exact |
| `session.created` data | `model.ref` (`office_store.gd:394`) | `session-event.ts:61` declares `model: Model.Ref` = `{ id, providerID, variant? }` (`packages/schema/src/model.ts:14-18`) | **ABSENT — no `ref` field; live `model_ref` is always `""`** |
| `session.created` data | `synthetic` (`office_store.gd:398`) | not declared on `SessionEvent.Created`; it is a fixture-only marker (`fixture_translator.gd:109`) | absent by design (fixture-internal); false on LIVE |
| `session.status` data | `status.type` (`office_store.gd:452-453`) | `session-status-event.ts:9,14,30` (`{status:{type}}`) | exact |
| `session.task.updated` change | `type`, `description`, `inputID`, `parentID`, `toolCallID` (`office_store.gd:504-518`) | `session-orchestration.ts:181-191` | exact |
| `session.task.updated` change | `question.id`, `question.text` (`office_store.gd:527-540`) | `session-orchestration.ts:49-54` | exact |
| `session.task.updated` change | `answer.questionID`, `answer.text` (`office_store.gd:549-556`) | `session-orchestration.ts:61-65` | exact |
| `session.task.updated` change | `excerpt` (`office_store.gd:570`), `progress.text` (`office_store.gd:589-590`) | `session-orchestration.ts:200,58` | exact |
| `session.tool.called` data | `tool` / `name` (`office_store.gd:481`) | `session-event.ts:531-539` declares `assistantMessageID`, `callID`, `input`, `executed`, `state?` — **no `tool`/`name`** | **ABSENT — tool name lives on `session.tool.input.started` (`session-event.ts:500-507`) as `name`; the client never handles that event** |
| `session.file-change.recorded` data | `change.path`, `.patch`, `.additions`, `.deletions` (`office_store.gd:610-627`) | `session-event.ts:588-592` | exact |
| durable envelope | `durable.seq` (`office_store.gd:614-615`) | `packages/schema/src/event.ts:33` (`DurableEnvelope`) | exact |
| `permission.v2.asked` data | `id`, `action`, `resources` (`office_store.gd:318,346-347`) | `packages/schema/src/permission.ts:24-30` | exact |
| `permission.v2.asked` data | `reason` (`office_store.gd:348`) | **not declared** on `PermissionV2.Request` (permission.ts:24-30); `reason` exists only on `Guardrail.Request` (`guardrail.ts:57`) | **ABSENT for permission — falls back to the neutral caption** |
| `guardrail.asked` data | `action`, `resources`, `reason` (`office_store.gd:346-348`) | `guardrail.ts:52-60` | exact |
| `question` attention options | `data.options` (`conversation_panel.gd:290,296`) | `SessionOrchestration.Question` has no `options` (`session-orchestration.ts:49-54`); `options` belongs to `QuestionV2.Info` inside `question.v2.asked`'s `questions[]` (`packages/schema/src/question.ts:38-51`) | **ABSENT — see Defect D4** |
| `Model.Info` | `id`, `providerID`, `name`, `variants[].id`, `time.released` (`model_catalog.gd:71,74,100,106,126,250`) | `packages/schema/src/model.ts:42-68` | exact |
| `Model.Info` | `synthetic` deliberately erased (`model_catalog_api.gd:157`) | not a live field | correct (guards against demo-labelling server data) |

Nothing else the client reads is outside the live schema. No missing client coverage was found for the
kit's stated requirements on session/message/model/agent DTOs; the client reads no `Agent.Info` field
at all beyond `agent` as a bare string (`office_store.gd:364`), and `Agent.ID` is a branded string
(`packages/schema/src/agent.ts:13`), so that is consistent.

## 5. Auth and location scope

Auth (kit claim **verified**):

| fact | live source | client source |
| --- | --- | --- |
| username fixed to `ycoding` | `packages/server/src/auth.ts:35` (`username: "ycoding"`) | `gateway_contract.gd:140`; `http_transport.gd:48` default |
| optional HTTP Basic; auth is enforced only when a password is configured | `packages/server/src/auth.ts:44-50` (`required()` = password present and non-empty); `middleware/authorization.ts:52-53` | `http_transport.gd:298-300` sends the header only when a password is set |
| password from the service registration file | `packages/client/src/effect/service.ts` (named in `service_registration.gd:4-6`); registration shape `{url,pid,password?,id?,version?}` | `service_registration.gd:20-26` reads `~/.local/state/ycoding/service.json`; `main.gd:154` |
| 401 carries `WWW-Authenticate: Basic realm="Secure Area"` | `packages/server/src/middleware/authorization.ts:11,66`; `packages/server/src/process.ts:191`; `packages/protocol/src/errors.ts:15-19` (401) | `gateway_contract.gd:141` declares `AUTH_CHALLENGE` **but never reads a response header** — the constant is unused (`grep` finds only the declaration) |
| `auth_token` query accepted | `packages/server/src/middleware/authorization.ts:10,29-31` | `gateway_contract.gd:143` declares `AUTH_TOKEN_QUERY`, **unused** |

Location scope (kit claim **verified**, with one client gap):

- Live contract: `LocationQuery` = `{ location?: { directory?: string, workspace?: string } }`
  (`packages/protocol/src/groups/location.ts:5-12`), OpenAPI-transformed to `style: "deepObject",
  explode: true` (`location.ts:14-26`). Server resolution reads the query keys
  `location[directory]` / `location[workspace]` first, then the headers `x-ycoding-directory`
  (URI-decoded) / `x-ycoding-workspace`, and falls back to `process.cwd()` when a directory is absent
  (`packages/server/src/location.ts:28-38`).
- Client: declares all four names (`gateway_contract.gd:149-152`) but sends **only the headers**
  (`http_transport.gd:306-310`); the two query constants are unused (`grep` finds only the
  declarations) and the transport has no query-authoring path at all.
- The `Location.Ref` body form used by `session.create` is `{ directory, workspaceID? }`
  (`packages/schema/src/location.ts:9-12`); `session_api.gd:74-75` sends `location: {directory}`,
  matching.
- Session routes take the location from the session row via the server's
  `sessionLocationMiddleware` (`session.ts:317-318` and every other session endpoint), so the client
  correctly sends no scope for them: `gateway_contract.gd:146-147` states this and
  `live_transport.gd:83-86` only forwards scope for the location-scoped routes.

## 6. Provider usage contract

Route and query (live, exact):

| fact | live source |
| --- | --- |
| list route | `GET /api/provider/usage` — `providerUsage.list`, `packages/protocol/src/groups/provider-usage.ts:31` |
| get route | `GET /api/provider/:providerID/usage` — `providerUsage.get`, `provider-usage.ts:48` |
| query | `LocationQuery` fields + `refresh` — `refresh` is the literal `"true"`/`"false"` string, **optional** (`provider-usage.ts:21-26`) |
| list success | `Location.response(Schema.Array(ProviderUsage.Snapshot))` = `{ location: Location.Info, data: Snapshot[] }` (`provider-usage.ts:34`; `packages/schema/src/location.ts:23-31`) |
| get success | `Location.response(ProviderUsage.Snapshot)` = `{ location, data: Snapshot }` (`provider-usage.ts:51`) |
| error | `ServiceUnavailableError` (`provider-usage.ts:35,52`) |
| handler | `packages/server/src/handlers/provider-usage.ts:18-33` |

`Snapshot` (`packages/schema/src/provider-usage.ts:41-50`): `providerID` (Provider.ID), `label`
(non-empty string), `status`, `source`, `stability`, `updatedAt` (NonNegativeInt), `windows`
(`Window[]`) — all **required**; `message` (string) **optional**.

`Window` (`provider-usage.ts:31-39`): `id` (non-empty string), `label` (non-empty string), `unit`
(`"percent"|"usd"|"requests"|"tokens"|"count"`) — **required**; `used`, `limit`, `remaining`
(non-negative finite), `unlimited` (boolean), `resetAt` (NonNegativeInt), `periodSeconds`
(NonNegativeInt) — **all optional**.

Enums (all closed literals):

- `status`: `"available" | "stale" | "unsupported" | "unauthorized" | "error"` (`provider-usage.ts:8`)
- `source`: `"provider_api" | "local_client_rpc" | "response_headers" | "provider_internal_api" | "local_session"` (`provider-usage.ts:12-18`)
- `stability`: `"stable" | "client_contract" | "observed" | "best_effort"` (`provider-usage.ts:20`)
- `unit`: `"percent" | "usd" | "requests" | "tokens" | "count"` (`provider-usage.ts:24`)

Legitimately absent, and **must not be coerced to zero**: any of `used`, `limit`, `remaining`,
`unlimited`, `resetAt`, `periodSeconds` on any window, and `message` on the snapshot. The producers
omit them deliberately rather than zero-filling, e.g. `packages/core/src/provider-usage/claude.ts:199`
and `codex.ts:153,183-184,201` spread the field only when the provider reported it, and
`copilot.ts:213-214` does the same for `limit`/`unlimited`. A window may therefore carry no numeric
bound at all, which means "unreported", not "0% used". `status: "unsupported"`, `"unauthorized"` and
`"error"` are legitimate snapshot states with empty or partial `windows`.

Client side: **the office client has no provider-usage code at all.** `grep` for
`usage|ProviderUsage|remaining|resetAt|periodSeconds|unlimited` across `apps/office` returns only
unrelated hits (`office_actor.gd:59` ambient timer). `Gateway` (`gateway_contract.gd:15-152`) declares
no provider-usage path, `SessionApi` and `ModelCatalogApi` do not call one, and no constant in
`wire.gd` or `gateway_contract.gd` carries `used`/`limit`/`remaining`/`unlimited`/`resetAt`/
`periodSeconds`. R7 must therefore add the route, the parse, and an absence-preserving render path
from scratch; there is no existing parse to correct.

## 7. Defects (ranked)

Ranked by likelihood of producing wrong behaviour in LIVE, then by fix size.

**D1 — `guardrail_reply` path was missing the `request` segment; the route did not exist.**
At HEAD (`a4bb99e`) `apps/office/integration/gateway_contract.gd:64-65` built
`/api/session/{s}/guardrail/{r}/reply`. The live operation is `session.guardrail.request.reply` at
`/api/session/:sessionID/guardrail/request/:requestID/reply` (`packages/protocol/src/groups/guardrail.ts:43-45`),
so every guardrail answer 404'd, and `live_transport.gd:364-365` does not inspect the response, so the
UI reported nothing while `_on_response` (`live_transport.gd:174-175`) flipped the feed to
`CONNECTION_DISCONNECTED` for a route-level 404.
**Status at the time of writing: already corrected in the working tree** (uncommitted, not this
lane's change — see the concurrency note). `git diff -- apps/office/integration/gateway_contract.gd`
shows the `request` segment inserted, and `test_gateway_contract.gd` now pins it. Nothing left for
this lane to fix; the report is the verification that the new value matches the live route.

**D2 — `session.tool.called` never carries the tool name, so every tool activity falls back.**
`office_store.gd:481` reads `data["tool"]` then `data["name"]`; `SessionEvent.Tool.Called` declares
neither (`packages/schema/src/session-event.ts:531-538`; the runtime publishes only `input`/`executed`/
`state` — `packages/core/src/session/runner/publish-llm-event.ts:485-493`). The name is published on
`session.tool.input.started` as `name` (`session-event.ts:500-507`;
`publish-llm-event.ts:252-257`). Consequence: `WorkState.from_tool("")` always returns
`PROCESSING` (`work_state.gd:59-66`), so Reading/Typing/Testing states and their distinct glyphs never
appear in LIVE, and new `wire_create` named constants for the tool families cannot help until the
client consumes that event. Note `session.task.updated` `launched` changes also carry no tool name,
so the delegation path is unaffected.
Fix target: handle `session.tool.input.started` (new real constant, `session-event.ts:500`) and read
`name` from its data; keep `session.tool.called` only for the called/settled transition.

**D3 — `session.created.model` is read as a string field `ref` that the schema does not declare.**
`office_store.gd:393-396` reads `(data["model"] as Dictionary)["ref"]`; live `model` is `Model.Ref` =
`{ id, providerID, variant? }` (`packages/schema/src/model.ts:14-18`). Consequence:
`actor.model_ref` stays `""` in LIVE, so `main.gd:589-596` `_default_model_ref()` never adopts the
session's own model and the composer keeps its previous selection — exactly the behaviour the comment
at `main.gd:586-587` says it prevents. The value is a config string, not a wire field, so the fix is a
composition, not a rename.
Fix target: `office_store.gd:393-396` — build the string with `ModelCatalog.format_ref({providerID,id,variant})`
from the declared fields. `fixture_translator.gd:110` and `test_office_store.gd:199,221` must move to
the declared shape in the same change, or the demo path and the tests keep exercising the absent field.

**D4 — question attention is structurally unreachable in LIVE, and the option shape it expects does not exist.**
The client only creates a question attention entry from `session.task.updated` /
`change.type == "question_asked"` (`office_store.gd:522-543`), whose `question` is
`SessionOrchestration.Question` = `{ id, text, data?, time }` (`session-orchestration.ts:49-54`) — no
`options`. `conversation_panel.gd:290,296` reads `data["options"][].label` from the flat attention
data, and `attention_queue.gd:100-112` reads `data["questions"][].options[].label`; neither shape
exists at that path. `SessionOrchestration.Question.data` is `Schema.Json` of at most 8 KiB
(`session-orchestration.ts:36,52`), so choices would have to arrive inside that opaque `data` blob and
the client would have to decode them; the typed option shape lives only on `QuestionV2.Info` inside
`question.v2.asked` (`packages/schema/src/question.ts:38-51`), which the office never handles.
Consequence: a question renders with "No choices were supplied." and cannot be answered from the
office. `QuestionV2.ID` is prefixed `que` (`question.ts:10`) while `SessionOrchestration.QuestionID`
is `qst_` (`session-orchestration.ts:57`), so the two are also different ID spaces and the reply route
would need the right one.
`gateway_contract.gd:55-56` builds `/api/session/{s}/question/{r}/reply` against
`question.ts:52-58` with `params: { requestID: Question.ID }` (the `que_` space), while the id the
office holds comes from `question_asked` (`qst_`). Fix requires settling which of the two question
surfaces is authoritative before either the parse or the path is changed.
Fix target: decide the question surface (`question.v2.asked` vs `SessionOrchestration.Question.data`)
and then fix `office_store.gd:522-543`, `attention_queue.gd:97-112`,
`conversation_panel.gd:242-303`, `wire.gd` (a `QUESTION_ASKED` constant for `question.v2.asked`), and
`gateway_contract.gd:55-56` as one change. Do not patch the option read alone.

**D5 — `permission.v2.asked` has no `reason`, so the permission caption reads as `action — resources`.**
`office_store.gd:348` reads `data["reason"]`, declared only on `Guardrail.Request`
(`packages/schema/src/guardrail.ts:57`); `PermissionV2.Request` has `action`, `resources`, `save?`,
`metadata?`, `source?` (`packages/schema/src/permission.ts:24-30`). The code degrades cleanly to the
neutral fallback, so this is a caption-quality defect, not a crash. If a reason is genuinely wanted,
it is in `metadata` (opaque) or must come from the guardrail family.
Fix target: `office_store.gd:346-352` — either drop the `reason` read for permission or source it from
the declared field, and stop implying a schema field that is not there.

**D6 — `gateway_contract.gd` documents response shapes the client never reads and one that does not exist.**
`MESSAGES_CURSOR := "cursor"` (`:95-97`) claims the message list returns a cursor; it does not
(`packages/protocol/src/groups/message.ts:11-15`). `AUTH_CHALLENGE`, `AUTH_HEADER`, `AUTH_TOKEN_QUERY`
(`:141-143`), the two `LOCATION_*_QUERY` constants (`:149-150`), `SNAPSHOT_SESSION`,
`SNAPSHOT_WATERMARK`, `WATERMARK_AGGREGATE`, `WATERMARK_SEQ` (`:85-93`), `SERVER_CONNECTED`,
`SOURCE_EPOCH`, `ACTIVE_RUNNING`, `PROMPT_*`, `SSE_DATA_PREFIX` (`:104-133`), `SESSION_ACTIVE` (`:18`)
and `session()`/`snapshot()`/`messages()`/`subagents()` (`:29-51`) are all declared and unused
outside `test_gateway_contract.gd` (which asserts on several of them by literal). A contract file that
asserts unread shapes is evidence of drift, and the snapshot/watermark comments describe resume
behaviour the client does not implement (`:88-90` vs `live_transport.gd:247`).
Fix target: `gateway_contract.gd` — delete the constants with no consumer, correct the message-cursor
comment, and either implement the watermark resume or delete the comment. Keep the values that
`test_gateway_contract.gd` pins only while the test still needs them.

**D7 — `apps/office/AGENTS.md`, `core/wire.gd` and `fixture_translator.gd` cited a document that does not exist.**
`contracts/wire-audit.json` is absent from the repository and from the kit
(`ycoding-office-repair-kit/contracts/` holds only `verification-cases.json`). Three files named it as
the authority for the vocabulary; the real authority is
`packages/schema/src/session-event.ts` + `event-manifest.ts`, which `wire.gd:3-4` also named.
**Status at the time of writing: already corrected in the working tree** (uncommitted, not this
lane's change — see the concurrency note). `git diff` shows `apps/office/AGENTS.md`,
`apps/office/core/wire.gd` and `apps/office/integration/fixture_translator.gd` all re-pointed at the
live schema files. Nothing left for this lane to fix.

**D8 — the four location query/header constants are declared but only two are used, and no query form exists.**
`http_transport.gd:306-310` sends `x-ycoding-directory`/`x-ycoding-workspace` only;
`LOCATION_DIRECTORY_QUERY`/`LOCATION_WORKSPACE_QUERY` (`gateway_contract.gd:149-150`) have no
consumer and the transport has no query-authoring path. `LiveTransport.set_location`
(`live_transport.gd:83-86`) has no production caller (`main.gd` never calls it), so the office sends
no location scope at all today; the model route then resolves the server's `process.cwd()`
(`packages/server/src/location.ts:34-36`). Not a wire mismatch — the server accepts either form —
but the client's scoped read is narrower than its declared contract.
Fix target: `gateway_contract.gd:149-150` or `live_transport.gd:83-86` — either wire the scope
through `ModelCatalogApi.configure` for the LIVE model read, or delete the unused constants. Decide
with the R7 owner, since provider usage is also location-scoped.

## 8. Unknowns

- **Whether `Packages/protocol` registers these routes exactly as read.** Verified from the group
  definitions in `packages/protocol/src/groups/*.ts` and the handler maps in `packages/server/src/handlers/*.ts`;
  not verified by starting the service or by reading a generated OpenAPI artifact. The task forbids
  starting the service. No live server response was observed.
- **The real `question` surface for the office.** Which event the runtime actually uses to block a
  session on a question (`question.v2.asked` vs the `question_asked` task change) is unresolved here:
  the office handles only the latter, and `QuestionV2.ID`/`SessionOrchestration.QuestionID` use
  different prefixes (`question.ts:10` vs `session-orchestration.ts:57`). Determining which is
  canonical needs the runtime's publish site, which was not traced past
  `packages/core/src/session/orchestration.ts:706` (a task change). Unverified.
- **Whether `SessionOrchestration.Question.data` carries options in practice.** It is typed as opaque
  JSON (`session-orchestration.ts:36,52`); no producer was inspected, so whether real question
  payloads embed a labelled option list is unverified.
- **`service_registration.gd`'s registration contract.** The client cites
  `packages/client/src/effect/service.ts` (`service_registration.gd:4-6`); that file was not read
  here, so the stated shape `{url,pid,password?,id?,version?}` and the STATE-directory path are
  unverified in this lane. The `~/.local/state/ycoding/service.json` fallback
  (`service_registration.gd:24`) is the client's own assumption.
- **`auth_token` in practice.** The server accepts it
  (`packages/server/src/middleware/authorization.ts:10,29-31`); whether the office ever needs it
  (the browser/extension exemption is at `authorization.ts:54`) is unverified.
- **Demo/live reducer parity for the changed shapes.** `test_office_store.gd:199,221` and
  `fixture_translator.gd:110` exercise the absent `model.ref`; fixing D3 requires re-running the
  office headless suite, which this lane did not run (Godot is out of scope for R0-03 lane I).
