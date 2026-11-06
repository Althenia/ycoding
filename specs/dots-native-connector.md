# Dots remote connector

## Ownership and transport

Core owns a private `NativeDots.Host` in the server process. Server constructs it in the built global-services context and passes it as the fifth process callback argument. CLI obtains Channels directly from this Host. Native tasks, candidate reads, and decision settlement do not use public HTTP, the browser relay, or an MCP adapter.

Trusted global `dots.enabled: true` and an explicit `dots.profile` select exactly one OpenAI OAuth credential with an account identity. A connection pins its profile, credential ID, account ID, account generation, and global access revision. Configuration, access, or credential replacement retires that connection and its Channels. Project configuration cannot enable the Host, and selection never falls back to another profile or account.

Native enrollment and refresh send a display label as the request `name` and the `x-codex-name` socket header: trusted global `dots.name`, else the saved enrollment's registered name, else `<host name> (<first 6 hex digits of SHA-256 of installation_id>)`. A label that differs from the saved enrollment refreshes it with the saved server ID and installation ID at the next connection; the enrollment record stores the label as `serverName`. A rename refresh must return the saved server and environment IDs: another ID, or a refresh outcome that would delete and re-enroll, fails that attempt with `enrollment` and the diagnostic `Remote-control rename rejected`, saving, adopting, deleting, and connecting nothing. Later attempts use the saved name, through the ordinary refresh and recovery path, until the connector restarts its configuration generation. Refreshes without a rename keep the ordinary contract. `NativeDots.Host.name()` returns the configured label, which is excluded from connection pins, source receipts, Channel and scope validity, routing, and authentication: changing it retires no connection, Channel, candidate, or scope and notifies no configuration listener. The installation ID is persisted once in `remote-control.json` and shared with the CCA executor.

The enrolled authenticated socket supplies the environment identity. Incoming frames require nonempty `client_id` and `stream_id` and a safe nonnegative integer `seq_id`. A supplied `env_id` must exactly match the socket's environment before receipt, chunk, or stream state changes. ACK, pong, and server responses carry that authenticated `env_id`. Connection and stream retirement applies equally to frames with and without a wire `env_id`.

## Global access and status

Persist one backend-wide access preference as `{ enabled, revision }` in the existing global KV store under `dots.native-access`. An absent preference is Off at revision 0. Malformed persisted state fails closed and is not overwritten. An unreadable preference retires existing native authority and remains an error at status and administration boundaries; infallible owner validators deny it, and native event hooks do not fail the event publisher. Enabling grants access to every existing and future eligible Session on this backend, including native-created roots and managed descendants. Session creation and historical family grants do not enable it. Missing, deleted, archived, and foreign-owned Sessions or ancestors remain ineligible. Root listings expose roots, not children as independent native threads.

Local and web clients administer access through these operations only:

| Operation | HTTP | Input | Output |
| --- | --- | --- | --- |
| `dots.get` | `GET /api/dots` | None | `{ data: Dots.NativeStatus }` |
| `dots.set` | `PUT /api/dots` | `{ enabled, expectedRevision }` | Same status envelope |
| `dots.attach` | `POST /api/dots/computer` | `{ replaceOthers: true, expectedTarget?: Dots.ComputerTarget }` | Same status envelope |

All three operations require normal server authentication and authenticated relay user/device ownership. Neither accepts a Session ID or Location. Setters reject excess authority fields. Revisions are nonnegative integers; a stale revision conflicts before no-op handling. Repeating the same enabled state at the current revision does not increment it. Concurrent writes at one revision commit at most one change. Enabling requires available trusted configuration and the selected OpenAI OAuth profile. Turning access Off does not require those prerequisites.

`Dots.NativeStatus` has independent fields:

```ts
{
  access: { enabled: boolean, revision: number },
  configuration: { ready: boolean, profile?: string, message?: string },
  connection: {
    state: "unavailable" | "off" | "connecting" | "connected" | "error",
    hostname?: string,
    name?: string,
    message?: string,
  },
  computer?: { state: "attached" | "detached" | "unavailable", name?: string, target?: Dots.ComputerTarget, message?: string },
}
```

`computer` is present whenever a process-owned transport is attached and reports whether ChatGPT lists this computer's Dots executor as attached to the user's Dot. Its `name` is the observed CCA display name; `connection.name` is the registered native label. A `Dots.ComputerTarget` contains `dotID`, `threadID`, `environmentID`, and an opaque `revision` binding fingerprint. New callers forward the displayed target as `expectedTarget`; the receipt is not authorization. `dots.attach` requires the literal `replaceOthers: true` as explicit consent that attaching detaches the user's other computers from that Dot; legacy replace-only input remains valid. Current principal, access, enrollment and target are rechecked before dispatch and before publication. Without an attached transport it fails as invalid input; otherwise it returns the status with `computer` set from the attach outcome.

An absent process-owned transport is `unavailable`; an attached transport gated by configuration or access is `off`. `connected` means the native transport is attached, not that an external client has selected or opened a conversation. `hostname` is the machine name, not the display label. The profile and hostname are bounded to 256 characters and guidance to 500, without control characters. Guidance uses fixed categories, never raw provider messages, URLs, credential/account identifiers, tokens, or payloads.

The TUI and web command palette expose **Dots connection** from landing, root, and child views. Show the selected profile, machine name when available, configuration readiness, global access, and actual connection state separately. Connect/Disconnect changes the single global preference. Connection start, stop, and automatic retry belong to the existing transport lifecycle; there is no separate retry or profile-selection control. Refetch after conflicts or uncertain mutation outcomes rather than replaying the mutation.

## Private transport status

The Host and HTTP handlers consume the same global `DotsAccess.Service`. `NativeDots.Host.attachTransport(transport)` installs one process-owned read-only status adapter and returns its unregister function. `transport.status()` returns a Promise of `{ state: "off" | "connecting" | "connected" | "error", hostname?, name?, problem? }`; `problem` is one of `configuration`, `authentication`, `enrollment`, or `connection`. `transport.computer()` and `transport.attachComputer(expectedTarget?)` return a Promise of `{ state: "attached" | "detached" | "unavailable", name?, target?, problem? }` with `problem` one of `configuration`, `authentication`, `enrollment`, `dot-unavailable`, `not-listed`, `admin-disabled`, `not-connectable`, `target-changed`, `rejected`, `unconfirmed`, or `connection`; a rejected read is `unavailable` with `connection`. Core maps each category to fixed display guidance.

An uncaught native request-handler failure emits one Host diagnostic containing only its sanitized JSON-RPC method and error kind, each bounded to 80 characters. Kind selection prefers a token-shaped `_tag`, then a token-shaped or finite numeric `code`, then the constructor name, with an Effect failure tag or value type when none is available. Diagnostics exclude error messages, parameters, request and thread IDs, paths and stacks. The JSON-RPC response remains `-32603` with `Remote-control request failed`.

Reject an attachment while another owns the slot. Identity-fence unregister and asynchronous status reads so a retired attachment cannot clear or report for its replacement. Discard a connection observation spanning an access revision change. Host shutdown unregisters its adapter. The adapter exposes no Channel or execution operation and grants no authority.

Effective native configuration combines the trusted profile gate with global access. Access changes synchronously retire existing Channels, root lifetimes, candidates, subscriptions, and staged answers, then notify the existing configuration subscription. Off-On captures a fresh revision and cannot revive old socket pins or handles. Off does not interrupt execution, remove admitted prompts, consume pending decisions, or replay work.

## Native admission and decisions

Channels carry native source receipts with exact profile, credential, account generation, environment, connection, client, stream, root, global access revision, and request identity. Lifetime checks fence asynchronous reads and writes against connection retirement and global access changes. Managed-child ownership remains parent-only.

Decision candidates bind an exact typed source and revision. Native projection stages single-pick choices rather than granting ambient approval. Permissions, hard/custom guardrails, Forms, Questions, managed-child questions, deferred reviews, and recovery retain their existing typed outcomes and validators. Explicit denies, ceilings, ownership, archive state, and live access are rechecked at settlement. Replaced candidates and retired lifetimes cannot settle. Uncertain mutation outcomes are not replayed.

Prompt text cannot establish a typed decision, native source receipt, or delegation. Ordinary configured external MCP servers, provider tools, and elicitation retain their separate runtime paths.

## Native thread lifecycle

`thread/start` requires an absolute `cwd` naming an existing local directory. YCoding records and opens that directory as a project location before creating the root. It never creates a missing directory; a relative path, missing path, or file path is rejected before effects. An existing root cannot change `cwd` through resume, turn, or any other request. Roots created by `thread/start` carry no Session origin and stay in every Session picker; only CCA executor Sessions carry origin `dots-executor` (see [the CCA executor contract](./dots-cca-executor.md#thread-sessions)). Root listings contain roots only.

A snapshot enrichment failure on one eligible root does not abort `thread/list` or hide that root. Its entry reports `{ type: "systemError" }` as its status and `unknown` model metadata; it does not report an idle or active state from incomplete reads. Core logs the failed root's Session ID without the backend error payload. Successful entries retain their model and live status. Every entry, including a failed snapshot, passes the same final access, ownership, archive, configuration and revision checks before publication. Listing failures outside individual snapshots and interruption remain errors. Targeted reads and resume still fail when their requested snapshot fails; listing does not repair the underlying failure or select a different model.

Lifecycle requests: `thread/name/set` `{ threadId, name }`, `thread/archive` `{ threadId }`, `thread/unarchive` `{ threadId }` returning `{ thread }`, and `thread/delete` `{ threadId }`. Notifications: `thread/started` `{ thread }`, `thread/name/updated` `{ threadId, threadName }`, and `thread/archived`, `thread/unarchived`, `thread/deleted` each with `{ threadId }`.

Reads, prompts, and decisions exclude archived roots. Targeted `thread/unarchive` and `thread/delete` are the only operations that accept an archived root, and only after global access, configuration, ownership, and connection pins validate. Rename and archive require a non-archived eligible root. Delete removes the root family recursively through `Session.remove` only after the whole descendant tree passes ownership and root checks; a foreign-owned descendant blocks the request with no deletion. Managed children are not independent native threads and cannot be renamed, archived, or deleted directly.

A root stops receiving escalation requests on a stream only when it is genuinely retired: it was archived or deleted, its backend subscription reported retirement, or native access ended. A failed pending-decision read leaves the root subscribed, because the same subscription carries the turn's progress and completion frames, and the carrier re-reads that root's current pending state after 1, 2, 4, 8 and 16 seconds: one scheduled read per root at a time, shared with event-triggered reads, cancelled by any successful read, root retirement, a dropped subscription, or stream retirement. After the fifth failed retry the root waits for its next event or escalation. A failed read never resolves or drops a held request, and a request already sent on the stream is not sent again. A failed subscription attempt is dropped so a later escalation establishes a fresh watch. Pending requests are delivered on `item/tool/requestUserInput` once per request per stream, and the client acknowledges them; YCoding keeps no unacknowledged-frame queue and never resends a request that a re-read no longer lists.

## Native escalation delivery

After the app-server `initialized` notification, Core notifies the carrier of eligible roots with pending decisions: one initial scan, then internal decision lifecycle events. The carrier watches each such root and forwards its exact candidates immediately as `item/tool/requestUserInput`, including roots the stream has not opened or read. This covers permissions, guardrails, Forms, Questions, deferred reviews and recovery, and managed-child questions. Settlement and resolution still use `serverRequest/resolved` with exact candidate revalidation. Every stream holding a request for a decision receives exactly one `serverRequest/resolved` once that decision settles, whichever stream, client or service settled it: a terminal Permission, guardrail, Form or Question event resolves the request on that stream even while its pending read still lists the decision, and a decision already settled when it is first read is not delivered. Prompt text grants no authority.

For every root a stream watches, including roots it did not start, the carrier sends `thread/status/changed` `{ threadId, status }` when its status changes. `status` is `{ type: "idle" }` or `{ type: "active", activeFlags }` with `waitingOnApproval` or `waitingOnUserInput`. Both notifications and `thread/*` results use the same Core snapshot: `active` reads the canonical `Session.outstanding().running` set, which includes own execution, descendant tasks in `starting`, `running` or `cancelling`, and own or descendant running shell jobs. Waiting decisions supply separate flags; `supervising`, queued inputs, undelivered notices and settled shells awaiting their notice do not by themselves mean running. Idle is not proof of completed work.

A terminal execution event precedes removal from the execution registry and cannot stamp the entire family idle. The subsequent `session.status` event follows coordinator settlement and triggers a fresh canonical snapshot; an idle root execution still reports active while a descendant or shell runs. Execution, task, shell and Session-status events refresh the snapshot independently of the escalation pending-decision read; a snapshot read that fails, including its own pending-decision read, sends no status change and fabricates no waiting flag. Status refreshes coalesce per root, send only changed values, and record the first observation without a notification when the stream has received no status for that root. Retirement, archive, deletion and global Off suppress further delivery. Reconnect reads current snapshots and pending candidates rather than replaying missed notifications.

### Reach and direction

| Target | Supported direction and method | Required connection and lifetime |
| --- | --- | --- |
| Connected native client watching a YCoding root | YCoding → client: `item/tool/requestUserInput`, `serverRequest/resolved`, `thread/status/changed`; `item/started`, `item/agentMessage/delta`, `item/completed` and `turn/completed` for turns that stream admitted and tracks | Authenticated enrolled socket plus a client-opened `client_id`/`stream_id`, initialized app-server, eligible root and current Channel pins; only while that socket, stream and root lifetime remain valid |
| Active Dots cloud task | No executor-originated prompt/steer method on these transports. App-server `turn/steer` is client → execution host and carries the active `expectedTurnId`; it is not a server notification that injects input into another host's cloud task | A client connected to the host that owns the target turn must originate the request. YCoding's inbound `turn/start` and `turn/steer` admit text into YCoding Sessions, not into the cloud harness |
| Idle Dots conversation | No server-originated wake method. Client → host `thread/resume` loads/rejoins a thread; client → host `turn/start` starts execution | The owning client must initiate the request on the owning host. A connected native client may display fresh pending decisions or status for an idle YCoding root; displaying them does not start a cloud turn |
| Finished cloud task | No supported executor-originated reopen, resume or wake operation | A connected client starting another turn on the owning cloud host is a separate operation; YCoding does not synthesize one |

Every native source binds profile, credential ID, account ID/generation, global revision, environment, connection, client, stream, root and exact request/candidate identity. Delivery and candidate reads recheck live access, ownership, archive state and connection lifetime; settlement additionally preserves the operation's explicit denies, permission ceilings and one-shot typed validation. Notification text grants no approval and settles nothing. A CCA cloud thread ID and its executor-backed YCoding Session ID are distinct identities, not interchangeable notification destinations.

Every server frame targets a client-opened stream; the host keeps one socket per enrollment and replaces it on reconnect. There is no thread-addressed host-initiated frame, persistent notification queue or store-and-forward acknowledgement. Frames are sent once, without a server-side unacknowledged-frame queue; clients needing certainty reread current state. The status protocol has no completed, failed or interrupted value, so an untracked run exposes activity transitions, not a fabricated completion turn. CCA process and HTTP notifications belong only to harness-initiated operations. The desktop's `thread/environmentReady` request is desktop → cloud execution host workspace readiness, not an unsolicited report or wake method. An MCP event notification is not an authority or transport bridge into these native Channels.

## Executor scope

`NativeDots.Host.threadScope({ environmentID, threadID, cwd? })` and `NativeDots.Host.unattributedScope({ environmentID })` return `{ sessionID, directory, roots, authorization, transcript, close }` for the CCA executor hosted by the server process (see [the CCA executor contract](./dots-cca-executor.md#thread-sessions) for directory, title, and root rules).

- Input requires nonblank identifiers of at most 256 characters and an absolute `cwd` when given; otherwise the call rejects with `NativeDots.Error` `invalid_input`. Opening requires effective native configuration (global access On, trusted configuration ready, selected profile credential); otherwise it rejects with `unavailable`. Errors carry no path, credential, or payload.
- Each scope key is a durable key-value mapping, `dots.cca.thread.<environmentID>.<threadID>` or `dots.cca.unattributed.<environmentID>`, holding `{ sessionID, projectID? }`. Calls for one key are serialized. A mapped Session that still exists, is not archived, and has no parent is reused; otherwise Core records the directory as a project location, creates a new root Session with Session origin `dots-executor` through the server's own Session service, and then overwrites the mapping with it. A replaced Session keeps its origin.
- The Session stays an eligible root: native root listings, escalation delivery, reads by ID, and history include it. `session.list` callers that pass `background: "exclude"` omit it.
- `authorization` is `createCcaAuthorization` bound to that Session with `defer`, after the Location's plugins load. Its current-Session check fails for another Session ID, a missing, deleted, archived, or foreign-owned Session, or a change to the configuration or access revision captured at opening. Global access or configuration Off denies the next operation; turning it On again does not revive the scope. The display label is not part of this check.
- Core caches one scope per key and counts its handles. Each handle's `close()` is idempotent; the last close flushes the transcript and releases every outstanding grant, and host shutdown closes every cached scope. A release failure rejects with the fixed `CcaAuthorizationCloseError`. Closing keeps the Session and its mapping.

## Platform spelling

Native `initialize` and CCA `environment/info` report the upstream `platformOs` spelling: `darwin` as `macos`, `win32` as `windows`, any other Node platform unchanged. The spelling does not establish live interoperability.

## Historical readability

Historical Dots and RemoteMCP Session events, family access events, source metadata, peer labels, `Dots.DelegationReview`, database tables, and migrations remain readable. Their presence grants no active authority. Stored native receipts retain their recorded `rootSessionID` and `accessRevision`; new receipts use the global revision. Historical data is neither rewritten nor used to initialize global consent.

Normal queue and steer promotion inspect the stored `DotsExchangeCreated` record. An unpromoted routine or delegated task is rejected transactionally with the existing `DotsInstructionRejected` event and `reason: "delegation_invalid"`, before input preparation or promotion. Repeated promotion emits no duplicate rejection. Historical exchange events remain unchanged; ordinary and native inputs continue normally. No bulk rewrite or data migration occurs.

## Verification

Select the global access, native admission, native decision, Schema, Protocol, and HTTP contract files for access persistence/CAS/no-op conflicts, historical decoding without consent, global Off races, ownership/archive/deny/ceiling checks, attachment lifetime and safe status output. CLI transport checks cover authenticated environment binding, exact supplied-environment rejection, ACK/pong addressing, sequence and chunk state, and retirement. Core `dots-native` and `cca-executor` files and CLI `remote-control-native`, escalation, and wire files cover any-folder thread creation, lifecycle safety, escalation reach into unopened roots, lifecycle notifications, and platform spelling. Core `dots-native` and `dots-executor-*` files cover executor scope opening, mapping reuse and replacement, eligibility, authorization denial, and close; Core `session-origin` files cover origin recording, persistence across renames, and list exclusion; Core `dots-native` and CLI `remote-control` files cover that a display-label change keeps pins, Channels, and candidates and that a rename never rotates the native enrollment. TUI rendered screens and web palette checks cover global availability and independent status display. Stubbed transports do not establish external conversation-picker interoperability.
