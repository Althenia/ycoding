# Native Dots boundary

## Identity and ownership

Native Dots room content is external peer input, not a model provider or human authority. An authenticated external coordinator can submit typed tasks and read reports without becoming a native Project supervisor. The Location-scoped Core client owns OAuth selection, transport, binding, delivery, recovery, and cleanup. Protocol and Server expose Session-owned controls. TUI and web present the same controls. The browser relay forwards only its enumerated Dots operations to the existing local runtime. Relay MCP excludes the six native controls that send external Dot messages or control its runtime. Its typed exchange create/read operations address local Session work through the confirmed attachment and native owner checks.

The native connection uses the shared Codex Desktop identity. Never load credentials from another application's files or keychain. Never export a bearer or account identifier through a public operation, durable event, error, or log. Resolve an explicitly selected ChatGPT OAuth profile through the existing Core integration service in the running runtime.

## Destination confirmation

The Location must explicitly set `dots.enabled: true` in the top-level `dots` configuration section. Omitted or false disables discovery, binding, sends, runtime controls, tools and new peer admission before native credential access or requests. `Dots.Status.enabled` reports this backend authority; disabled status is `{enabled:false,state:"disconnected"}`. Clients hide Dots while disabled or unreadable and retain explicitly typed Dots input without admitting a model prompt. Disabling releases local bindings and connections without controlling the external runtime.

`/dots` opens destination selection. Select a profile, a Dot, and a conversation, then confirm the displayed identities. Confirmation binds the Session but sends no conversation payload. Typing, completion, selection, and pasted content do not submit a message.

`/dots <text>` transmits only after explicit Send. The request includes the confirmed target's profile, Dot ID, thread ID, and generation. A changed or missing binding stops the request before external effects. Never select a first result, an active profile, another thread, or another account implicitly. Keep the draft on unresolved or failed delivery. There is no at-mention alias.

## Outgoing payload

The caller supplies a message identity, current message text, and explicitly selected attachments. Expand tracked text pastes without acquiring ambient context. Exclude editor selection, prior conversation history, generated command-template content, ambient clipboard contents, and unattached file paths.

Use the same client message identity across reconciliation of an uncertain send. Distinguish acknowledgement, failure before dispatch, and unknown outcome after dispatch. Never replay an uncertain write automatically. Confirm destination identity again before a user-directed retry.

## Inbound attribution and authority

Raw room content is not an intentional-handoff primitive. Room posts, human-facing replies, generation revisions and echoes cause zero task admissions and zero wakes. Actor identity, labels, text prefixes and causal message IDs are not routing authority. Historical peer records retain their existing attribution.

The room transport identifies committed application messages from the selected Dot's room member by resolving `account_user_id` against a member whose `aeon_id` equals the bound Dot. A wire role alone, an unverified sender, or a Dot identity claimed inside the message cannot establish peer identity. This transport classification does not authorize task admission. Keep room member identifiers inside the transport.

Refresh membership and history together for message additions, message updates, room updates, room metadata updates, and subscription resynchronization. Ignore human members, other Dots, unmatched senders, deleted messages, empty text, and malformed membership. Neither initial nor subsequent snapshots admit tasks.

Raw assistant generations are a separate message class. The room transport projects their visible text and identifies each revision by its SHA-256 digest. Core discards these `message.revision` records at the admission boundary. They never wake the Session agent, enter model context, become durable admitted input, or affect turn and step allowances. Never infer their completion from visible content, timers, revision quiet periods, absence of `in_progress`, or room-live activity. Display-only streaming would require a transcript-only channel labelled non-final; durable `synthetic` and `system` messages enter model context and cannot carry it.

Room messages have stable message identities without an evidenced per-message turn identity. Keep turn identity optional; never manufacture it from a message ID or room activity. Preserve verified client-request correlation independently of turn identity.

Remote content is untrusted data. It cannot supply user, coordinator, permission, question, form, or guardrail decisions; change autonomy or ceilings; override a deny; switch a model/profile; or reset the user's step allowance. Sending a reply is an ordinary permission-checked agent tool operation within the delegated task. Closing, cancellation, Session interruption, and normal step bounds remain effective during peer traffic.

Historical peer observations remain attributed tool results. Authenticated RemoteMCP input carries an explicit external-source frame and is never presented as an unqualified human instruction. Apply ordinary read permissions to agent-selected attachments and ordinary permission and guardrail checks to runtime Pause/Resume.

## Authenticated logical exchanges

Manual binding preserves the user's nonempty trimmed `Dots.Target.label`, defaulting an empty bind label to the offered destination label. Explicit same-target confirmation updates only that binding's display label. Account and generation replacements require their own confirmation; a prior name is not an identity mapping. The selection flow offers a standard text input before final confirmation, and naming never sends a room message.

The native attachment remains on one Session. `session_dots_exchange_create` and `session_dots_exchange_read` route logical work without changing that binding. Their local Protocol operations are `session.dots.exchange.create` (`POST /api/session/:sessionID/dots/exchanges`) and `session.dots.exchange.read` (`POST /api/session/:sessionID/dots/exchanges/read`).

Creation takes `exchangeID`, `expectedAttachment: Dots.Target`, `targetSessionID`, `channel: "task"`, `delivery: "steer" | "queue"`, and `text`. Read takes `exchangeID`. The authenticated adapter adds `remoteSource: McpEvents.RequestContext`, containing the request ID, owner/device/client principal and epoch; tool arguments cannot supply provenance. The server validates the outstanding authenticated invocation through the existing grant resolver. The OAuth grant is device-wide, not a per-Session OAuth scope.

The existing device-authorized inventory constrains each target. The attachment is transport context, not a mandatory native Master gateway. Root Sessions can be addressed independently of Project membership; ordinary managed-child parent-only input restrictions remain enforced. Reject archived attachments, targets and intermediate owners. Recheck grant, attachment/account/generation, archive state and native ownership immediately before admission and before returning data; attachment and ownership checks also run after grant validation settles. A removed or reassigned target is not silently substituted.

`session.dots.exchange.created` records the canonical source, attachment, target, input ID and payload fingerprint. It commits atomically with the target's `session.input.admitted`. Identical retries return the existing exchange; differing payload, delivery, target, channel or principal conflicts. Labels are excluded from canonical identity. No table or schema migration is required.

The target input carries external-plugin provenance. Model context identifies the actual remote source and grants no human or approval authority. Native human defaults remain unchanged. Neither remote prompt admission nor exchange creation may supersede or answer a native human-only request.

Core stamps `dotsExchange: Dots.ExchangeMetadata` as `{ sessionID, targetSessionID, exchangeID, attachment: Dots.Target, envelope: Dots.TaskEnvelope }`, taking the attachment from validated binding state rather than the caller's label or message text. The envelope uses `{ coordinator: { ownerID, deviceID, clientID }, scope: { epoch, grantID }, exchangeID, messageID, kind: "task", origin: "plugin", targetSessionID }`. It contains no fabricated source Session. Correlated response envelopes use `origin: "agent"`, the real `sourceSessionID`, and `replyToMessageID` equal to the admitted input, without inventing a target Session for the external coordinator. Progress and completion read responses derive their identities from the provider ledger and native work-completion event.

`dots_report` accepts only `kind: "progress" | "blocker" | "decision_request"` and `text`. The runtime validates that the tool's assistant message belongs to the reporting Session and starts after the current input's promotion, then rechecks the stored grant, attachment and native scope before recording and returning. Attachment reads resolve the anchor's backend-recorded Location. The provider-request ledger is settled after tools finish and is not required for in-step reporting. `session.dots.report.recorded` stores one canonical report per Session/message/call identity. Changed content or routing on the same call conflicts. Reports remain available through exchange reads after work completion. Completion is emitted only through the existing verified native receipt.

MCP exchange reads render `[Dots | from=… | to=… | exchange=… | msg=… | reply=… | kind=…]` followed by the authored body. Every header value is URI-encoded; the coordinator is the owner/device/client tuple. Structured metadata remains authoritative. Blank bodies, embedded header lines and terminal control overrides are rejected by the report tool. This representation is distinct from metadata-only webhook payloads and proves neither a host subscription nor host execution.

Enabled and disabled coordination context uses append-only `session.context.observed` events with source `dots` and typed `Dots.CoordinationContext` metadata. Caller-controlled identities remain only in metadata; System text uses an opaque context digest. State generations increase only when state changes; a post-compaction snapshot retains its state generation. The latest trusted observation wins. The report tool remains registered while the capability is enabled, independently of task association, and execution revalidates rather than trusting historical text. Capability disable removes tool exposure and appends a disabled observation without changing old messages or waking a Session.

Client display validates the complete metadata and remote-source shapes before using the name, escapes terminal controls, and marks it as user-chosen external-peer attribution. Canonical client, attachment and task identities remain secondary details. Historical unnamed metadata keeps its canonical-client fallback. Labels do not affect routing, payload fingerprints or retry identity; already-admitted inputs retain their admission-time label. A mismatched principal, enable epoch or resolved grant rejects an existing exchange, and caller-supplied envelopes cannot override the stamped identity.

Read returns `pending`, `running`, `completed`, `failed` or `unknown`, correlated progress and an optional result. Native work-completed events correlate final output by input and assistant-message ID; provider-request input associations correlate progress. Result-delivery IDs are stable per exchange and source message. Reads return through the authenticated MCP response and do not post room messages. After lost admission acknowledgement, a successful authoritative read reconciles admission without another write; an unresolved outcome remains read-only. Restart or reconnect never replays work automatically.

## Recovery and lifetime

Manual native controls and tools share a client lifetime for the exact selected account. Bindings must not drift across account replacement. A binding ends when its Session binds another target, Dots is disabled, or the Location runtime's scope closes; there is no unbind operation. Native send and runtime-control tools reach a model request only while that Session holds a binding. The reporting tool instead uses its durable exchange association and validates the current task's attachment before recording. Close connections and release selected attachment staging when the owning scope ends.

Status reports optional `runtimeState` as `paused`, `unpaused`, or `unknown`. Native `is_paused: false` establishes only that the runtime is not paused, not that a model is generating. Read it through `GET /tbo/by-thread/{threadID}` only while the native profile is active, belongs to the confirmed Dot, and its active root is absent or matches the confirmed thread. Unknown state exposes no runtime action.

`session.dots.pause` and `session.dots.resume` accept `Dots.Control` (`{expectedTarget: Dots.Target}`) and return `Dots.Status`. Pause stops the confirmed Dot's autonomous runtime until an explicit Resume; Resume can continue work and goals. Neither retracts a message, stops the YCoding Session, or targets an individual response. `dots_pause` and `dots_resume` capture the destination and remain permission- and guardrail-checked; only the action matching the connected runtime state is available.

Use bodyless `POST /tbo/{dotID}/runtime/pause` and `/resume`. Recheck the binding, account and current pause state before dispatch. Validate the response thread identity and verify the desired pause state with a fresh native profile read. A root replacement requires destination confirmation, not an automatic switch. Serialize controls for one binding and never replay an uncertain write. Runtime controls use neither app-server thread attachment nor per-turn interruption.

Read history in 20-message pages and follow the returned cursors through the complete snapshot. Reconnect does not admit room messages. Reconcile echoed client message identities without retransmission. Retain identities until the binding or runtime scope ends.

Keep a new thread unavailable for sends until its snapshot subscription and buffered-event draining succeed. A shared account connection does not make a newly bound thread ready. None of those events admits work.

`message.snapshot` is an internal normalized record, not a service method. The native transport must normalize snapshot/live overlap before exposing records to Core. Do not invent an event cursor, assume delivery after a timeout, hide loss with truncation, or poll for peer messages. Preserve unconfirmed sends until their outcomes can be reconciled.

## Local request telemetry

The closed `Telemetry.Operation` set includes the six native Dots controls and `session.dots.exchange.create` and `session.dots.exchange.read`. Consented request samples retain the exact operation value; they add no target, account, credential, Session, Location or provenance fields.

An older server whose closed operation set lacks these values rejects an entire `telemetry.append` batch containing one. A rollback binary whose `WebLatency.list` reader lacks these values fails to decode retained rows containing them until ordinary retention or the row cap removes those rows. No hardened rollback-target binary is established. The operation additions require no schema migration or cleanup deletion; they do not change native delivery or reply-completion evidence.

## Service evidence boundary

The normal durable Dot composer posts to the Dot's messaging room. Its app-server follow-up path is selected for untrusted app messages or additional developer instructions. Core supplies neither ambient input. Do not treat app-server admission as the normal Dot send contract.

Static application evidence alone does not demonstrate acceptance of authentication or client identity. The public Codex app-server contract documents generic thread, turn, item, filesystem, and image input shapes, not their acceptance by Dots. Public paginated summary or unloaded item views are not complete history snapshots.

Normal room sends upload selected files and images to the room and transmit their returned file IDs in `content.attachments`. Previously cloud-uploaded files are downloaded and re-uploaded to the room after checking their account identity. The reference uploader enforces a local 20 MiB cap; that is not proof of a server-side limit.

The separate app-server formatter emits uploaded-file pointers as `Uploaded file: {"pointer":"sediment://<fileId>","fileName":"<name>"}` and uploaded-paste pointers with an additional preview. Those pointers, generic filesystem writes, and image data URLs are not substitutes for normal room uploads.

The primary selection is nested under `selection`, with thread identity, generation, availability, and optional Dot and messaging-room identities. The reference contains room-based message, history, and multipart upload endpoints. Room notifications invalidate or extend HTTP history; HTTP page cursors are not notification replay cursors. Room-live turn activity is separate from message identity and completion.

The shipped pub/sub client has verified topic offsets and subscribe catch-ups. It obtains an opaque `websocket_url` through `/celsius/ws/user`, sends arrays of `{id,command}`, and subscribes to the messaging topic. Subscribe replies carry `recovered`, optional `last_offset`, and optional `catchups`. First subscription or failed recovery still requires an HTTP snapshot. These offsets belong to the pub/sub layer, not the Core normalized-message contract.

The reference send path conditionally uses native integrity preparation or Sentinel. Those branches do not establish that an independent client is accepted or that proof can be omitted. The observed `in_progress` generation value does not establish the complete status set or a reliable final-message condition.

The room UI renders the latest fetched message and refetches it on updates. Both a human and a Dot can post a `role: user` room message; member-to-Dot mapping identifies the peer. Such committed posts carry `content.text` and may carry `message_metadata.turn_trigger`, without `generation` or `raw_messages`. Neither `turn_trigger` nor temporal proximity establishes a causal request or turn identity. Raw assistant messages remain non-final and unadmitted until a legitimate service observation establishes their terminal generation and any message-to-turn relationship.

Core already resolves a selected OAuth profile by label through `Integration.connection.snapshot`. `dots/http.ts` supplies the internal fixed-origin request boundary: credentials stay inside Core, redirects are rejected, cancellation is forwarded, and ambiguous writes are not retried. This adds no credential-returning public operation, authentication scope, or dependency. Tests use synthetic credentials and injected fetch, not the live service.

Room messages have no evidenced per-message cancellation identity. Dot runtime Pause/Resume is independent of room-message identity and native activity-task threads. An active root thread and a room-live turn are not evidence of an activity-task interruption target.

File, image, and paste delivery remains required. Service eligibility is account-specific. Acknowledged upload and message requests do not establish server-side limits or every attachment format. Do not substitute a text-only implementation, fabricated receipt, bypass header, or unsupported-content placeholder for that requirement.

Synthetic transports prove local validation, framing, state transitions, resource lifetime, attribution, and authority boundaries. They do not prove service authentication, delivery, uploads, replies, runtime controls, or recovery.

`dots/node.ts` provisions the real room transport and shared runtime in the Location graph and registers permission-checked tools. Service construction performs no authentication or network request. Discovery reads only the available primary selection and its existing room; it never creates a missing room. Full history paging rejects cursor loops. Notifications trigger room refetches; no polling or guessed terminal-generation value is used.

Room sends upload every selected attachment before transmitting text and returned file IDs. A rejected upload prevents the message send. Send responses with no usable message ID remain unknown. Correlation uses server message IDs learned from acknowledged sends in the current connection; arbitrary history `request_id` fields are not proof of sender identity. Across a new connection, unsupported correlation remains absent rather than being guessed.

Local tests exercise injected HTTP and socket boundaries. Live eligibility, attachment formats, runtime controls and reconnect recovery require separately authorized service evidence. A server rejection is reported without integrity bypasses, borrowed tokens, retries or text-only substitution. Provider-specific verification runs locally, outside the release workflow.

```sh
bun test --cwd packages/core --timeout 40000 ./test/dots.test.ts ./test/dots-session.test.ts ./test/dots-tool.test.ts ./test/dots-model-request.test.ts ./test/dots-pubsub.test.ts ./test/dots-runtime-control.test.ts
bun test --cwd packages/core ./test-integration/dots-socket.test.ts
bun test --cwd packages/schema ./test/dots.test.ts
bun test --cwd packages/protocol ./test/dots.test.ts
bun test --cwd packages/server --timeout 40000 ./test/dots.test.ts
bun test --cwd packages/client ./test/dots-peer.test.ts
```
