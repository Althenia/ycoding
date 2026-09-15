# YCoding integration and recovery contract

## What is verified versus proposed

The remote snapshot inspected for this pack has a Protocol-owned HTTP API, a volatile global SSE feed at `GET /api/event`, and `GET /api/session/:sessionID/snapshot` returning canonical projected messages, a `sourceEpoch` and an exact durable `watermark`. The snapshot operation describes its response as atomic for one server process epoch. Session list/create/active routes and a subagent launch/message DTO were inspected. These are **remote source observations, not locally executed integration tests** [R1–R6 in SOURCES].

All event names in `contracts/semantic-event.schema.json` and `fixtures/` are **new client-internal proposal names**. They are not claimed to match the current YCoding wire. Populate `contracts/wire-audit.json` from the local checkout before live implementation.

## M0 wire audit

Inspect the owning code/tests for service startup/discovery/auth, location headers, session create/select, prompt payload/admission/retry identity/delivery, interrupt, current execution status, child listing/pagination, messages, snapshot watermark/epoch, global stream, questions/forms, permission/guardrail responses and optional VCS/tool detail reads.

Record: local commit plus dirty paths, source file/symbol, method/path, request shape, response shape, error cases, scope, pagination, read consistency and targeted test command. A route label alone is insufficient. Do not copy an SDK convenience signature into GDScript and assume it is the HTTP request body.

## Prompt parity

Use the same user text and supported session/agent/model/location/delivery selection as the TUI. The desktop must not prepend “you are CEO,” force subagent launches, silently elevate autonomy or auto-approve for the animation. Reuse existing settings. A manager-oriented policy is a separate explicit user configuration, not required for office visuals.

Separate prompt **admission**, visible message promotion, model execution and final settlement in the UI. Disable unintended double-submit while a request is in flight, but keep intentional new messages possible. Use a stable message/request identity only as supported by the verified contract. The remote root guide describes exact-retry reconciliation under matching session/prompt/delivery conditions; confirm this with local tests before relying on it [R2].

On ambiguous timeout, reconcile by that supported identity or canonical state before retrying. Never retry a mutation just because an animation did not play. Do not advertise exactly-once execution beyond the server guarantee. The local UI does not invent a “run ID” for a backend drain with no durable identity.

## HTTP and SSE implementation

Use asynchronous `HTTPRequest`-style calls for bounded JSON operations and a separately owned, non-blocking `HTTPClient` stream for SSE. Call `poll()` and consume available body chunks within a per-frame budget; yield instead of a busy loop [G6]. Keep cancellation and request generations so late responses cannot alter a newly selected workspace.

The SSE parser must support UTF-8 split across network chunks, CR/LF/CRLF boundaries, comment/heartbeat lines, multiple `data:` lines, an optional `event:` name, `id:` semantics, a numeric `retry:` field and unknown fields. Dispatch only complete events. An EOF-incomplete event is not a successful message. Parse framing incrementally and validate JSON separately. Do not call `get_string_from_utf8()` on arbitrary partial code points and concatenate corrupted strings. WHATWG defines these stream rules [G7].

Transport frames, decoded event payloads and presentation intents are distinct. The server may deliver no globally ordered cursor suitable for your chosen read model. The presence of an SSE ID is not a promise of server replay.

## Reconnect and synchronization

**The inspected global feed is volatile:** disconnection misses events and slow-consumer overflow fails the stream. No replay is promised for `/api/event`. However, a **durable per-session replay exists** and must be used for gap-free history:

`GET /api/experimental/session/:sessionID/log?after=<Event.Seq>&follow=<bool>`

It replays public durable session events after an exclusive cursor, emits a `log.synced` marker carrying the captured aggregate sequence, and continues with live events when `follow=true`. Local proof: `packages/core/test/session-log.test.ts` passes including "replays public session events and marks synced at the aggregate watermark".

Corrected strategy:

1. On initial connect/reconnect, enter `SYNCING`, mark current statuses stale, start the stream and track a new local request generation.
2. Load the canonical selected-root snapshot first, plus child pages and `session.active`. The snapshot returns `{ sourceEpoch, session, messages, watermark }` atomically for one server process epoch.
3. Attach `/api/event` as an invalidation signal. For gap-free durable history within one epoch, resume from the snapshot watermark with `session.log?after=<watermark.seq>&follow=false`; do not treat the global feed as a cursor.
4. `seq` is an exclusive per-aggregate cursor; `log.synced` may report a seq above the last emitted event because other durable events share the sequence space. Never compare Event IDs or epochs numerically.
5. If `sourceEpoch` changes (compare against `/api/health` and `server.connected`), discard cursors and in-flight reads, cancel cosmetic queues, reload the session family, and retain only explicitly stale placeholders while loading.
6. Transition to LIVE when the selected view is consistent. Do not replay every old message as a walk/bubble. Newly discovered history appears in the drawer; a neutral "activity updated while disconnected" notice is sufficient.

Starting the stream before reading narrows the race, but is **not** itself an atomic distributed snapshot. The local implementation must test the supported watermark/dirtied-during-fetch strategy with events inserted around reads. If consistency cannot be proven, repeat canonical reads or show SYNCING rather than claiming a gap-free replay.

Transient deltas may improve responsiveness only when their real semantics are verified; reconcile them with canonical projected messages. Unknown event types should trigger a conservative refresh or diagnostic, not crash or erase state. Use bounded exponential reconnect delay with jitter, stop retries on explicit user disconnect, and distinguish auth failure from temporary unavailability.

## Identity and conversation

Use `(service identity, workspace/location context, sessionID)` as the scoped assignment key; include process epoch only in synchronization metadata, not a durable identity that changes on every restart. The exact context key comes from M0. `agentID` is a reusable definition, not a unique active worker. Two child sessions using Backend need distinct actor IDs and labels such as Backend A/B.

A social thread is based on a source-supported parent-child assignment relationship. Persistent employee display profiles can reuse art/desk preferences across assignments; they must not merge unrelated session histories or imply a permanent org chart in Core.

Store source references for every visible conversation item: session/message/tool/orchestration identity, relationship and optional locator into canonical content. The same delegated prompt can appear in multiple raw views; deduplicate the social projection by provenance, not by equal text. Failure to reconstruct a relation means an unlinked source item, not invented dialogue.

## Truth and command boundaries

`idle`, `inactive`, a successful tool call and an assistant saying “done” mean different things. Only map to success/report when the actual source supports it. “Agent reports 14 tests passed” and “test runner exited successfully” should remain distinguishable. Unknown test runners are generic shell activity unless verified tool metadata supports classification. Do not send a test result bubble for every zero exit code.

Human approval/guardrail decisions go through the same backend route/options as the TUI. A CEO avatar is not a human authority. A hard review may require restricted answers; do not add a blanket “approve all” button. Disable mutations when disconnected or stale enough to risk acting on the wrong session; preserve text drafts.

## Service lifecycle

First ship attach-to-existing-service with an explicit configured executable/base URL and existing credential mechanism. Do not assume a compiled GDScript app can import the TypeScript `Service.ensure()` helper. Audit how the CLI exposes equivalent behavior. No hardcoded port/token or shell-sourced secret files.

Optional auto-start later uses the established CLI mechanism and records whether the app started a private or shared process. Never stop an existing daemon on desktop exit. No arbitrary command concatenation from prompt content or server messages. No auto-opening unsafe transcript URLs/files. Local transport stays loopback for this MVP; remote connection is out of scope.

## Suggested initial resource bounds

These are tunable test defaults: 2 concurrent snapshot reads; coalesced invalidation around 100–250 ms; bounded event input queue; configurable maximum SSE line/event size (start at 1 MiB/4 MiB); 8 decorative actions per actor; 3 globally visible social bubbles; an LRU cap on resident complete transcripts. Oversized input produces a visible recoverable diagnostic/resync, not silent data truncation. Durable transcript availability comes from the server even when the UI evicts a resident view.
